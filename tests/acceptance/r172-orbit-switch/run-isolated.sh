#!/usr/bin/env bash
# 一条命令跑整套行为 1~11:自己起隔离后端 + Vite 源码直出(不用 client/dist,不需要先 build),跑完只杀自己记录的 pid。
#
#   bash tests/acceptance/r172-orbit-switch/run-isolated.sh                              # 全量(webkit 全部 + chromium 的行为 1/2/3)
#   bash tests/acceptance/r172-orbit-switch/run-isolated.sh --project=webkit             # 只跑 webkit
#   bash tests/acceptance/r172-orbit-switch/run-isolated.sh --project=chromium           # 只跑 chromium(行为 1/2/3)
#   bash tests/acceptance/r172-orbit-switch/run-isolated.sh --grep '行为7 '              # 额外参数原样转给 playwright
#   R172_PORT=6750 bash .../run-isolated.sh                                              # 指定后端端口(只许 6700–6799)
#   R172_HOLD=1 bash .../run-isolated.sh                                                 # 只起实例不跑用例(调试用)
#
# 端口:只在 6700–6799 里挑 lsof 查过当前空闲的;硬拒 6677 / 6689 / 6710 / 8798 / 8799。
# 隔离:HOME 与 USERPROFILE 都指到本套件 .artifacts/runtime-data/home;后端进程(只有后端)带 tests/unit/q8-helpers/cu-preload.mjs 预加载,
#       CU_TEST_HOME 指向同一个假家目录;CGUI_DISABLE_FILE_WATCHER=1;PATH 最前面挂假 claude;任何 CU_ALLOW_* 一律 unset;
#       Vite 的 /api 与 /ws 代理只指向本套件自己的后端端口。
# 收尾:kill 只按 .artifacts/pids 里记录的 pid(先温和、再对仍存活的强制),绝不 pkill / 不按端口或进程名去杀。
# 本套件不要和别的验收套件同时运行(各套件的 .artifacts 互相独立,但 CPU 争用会让逐帧采样卡顿)。
set -euo pipefail

SUITE="$(cd "$(dirname "$0")" && pwd)"
WORKTREE="$(cd "$SUITE/../../.." && pwd)"
ART="$SUITE/.artifacts"
ROOT="$ART/runtime-data"
PIDFILE="$ART/pids"
DENY=" 6677 6689 6710 8798 8799 "

port_free() { [ -z "$(lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null || true)" ]; }
valid_port() {
  case "$1" in ''|*[!0-9]*) return 1;; esac
  [ "$1" -ge 6700 ] && [ "$1" -le 6799 ] && [[ "$DENY" != *" $1 "* ]]
}
pick_port() { # 参数 = 要排除的端口;从随机起点往后找第一个 lsof 看着空闲的
  local start=$(( RANDOM % 100 )) i p
  for i in $(seq 0 99); do
    p=$(( 6700 + (start + i) % 100 ))
    valid_port "$p" || continue
    case " $* " in *" $p "*) continue;; esac
    if port_free "$p"; then echo "$p"; return 0; fi
  done
  return 1
}

if [ -n "${R172_PORT:-}" ]; then BPORT="$R172_PORT"; else BPORT="$(pick_port)"; fi
valid_port "$BPORT" || { echo "拒绝端口 $BPORT:只允许 6700–6799,且不得是 6677/6689/6710/8798/8799" >&2; exit 1; }
port_free "$BPORT" || { echo "端口 $BPORT 已被占用(lsof 查到监听者),换一个" >&2; exit 1; }
VPORT="$(pick_port "$BPORT")"
valid_port "$VPORT" || { echo "挑不到第二个空闲端口" >&2; exit 1; }

for v in $(env | sed -n 's/^\(CU_ALLOW_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done

mkdir -p "$ROOT/home/.claude" "$ROOT/home/.claude-gui" "$ROOT/fixture-workspace"
node "$SUITE/helpers/fixtures.mjs" >/dev/null
: > "$PIDFILE"

cleanup() {
  local name pid i alive
  [ -f "$PIDFILE" ] || return 0
  while read -r name pid; do [ -n "${pid:-}" ] && kill "$pid" 2>/dev/null || true; done < "$PIDFILE"
  for i in 1 2 3 4 5 6 7 8 9 10; do
    alive=0
    while read -r name pid; do if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then alive=1; fi; done < "$PIDFILE"
    [ "$alive" = 0 ] && break
    sleep 0.5
  done
  while read -r name pid; do if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" 2>/dev/null || true; fi; done < "$PIDFILE"
}
trap cleanup EXIT INT TERM

# 后端:端口一律由本脚本写死(不读继承来的 PORT);ANTHROPIC_* 全部剥掉;预加载只加在后端进程上。
cd "$ROOT"
env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_MODEL -u ANTHROPIC_API_KEY \
  -u CLAUDE_CODE_OAUTH_TOKEN \
  HOME="$ROOT/home" USERPROFILE="$ROOT/home" CU_TEST_HOME="$ROOT/home" PORT="$BPORT" \
  PATH="$ART/fakebin:$PATH" \
  CGUI_FAKE_CLAUDE_DIR="$ROOT/home/fake-claude" \
  CGUI_DISABLE_FILE_WATCHER=1 CGUI_ENABLE_LOCAL_ROUTES=1 \
  nohup node --import "$WORKTREE/tests/unit/q8-helpers/cu-preload.mjs" "$WORKTREE/server/index.js" > "$ROOT/server.log" 2>&1 &
echo "backend $!" >> "$PIDFILE"

for _ in $(seq 1 60); do
  curl -sf -m 2 "http://127.0.0.1:$BPORT/api/health" >/dev/null && break
  sleep 0.5
done
curl -sf -m 2 "http://127.0.0.1:$BPORT/api/health" >/dev/null \
  || { echo "后端起不来(端口 $BPORT):看 $ROOT/server.log" >&2; exit 1; }

# 注意:不能写成 `( cd … && … & )`——那样 $! 是子 shell 的 pid,收尾时杀不到真正的 vite 进程。
cd "$WORKTREE/client"
env HOME="$ROOT/home" USERPROFILE="$ROOT/home" R172_BACKEND_PORT="$BPORT" \
  nohup node node_modules/vite/bin/vite.js --config "$SUITE/vite.isolated.config.mjs" \
    --host 127.0.0.1 --port "$VPORT" --strictPort > "$ROOT/vite.log" 2>&1 &
echo "vite $!" >> "$PIDFILE"
cd "$WORKTREE"
for _ in $(seq 1 120); do
  curl -sf -m 3 "http://127.0.0.1:$VPORT/" >/dev/null && break
  sleep 0.5
done
curl -sf -m 3 "http://127.0.0.1:$VPORT/" >/dev/null \
  || { echo "Vite 起不来(端口 $VPORT):看 $ROOT/vite.log" >&2; exit 1; }

BASE_URL="http://127.0.0.1:$VPORT"
echo "$BASE_URL" > "$ART/base-url"
echo "[R172] 隔离实例就绪:$BASE_URL(后端端口 $BPORT;数据根 $ROOT;pids 记在 $PIDFILE)"

if [ -n "${R172_HOLD:-}" ]; then
  while :; do sleep 2; done
fi

cd "$WORKTREE"
BASE_URL="$BASE_URL" npx playwright test -c "$SUITE/playwright.config.mjs" "$@"
