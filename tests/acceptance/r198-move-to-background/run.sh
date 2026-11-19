#!/usr/bin/env bash
# r198 界面验收,一条命令:
#   tests/acceptance/r198-move-to-background/run.sh                 # 全量
#   tests/acceptance/r198-move-to-background/run.sh -g 'C1 '        # 额外参数原样转给 playwright
# 自己做:建夹具 → 起隔离实例(HOME=本套件 .artifacts,PATH 上挂假 claude,后端带只改 userInfo 的预加载)
#        → 起 dev server(源码直出)→ 跑用例 → 按记录的 pid 收掉这两个进程。
# 端口固定:后端 6967、页面 6968;任一已被占用就直接退出,不碰别的端口(硬拒 6677 6689 6710 8788 8789 8798 8799)。
# 本套件不要和别的验收套件同时跑,也不要同时跑两份。
set -euo pipefail

SUITE="$(cd "$(dirname "$0")" && pwd)"
WORKTREE="$(cd "$SUITE/../../.." && pwd)"
ROOT="$SUITE/.artifacts/runs/$(date +%Y%m%d-%H%M%S)-$$"
LOGS="$ROOT/logs"
mkdir -p "$LOGS"
export R198_DATA_ROOT="$ROOT"
API_PORT=6967
UI_PORT=6968

for port in "$API_PORT" "$UI_PORT"; do
  case " 6677 6689 6710 8788 8789 8798 8799 " in *" $port "*) echo "拒绝端口 $port" >&2; exit 1;; esac
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "端口 $port 已被占用,不启动" >&2; exit 1
  fi
done

# 任何 CU_ALLOW_* 一律 unset
for v in $(env | sed -n 's/^\(CU_ALLOW_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done

API_PID=""
VITE_WRAPPER_PID=""
VITE_PID=""
cleanup() {
  [ -n "$VITE_PID" ] && kill "$VITE_PID" 2>/dev/null || true
  [ -n "$VITE_WRAPPER_PID" ] && kill "$VITE_WRAPPER_PID" 2>/dev/null || true
  [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

node "$SUITE/helpers/fixtures.mjs"
CTL="$ROOT/home/fake-claude"
mkdir -p "$CTL"

cd "$ROOT"
env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_MODEL -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN \
  HOME="$ROOT/home" USERPROFILE="$ROOT/home" CU_TEST_HOME="$ROOT/home" PORT="$API_PORT" \
  PATH="$SUITE/.artifacts/fakebin:$PATH" CGUI_FAKE_CLAUDE_DIR="$CTL" CGUI_DISABLE_FILE_WATCHER=1 \
  nohup node --import "$WORKTREE/tests/unit/q8-helpers/cu-preload.mjs" "$WORKTREE/server/index.js" > "$LOGS/server.log" 2>&1 &
API_PID=$!

for _ in $(seq 1 60); do
  curl -sf -m 2 --noproxy '*' "http://127.0.0.1:$API_PORT/api/health" >/dev/null && break
  perl -e 'select(undef,undef,undef,0.5)'
done
kill -0 "$API_PID" 2>/dev/null || { echo "实例进程已退出:看 $LOGS/server.log" >&2; exit 1; }
lsof -nP -iTCP:"$API_PORT" -sTCP:LISTEN -t 2>/dev/null | grep -qx "$API_PID" \
  || { echo "端口 $API_PORT 上的监听者不是本实例(pid $API_PID)" >&2; exit 1; }
echo "[R198] 隔离实例就绪:http://127.0.0.1:$API_PORT(pid $API_PID,HOME=$ROOT/home)"

( cd "$WORKTREE/client" && R198_API_PORT="$API_PORT" R198_UI_PORT="$UI_PORT" HOME="$ROOT/home" USERPROFILE="$ROOT/home" \
    nohup node "$WORKTREE/client/node_modules/vite/bin/vite.js" --config "$SUITE/vite.dev.config.mjs" \
    > "$LOGS/vite.log" 2>&1 & echo $! > "$LOGS/vite.pid" )
VITE_WRAPPER_PID="$(cat "$LOGS/vite.pid")"
for _ in $(seq 1 80); do
  curl -sf -m 2 --noproxy '*' "http://127.0.0.1:$UI_PORT/" >/dev/null && break
  perl -e 'select(undef,undef,undef,0.5)'
done
LISTENER="$(lsof -nP -iTCP:"$UI_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)"
if [ -n "$LISTENER" ] && ps -p "$LISTENER" -o command= | grep -q "r198-move-to-background"; then
  VITE_PID="$LISTENER"
else
  echo "dev server 没起来或端口 $UI_PORT 上不是本套件的进程:看 $LOGS/vite.log" >&2; exit 1
fi
echo "[R198] dev server 就绪:http://127.0.0.1:$UI_PORT(pid $VITE_PID;/api、/ws 代理到 $API_PORT)"

cd "$WORKTREE"
# json 报告位置:调用者没指定就落在本次运行的日志目录(.artifacts 下)
export PLAYWRIGHT_JSON_OUTPUT_NAME="${PLAYWRIGHT_JSON_OUTPUT_NAME:-$LOGS/report.json}"
set +e
R198_UI_BASE="http://127.0.0.1:$UI_PORT" R198_API_BASE="http://127.0.0.1:$API_PORT" R198_CTL="$CTL" \
  npx playwright test -c "$SUITE/playwright.config.mjs" "$@"
CODE=$?
set -e
echo "[R198] playwright 退出码 $CODE(实例 pid $API_PID / dev server pid $VITE_PID)"

COUNTS="$(node -e '
  try {
    const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).stats;
    console.log(`通过 ${s.expected + (s.flaky || 0)} / 失败 ${s.unexpected} / 跳过 ${s.skipped}`);
  } catch { console.log("通过 0 / 失败 0 / 跳过 0(没读到报告)"); }
' "$PLAYWRIGHT_JSON_OUTPUT_NAME")"
echo "[R198] 计数:$COUNTS"
exit $CODE
