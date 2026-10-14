#!/usr/bin/env bash
# r151a 第三方 provider 下的 auto 审计 —— 验收,一条命令:
#   tests/acceptance/r151a-auto-audit/run.sh                 # 全量
#   tests/acceptance/r151a-auto-audit/run.sh -g 'C1'         # 额外参数原样转给 playwright
# 自己做:建夹具 → 起本地假模型接口 → 起"被测工作树"的 openai 协议代理(测试端口,上游 = 假接口)
#        → 起隔离实例(HOME=本次运行的临时目录,PATH 上挂假 claude,环境用 env -i 从零给)→ 起 dev server
#        → 跑用例 → 按记录的 pid 收掉自己起的进程(不按端口、不按名字批量杀)。
# 端口只在 6700–6999 里挑空闲的,硬拒 6677 / 6689 / 6710。
# 隔离实例的环境里故意带着 CLAUDE_CODE_AUTO_MODE_SERVER=1:验证"GUI 后端自身环境里的这个键先被剥掉"(Y.3.2 最后一条)。
set -euo pipefail

SUITE="$(cd "$(dirname "$0")" && pwd)"
WORKTREE="$(cd "$SUITE/../../.." && pwd)"
ROOT="$SUITE/.artifacts/runs/$(date +%Y%m%d-%H%M%S)-$$"
LOGS="$ROOT/logs"
mkdir -p "$LOGS" "$ROOT/tmp" "$ROOT/proxyhome"
export R151A_DATA_ROOT="$ROOT"

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
MOCK_PORT="$(pick_port "$API_PORT" "$UI_PORT")"
PROXY_PORT="$(pick_port "$API_PORT" "$UI_PORT" "$MOCK_PORT")"

node "$SUITE/helpers/fixtures.mjs"
CTL="$ROOT/home/fake-claude"

PIDS=()
VITE_WRAPPER_PID=""
VITE_PID=""
cleanup() {
  [ -n "$VITE_PID" ] && kill "$VITE_PID" 2>/dev/null || true
  [ -n "$VITE_WRAPPER_PID" ] && kill "$VITE_WRAPPER_PID" 2>/dev/null || true
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
}
trap cleanup EXIT

# 1) 本地假模型接口
nohup node "$SUITE/helpers/mock-upstream.mjs" "$MOCK_PORT" "$ROOT/mock" > "$LOGS/mock.log" 2>&1 &
MOCK_PID=$!; PIDS+=("$MOCK_PID")
# 2) 被测工作树的 openai 协议代理(测试端口;上游 = 假接口的 proxy 车道)
#    直接在本 shell 里后台起(nohup → env → node 逐级 exec,$! 就是 node 本身;套一层子 shell 会让记下的 pid 是壳)
cd "$ROOT"
nohup env -i PATH="$PATH" HOME="$ROOT/proxyhome" TMPDIR="$ROOT/tmp" LANG=en_US.UTF-8 \
  CGUI_USAGE_ISSUES_PATH="$ROOT/proxyhome/usage-issues.json" \
  node "$SUITE/helpers/proxyhost.mjs" "$PROXY_PORT" "http://127.0.0.1:$MOCK_PORT/lane/proxy" > "$LOGS/proxyhost.log" 2>&1 &
PROXY_PID=$!; PIDS+=("$PROXY_PID")

# 3) 隔离实例
env -i PATH="$SUITE/.artifacts/fakebin:$PATH" HOME="$ROOT/home" USERPROFILE="$ROOT/home" USER="${USER:-tester}" LOGNAME="${LOGNAME:-tester}" \
  SHELL=/bin/sh LANG=en_US.UTF-8 TMPDIR="$ROOT/tmp" PORT="$API_PORT" \
  CGUI_FAKE_CLAUDE_DIR="$CTL" CGUI_DISABLE_FILE_WATCHER=1 CLAUDE_CODE_AUTO_MODE_SERVER=1 \
  nohup node "$WORKTREE/server/index.js" > "$LOGS/server.log" 2>&1 &
API_PID=$!; PIDS+=("$API_PID")

