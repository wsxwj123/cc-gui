#!/usr/bin/env bash
# r151q 评审修复 —— 验收,一条命令:
#   tests/acceptance/r151q-review-fixes/run.sh               # 全量(25 条)
#   tests/acceptance/r151q-review-fixes/run.sh -g 'Q01|Q02'  # 额外参数原样转给 playwright
# 结构照 r151g run.sh:共享实例(假 claude 外壳 + 假模型接口)+ vite dev server 供界面用例;
# 一次性实例由用例自己起停。playwright 的 JSON 报告写 .artifacts/last-run.json。
# 端口只在 6700–6999 挑空闲的;收进程只按自己记录的 pid(并核对命令行),不 pkill。
set -euo pipefail
SUITE="$(cd "$(dirname "$0")" && pwd)"
P1="$(cd "$SUITE/../r151b-xsession-p1" && pwd)"
WORKTREE="$(cd "$SUITE/../../.." && pwd)"
ROOT="$SUITE/.artifacts/runs/$(date +%Y%m%d-%H%M%S)-$$"
LOGS="$ROOT/logs"
mkdir -p "$LOGS" "$ROOT/tmp" "$ROOT/proxy"
export R151B_DATA_ROOT="$ROOT"
export R151Q_PW_JSON="$SUITE/.artifacts/last-run.json"
export R151Q_VITE_CACHE="$ROOT/vite-cache"
export R151Q_ART="$ROOT"

pick_port() {
  local exclude=" $* " port
  for port in $(seq 6700 6999); do
    case "$port" in 6677|6689|6710|8788|8789|8798|8799|8000) continue ;; esac
    case "$exclude" in *" $port "*) continue ;; esac
    if ! lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then echo "$port"; return 0; fi
  done
  echo "6700-6999 没有空闲端口" >&2; return 1
}
API_PORT="$(pick_port)"; UI_PORT="$(pick_port "$API_PORT")"; MOCK_PORT="$(pick_port "$API_PORT" "$UI_PORT")"
export R151B_MOCK_BASE="http://127.0.0.1:$MOCK_PORT"

node "$P1/helpers/fixtures.mjs"
node "$SUITE/helpers/shim-q.mjs"
CTL="$ROOT/home/fake-claude"
export R151B_CTL="$CTL"

