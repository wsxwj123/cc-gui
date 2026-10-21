#!/usr/bin/env bash
# r151m 第三方 provider 下 claude 模型名兜底映射 —— 黑盒验收,一条命令:
#   tests/acceptance/r151m-model-fallback/run.sh            # 行为清单 1–10 全量
#   tests/acceptance/r151m-model-fallback/run.sh 1 4 6      # 只跑指定用例(调试用)
#
# 结构:本脚本只负责建产物目录 / 调 spec.mjs / 收自己记录的 pid / 核对端口;
# 每条用例由 spec.mjs 单独 spawn 一个 node 进程,进程内起假上游和代理,退出即释放监听端口。
# 端口只在 6700–6999 里挑,硬拒 6677/6689/6710/8788/8789/8798/8799/8000。
# 收进程只按本套件 .artifacts 里记录的 pid(并核对命令行含本套件路径),不用 pkill -f。
set -uo pipefail

# 不让本机残留的 provider 环境变量影响“default/models 都缺”等用例的判定。
unset OPENAI_MODEL OPENAI_BASE_URL OPENAI_API_KEY \
      ANTHROPIC_MODEL ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY

SUITE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SUITE/../../.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
ROOT="$SUITE/.artifacts/runs/$STAMP-$$"
OUT="$ROOT/run-output.txt"
RAW_COPY="$REPO/.devflow/test-output-r151m-step1.txt"
mkdir -p "$ROOT" "$REPO/.devflow"
export R151M_ARTIFACT_DIR="$ROOT"

recorded_pids() {
  local f p
  for f in "$ROOT"/*.pid; do
    [ -f "$f" ] || continue
    p="$(tr -dc '0-9' < "$f" 2>/dev/null || true)"
    [ -n "$p" ] && echo "$p"
  done | sort -un
}

kill_recorded() {
  local sig="$1" p cmd
  for p in $(recorded_pids); do
    cmd="$(ps -p "$p" -o command= 2>/dev/null || true)"
    case "$cmd" in
      *"$SUITE"*) kill "-$sig" "$p" 2>/dev/null || true ;;
    esac
  done
}

cleanup() {
  local code=$?
  trap - EXIT INT TERM
  kill_recorded TERM
  if [ -n "$(recorded_pids)" ]; then
    sleep 0.3
    kill_recorded KILL
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

echo "[r151m] 仓库 $REPO"
echo "[r151m] 产物目录 $ROOT"
echo "[r151m] 原始输出 $OUT"
echo "[r151m] 端口范围 6700–6999;不碰 6677/6689/6710/8788/8789/8798/8799/8000"

node "$SUITE/spec.mjs" "$@" 2>&1 | tee "$OUT"
CODE=${PIPESTATUS[0]}

# 端口核对:只检查本套件自己记录过的端口;若监听者仍是本套件记录过的 pid,先收掉。
LEFTOVER=0
CHECK_LOG="$ROOT/port-check.txt"
: > "$CHECK_LOG"
if [ -f "$ROOT/ports.txt" ]; then
  while read -r cid kind port; do
    [ -n "${port:-}" ] || continue
    LPID="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
    if [ -n "$LPID" ]; then
      LEFTOVER=1
      echo "LEFTOVER case=$cid kind=$kind port=$port pid=$LPID" | tee -a "$CHECK_LOG"
      if recorded_pids | grep -qx "$LPID"; then
        kill "$LPID" 2>/dev/null || true
        sleep 0.2
        kill -9 "$LPID" 2>/dev/null || true
        echo "CLEANED port=$port pid=$LPID(本套件记录 pid)" | tee -a "$CHECK_LOG"
      fi
    else
      echo "OK case=$cid kind=$kind port=$port 已释放" >> "$CHECK_LOG"
    fi
  done < "$ROOT/ports.txt"
else
  echo "WARN 没有 ports.txt(用例可能全部启动失败)" | tee -a "$CHECK_LOG"
fi

if [ "$LEFTOVER" -ne 0 ]; then
  echo "[r151m] 端口核对发现残留监听,详见 $CHECK_LOG" >&2
  if [ "$CODE" -eq 0 ]; then CODE=1; fi
else
  echo "[r151m] 端口核对:本套件记录的端口全部已释放"
fi
cat "$CHECK_LOG" >> "$OUT"

cp "$OUT" "$RAW_COPY"
echo "[r151m] 退出码 $CODE;原始输出已复制到 $RAW_COPY"
exit "$CODE"
