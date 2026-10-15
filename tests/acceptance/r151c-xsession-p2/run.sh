#!/usr/bin/env bash
# r151c 跨会话消息二期 —— 验收,一条命令:
#   tests/acceptance/r151c-xsession-p2/run.sh                 # 全量
#   tests/acceptance/r151c-xsession-p2/run.sh -g 'P09'        # 额外参数原样转给 playwright
# 结构照搬一期 run.sh:建夹具(临时 HOME,用一期 helpers/fixtures.mjs)→ 换成二期 claude 垫片 → 起本地假模型接口(二期 mock-p2.mjs)
# → 起共享隔离实例(env -i 从零给环境)→ 起 dev server → 跑用例 → 按记录的 pid 收掉自己起的进程。
# 端口只在 6700–6999 里挑空闲的,硬拒 6677 / 6689 / 6710。环境变量名沿用一期(R151B_*),一期 helpers/ 可直接复用。
set -euo pipefail

SUITE="$(cd "$(dirname "$0")" && pwd)"
P1="$(cd "$SUITE/../r151b-xsession-p1" && pwd)"
WORKTREE="$(cd "$SUITE/../../.." && pwd)"
ROOT="$SUITE/.artifacts/runs/$(date +%Y%m%d-%H%M%S)-$$"
LOGS="$ROOT/logs"
mkdir -p "$LOGS" "$ROOT/tmp"
export R151B_DATA_ROOT="$ROOT"

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
export R151B_MOCK_BASE="http://127.0.0.1:$MOCK_PORT"

node "$P1/helpers/fixtures.mjs"
node "$SUITE/helpers/shim-p2.mjs"
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

nohup node "$SUITE/helpers/mock-p2.mjs" "$MOCK_PORT" "$ROOT/mock" > "$LOGS/mock.log" 2>&1 &
MOCK_PID=$!; PIDS+=("$MOCK_PID")

cd "$ROOT"
env -i PATH="$ROOT/fakebin:$PATH" HOME="$ROOT/home" USERPROFILE="$ROOT/home" USER="${USER:-tester}" LOGNAME="${LOGNAME:-tester}" \
  SHELL=/bin/sh LANG=en_US.UTF-8 TMPDIR="$ROOT/tmp" PORT="$API_PORT" \
  CGUI_FAKE_CLAUDE_DIR="$CTL" CGUI_DISABLE_FILE_WATCHER=1 \
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
echo "[r151c] 共享实例 http://127.0.0.1:$API_PORT(pid $API_PID,HOME=$ROOT/home);假接口 :$MOCK_PORT(pid $MOCK_PID)"

( cd "$WORKTREE/client" && R151B_API_PORT="$API_PORT" R151B_UI_PORT="$UI_PORT" \
    nohup node "$WORKTREE/client/node_modules/vite/bin/vite.js" --config "$SUITE/vite.dev.config.mjs" \
    > "$LOGS/vite.log" 2>&1 & echo $! > "$LOGS/vite.pid" )
VITE_WRAPPER_PID="$(cat "$LOGS/vite.pid")"
for _ in $(seq 1 80); do
  curl -sf -m 2 "http://127.0.0.1:$UI_PORT/" >/dev/null && break
  perl -e 'select(undef,undef,undef,0.5)'
done
LISTENER="$(lsof -nP -iTCP:"$UI_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)"
if [ -n "$LISTENER" ] && ps -p "$LISTENER" -o command= | grep -q "r151c-xsession-p2"; then
  VITE_PID="$LISTENER"
else
  echo "dev server 没起来或端口 $UI_PORT 上不是本套件的进程:看 $LOGS/vite.log" >&2; exit 1
fi
echo "[r151c] dev server http://127.0.0.1:$UI_PORT(pid $VITE_PID;/api、/ws 代理到 $API_PORT)"

cd "$WORKTREE"
set +e
R151B_UI_BASE="http://127.0.0.1:$UI_PORT" R151B_API_BASE="http://127.0.0.1:$API_PORT" R151B_CTL="$CTL" \
  npx playwright test -c "$SUITE/playwright.config.mjs" "$@"
CODE=$?
set -e
echo "[r151c] playwright 退出码 $CODE(实例 $API_PID / 假接口 $MOCK_PID / dev server $VITE_PID;数据在 $ROOT)"
exit $CODE
