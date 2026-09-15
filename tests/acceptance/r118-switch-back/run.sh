#!/usr/bin/env bash
# r118 界面验收,一条命令:
#   tests/acceptance/r118-switch-back/run.sh                 # 全量
#   tests/acceptance/r118-switch-back/run.sh -g 'B1'         # 额外参数原样转给 playwright
# 自己做:建夹具 → 起隔离实例(HOME=本套件 .artifacts,PATH 上挂假 claude)→ 起 dev server(源码直出)
#        → 跑用例 → 按记录的 pid 收掉这两个进程。
# 端口只在 6700–6999 里挑空闲的,硬拒 6677 / 6689 / 6710。
set -euo pipefail

SUITE="$(cd "$(dirname "$0")" && pwd)"
WORKTREE="$(cd "$SUITE/../../.." && pwd)"
# 每次一个全新的数据根(HOME 在它下面):上一轮的会话、控制文件不会混进来。
ROOT="$SUITE/.artifacts/runs/$(date +%Y%m%d-%H%M%S)-$$"
LOGS="$ROOT/logs"
mkdir -p "$LOGS"
export R118_DATA_ROOT="$ROOT"

# 用 lsof 看有没有监听者(对 127.0.0.1 试绑在 macOS 上会被 0.0.0.0 的监听骗过)
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

node "$SUITE/helpers/fixtures.mjs"
CTL="$ROOT/home/fake-claude"
rm -f "$CTL"/*.chunk "$CTL"/*.done "$CTL"/*.phase 2>/dev/null || true

cd "$ROOT"
env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_MODEL -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN \
  HOME="$ROOT/home" USERPROFILE="$ROOT/home" PORT="$API_PORT" \
  PATH="$SUITE/.artifacts/fakebin:$PATH" CGUI_FAKE_CLAUDE_DIR="$CTL" CGUI_DISABLE_FILE_WATCHER=1 \
  nohup node "$WORKTREE/server/index.js" > "$LOGS/server.log" 2>&1 &
API_PID=$!
VITE_WRAPPER_PID=""
VITE_PID=""
cleanup() {
  [ -n "$VITE_PID" ] && kill "$VITE_PID" 2>/dev/null || true
  [ -n "$VITE_WRAPPER_PID" ] && kill "$VITE_WRAPPER_PID" 2>/dev/null || true
  kill "$API_PID" 2>/dev/null || true
}
trap cleanup EXIT

for _ in $(seq 1 60); do
  curl -sf -m 2 "http://127.0.0.1:$API_PORT/api/health" >/dev/null && break
  perl -e 'select(undef,undef,undef,0.5)'
done
kill -0 "$API_PID" 2>/dev/null || { echo "实例进程已退出:看 $LOGS/server.log" >&2; exit 1; }
lsof -nP -iTCP:"$API_PORT" -sTCP:LISTEN -t 2>/dev/null | grep -qx "$API_PID" \
  || { echo "端口 $API_PORT 上的监听者不是本实例(pid $API_PID)" >&2; exit 1; }
echo "[r118] 隔离实例就绪:http://127.0.0.1:$API_PORT(pid $API_PID,HOME=$ROOT/home)"

( cd "$WORKTREE/client" && R118_API_PORT="$API_PORT" R118_UI_PORT="$UI_PORT" \
    nohup node "$WORKTREE/client/node_modules/vite/bin/vite.js" --config "$SUITE/vite.dev.config.mjs" \
    > "$LOGS/vite.log" 2>&1 & echo $! > "$LOGS/vite.pid" )
VITE_WRAPPER_PID="$(cat "$LOGS/vite.pid")"
for _ in $(seq 1 80); do
  curl -sf -m 2 "http://127.0.0.1:$UI_PORT/" >/dev/null && break
  perl -e 'select(undef,undef,undef,0.5)'
done
LISTENER="$(lsof -nP -iTCP:"$UI_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)"
if [ -n "$LISTENER" ] && ps -p "$LISTENER" -o command= | grep -q "r118-switch-back"; then
  VITE_PID="$LISTENER"
else
  echo "dev server 没起来或端口 $UI_PORT 上不是本套件的进程:看 $LOGS/vite.log" >&2; exit 1
fi
echo "[r118] dev server 就绪:http://127.0.0.1:$UI_PORT(pid $VITE_PID;/api、/ws 代理到 $API_PORT)"

cd "$WORKTREE"
set +e
R118_UI_BASE="http://127.0.0.1:$UI_PORT" R118_API_BASE="http://127.0.0.1:$API_PORT" R118_CTL="$CTL" \
  npx playwright test -c "$SUITE/playwright.config.mjs" "$@"
CODE=$?
set -e
echo "[r118] playwright 退出码 $CODE(实例 pid $API_PID / dev server pid $VITE_PID)"
exit $CODE
