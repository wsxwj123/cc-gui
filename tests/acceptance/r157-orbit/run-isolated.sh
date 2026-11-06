#!/usr/bin/env bash
# 一条命令跑整套 R1~R4：自己起隔离后端 + Vite 源码直出（不用 client/dist，不需要先 build），跑完只杀自己记录的 pid。
#
#   bash tests/acceptance/r157-orbit/run-isolated.sh                  # 全量
#   bash tests/acceptance/r157-orbit/run-isolated.sh --grep "R1 "    # 额外参数原样转给 playwright
#   R154_BROWSERS=webkit,chromium bash .../run-isolated.sh                   # 再加 chromium 对照
#   R154_MODE=dist bash .../run-isolated.sh                                  # 改用 client/dist（后端直接托管；需自己先 build）
#   R154_PORT=6781 bash .../run-isolated.sh                                  # 指定后端端口（只许 6700–6999）
#   R154_HOLD=1 bash .../run-isolated.sh                                     # 只起实例不跑用例（调试用；Ctrl-C / kill 本脚本即收尾）
#
# 端口：只在 6700–6999 里挑 lsof 查过当前空闲的；硬拒 6677 / 6689 / 6710 / 8798 / 8799（用户在用或别人占用）。
# 隔离：HOME 与 USERPROFILE 都指到本套件 .artifacts/runtime-data/home；CGUI_DISABLE_FILE_WATCHER=1；
#       PATH 最前面挂假 claude；任何 CU_ALLOW_* 一律 unset；Vite 的 /api 与 /ws 代理只指向本套件自己的后端端口。
# 收尾：kill 只按 .artifacts/pids 里记录的 pid（先温和、再对仍存活的强制），绝不 pkill / 不按端口或进程名去杀。
set -euo pipefail

SUITE="$(cd "$(dirname "$0")" && pwd)"
WORKTREE="$(cd "$SUITE/../../.." && pwd)"
ART="$SUITE/.artifacts"
ROOT="$ART/runtime-data"
PIDFILE="$ART/pids"
DENY=" 6677 6689 6710 8798 8799 "
MODE="${R154_MODE:-dev}"

port_free() { [ -z "$(lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null || true)" ]; }
valid_port() {
  case "$1" in ''|*[!0-9]*) return 1;; esac
  [ "$1" -ge 6700 ] && [ "$1" -le 6999 ] && [[ "$DENY" != *" $1 "* ]]
}
pick_port() { # 参数 = 要排除的端口；从随机起点往后找第一个 lsof 看着空闲的
  local start=$(( RANDOM % 300 )) i p
  for i in $(seq 0 299); do
    p=$(( 6700 + (start + i) % 300 ))
    valid_port "$p" || continue
    case " $* " in *" $p "*) continue;; esac
    if port_free "$p"; then echo "$p"; return 0; fi
  done
  return 1
}

if [ -n "${R154_PORT:-}" ]; then BPORT="$R154_PORT"; else BPORT="$(pick_port)"; fi
valid_port "$BPORT" || { echo "拒绝端口 $BPORT：只允许 6700–6999，且不得是 6677/6689/6710/8798/8799" >&2; exit 1; }
port_free "$BPORT" || { echo "端口 $BPORT 已被占用（lsof 查到监听者），换一个" >&2; exit 1; }
if [ "$MODE" = "dev" ]; then
  VPORT="$(pick_port "$BPORT")"
  valid_port "$VPORT" || { echo "挑不到第二个空闲端口" >&2; exit 1; }
  BASE_PORT="$VPORT"
else
  [ -f "$WORKTREE/client/dist/index.html" ] || { echo "R154_MODE=dist 缺少 client/dist（不自动 rebuild）" >&2; exit 1; }
  BASE_PORT="$BPORT"
fi

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

# 后端：端口一律由本脚本写死（不读继承来的 PORT）；ANTHROPIC_* 全部剥掉。
cd "$ROOT"
env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_MODEL -u ANTHROPIC_API_KEY \
  -u CLAUDE_CODE_OAUTH_TOKEN \
  HOME="$ROOT/home" USERPROFILE="$ROOT/home" PORT="$BPORT" \
  PATH="$ART/fakebin:$PATH" \
  CGUI_FAKE_CLAUDE_DIR="$ROOT/home/fake-claude" \
  CGUI_DISABLE_FILE_WATCHER=1 CGUI_ENABLE_LOCAL_ROUTES=1 \
  nohup node "$WORKTREE/server/index.js" > "$ROOT/server.log" 2>&1 &
echo "backend $!" >> "$PIDFILE"

for _ in $(seq 1 60); do
  curl -sf -m 2 "http://127.0.0.1:$BPORT/api/health" >/dev/null && break
  sleep 0.5
done
curl -sf -m 2 "http://127.0.0.1:$BPORT/api/health" >/dev/null \
  || { echo "后端起不来（端口 $BPORT）：看 $ROOT/server.log" >&2; exit 1; }

if [ "$MODE" = "dev" ]; then
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
fi

BASE_URL="http://127.0.0.1:$BASE_PORT"
echo "$BASE_URL" > "$ART/base-url"
echo "[R157] 隔离实例就绪：$BASE_URL（模式 $MODE；后端端口 $BPORT；数据根 $ROOT；pids 记在 $PIDFILE）"

if [ -n "${R154_HOLD:-}" ]; then
  while :; do sleep 2; done
fi

cd "$WORKTREE"
BASE_URL="$BASE_URL" npx playwright test -c "$SUITE/playwright.config.mjs" "$@"
