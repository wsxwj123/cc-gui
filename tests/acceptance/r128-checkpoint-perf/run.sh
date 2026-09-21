#!/usr/bin/env bash
# r128 「回滚点回收不拖慢消息 / 拍快照与清扫互斥 / 带 BOM 的合法 JSON 不算损坏」验收,一条命令:
#   tests/acceptance/r128-checkpoint-perf/run.sh                 # 全量(A / B / C 三组)
#   tests/acceptance/r128-checkpoint-perf/run.sh -g 'A1'         # 额外参数原样转给 playwright
# 全部是接口用例:每条用例自己起/停隔离实例(HOME=本套件 .artifacts 下,断外网预载),不起浏览器、不起 dev server。
# 端口只在 6700–6999 里挑空闲的,硬拒 6677 / 6689 / 6710。不读写真实的 ~/.claude、~/.claude-gui。
# 收尾只按用例落下的 pid 文件收(且命令行必须是本 worktree 的 server/index.js),不按进程名/端口批量杀。
set -euo pipefail

SUITE="$(cd "$(dirname "$0")" && pwd)"
WORKTREE="$(cd "$SUITE/../../.." && pwd)"
ROOT="$SUITE/.artifacts/runs/$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$ROOT"
export R128_DATA_ROOT="$ROOT"

cleanup() {
  for f in "$ROOT"/*/*/instance-*.pid; do
    [ -e "$f" ] || continue
    pid="$(cat "$f" 2>/dev/null || true)"
    case "$pid" in ''|*[!0-9]*) continue ;; esac
    if ps -p "$pid" -o command= 2>/dev/null | grep -q "$WORKTREE/server/index.js"; then kill "$pid" 2>/dev/null || true; fi
  done
}
trap cleanup EXIT

echo "[r128] 数据根:$ROOT"
cd "$WORKTREE"
set +e
npx playwright test -c "$SUITE/playwright.config.mjs" "$@"
CODE=$?
set -e
echo "[r128] playwright 退出码 $CODE(产物在 $ROOT)"
exit $CODE
