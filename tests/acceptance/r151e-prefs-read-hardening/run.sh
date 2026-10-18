#!/usr/bin/env bash
# r151e 偏好文件读失败加固 —— 验收,一条命令:
#   tests/acceptance/r151e-prefs-read-hardening/run.sh          # 全量
#   tests/acceptance/r151e-prefs-read-hardening/run.sh -g 'E12'  # 额外参数原样转给 playwright
# 结构照搬 r151d run.sh;区别:本套件没有界面用例、每条用例自起一次性实例,所以不起共享实例和 dev server;
# claude 垫片换成本套件的 shim-e.mjs(二期垫片 + 可让指定进程吞掉切档请求的假 claude 外壳),假模型接口直接用 r151c 的 mock-p2.mjs。
# 端口只在 6700–6999 里挑空闲的,硬拒 6677 / 6689 / 6710。收尾只按记录的 pid 收自己起的假模型接口(一次性实例由用例自己停)。
set -euo pipefail

SUITE="$(cd "$(dirname "$0")" && pwd)"
P1="$(cd "$SUITE/../r151b-xsession-p1" && pwd)"
P2="$(cd "$SUITE/../r151c-xsession-p2" && pwd)"
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
MOCK_PORT="$(pick_port)"
export R151B_MOCK_BASE="http://127.0.0.1:$MOCK_PORT"

node "$P1/helpers/fixtures.mjs"
node "$SUITE/helpers/shim-e.mjs"

PIDS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
}
trap cleanup EXIT

nohup node "$P2/helpers/mock-p2.mjs" "$MOCK_PORT" "$ROOT/mock" > "$LOGS/mock.log" 2>&1 &
MOCK_PID=$!; PIDS+=("$MOCK_PID")
for _ in $(seq 1 20); do
  lsof -nP -iTCP:"$MOCK_PORT" -sTCP:LISTEN -t 2>/dev/null | grep -qx "$MOCK_PID" && break
  perl -e 'select(undef,undef,undef,0.25)'
done
lsof -nP -iTCP:"$MOCK_PORT" -sTCP:LISTEN -t 2>/dev/null | grep -qx "$MOCK_PID" || { echo "假模型接口没起来:看 $LOGS/mock.log" >&2; exit 1; }
echo "[r151e] 假模型接口 :$MOCK_PORT(pid $MOCK_PID);数据根 $ROOT"

cd "$WORKTREE"
set +e
npx playwright test -c "$SUITE/playwright.config.mjs" "$@"
CODE=$?
set -e
echo "[r151e] playwright 退出码 $CODE(假接口 $MOCK_PID;数据在 $ROOT)"
exit $CODE
