#!/usr/bin/env bash
# r122 界面小改一批(过程块自动折叠开关 / 用量页「价格与来源」精简 / 订阅额度"未登录"提示 / 两家中转站预设),一条命令:
#   tests/acceptance/r122-ui-batch/run.sh                 # 全量
#   tests/acceptance/r122-ui-batch/run.sh -g 'A4'         # 额外参数原样转给 playwright
#   R122_PROBE=1 tests/acceptance/r122-ui-batch/run.sh -g '探路'   # 只跑探路脚本(平时跳过)
#   R122_PW_CONFIG=tests/acceptance/<旧套件>/playwright.config.mjs tests/acceptance/r122-ui-batch/run.sh -g 'PR-25'
#        # 用本套件的隔离实例 + dev server 跑别的套件(同时导出 BASE_URL / WORKTREE);旧套件对齐验证用
# 自己做:建夹具(隔离 HOME + 夹具会话)→ 起隔离实例(HOME=本套件 .artifacts,PATH 上挂假 claude)
#        → 起 dev server(源码直出,/api、/ws 代理到隔离实例)→ 跑用例 → 按记录的 pid 收掉这两类进程和所有桩进程。
# 端口只在 6700–6999 里挑空闲的,硬拒 6677 / 6689 / 6710。不读写真实的 ~/.claude、~/.claude-gui。
set -euo pipefail

SUITE="$(cd "$(dirname "$0")" && pwd)"
WORKTREE="$(cd "$SUITE/../../.." && pwd)"
ROOT="$SUITE/.artifacts/runs/$(date +%Y%m%d-%H%M%S)-$$"
LOGS="$ROOT/logs"
mkdir -p "$LOGS"
export R122_DATA_ROOT="$ROOT"

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
HOME_DIR="$ROOT/home"
CTL="$HOME_DIR/fake-claude"

cd "$ROOT"
env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_MODEL -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN \
  HOME="$HOME_DIR" USERPROFILE="$HOME_DIR" PORT="$API_PORT" \
  PATH="$SUITE/.artifacts/fakebin:$PATH" CGUI_FAKE_CLAUDE_DIR="$CTL" CGUI_DISABLE_FILE_WATCHER=1 \
  nohup node "$WORKTREE/server/index.js" > "$LOGS/server.log" 2>&1 &
API_PID=$!
VITE_WRAPPER_PID=""
VITE_PID=""
cleanup() {
  [ -n "$VITE_PID" ] && kill "$VITE_PID" 2>/dev/null || true
  [ -n "$VITE_WRAPPER_PID" ] && kill "$VITE_WRAPPER_PID" 2>/dev/null || true
  kill "$API_PID" 2>/dev/null || true
  # F 组用例自己起的隔离实例:按它们落下的 pid 文件收(只杀命令行确实是本 worktree server/index.js 的)
  for f in "$ROOT"/f/*/instance-*.pid; do
    [ -e "$f" ] || continue
    pid="$(cat "$f" 2>/dev/null || true)"
    case "$pid" in ''|*[!0-9]*) continue ;; esac
    if ps -p "$pid" -o command= 2>/dev/null | grep -q "$WORKTREE/server/index.js"; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  # 桩进程:只按桩自己写下的 pid 文件收(不按进程名/端口批量杀)
  for f in "$CTL"/*.pid; do
    [ -e "$f" ] || continue
    pid="$(cat "$f" 2>/dev/null || true)"
    case "$pid" in ''|*[!0-9]*) continue ;; esac
    # 防 pid 复用误伤:只杀命令行里确实带着本套件假 claude 的进程
    if ps -p "$pid" -o command= 2>/dev/null | grep -q "r122-ui-batch/helpers/fake-claude.mjs"; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT

for _ in $(seq 1 60); do
  curl -sf -m 2 "http://127.0.0.1:$API_PORT/api/health" >/dev/null && break
  perl -e 'select(undef,undef,undef,0.5)'
done
kill -0 "$API_PID" 2>/dev/null || { echo "实例进程已退出:看 $LOGS/server.log" >&2; exit 1; }
lsof -nP -iTCP:"$API_PORT" -sTCP:LISTEN -t 2>/dev/null | grep -qx "$API_PID" \
  || { echo "端口 $API_PORT 上的监听者不是本实例(pid $API_PID)" >&2; exit 1; }
echo "[r122] 隔离实例就绪:http://127.0.0.1:$API_PORT(pid $API_PID,HOME=$HOME_DIR)"

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
echo "[r122] dev server 就绪:http://127.0.0.1:$UI_PORT(pid $VITE_PID;/api、/ws 代理到 $API_PORT)"

cd "$WORKTREE"
CONFIG="${R122_PW_CONFIG:-$SUITE/playwright.config.mjs}"
case "$CONFIG" in /*) ;; *) CONFIG="$WORKTREE/$CONFIG" ;; esac
set +e
R122_UI_BASE="http://127.0.0.1:$UI_PORT" R122_API_BASE="http://127.0.0.1:$API_PORT" R122_CTL="$CTL" \
  BASE_URL="http://127.0.0.1:$UI_PORT" WORKTREE="$WORKTREE" \
  npx playwright test -c "$CONFIG" "$@"
CODE=$?
set -e
echo "[r122] playwright 退出码 $CODE(实例 pid $API_PID / dev server pid $VITE_PID)"
exit $CODE
