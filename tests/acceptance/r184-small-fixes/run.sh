#!/bin/bash
# r184-small-fixes 验收套件:一条命令跑完全部用例。
#   bash tests/acceptance/r184-small-fixes/run.sh
# 标准输出:每条用例一行(spec reporter)+ 末尾 tests / pass / fail / skipped 计数;有失败时退出码非 0。
# 设了 R184_JUNIT=<文件路径> 时,同时把 junit 报告写到该文件。
SUITE_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="${NODE:-/opt/homebrew/bin/node}"
[ -x "$NODE" ] || NODE="$(command -v node)"

export R184_PID_DIR="$(mktemp -d "${TMPDIR:-/tmp}/r184-pids-XXXXXX")"

# 兜底:只结束本次运行记录过 pid 的后端(各用例自己也会收尾)
cleanup() {
  for f in "$R184_PID_DIR"/pid-*; do
    [ -e "$f" ] || continue
    pid="$(cat "$f" 2>/dev/null)"
    [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
  done
}
trap cleanup EXIT

REPORTERS=(--test-reporter=spec --test-reporter-destination=stdout)
if [ -n "$R184_JUNIT" ]; then
  REPORTERS+=(--test-reporter=junit "--test-reporter-destination=$R184_JUNIT")
fi

"$NODE" --test --test-force-exit --test-concurrency=1 --test-timeout=120000 "${REPORTERS[@]}" \
  "$SUITE_DIR/p-prefs.acceptance.mjs" \
  "$SUITE_DIR/i-install-cmd.acceptance.mjs" \
  "$SUITE_DIR/u-usage.acceptance.mjs"
status=$?
exit $status
