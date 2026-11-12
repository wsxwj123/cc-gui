#!/usr/bin/env bash
# r171 历史读取超时后停止读文件 —— 验收,一条命令:
#   tests/acceptance/r171-history-read-stop/run.sh
# 每个用例自己起一个一次性隔离后端(临时家目录、端口 6700–6799 里挑空闲的、禁用 6677/6689/6710/8798/8799),
# 用例内自己建命名管道与写入进程并收尾。本脚本只负责:建运行目录、跑用例、
# 最后按 pids.txt 里记录的进程号兜底收尾(只杀命令行确认是本套件起的后端 / 写入进程)。
# 不需要浏览器;不要和别的验收套件同时运行。
set -uo pipefail

SUITE="$(cd "$(dirname "$0")" && pwd)"
RUN_ROOT="$SUITE/.artifacts/runs/$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$RUN_ROOT"
export R171_RUN_ROOT="$RUN_ROOT"

cleanup() {
  [ -f "$RUN_ROOT/pids.txt" ] || return 0
  while read -r pid; do
    [ -n "$pid" ] || continue
    cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    case "$cmd" in
      *"server/index.js"*|*"fifo-writer.mjs"*) kill "$pid" 2>/dev/null || true ;;
    esac
  done < "$RUN_ROOT/pids.txt"
}
trap cleanup EXIT

echo "[r171] 运行目录 $RUN_ROOT"
node --test --test-concurrency=1 "$SUITE/history-read-stop.spec.mjs"
CODE=$?
echo "[r171] node --test 退出码 $CODE(日志与夹具在 $RUN_ROOT)"
exit $CODE
