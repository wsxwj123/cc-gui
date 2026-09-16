#!/usr/bin/env bash
# r120 界面验收(回滚点失控:可见性 / 删除入口 / 二次确认 / 跳过告知),一条命令:
#   tests/acceptance/r120-checkpoint/run.sh                 # 全量
#   tests/acceptance/r120-checkpoint/run.sh -g 'B2'         # 额外参数原样转给 playwright
# 自己做:建夹具(隔离 HOME + 会话 + 大目录)→ 起隔离实例(HOME=本套件 .artifacts,阈值/上限都注入得极小)
#        → 起 dev server(源码直出)→ 跑用例 → 按记录的 pid 收掉这两类进程和所有桩进程。
# 端口只在 6700–6999 里挑空闲的,硬拒 6677 / 6689 / 6710。
set -euo pipefail

SUITE="$(cd "$(dirname "$0")" && pwd)"
WORKTREE="$(cd "$SUITE/../../.." && pwd)"
ROOT="$SUITE/.artifacts/runs/$(date +%Y%m%d-%H%M%S)-$$"
LOGS="$ROOT/logs"
mkdir -p "$LOGS"
export R120_DATA_ROOT="$ROOT"

pick_port() {
  local exclude=" $* " port
  for port in $(seq 6700 6999); do
    case "$port" in 6677|6689|6710) continue ;; esac
    case "$exclude" in *" $port "*) continue ;; esac
    if ! lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then echo "$port"; return 0; fi
  done
  echo "6700-6999 没有空闲端口" >&2; return 1
}
API_PORT="$(pick_port)"
UI_PORT="$(pick_port "$API_PORT")"

node "$SUITE/helpers/fixtures.mjs"
HOME_DIR="$ROOT/home"
WS="$HOME_DIR/work/proj"
BIG="$HOME_DIR/work/big"
PROJECT_HASH="$(printf '%s' "$WS" | sed 's/[^A-Za-z0-9]/-/g')"
# 大目录:稀疏大文件 + 1500 个小文件 ≈ 6 MB(单次运行总写 < 10 MB,不写满盘)
node -e '
const fs=require("node:fs"),p=require("node:path");
const dir=process.argv[1];fs.rmSync(dir,{recursive:true,force:true});fs.mkdirSync(dir,{recursive:true});
const f=p.join(dir,"filler.bin");fs.writeFileSync(f,"");fs.truncateSync(f,8*1024*1024);
const blob=Buffer.alloc(4096,0x61);
for(let i=0;i<1500;i+=1)fs.writeFileSync(p.join(dir,`data-${String(i).padStart(4,"0")}.txt`),blob);
' "$BIG"

# 阈值/上限一律走可注入配置(不改默认值):64 KB 阈值 + 3 条上限,好在小机器上几秒内触发
cd "$ROOT"
env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_MODEL -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN \
  HOME="$HOME_DIR" USERPROFILE="$HOME_DIR" PORT="$API_PORT" CGUI_DISABLE_FILE_WATCHER=1 \
  CGUI_CHECKPOINT_MAX_BYTES=65536 CGUI_CHECKPOINTS_MAX_BYTES=65536 \
  CGUI_CHECKPOINT_MAX_COUNT=3 CGUI_CHECKPOINTS_MAX_COUNT=3 \
  CGUI_CHECKPOINT_RETENTION_DAYS=30 CGUI_CHECKPOINTS_RETENTION_DAYS=30 \
  CGUI_ALLOW_TINY_CHECKPOINT_RETENTION=1 \
  nohup node "$WORKTREE/server/index.js" > "$LOGS/server.log" 2>&1 &
API_PID=$!
VITE_PID=""
VITE_WRAPPER_PID=""
cleanup() {
  [ -n "$VITE_PID" ] && kill "$VITE_PID" 2>/dev/null || true
  [ -n "$VITE_WRAPPER_PID" ] && kill "$VITE_WRAPPER_PID" 2>/dev/null || true
  kill "$API_PID" 2>/dev/null || true
}
trap cleanup EXIT

for _ in $(seq 1 60); do
  curl -sf -m 2 "http://127.0.0.1:$API_PORT/api/health" >/dev/null && break
  perl -e 'select(undef,undef,undef,0.5)'
done
kill -0 "$API_PID" 2>/dev/null || { echo "实例进程已退出:看 $LOGS/server.log" >&2; exit 1; }
lsof -nP -iTCP:"$API_PORT" -sTCP:LISTEN -t 2>/dev/null | grep -qx "$API_PID" \
  || { echo "端口 $API_PORT 上的监听者不是本实例(pid $API_PID)" >&2; exit 1; }
echo "[r120] 隔离实例就绪:http://127.0.0.1:$API_PORT(pid $API_PID,HOME=$HOME_DIR)"

( cd "$WORKTREE/client" && R120_API_PORT="$API_PORT" R120_UI_PORT="$UI_PORT" \
    nohup node "$WORKTREE/client/node_modules/vite/bin/vite.js" --config "$SUITE/vite.dev.config.mjs" \
    > "$LOGS/vite.log" 2>&1 & echo $! > "$LOGS/vite.pid" )
VITE_WRAPPER_PID="$(cat "$LOGS/vite.pid")"
for _ in $(seq 1 80); do
  curl -sf -m 2 "http://127.0.0.1:$UI_PORT/" >/dev/null && break
  perl -e 'select(undef,undef,undef,0.5)'
done
LISTENER="$(lsof -nP -iTCP:"$UI_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)"
if [ -n "$LISTENER" ] && ps -p "$LISTENER" -o command= | grep -q "r120-checkpoint"; then
  VITE_PID="$LISTENER"
else
  echo "dev server 没起来或端口 $UI_PORT 上不是本套件的进程:看 $LOGS/vite.log" >&2; exit 1
fi
echo "[r120] dev server 就绪:http://127.0.0.1:$UI_PORT(pid $VITE_PID;/api、/ws 代理到 $API_PORT)"

cd "$WORKTREE"
set +e
R120_UI_BASE="http://127.0.0.1:$UI_PORT" R120_API_BASE="http://127.0.0.1:$API_PORT" \
R120_HOME="$HOME_DIR" R120_WORKSPACE="$WS" R120_PROJECT_HASH="$PROJECT_HASH" \
R120_SESSION_ID="a1200000-0000-4000-8000-000000000001" R120_SESSION_MARK="R120CHECK" \
  npx playwright test -c "$SUITE/playwright.config.mjs" "$@"
CODE=$?
set -e
echo "[r120] playwright 退出码 $CODE(实例 pid $API_PID / dev server pid $VITE_PID)"
exit $CODE
