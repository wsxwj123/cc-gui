#!/usr/bin/env bash
# 一条命令跑完 Q8(2026-09-14 代码质量抽查 13 条「重要」项)的全部复现测试:
#   tests/acceptance/quality8-20260914/run-all.sh            # 全部(约 1.5 分钟:含两条 ~20s 的超时用例与一条 ~15s 的反向用例)
#   tests/acceptance/quality8-20260914/run-all.sh --fast     # 跳过三条慢用例(cu-timeout / terminal-open-timeout / q13 验收)
# 修前预期:每个文件末尾"修前应红"一栏应为红;修后全部转绿才算修好。退出码 = 红的文件数。
set -uo pipefail
SUITE="$(cd "$(dirname "$0")" && pwd)"
WORKTREE="$(cd "$SUITE/../../.." && pwd)"
cd "$WORKTREE"

FAST=0; [ "${1:-}" = "--fast" ] && FAST=1
UNIT=(
  tests/unit/check-q8-cu-argv.mjs
  tests/unit/check-q8-cu-scope.mjs
  tests/unit/check-q8-atomic-write.mjs
  tests/unit/check-q8-pricing-retry.mjs
  tests/unit/check-q8-history-submit-race.mjs
  tests/unit/check-q8-turn-capacity.mjs
)
SLOW=(
  tests/unit/check-q8-cu-timeout.mjs
  tests/unit/check-q8-terminal-open-timeout.mjs
)
[ $FAST = 1 ] || UNIT+=("${SLOW[@]}")

FAILED=0
echo "== Q8 复现测试 $(date '+%Y-%m-%d %H:%M:%S') @ $(git rev-parse --short HEAD 2>/dev/null) =="
for f in "${UNIT[@]}"; do
  echo; echo "──── $f ────"
  node "$f"; code=$?
  [ $code -eq 0 ] || FAILED=$((FAILED+1))
  echo "→ $f 退出码 $code"
done
if [ $FAST = 0 ]; then
  echo; echo "──── tests/acceptance/quality8-20260914/run-isolated.sh (Q8-13) ────"
  "$SUITE/run-isolated.sh"; code=$?
  [ $code -eq 0 ] || FAILED=$((FAILED+1))
  echo "→ run-isolated.sh 退出码 $code"
fi
echo; echo "== Q8 总计:$FAILED 个测试文件有红 =="
exit $FAILED
