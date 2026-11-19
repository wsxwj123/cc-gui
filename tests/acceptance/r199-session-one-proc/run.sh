#!/usr/bin/env bash
# r199 一个会话同一时刻只有一个命令行进程 —— 验收,一条命令:
#   tests/acceptance/r199-session-one-proc/run.sh                 # 全量
#   tests/acceptance/r199-session-one-proc/run.sh -g 'A1'        # 额外参数原样转给 playwright
# 自己做:建夹具 → 起隔离实例(HOME=本套件 .artifacts,PATH 上挂假 claude)→ 起 dev server(源码直出)→ 跑用例 → 按记录的 pid 收进程。
# 端口固定:后端 6971、页面 6972;任一已被占用就直接退出,不碰别的端口。
set -euo pipefail

SUITE="$(cd "$(dirname "$0")" && pwd)"
WORKTREE="$(cd "$SUITE/../../.." && pwd)"
ROOT="$SUITE/.artifacts/runs/$(date +%Y%m%d-%H%M%S)-$$"
LOGS="$ROOT/logs"
mkdir -p "$LOGS" "$ROOT/tmp"
export R199_DATA_ROOT="$ROOT"
API_PORT=6971
UI_PORT=6972

for port in "$API_PORT" "$UI_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "端口 $port 已被占用,不启动" >&2; exit 1
  fi
done

node "$SUITE/helpers/fixtures.mjs"
CTL="$ROOT/home/fake-claude"
export R199_CTL="$CTL"

API_PID=""
VITE_WRAPPER_PID=""
VITE_PID=""
cleanup() {
  # 只收本套件夹具记录里的假 claude 进程(不按端口 / 名字批量杀)
  if [ -f "$CTL/spawn.jsonl" ]; then
    while IFS= read -r pid; do
      [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null || true
    done <<EOT
$(node -e 'const fs=require("fs");try{for(const l of fs.readFileSync(process.argv[1],"utf8").split("\n")){if(!l.trim())continue;try{const o=JSON.parse(l);if(o&&o.pid)console.log(o.pid)}catch{}}}catch{}' "$CTL/spawn.jsonl")
EOT
  fi
  [ -n "$VITE_PID" ] && kill "$VITE_PID" 2>/dev/null || true
  [ -n "$VITE_WRAPPER_PID" ] && kill "$VITE_WRAPPER_PID" 2>/dev/null || true
  [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cd "$ROOT"
env -i PATH="$ROOT/fakebin:$PATH" HOME="$ROOT/home" USERPROFILE="$ROOT/home" USER="${USER:-tester}" LOGNAME="${LOGNAME:-tester}" \
  SHELL=/bin/sh LANG=en_US.UTF-8 TMPDIR="$ROOT/tmp" PORT="$API_PORT" \
  CGUI_FAKE_CLAUDE_DIR="$CTL" CGUI_DISABLE_FILE_WATCHER=1 \
  nohup node "$WORKTREE/server/index.js" > "$LOGS/server.log" 2>&1 &
API_PID=$!

for _ in $(seq 1 60); do
  curl -sf -m 2 --noproxy '*' "http://127.0.0.1:$API_PORT/api/health" >/dev/null && break
  perl -e 'select(undef,undef,undef,0.5)'
done
kill -0 "$API_PID" 2>/dev/null || { echo "实例进程已退出:看 $LOGS/server.log" >&2; exit 1; }
lsof -nP -iTCP:"$API_PORT" -sTCP:LISTEN -t 2>/dev/null | grep -qx "$API_PID" \
  || { echo "端口 $API_PORT 上的监听者不是本实例(pid $API_PID)" >&2; exit 1; }
echo "[r199] 隔离实例就绪:http://127.0.0.1:$API_PORT(pid $API_PID,HOME=$ROOT/home)"

( cd "$WORKTREE/client" && R199_API_PORT="$API_PORT" R199_UI_PORT="$UI_PORT" \
    nohup node "$WORKTREE/client/node_modules/vite/bin/vite.js" --config "$SUITE/vite.dev.config.mjs" \
    > "$LOGS/vite.log" 2>&1 & echo $! > "$LOGS/vite.pid" )
VITE_WRAPPER_PID="$(cat "$LOGS/vite.pid")"
for _ in $(seq 1 80); do
  curl -sf -m 2 --noproxy '*' "http://127.0.0.1:$UI_PORT/" >/dev/null && break
  perl -e 'select(undef,undef,undef,0.5)'
done
LISTENER="$(lsof -nP -iTCP:"$UI_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)"
if [ -n "$LISTENER" ] && ps -p "$LISTENER" -o command= | grep -q "r199-session-one-proc"; then
  VITE_PID="$LISTENER"
else
  echo "dev server 没起来或端口 $UI_PORT 上不是本套件的进程:看 $LOGS/vite.log" >&2; exit 1
fi
echo "[r199] dev server 就绪:http://127.0.0.1:$UI_PORT(pid $VITE_PID;/api、/ws 代理到 $API_PORT)"

cd "$WORKTREE"
set +e
R199_UI_BASE="http://127.0.0.1:$UI_PORT" R199_API_BASE="http://127.0.0.1:$API_PORT" R199_CTL="$CTL" \
  npx playwright test -c "$SUITE/playwright.config.mjs" "$@"
CODE=$?
set -e
echo "[r199] playwright 退出码 $CODE(实例 $API_PID / dev server $VITE_PID;数据在 $ROOT)"
exit $CODE
