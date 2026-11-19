#!/usr/bin/env bash
# 一条命令跑整套:自己起隔离后端(6975)+ Vite 源码直出(6976),跑完只杀自己记录的 pid;结束时打印「通过 / 失败 / 跳过」计数与失败用例名。
#
#   bash tests/acceptance/r200-subagent-model-switch/run-isolated.sh               # 全量
#   bash .../run-isolated.sh --grep 'L1'                                            # 额外参数原样转给 playwright
#   R200_HOLD=1 bash .../run-isolated.sh                                            # 只起实例不跑用例(调试用)
#
# 端口:后端 6975、开发服务器 6976(写死);启动前用 lsof 确认空闲,被占就退出,不会去抢。硬拒 6677 / 6689 / 6710 / 8788 / 8789 / 8798 / 8799。
# 隔离:HOME 与 USERPROFILE 都指到本套件 .artifacts/runtime-data/home;后端进程(只有后端)带 tests/unit/q8-helpers/cu-preload.mjs 预加载,
#       CU_TEST_HOME 指向同一个假家目录;CGUI_DISABLE_FILE_WATCHER=1;PATH 最前面挂假 claude;CU_ALLOW_* 一律 unset;ANTHROPIC_* 全部剥掉。
#       后端进程套 sandbox-exec,禁止向 6677 / 6689 / 6710 / 8788 / 8789 / 8798 / 8799 发起出站连接(费用用例要切到自定义 provider,
#       切换时后端会探测本机常驻代理端口,沙箱保证探测碰不到用户真实的实例)。
# 收尾:kill 只按 .artifacts/pids 里记录的 pid,绝不 pkill / 不按端口或进程名去杀。
# 本套件不要和别的验收套件同时运行,也不要同时跑两份。
set -euo pipefail

SUITE="$(cd "$(dirname "$0")" && pwd)"
WORKTREE="$(cd "$SUITE/../../.." && pwd)"
ART="$SUITE/.artifacts"
ROOT="$ART/runtime-data"
PIDFILE="$ART/pids"
BPORT=6975
VPORT=6976
for p in "$BPORT" "$VPORT"; do
  case " 6677 6689 6710 8788 8789 8798 8799 " in *" $p "*) echo "拒绝端口 $p" >&2; exit 1;; esac
  [ -z "$(lsof -nP -iTCP:"$p" -sTCP:LISTEN -t 2>/dev/null || true)" ] || { echo "端口 $p 已被占用(lsof 查到监听者),不抢,退出" >&2; exit 1; }
done

for v in $(env | sed -n 's/^\(CU_ALLOW_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done

mkdir -p "$ROOT/home/.claude" "$ROOT/home/.claude-gui" "$ROOT/fixture-workspace"
node "$SUITE/helpers/fixtures.mjs" >/dev/null
: > "$PIDFILE"

SBPROFILE="$ART/deny-ports.sb"
{
  echo '(version 1)'
  echo '(allow default)'
  for p in 6677 6689 6710 8788 8789 8798 8799; do echo "(deny network-outbound (remote ip \"*:$p\"))"; done
} > "$SBPROFILE"
sandbox-exec -f "$SBPROFILE" /usr/bin/true || { echo "sandbox-exec 不可用,不起后端(没有端口沙箱不能切 provider)" >&2; exit 1; }

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
  CGUI_FAKE_CLAUDE_DIR="$ROOT/home/fake-claude" \
  CGUI_DISABLE_FILE_WATCHER=1 CGUI_ENABLE_LOCAL_ROUTES=1 \
  nohup sandbox-exec -f "$SBPROFILE" node --import "$WORKTREE/tests/unit/q8-helpers/cu-preload.mjs" "$WORKTREE/server/index.js" > "$ROOT/server.log" 2>&1 &
echo "backend $!" >> "$PIDFILE"

for _ in $(seq 1 60); do
  curl -sf -m 2 --noproxy '*' "http://127.0.0.1:$BPORT/api/health" >/dev/null && break
  sleep 0.5
done
curl -sf -m 2 --noproxy '*' "http://127.0.0.1:$BPORT/api/health" >/dev/null \
  || { echo "后端起不来(端口 $BPORT):看 $ROOT/server.log" >&2; exit 1; }

cd "$WORKTREE/client"
env HOME="$ROOT/home" USERPROFILE="$ROOT/home" R200_BACKEND_PORT="$BPORT" \
  nohup node node_modules/vite/bin/vite.js --config "$SUITE/vite.isolated.config.mjs" \
    --host 127.0.0.1 --port "$VPORT" --strictPort > "$ROOT/vite.log" 2>&1 &
echo "vite $!" >> "$PIDFILE"
cd "$WORKTREE"
for _ in $(seq 1 120); do
  curl -sf -m 3 --noproxy '*' "http://127.0.0.1:$VPORT/" >/dev/null && break
  sleep 0.5
done
curl -sf -m 3 --noproxy '*' "http://127.0.0.1:$VPORT/" >/dev/null \
  || { echo "Vite 起不来(端口 $VPORT):看 $ROOT/vite.log" >&2; exit 1; }

BASE_URL="http://127.0.0.1:$VPORT"
echo "$BASE_URL" > "$ART/base-url"
echo "[R200] 隔离实例就绪:$BASE_URL(后端端口 $BPORT;数据根 $ROOT;pids 记在 $PIDFILE)"

if [ -n "${R200_HOLD:-}" ]; then
  while :; do sleep 2; done
fi

cd "$WORKTREE"
: > "$ART/results.json"
rc=0
BASE_URL="$BASE_URL" NO_PROXY='127.0.0.1,localhost' no_proxy='127.0.0.1,localhost' npx playwright test -c "$SUITE/playwright.config.mjs" "$@" || rc=$?
node "$SUITE/helpers/summary.mjs" || true
exit "$rc"
