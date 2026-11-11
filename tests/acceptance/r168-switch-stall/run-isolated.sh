#!/usr/bin/env bash
# 一条命令跑整套 B01~B15：自己起隔离后端 + Vite 源码直出（不用 client/dist），跑完只杀自己记录的 pid。
#
#   bash tests/acceptance/r168-switch-stall/run-isolated.sh                       # 全量（api + chromium + webkit 三个项目）
#   bash tests/acceptance/r168-switch-stall/run-isolated.sh --project=api         # 只跑接口类 B06~B09
#   bash tests/acceptance/r168-switch-stall/run-isolated.sh --grep 'B05'          # 额外参数原样转给 playwright
#   R168_PORT=6891 bash …/run-isolated.sh                                         # 指定后端端口（只许 6890–6899）
#   R168_HOLD=1 bash …/run-isolated.sh                                            # 只起实例不跑用例
#
# 端口：只在 6890–6899 里挑 lsof 查过空闲的；硬拒 6677 / 6689 / 6710 / 8798 / 8799。
# 隔离：HOME、USERPROFILE、CU_TEST_HOME 都指到 .artifacts/runtime-data/home；CGUI_DISABLE_FILE_WATCHER=1；
#       不设 CGUI_ENABLE_LOCAL_ROUTES；ANTHROPIC_* / CU_ALLOW_* 全部剥掉；PATH 最前面挂假 claude；
#       后端用 node --import tests/unit/q8-helpers/cu-preload.mjs server/index.js 启动。
# 收尾：kill 只按 .artifacts/pids 里记录的 pid，绝不 pkill / 不按端口或进程名杀；不删任何目录。
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
  [ "$1" -ge 6890 ] && [ "$1" -le 6899 ] && [[ "$DENY" != *" $1 "* ]]
}
pick_port() {
  local start=$(( RANDOM % 10 )) i p
  for i in $(seq 0 9); do
    p=$(( 6890 + (start + i) % 10 ))
    valid_port "$p" || continue
    case " $* " in *" $p "*) continue;; esac
    if port_free "$p"; then echo "$p"; return 0; fi
  done
  return 1
}

if [ -n "${R168_PORT:-}" ]; then BPORT="$R168_PORT"; else BPORT="$(pick_port)"; fi
valid_port "$BPORT" || { echo "拒绝端口 $BPORT：只允许 6890–6899，且不得是 6677/6689/6710/8798/8799" >&2; exit 1; }
port_free "$BPORT" || { echo "端口 $BPORT 已被占用，换一个" >&2; exit 1; }
VPORT="$(pick_port "$BPORT")"
valid_port "$VPORT" || { echo "挑不到第二个空闲端口" >&2; exit 1; }

for v in $(env | sed -n 's/^\(CU_ALLOW_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done
for v in $(env | sed -n 's/^\(ANTHROPIC_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done
unset CLAUDE_CODE_OAUTH_TOKEN CGUI_ENABLE_LOCAL_ROUTES || true

mkdir -p "$ROOT/home/.claude" "$ROOT/home/.claude-gui"
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

cd "$ROOT"
env HOME="$ROOT/home" USERPROFILE="$ROOT/home" CU_TEST_HOME="$ROOT/home" PORT="$BPORT" \
  PATH="$ART/fakebin:$PATH" \
  CGUI_FAKE_CLAUDE_DIR="$ROOT/home/fake-claude" \
  CGUI_DISABLE_FILE_WATCHER=1 \
  nohup node --import "$WORKTREE/tests/unit/q8-helpers/cu-preload.mjs" "$WORKTREE/server/index.js" > "$ROOT/server.log" 2>&1 &
echo "backend $!" >> "$PIDFILE"

for _ in $(seq 1 60); do
  curl -sf -m 2 "http://127.0.0.1:$BPORT/api/health" >/dev/null && break
  sleep 0.5
done
curl -sf -m 2 "http://127.0.0.1:$BPORT/api/health" >/dev/null \
  || { echo "后端起不来（端口 $BPORT）：看 $ROOT/server.log" >&2; exit 1; }

# 注意：不能写成 `( cd … && … & )`——那样 $! 是子 shell 的 pid，收尾时杀不到真正的 vite 进程。
cd "$WORKTREE/client"
env HOME="$ROOT/home" USERPROFILE="$ROOT/home" R154_BACKEND_PORT="$BPORT" \
  nohup node node_modules/vite/bin/vite.js --config "$SUITE/vite.isolated.config.mjs" \
    --host 127.0.0.1 --port "$VPORT" --strictPort > "$ROOT/vite.log" 2>&1 &
echo "vite $!" >> "$PIDFILE"
cd "$WORKTREE"
for _ in $(seq 1 120); do
  curl -sf -m 3 "http://127.0.0.1:$VPORT/" >/dev/null && break
  sleep 0.5
done
curl -sf -m 3 "http://127.0.0.1:$VPORT/" >/dev/null \
  || { echo "Vite 起不来（端口 $VPORT）：看 $ROOT/vite.log" >&2; exit 1; }

BASE_URL="http://127.0.0.1:$VPORT"
BACKEND_URL="http://127.0.0.1:$BPORT"
echo "[R168] 隔离实例就绪：前端 $BASE_URL  后端 $BACKEND_URL（pids 记在 $PIDFILE）"

if [ -n "${R168_HOLD:-}" ]; then
  while :; do sleep 2; done
fi

cd "$WORKTREE"
BASE_URL="$BASE_URL" BACKEND_URL="$BACKEND_URL" npx playwright test -c "$SUITE/playwright.config.mjs" "$@"
