#!/usr/bin/env bash
# r151k 会话常驻 + 提问卡不再被看门狗误杀 —— 验收,一条命令:
#   tests/acceptance/r151k-session-liveness/run.sh                 # 全量
#   tests/acceptance/r151k-session-liveness/run.sh -g 'K1'         # 额外参数原样转给 playwright
# 结构照 r151h run.sh:建隔离 HOME + 假模型接口(K5 的真 CLI 车道要用),每条用例各起一次性实例
# (临时 HOME、自挑端口、用例自己 stop),不需要共享实例和 dev server。
# 端口只在 6700–6999 里挑空闲的,硬拒 6677 / 6689 / 6710。收尾只按自己记录 / 本套件夹具记录里的 pid 收进程。
set -euo pipefail

SUITE="$(cd "$(dirname "$0")" && pwd)"
P1="$(cd "$SUITE/../r151b-xsession-p1" && pwd)"
P2="$(cd "$SUITE/../r151c-xsession-p2" && pwd)"
WORKTREE="$(cd "$SUITE/../../.." && pwd)"
ROOT="$SUITE/.artifacts/runs/$(date +%Y%m%d-%H%M%S)-$$"
LOGS="$ROOT/logs"
mkdir -p "$LOGS" "$ROOT/tmp"
export R151B_DATA_ROOT="$ROOT"
# 不让本机环境里残留的联调变量影响套件:K1/K2 用 1500 的静默阈值,K3 用 1500 的空闲窗口,
# 都由用例经 startInstanceP2 的 envExtra 显式给;默认阈值用例(K2 的相邻回归/ K3 的 never 段)不要被外部改。
unset CGUI_STALL_MS CGUI_KEEPALIVE_IDLE_MS

pick_port() {
  local exclude=" $* " port
  for port in $(seq 6700 6999); do
    case "$port" in 6677|6689|6710) continue ;; esac
    case "$exclude" in *" $port "*) continue ;; esac
    if ! lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then echo "$port"; return 0; fi
  done
  echo "6700-6999 没有空闲端口" >&2; return 1
}
MOCK_PORT="$(pick_port)"
export R151B_MOCK_BASE="http://127.0.0.1:$MOCK_PORT"

node "$P1/helpers/fixtures.mjs"
node "$SUITE/helpers/shim-k.mjs"

PIDS=()
# 只收本套件记录里的 pid:一次性实例的 node server(index.js)记在 instance-pids.txt,
# 假 CLI / 真 CLI 记在各自实例的 fake-claude/spawn.jsonl(只读本套件数据根)。
recorded_pids() {
  {
    [ -f "$ROOT/instance-pids.txt" ] && cat "$ROOT/instance-pids.txt"
    for f in "$ROOT"/inst/*/home/fake-claude/spawn.jsonl; do
      [ -f "$f" ] || continue
      node -e 'const fs=require("fs");try{for(const l of fs.readFileSync(process.argv[1],"utf8").split("\n")){if(!l.trim())continue;try{const o=JSON.parse(l);if(o&&o.pid)console.log(o.pid)}catch{}}}catch{}' "$f" || true
    done
  } | sort -un
}
cleanup() {
  local p
  for p in $(recorded_pids); do kill "$p" 2>/dev/null || true; done
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  sleep 1
  for p in $(recorded_pids); do kill -9 "$p" 2>/dev/null || true; done
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill -9 "$p" 2>/dev/null || true; done
}
trap cleanup EXIT

nohup node "$P2/helpers/mock-p2.mjs" "$MOCK_PORT" "$ROOT/mock" > "$LOGS/mock.log" 2>&1 &
MOCK_PID=$!; PIDS+=("$MOCK_PID")
for _ in $(seq 1 20); do
  lsof -nP -iTCP:"$MOCK_PORT" -sTCP:LISTEN -t 2>/dev/null | grep -qx "$MOCK_PID" && break
  perl -e 'select(undef,undef,undef,0.25)'
done
lsof -nP -iTCP:"$MOCK_PORT" -sTCP:LISTEN -t 2>/dev/null | grep -qx "$MOCK_PID" || { echo "假模型接口没起来:看 $LOGS/mock.log" >&2; exit 1; }
echo "[r151k] 假接口 http://127.0.0.1:$MOCK_PORT(pid $MOCK_PID;K5 的真 CLI 车道用它,其余用例走假 CLI)"
echo "[r151k] 数据根 $ROOT"

cd "$WORKTREE"
set +e
R151B_MOCK_BASE="http://127.0.0.1:$MOCK_PORT" R151B_DATA_ROOT="$ROOT" \
  npx playwright test -c "$SUITE/playwright.config.mjs" "$@"
CODE=$?
set -e
echo "[r151k] playwright 退出码 $CODE(假接口 $MOCK_PID;数据在 $ROOT)"
exit $CODE