for _ in $(seq 1 60); do
  curl -sf -m 2 "http://127.0.0.1:$API_PORT/api/health" >/dev/null && break
  perl -e 'select(undef,undef,undef,0.5)'
done
kill -0 "$API_PID" 2>/dev/null || { echo "实例进程已退出:看 $LOGS/server.log" >&2; exit 1; }
lsof -nP -iTCP:"$API_PORT" -sTCP:LISTEN -t 2>/dev/null | grep -qx "$API_PID" \
  || { echo "端口 $API_PORT 上的监听者不是本实例(pid $API_PID)" >&2; exit 1; }
for _ in $(seq 1 20); do
  lsof -nP -iTCP:"$MOCK_PORT" -sTCP:LISTEN -t 2>/dev/null | grep -qx "$MOCK_PID" && break
  perl -e 'select(undef,undef,undef,0.25)'
done
lsof -nP -iTCP:"$MOCK_PORT" -sTCP:LISTEN -t 2>/dev/null | grep -qx "$MOCK_PID" || { echo "假模型接口没起来:看 $LOGS/mock.log" >&2; exit 1; }
for _ in $(seq 1 20); do
  grep -q '"ready":true' "$LOGS/proxyhost.log" 2>/dev/null && break
  perl -e 'select(undef,undef,undef,0.25)'
done
grep -q '"ready":true' "$LOGS/proxyhost.log" || echo "[r151a] ⚠️ openai 协议代理没起来(相关用例会失败):看 $LOGS/proxyhost.log" >&2
lsof -nP -iTCP:"$PROXY_PORT" -sTCP:LISTEN -t 2>/dev/null | grep -qx "$PROXY_PID" \
  || echo "[r151a] ⚠️ 端口 $PROXY_PORT 上的监听者不是本套件起的代理(pid $PROXY_PID)" >&2
echo "[r151a] 隔离实例 http://127.0.0.1:$API_PORT(pid $API_PID,HOME=$ROOT/home);假接口 :$MOCK_PORT(pid $MOCK_PID);代理 :$PROXY_PORT(pid $PROXY_PID)"

# 4) dev server(源码直出)
( cd "$WORKTREE/client" && R151A_API_PORT="$API_PORT" R151A_UI_PORT="$UI_PORT" \
    nohup node "$WORKTREE/client/node_modules/vite/bin/vite.js" --config "$SUITE/vite.dev.config.mjs" \
    > "$LOGS/vite.log" 2>&1 & echo $! > "$LOGS/vite.pid" )
VITE_WRAPPER_PID="$(cat "$LOGS/vite.pid")"
for _ in $(seq 1 80); do
  curl -sf -m 2 "http://127.0.0.1:$UI_PORT/" >/dev/null && break
  perl -e 'select(undef,undef,undef,0.5)'
done
LISTENER="$(lsof -nP -iTCP:"$UI_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)"
if [ -n "$LISTENER" ] && ps -p "$LISTENER" -o command= | grep -q "r151a-auto-audit"; then
  VITE_PID="$LISTENER"
else
  echo "dev server 没起来或端口 $UI_PORT 上不是本套件的进程:看 $LOGS/vite.log" >&2; exit 1
fi
echo "[r151a] dev server http://127.0.0.1:$UI_PORT(pid $VITE_PID;/api、/ws 代理到 $API_PORT)"

cd "$WORKTREE"
set +e
R151A_UI_BASE="http://127.0.0.1:$UI_PORT" R151A_API_BASE="http://127.0.0.1:$API_PORT" R151A_CTL="$CTL" \
R151A_MOCK_BASE="http://127.0.0.1:$MOCK_PORT" R151A_PROXY_BASE="http://127.0.0.1:$PROXY_PORT" \
  npx playwright test -c "$SUITE/playwright.config.mjs" "$@"
CODE=$?
set -e
echo "[r151a] playwright 退出码 $CODE(实例 $API_PID / 假接口 $MOCK_PID / 代理 $PROXY_PID / dev server $VITE_PID;数据在 $ROOT)"
exit $CODE
