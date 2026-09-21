#!/usr/bin/env bash
# r123 生图接任意中转站(任务形态表 / 网页响应与基址规范化 / 报错分层 / 两处补读)验收,一条命令:
#   tests/acceptance/r123-imagegen/run.sh                  # 全量(接口用例 + 界面用例)
#   tests/acceptance/r123-imagegen/run.sh -g 'A1'          # 额外参数原样转给 playwright
#   R123_API_ONLY=1 tests/acceptance/r123-imagegen/run.sh  # 不起 dev server,只跑接口用例(界面用例自动跳过)
#   R123_PROBE=1 tests/acceptance/r123-imagegen/run.sh -g '探路'   # 只跑探路脚本(平时跳过)
# 自己做:建隔离 HOME → 起隔离实例(HOME=本套件 .artifacts,轮询间隔调到 200ms)→ [起 dev server(源码直出,/api、/ws 代理到隔离实例)]
#        → 跑用例(假上游 / 假图片服务 / 诱饵由用例进程自己起,进程退出即消失)→ 按记录的 pid 收掉实例与 dev server。
# 端口只在 6700–6999 里挑空闲的,硬拒 6677 / 6689 / 6710。不读写真实的 ~/.claude、~/.claude-gui;不联外网。
set -euo pipefail

SUITE="$(cd "$(dirname "$0")" && pwd)"
WORKTREE="$(cd "$SUITE/../../.." && pwd)"
ROOT="$SUITE/.artifacts/runs/$(date +%Y%m%d-%H%M%S)-$$"
LOGS="$ROOT/logs"
HOME_DIR="$ROOT/home"
mkdir -p "$LOGS" "$HOME_DIR/.claude-gui" "$HOME_DIR/images"
# 钉成回环免密(公开版会自愈成 0.0.0.0+随机密码,会写盘)
printf '{"host":"127.0.0.1"}\n' > "$HOME_DIR/.claude-gui/network.json"

pick_port() {
  local exclude=" $* " port
  for port in $(seq 6700 6799); do
    case "$port" in 6677|6689|6710) continue ;; esac
    case "$exclude" in *" $port "*) continue ;; esac
    if ! lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then echo "$port"; return 0; fi
  done
  echo "6700-6799 没有空闲端口" >&2; return 1
}
API_PORT="$(pick_port)"
UI_PORT="$(pick_port "$API_PORT")"

cd "$ROOT"
env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_MODEL -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN \
    -u http_proxy -u https_proxy -u all_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
  HOME="$HOME_DIR" USERPROFILE="$HOME_DIR" PORT="$API_PORT" NO_PROXY="127.0.0.1,localhost" no_proxy="127.0.0.1,localhost" \
  CGUI_IMAGE_TASK_POLL_INTERVAL_MS=200 CGUI_DISABLE_FILE_WATCHER=1 \
  nohup node "$WORKTREE/server/index.js" > "$LOGS/server.log" 2>&1 &
API_PID=$!
echo "$API_PID" > "$LOGS/instance.pid"
VITE_WRAPPER_PID=""
VITE_PID=""
cleanup() {
  [ -n "$VITE_PID" ] && kill "$VITE_PID" 2>/dev/null || true
  [ -n "$VITE_WRAPPER_PID" ] && kill "$VITE_WRAPPER_PID" 2>/dev/null || true
  kill "$API_PID" 2>/dev/null || true
}
trap cleanup EXIT

for _ in $(seq 1 80); do
  curl -sf -m 2 "http://127.0.0.1:$API_PORT/api/health" >/dev/null && break
  perl -e 'select(undef,undef,undef,0.5)'
done
kill -0 "$API_PID" 2>/dev/null || { echo "实例进程已退出:看 $LOGS/server.log" >&2; exit 1; }
lsof -nP -iTCP:"$API_PORT" -sTCP:LISTEN -t 2>/dev/null | grep -qx "$API_PID" \
  || { echo "端口 $API_PORT 上的监听者不是本实例(pid $API_PID)" >&2; exit 1; }
echo "[r123] 隔离实例就绪:http://127.0.0.1:$API_PORT(pid $API_PID,HOME=$HOME_DIR,轮询间隔 200ms)"

UI_BASE=""
if [ "${R123_API_ONLY:-0}" != "1" ]; then
  ( cd "$WORKTREE/client" && R123_API_PORT="$API_PORT" R123_UI_PORT="$UI_PORT" \
      nohup node "$WORKTREE/client/node_modules/vite/bin/vite.js" --config "$SUITE/vite.dev.config.mjs" \
      > "$LOGS/vite.log" 2>&1 & echo $! > "$LOGS/vite.pid" )
  VITE_WRAPPER_PID="$(cat "$LOGS/vite.pid")"
  for _ in $(seq 1 80); do
    curl -sf -m 2 "http://127.0.0.1:$UI_PORT/" >/dev/null && break
    perl -e 'select(undef,undef,undef,0.5)'
  done
  LISTENER="$(lsof -nP -iTCP:"$UI_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)"
  if [ -n "$LISTENER" ] && ps -p "$LISTENER" -o command= | grep -q "r123-imagegen"; then
    VITE_PID="$LISTENER"
  else
    echo "dev server 没起来或端口 $UI_PORT 上不是本套件的进程:看 $LOGS/vite.log" >&2; exit 1
  fi
  UI_BASE="http://127.0.0.1:$UI_PORT"
  echo "[r123] dev server 就绪:$UI_BASE(pid $VITE_PID;/api、/ws 代理到 $API_PORT)"
else
  echo "[r123] R123_API_ONLY=1:不起 dev server,界面用例将跳过"
fi

cd "$WORKTREE"
set +e
R123_API_BASE="http://127.0.0.1:$API_PORT" R123_UI_BASE="$UI_BASE" R123_HOME="$HOME_DIR" R123_DATA_ROOT="$ROOT" R123_LOGS="$LOGS" \
  BASE_URL="$UI_BASE" WORKTREE="$WORKTREE" \
  npx playwright test -c "$SUITE/playwright.config.mjs" "$@"
CODE=$?
set -e
echo "[r123] playwright 退出码 $CODE(实例 pid $API_PID / dev server pid ${VITE_PID:-无};实例日志 $LOGS/server.log)"
exit $CODE
