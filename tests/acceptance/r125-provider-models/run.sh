#!/usr/bin/env bash
# r125 Provider 与模型列表三问题(勾选弹窗可弃选 / 「拉取最新」对所有 provider 弹窗 / provider 列表不消失)验收,一条命令:
#   tests/acceptance/r125-provider-models/run.sh                  # 全量(B / C / D 三组)
#   tests/acceptance/r125-provider-models/run.sh -g 'B1'          # 额外参数原样转给 playwright
#   R125_API_ONLY=1 tests/acceptance/r125-provider-models/run.sh  # 不起 dev server,只跑接口用例(界面用例自动跳过)
#   R125_PROBE=1 tests/acceptance/r125-provider-models/run.sh -g '探路'   # 只跑探路脚本(平时跳过)
# 自己做:建共享实例的隔离 HOME → 起共享隔离实例(HOME=本套件 .artifacts,挂断外网预载)→ [起 dev server(源码直出,
#        /api、/ws 代理到共享实例)] → 跑用例(D3/D4 接口用例各自再起自己的实例)→ 只按记录的 pid 收尾。
# 端口只在 6700–6999 里挑空闲的,硬拒 6677 / 6689 / 6710。不读写真实的 ~/.claude、~/.claude-gui。不联外网。
set -euo pipefail

SUITE="$(cd "$(dirname "$0")" && pwd)"
WORKTREE="$(cd "$SUITE/../../.." && pwd)"
ROOT="$SUITE/.artifacts/runs/$(date +%Y%m%d-%H%M%S)-$$"
LOGS="$ROOT/logs"
mkdir -p "$LOGS"
export R125_DATA_ROOT="$ROOT"

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

API_PID=""; VITE_PID=""; VITE_WRAPPER_PID=""
cleanup() {
  [ -n "$VITE_PID" ] && kill "$VITE_PID" 2>/dev/null || true
  [ -n "$VITE_WRAPPER_PID" ] && kill "$VITE_WRAPPER_PID" 2>/dev/null || true
  [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null || true
  # 接口用例自己起的隔离实例:按它们落下的 pid 文件收(只杀命令行确实是本 worktree server/index.js 的)
  for f in "$ROOT"/api/*/instance-*.pid; do
    [ -e "$f" ] || continue
    pid="$(cat "$f" 2>/dev/null || true)"
    case "$pid" in ''|*[!0-9]*) continue ;; esac
    if ps -p "$pid" -o command= 2>/dev/null | grep -q "$WORKTREE/server/index.js"; then kill "$pid" 2>/dev/null || true; fi
  done
}
trap cleanup EXIT

# 1) 共享隔离实例(界面用例用)
node "$SUITE/helpers/fixtures.mjs"
HOME_DIR="$ROOT/home"
NO_OUTBOUND_URL="$(node -e 'console.log(require("node:url").pathToFileURL(process.argv[1]).href)' "$SUITE/helpers/no-outbound.mjs")"
cd "$ROOT"
env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_MODEL -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN \
    -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u all_proxy -u ALL_PROXY -u no_proxy -u NO_PROXY \
  HOME="$HOME_DIR" USERPROFILE="$HOME_DIR" PORT="$API_PORT" CGUI_DISABLE_FILE_WATCHER=1 \
  NODE_OPTIONS="--import=$NO_OUTBOUND_URL" R125_BLOCKED_LOG="$LOGS/shared.blocked.log" \
  nohup node "$WORKTREE/server/index.js" > "$LOGS/server.log" 2>&1 &
API_PID=$!
echo "$API_PID" > "$LOGS/instance.pid"
for _ in $(seq 1 60); do
  curl -sf --noproxy '*' -m 2 "http://127.0.0.1:$API_PORT/api/health" >/dev/null && break
  perl -e 'select(undef,undef,undef,0.5)'
done
kill -0 "$API_PID" 2>/dev/null || { echo "实例进程已退出:看 $LOGS/server.log" >&2; exit 1; }
lsof -nP -iTCP:"$API_PORT" -sTCP:LISTEN -t 2>/dev/null | grep -qx "$API_PID" \
  || { echo "端口 $API_PORT 上的监听者不是本实例(pid $API_PID)" >&2; exit 1; }
echo "[r125] 共享隔离实例就绪:http://127.0.0.1:$API_PORT(pid $API_PID,HOME=$HOME_DIR)"

# 2) dev server
UI_BASE=""
if [ "${R125_API_ONLY:-0}" != "1" ]; then
  ( cd "$WORKTREE/client" && R125_API_PORT="$API_PORT" R125_UI_PORT="$UI_PORT" \
      nohup node "$WORKTREE/client/node_modules/vite/bin/vite.js" --config "$SUITE/vite.dev.config.mjs" \
      > "$LOGS/vite.log" 2>&1 & echo $! > "$LOGS/vite.pid" )
  VITE_WRAPPER_PID="$(cat "$LOGS/vite.pid")"
  for _ in $(seq 1 80); do
    curl -sf --noproxy '*' -m 2 "http://127.0.0.1:$UI_PORT/" >/dev/null && break
    perl -e 'select(undef,undef,undef,0.5)'
  done
  LISTENER="$(lsof -nP -iTCP:"$UI_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)"
  if [ -n "$LISTENER" ] && ps -p "$LISTENER" -o command= | grep -q "r125-provider-models"; then
    VITE_PID="$LISTENER"
  else
    echo "dev server 没起来或端口 $UI_PORT 上不是本套件的进程:看 $LOGS/vite.log" >&2; exit 1
  fi
  UI_BASE="http://127.0.0.1:$UI_PORT"
  echo "[r125] dev server 就绪:$UI_BASE(pid $VITE_PID;/api、/ws 代理到 $API_PORT)"
else
  echo "[r125] R125_API_ONLY=1:不起 dev server,界面用例将跳过"
fi

# 3) 跑用例
cd "$WORKTREE"
set +e
R125_UI_BASE="$UI_BASE" R125_API_BASE="http://127.0.0.1:$API_PORT" R125_HOME="$HOME_DIR" R125_LOGS="$LOGS" \
  npx playwright test -c "$SUITE/playwright.config.mjs" "$@"
CODE=$?
set -e
echo "[r125] playwright 退出码 $CODE(实例 pid $API_PID / dev server pid ${VITE_PID:-无};产物在 $ROOT)"
exit $CODE
