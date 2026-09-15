#!/usr/bin/env bash
# U9:既有套件不回归(pricing-usage-20260911 / theme-usage-20260912 / slowload-20260912)。
#
#   ./u9-regression.sh
#   U9_ONLY=slowload-20260912 ./u9-regression.sh   # 只跑其中一个(返工时省 4 分钟)
#   U9_TU_GREP=            ./u9-regression.sh    # theme-usage 跑全量(默认只跑 TU-5 用量卡那组)
#
# 为什么要在 /tmp 复印件里跑:本套件不许改其它套件目录一个字节,而它们跑起来会往自己的
# .artifacts 写夹具与日志。所以先把套件抄到 /tmp,再把 worktree 顶层逐项软链过去,
# 让它们 `$SUITE/../../..` 仍能解析到真实的 server/client/node_modules。
#
# 端口:沿用各套件自己的挑端口逻辑(它们都硬拒 6677/6689)。
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORKTREE="$(cd "$HERE/../../.." && pwd)"
STAGE="/tmp/usg-u9-$(date +%s)-$$"
SUITES=(pricing-usage-20260911 theme-usage-20260912 slowload-20260912)
if [ -n "${U9_ONLY:-}" ]; then
  IFS=',' read -r -a SUITES <<< "${U9_ONLY}"
fi
TU_GREP="${U9_TU_GREP---grep TU-5}"
FAILED=0

echo "[u9] worktree=$WORKTREE"
echo "[u9] 复印件根=$STAGE(跑完不删,留着看日志)"

for name in "${SUITES[@]}"; do
  SRC="$WORKTREE/tests/acceptance/$name"
  RUNNER="$SRC/run-isolated.sh"
  echo ""
  echo "──── U9/$name ────"
  if [ ! -f "$RUNNER" ]; then
    echo "[u9] $name: 不可运行 —— 套件本体不在(没有 run-isolated.sh;目录内实际只有:$(ls -A "$SRC" 2>/dev/null | tr '\n' ' '))"
    FAILED=1
    continue
  fi
  DST="$STAGE/$name"
  mkdir -p "$DST/tests/acceptance"
  for e in "$WORKTREE"/*; do
    b="$(basename "$e")"
    [ "$b" = "tests" ] && continue
    ln -s "$e" "$DST/$b"
  done
  for other in "$WORKTREE"/tests/acceptance/*; do
    b="$(basename "$other")"
    [ "$b" = "$name" ] && continue
    ln -s "$other" "$DST/tests/acceptance/$b"
  done
  rsync -a --exclude '.artifacts' "$SRC/" "$DST/tests/acceptance/$name/"
  LOG="$STAGE/$name.log"
  echo "[u9] 跑 $DST/tests/acceptance/$name/run-isolated.sh"
  ( cd "$DST/tests/acceptance/$name" && ./run-isolated.sh $TU_GREP ) > "$LOG" 2>&1
  CODE=$?
  tail -n 12 "$LOG" | sed 's/^/    /'
  if [ $CODE -eq 0 ]; then
    echo "[u9] $name: 绿(退出码 0,完整输出 $LOG)"
  else
    echo "[u9] $name: 红(退出码 $CODE,完整输出 $LOG)"
    FAILED=1
  fi
done

echo ""
if [ $FAILED -eq 0 ]; then
  echo "[u9] 三个套件全部绿"
else
  echo "[u9] 有套件红或不可运行 —— 逐行看上面(不可运行 ≠ 跳过,已计为红)"
fi
exit $FAILED
