#!/usr/bin/env bash
# 用本 worktree 的源码跑旧套件 stripfold-20260913(不需要 client/dist):
#   tests/acceptance/r122-ui-batch/run-legacy-stripfold.sh sf-1-strip-static.spec.mjs     # 参数原样转给 playwright
#   tests/acceptance/r122-ui-batch/run-legacy-stripfold.sh -g 'SF-10'
# 为什么不用它自己的 run-isolated.sh:那份脚本要 client/dist 产物、挑端口时不避开 6710、收尾按端口批量杀;
# 这里改成:dev server 源码直出 + 端口硬拒 6677/6689/6710 + 只按自己记录的 pid(含实例的子进程树)收尾。
# 夹具、HOME、假 claude 全部沿用 stripfold 自己的 helpers(它的数据根固定在 stripfold-20260913/.artifacts/runtime-data)。
set -euo pipefail

SUITE="$(cd "$(dirname "$0")" && pwd)"
WORKTREE="$(cd "$SUITE/../../.." && pwd)"
SF="$WORKTREE/tests/acceptance/stripfold-20260913"
ROOT="$SF/.artifacts/runtime-data"
LOGS="$SUITE/.artifacts/legacy-runs/$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$LOGS"

pick_port() {
  local exclude=" $* " port
  for port in $(seq 6700 6999); do
    case "$port" in 6677|6689|6710) continue ;; esac
    case "$exclude" in *" $port "*) continue ;; esac
    if ! lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then echo "$port"; return 0; fi
  done
  echo "6700-6999 没有空闲端口" >&2; return 1
}
API_PORT="$(pick_port)"
UI_PORT="$(pick_port "$API_PORT")"

node "$SF/helpers/fixtures.mjs" >/dev/null
mkdir -p "$ROOT/home/.claude" "$ROOT/home/.claude-gui" "$ROOT/fixture-workspace"

cd "$ROOT"
env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_MODEL -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN \
  HOME="$ROOT/home" USERPROFILE="$ROOT/home" PORT="$API_PORT" \
  PATH="$SF/.artifacts/fakebin:$PATH" CGUI_FAKE_CLAUDE_DIR="$ROOT/home/fake-claude" \
  CGUI_DISABLE_FILE_WATCHER=1 CGUI_ENABLE_LOCAL_ROUTES=1 \
  nohup node "$WORKTREE/server/index.js" > "$LOGS/server.log" 2>&1 &
API_PID=$!
VITE_WRAPPER_PID=""
VITE_PID=""
descendants() {   # 只按"自己记录的 pid"往下找子进程树(stripfold 的假 claude 不写 pid 文件,它们是实例的子进程)
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do echo "$child"; descendants "$child"; done
}
cleanup() {
  local kids
  kids="$(descendants "$API_PID" 2>/dev/null || true)"
  [ -n "$VITE_PID" ] && kill "$VITE_PID" 2>/dev/null || true
  [ -n "$VITE_WRAPPER_PID" ] && kill "$VITE_WRAPPER_PID" 2>/dev/null || true
  kill "$API_PID" 2>/dev/null || true
  for pid in $kids; do kill -9 "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT

for _ in $(seq 1 60); do
  curl -sf -m 2 "http://127.0.0.1:$API_PORT/api/health" >/dev/null && break
  perl -e 'select(undef,undef,undef,0.5)'
done
kill -0 "$API_PID" 2>/dev/null || { echo "实例进程已退出:看 $LOGS/server.log" >&2; exit 1; }
lsof -nP -iTCP:"$API_PORT" -sTCP:LISTEN -t 2>/dev/null | grep -qx "$API_PID" \
  || { echo "端口 $API_PORT 上的监听者不是本实例(pid $API_PID)" >&2; exit 1; }
echo "[legacy-sf] 隔离实例就绪:http://127.0.0.1:$API_PORT(pid $API_PID,HOME=$ROOT/home)"

( cd "$WORKTREE/client" && R122_API_PORT="$API_PORT" R122_UI_PORT="$UI_PORT" \
    nohup node "$WORKTREE/client/node_modules/vite/bin/vite.js" --config "$SUITE/vite.dev.config.mjs" \
    > "$LOGS/vite.log" 2>&1 & echo $! > "$LOGS/vite.pid" )
VITE_WRAPPER_PID="$(cat "$LOGS/vite.pid")"
for _ in $(seq 1 80); do
  curl -sf -m 2 "http://127.0.0.1:$UI_PORT/" >/dev/null && break
  perl -e 'select(undef,undef,undef,0.5)'
done
LISTENER="$(lsof -nP -iTCP:"$UI_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)"
if [ -n "$LISTENER" ] && ps -p "$LISTENER" -o command= | grep -q "r122-ui-batch"; then
  VITE_PID="$LISTENER"
else
  echo "dev server 没起来或端口 $UI_PORT 上不是本套件的进程:看 $LOGS/vite.log" >&2; exit 1
fi
echo "[legacy-sf] dev server 就绪:http://127.0.0.1:$UI_PORT(pid $VITE_PID;/api、/ws 代理到 $API_PORT)"

cd "$WORKTREE"
set +e
BASE_URL="http://127.0.0.1:$UI_PORT" npx playwright test -c "$SF/playwright.config.mjs" "$@"
CODE=$?
set -e
echo "[legacy-sf] playwright 退出码 $CODE(实例 pid $API_PID / dev server pid $VITE_PID)"
exit $CODE
