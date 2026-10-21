#!/usr/bin/env bash
# r151n 分屏图标化 / 粘贴乱码还原 —— 补验收,一条命令:
#   tests/acceptance/r151n-ui-fixes/run.sh                # 全量
#   tests/acceptance/r151n-ui-fixes/run.sh -g 'S1'        # 额外参数原样转给 playwright
# 结构照 r151l-history-pagination/run.sh(隔离实例 + vite dev server,供界面用例用)。
# 种子会话由 helpers/fixtures.mjs 直写 jsonl;收尾只按自己记录的 pid 收进程。
# 端口只在 6700–6999 里挑空闲的,硬拒 6677 / 6689 / 6710(以及 8798/8799/8000)。
set -euo pipefail

SUITE="$(cd "$(dirname "$0")" && pwd)"
WORKTREE="$(cd "$SUITE/../../.." && pwd)"
ROOT="$SUITE/.artifacts/runs/$(date +%Y%m%d-%H%M%S)-$$"
LOGS="$ROOT/logs"
mkdir -p "$LOGS" "$ROOT/tmp"
export R151N_DATA_ROOT="$ROOT"

pick_port() {
  local exclude=" $* " port
  for port in $(seq 6700 6999); do
    case "$port" in 6677|6689|6710|8788|8789|8798|8799|8000) continue ;; esac
    case "$exclude" in *" $port "*) continue ;; esac
    if ! lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then echo "$port"; return 0; fi
  done
  echo "6700-6999 没有空闲端口" >&2; return 1
}
API_PORT="$(pick_port)"
UI_PORT="$(pick_port "$API_PORT")"
export R151N_API_PORT="$API_PORT" R151N_UI_PORT="$UI_PORT" R151N_UI_BASE="http://127.0.0.1:$UI_PORT" R151N_API_BASE="http://127.0.0.1:$API_PORT"

node "$SUITE/helpers/fixtures.mjs"
CTL="$ROOT/home/fake-claude"
export R151N_CTL="$CTL"
export R151N_SEED_FILE="$ROOT/seed.json"
export R151N_VITE_CACHE="$ROOT/vite-cache"
export R151N_PW_JSON="$ROOT/playwright.json"

PIDS=()
API_PID=""
VITE_PID=""
cleanup() {
  [ -n "$VITE_PID" ] && kill "$VITE_PID" 2>/dev/null || true
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
}
trap cleanup EXIT

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
echo "[r151n] 隔离实例 http://127.0.0.1:$API_PORT(pid $API_PID,HOME=$ROOT/home)"

( cd "$WORKTREE/client" && env R151N_API_PORT="$API_PORT" R151N_UI_PORT="$UI_PORT" R151N_VITE_CACHE="$R151N_VITE_CACHE" \
    nohup node "$WORKTREE/client/node_modules/vite/bin/vite.js" --config "$SUITE/vite.dev.config.mjs" \
    > "$LOGS/vite.log" 2>&1 & echo $! > "$LOGS/vite.pid" )
VITE_WRAPPER_PID="$(cat "$LOGS/vite.pid")"
PIDS+=("$VITE_WRAPPER_PID")
for _ in $(seq 1 100); do
  curl -sf -m 2 "http://127.0.0.1:$UI_PORT/" >/dev/null && break
  perl -e 'select(undef,undef,undef,0.5)'
done
LISTENER="$(lsof -nP -iTCP:"$UI_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)"
if [ -n "$LISTENER" ] && ps -p "$LISTENER" -o command= | grep -q "r151n-ui-fixes"; then
  VITE_PID="$LISTENER"
else
  echo "dev server 没起来或端口 $UI_PORT 上不是本套件的进程:看 $LOGS/vite.log" >&2; exit 1
fi
echo "[r151n] dev server http://127.0.0.1:$UI_PORT(pid $VITE_PID;/api、/ws 代理到 $API_PORT)"

cd "$WORKTREE"
set +e
R151N_UI_BASE="$R151N_UI_BASE" R151N_API_BASE="$R151N_API_BASE" R151N_SEED_FILE="$R151N_SEED_FILE" R151N_CTL="$CTL" \
  R151N_PW_JSON="$R151N_PW_JSON" \
  "$WORKTREE/node_modules/.bin/playwright" test -c "$SUITE/playwright.config.mjs" "$@"
CODE=$?
set -e
echo "[r151n] playwright 退出码 $CODE(实例 $API_PID / dev server $VITE_PID;数据在 $ROOT)"
exit $CODE
