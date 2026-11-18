#!/usr/bin/env bash
# 一条命令跑整套 r195 用例:自己起隔离后端(不起 Vite、不开页面),跑完只杀自己记录的 pid。
#
#   bash tests/acceptance/r195-trim-keep-titles/run-isolated.sh                          # 全量
#   bash .../run-isolated.sh -g '^1 '                                                   # 额外参数原样转给 playwright
#   PLAYWRIGHT_JSON_OUTPUT_NAME=/x/y.json bash .../run-isolated.sh --reporter=line,json  # 调用方自己指定 json 结果文件
#
# 端口:后端 6965(写死;6951–6954 是 r194 套件的,6961 / 6962 是 r197 的);启动前用 lsof 确认空闲,被占就退出。硬拒 6677 / 6689 / 6710 / 8788 / 8789 / 8798 / 8799。
# 隔离:HOME / USERPROFILE / CU_TEST_HOME 都指到 .artifacts/runtime-data/home;后端带 tests/unit/q8-helpers/cu-preload.mjs;
#       CGUI_DISABLE_FILE_WATCHER=1;PATH 最前面挂假 claude;ANTHROPIC_* / CLAUDE_CODE_OAUTH_TOKEN 剥掉;CU_ALLOW_* 一律 unset。
# 收尾:kill 只按 .artifacts/pids 里记录的 pid(先温和、再对仍存活的强制),不 pkill、不按端口或进程名杀。收到 INT/TERM 清理并退出。
# 输出:完整输出另存 .artifacts/run.log;结束打印通过 / 失败 / 跳过计数;退出码 = Playwright 的退出码。
# 本套件不要和别的验收套件同时运行,也不要同时跑两份。
set -euo pipefail

SUITE="$(cd "$(dirname "$0")" && pwd)"
WORKTREE="$(cd "$SUITE/../../.." && pwd)"
ART="$SUITE/.artifacts"
ROOT="$ART/runtime-data"
PIDFILE="$ART/pids"
BPORT=6965
case " 6677 6689 6710 8788 8789 8798 8799 " in *" $BPORT "*) echo "拒绝端口 $BPORT" >&2; exit 1;; esac
[ -z "$(lsof -nP -iTCP:"$BPORT" -sTCP:LISTEN -t 2>/dev/null || true)" ] || { echo "端口 $BPORT 已被占用,不抢,退出" >&2; exit 1; }

for v in $(env | sed -n 's/^\(CU_ALLOW_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done

mkdir -p "$ART"
node "$SUITE/helpers/setup.mjs"
: > "$PIDFILE"

cleanup() {
  local name pid i alive
  [ -f "$PIDFILE" ] || return 0
  while read -r name pid; do [ -n "${pid:-}" ] && kill "$pid" 2>/dev/null || true; done < "$PIDFILE"
  for i in 1 2 3 4 5 6 7 8 9 10; do
    alive=0
    while read -r name pid; do if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then alive=1; fi; done < "$PIDFILE"
    [ "$alive" = 0 ] && break
    sleep 0.5
  done
  while read -r name pid; do if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" 2>/dev/null || true; fi; done < "$PIDFILE"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cd "$ROOT"
env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_MODEL -u ANTHROPIC_API_KEY \
  -u CLAUDE_CODE_OAUTH_TOKEN \
  HOME="$ROOT/home" USERPROFILE="$ROOT/home" CU_TEST_HOME="$ROOT/home" PORT="$BPORT" \
  PATH="$ART/fakebin:$PATH" \
  CGUI_DISABLE_FILE_WATCHER=1 \
  nohup node --import "$WORKTREE/tests/unit/q8-helpers/cu-preload.mjs" "$WORKTREE/server/index.js" > "$ROOT/server.log" 2>&1 &
echo "backend $!" >> "$PIDFILE"

for _ in $(seq 1 60); do
  curl -sf -m 2 "http://127.0.0.1:$BPORT/api/health" >/dev/null && break
  sleep 0.5
done
curl -sf -m 2 "http://127.0.0.1:$BPORT/api/health" >/dev/null \
  || { echo "后端起不来(端口 $BPORT):看 $ROOT/server.log" >&2; exit 1; }
echo "[R195] 隔离后端就绪:127.0.0.1:$BPORT(数据根 $ROOT;pids 记在 $PIDFILE)"

cd "$WORKTREE"
export PLAYWRIGHT_JSON_OUTPUT_NAME="${PLAYWRIGHT_JSON_OUTPUT_NAME:-$ART/results.json}"
node -e 'try{require("fs").unlinkSync(process.argv[1])}catch{}' "$PLAYWRIGHT_JSON_OUTPUT_NAME"
set +e
R195_BACKEND_PORT="$BPORT" npx playwright test -c "$SUITE/playwright.config.mjs" "$@" 2>&1 | tee "$ART/run.log"
RC="${PIPESTATUS[0]}"
set -e
node "$SUITE/helpers/summary.mjs" "$PLAYWRIGHT_JSON_OUTPUT_NAME" || true
exit "$RC"