PIDS=(); VITE_PID=""; VITE_WRAPPER_PID=""
kill_if_ours() {  # $1 pid $2 信号;命令行不是本套件/本工作树的进程一律不动
  local cmd; cmd="$(ps -p "$1" -o command= 2>/dev/null || true)"
  case "$cmd" in *r151q-review-fixes*|*"$WORKTREE/server/index.js"*) kill "-$2" "$1" 2>/dev/null || true ;; esac
}
cleanup() {
  local f d pid fake=()
  for f in "$CTL/spawn.jsonl" "$ROOT"/inst/*/home/fake-claude/spawn.jsonl; do
    [ -f "$f" ] || continue
    d="$(dirname "$f")"; mkdir -p "$d/r151f/release" 2>/dev/null || true
    while IFS= read -r pid; do
      [ -n "$pid" ] || continue
      fake+=("$pid"); : > "$d/r151f/release/$pid" 2>/dev/null || true
    done < <(node -e 'const fs=require("fs");try{for(const l of fs.readFileSync(process.argv[1],"utf8").split("\n")){try{const o=JSON.parse(l);if(o&&o.pid)console.log(o.pid)}catch{}}}catch{}' "$f")
  done
  [ -n "$VITE_PID" ] && kill "$VITE_PID" 2>/dev/null || true
  [ -n "$VITE_WRAPPER_PID" ] && kill "$VITE_WRAPPER_PID" 2>/dev/null || true
  for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done
  if [ -f "$ROOT/instance-pids.txt" ]; then while IFS= read -r pid; do [ -n "$pid" ] && kill_if_ours "$pid" TERM; done < "$ROOT/instance-pids.txt"; fi
  for pid in "${fake[@]:-}"; do [ -n "$pid" ] && kill_if_ours "$pid" TERM; done
  sleep 1
  for pid in "${fake[@]:-}"; do [ -n "$pid" ] && kill_if_ours "$pid" KILL; done
  if [ -f "$ROOT/instance-pids.txt" ]; then while IFS= read -r pid; do [ -n "$pid" ] && kill_if_ours "$pid" KILL; done < "$ROOT/instance-pids.txt"; fi
}
trap cleanup EXIT

nohup node "$SUITE/helpers/mock-q.mjs" "$MOCK_PORT" "$ROOT/mock" > "$LOGS/mock.log" 2>&1 &
MOCK_PID=$!; PIDS+=("$MOCK_PID")
cd "$ROOT"
env -i PATH="$ROOT/fakebin:$PATH" HOME="$ROOT/home" USERPROFILE="$ROOT/home" USER="${USER:-tester}" LOGNAME="${LOGNAME:-tester}" \
  SHELL=/bin/sh LANG=en_US.UTF-8 TMPDIR="$ROOT/tmp" PORT="$API_PORT" CGUI_FAKE_CLAUDE_DIR="$CTL" CGUI_DISABLE_FILE_WATCHER=1 \
  nohup node "$WORKTREE/server/index.js" > "$LOGS/server.log" 2>&1 &
API_PID=$!; PIDS+=("$API_PID")
for _ in $(seq 1 60); do curl -sf -m 2 "http://127.0.0.1:$API_PORT/api/health" >/dev/null && break; perl -e 'select(undef,undef,undef,0.5)'; done
kill -0 "$API_PID" 2>/dev/null || { echo "实例进程已退出:看 $LOGS/server.log" >&2; exit 1; }
lsof -nP -iTCP:"$API_PORT" -sTCP:LISTEN -t 2>/dev/null | grep -qx "$API_PID" || { echo "端口 $API_PORT 上的监听者不是本实例" >&2; exit 1; }
for _ in $(seq 1 20); do lsof -nP -iTCP:"$MOCK_PORT" -sTCP:LISTEN -t 2>/dev/null | grep -qx "$MOCK_PID" && break; perl -e 'select(undef,undef,undef,0.25)'; done
lsof -nP -iTCP:"$MOCK_PORT" -sTCP:LISTEN -t 2>/dev/null | grep -qx "$MOCK_PID" || { echo "假模型接口没起来:看 $LOGS/mock.log" >&2; exit 1; }
echo "[r151q] 共享实例 http://127.0.0.1:$API_PORT(pid $API_PID,HOME=$ROOT/home);假接口 :$MOCK_PORT(pid $MOCK_PID)"

( cd "$WORKTREE/client" && R151B_API_PORT="$API_PORT" R151B_UI_PORT="$UI_PORT" R151Q_VITE_CACHE="$R151Q_VITE_CACHE" \
    nohup node "$WORKTREE/client/node_modules/vite/bin/vite.js" --config "$SUITE/vite.dev.config.mjs" > "$LOGS/vite.log" 2>&1 & echo $! > "$LOGS/vite.pid" )
VITE_WRAPPER_PID="$(cat "$LOGS/vite.pid")"
for _ in $(seq 1 100); do curl -sf -m 2 "http://127.0.0.1:$UI_PORT/" >/dev/null && break; perl -e 'select(undef,undef,undef,0.5)'; done
LISTENER="$(lsof -nP -iTCP:"$UI_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)"
if [ -n "$LISTENER" ] && ps -p "$LISTENER" -o command= | grep -q "r151q-review-fixes"; then VITE_PID="$LISTENER"
else echo "dev server 没起来或端口 $UI_PORT 上不是本套件的进程:看 $LOGS/vite.log" >&2; exit 1; fi
echo "[r151q] dev server http://127.0.0.1:$UI_PORT(pid $VITE_PID)"

cd "$WORKTREE"
set +e
R151B_UI_BASE="http://127.0.0.1:$UI_PORT" R151B_API_BASE="http://127.0.0.1:$API_PORT" \
  "$WORKTREE/node_modules/.bin/playwright" test -c "$SUITE/playwright.config.mjs" "$@"
CODE=$?
set -e
echo "[r151q] playwright 退出码 $CODE(JSON:$R151Q_PW_JSON;数据在 $ROOT)"
exit $CODE
