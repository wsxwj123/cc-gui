#!/usr/bin/env bash
# 一条命令跑整套:自己起隔离后端(6977)+ Vite 源码直出(6978),跑完只杀自己记录的 pid;结束时打印「通过 / 失败 / 跳过」计数与失败用例名。
#
#   bash tests/acceptance/r196-queue-drain-background/run-isolated.sh               # 全量
#   bash .../run-isolated.sh --grep 'V1 '                                           # 额外参数原样转给 playwright
#   R196_HOLD=1 bash .../run-isolated.sh                                            # 只起实例不跑用例(调试用)
#
# 端口:后端 6977、页面 6978(写死);启动前用 lsof 确认空闲,被占就退出,不会去抢。硬拒 6677 / 6689 / 6710 / 8788 / 8789 / 8798 / 8799。
# 隔离:HOME 与 USERPROFILE 都指到本次运行专属的假家目录(.artifacts/runs/<时间>-<pid>/home,每次全新);后端进程(只有后端)带
#       tests/unit/q8-helpers/cu-preload.mjs 预加载,CU_TEST_HOME 指向同一个假家目录;CGUI_DISABLE_FILE_WATCHER=1;PATH 最前面挂假 claude;
#       CU_ALLOW_* 一律 unset;ANTHROPIC_* 与 CLAUDE_CODE_OAUTH_TOKEN 全部剥掉。后端套 sandbox-exec,禁止向上面那几个端口发起出站连接。
# 收尾:kill 只按本次运行 pids 文件里记录的 pid,绝不 pkill / 不按端口或进程名去杀。
# 本套件不要和别的验收套件同时运行,也不要同时跑两份。
set -euo pipefail

SUITE="$(cd "$(dirname "$0")" && pwd)"
WORKTREE="$(cd "$SUITE/../../.." && pwd)"
ART="$SUITE/.artifacts"
ROOT="$ART/runs/$(date +%Y%m%d-%H%M%S)-$$"
PIDFILE="$ROOT/pids"
BPORT=6977
VPORT=6978
for p in "$BPORT" "$VPORT"; do
  case " 6677 6689 6710 8788 8789 8798 8799 " in *" $p "*) echo "拒绝端口 $p" >&2; exit 1;; esac
  [ -z "$(lsof -nP -iTCP:"$p" -sTCP:LISTEN -t 2>/dev/null || true)" ] || { echo "端口 $p 已被占用(lsof 查到监听者),不抢,退出" >&2; exit 1; }
done

for v in $(env | sed -n 's/^\(CU_ALLOW_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done

mkdir -p "$ROOT/home/.claude" "$ROOT/home/.claude-gui"
export R196_DATA_ROOT="$ROOT"
node "$SUITE/helpers/fixtures.mjs" >/dev/null
: > "$PIDFILE"
CTL="$ROOT/home/fake-claude"

SBPROFILE="$ART/deny-ports.sb"
{
  echo '(version 1)'
  echo '(allow default)'
  for p in 6677 6689 6710 8788 8789 8798 8799; do echo "(deny network-outbound (remote ip \"*:$p\"))"; done
} > "$SBPROFILE"
sandbox-exec -f "$SBPROFILE" /usr/bin/true || { echo "sandbox-exec 不可用,不起后端" >&2; exit 1; }

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
  CGUI_FAKE_CLAUDE_DIR="$CTL" \
  CGUI_DISABLE_FILE_WATCHER=1 \
  nohup sandbox-exec -f "$SBPROFILE" node --import "$WORKTREE/tests/unit/q8-helpers/cu-preload.mjs" "$WORKTREE/server/index.js" > "$ROOT/server.log" 2>&1 &
echo "backend $!" >> "$PIDFILE"

for _ in $(seq 1 60); do
  curl -sf -m 2 --noproxy '*' "http://127.0.0.1:$BPORT/api/health" >/dev/null && break
  sleep 0.5
done
curl -sf -m 2 --noproxy '*' "http://127.0.0.1:$BPORT/api/health" >/dev/null \
  || { echo "后端起不来(端口 $BPORT):看 $ROOT/server.log" >&2; exit 1; }

cd "$WORKTREE/client"
env HOME="$ROOT/home" USERPROFILE="$ROOT/home" R196_BACKEND_PORT="$BPORT" \
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

echo "[R196] 隔离实例就绪:http://127.0.0.1:$VPORT(后端端口 $BPORT;数据根 $ROOT;pids 记在 $PIDFILE)"

if [ -n "${R196_HOLD:-}" ]; then
  while :; do sleep 2; done
fi

: > "$ART/results.json"
rc=0
R196_UI_BASE="http://127.0.0.1:$VPORT" R196_API_BASE="http://127.0.0.1:$BPORT" R196_CTL="$CTL" \
  NO_PROXY='127.0.0.1,localhost' no_proxy='127.0.0.1,localhost' \
  npx playwright test -c "$SUITE/playwright.config.mjs" "$@" || rc=$?
node "$SUITE/helpers/summary.mjs" || true
exit "$rc"
