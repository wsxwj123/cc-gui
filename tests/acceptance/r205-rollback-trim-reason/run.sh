#!/usr/bin/env bash
# 一条命令跑整套 C1~C5:自己起隔离后端 + Vite 源码直出(不用 client/dist,不需要先 build),跑完只杀自己记录的 pid。
#
#   bash tests/acceptance/r205-fill-focused-pane/run.sh              # 全量
#   bash tests/acceptance/r205-fill-focused-pane/run.sh -g B2        # 额外参数原样转给 playwright(只跑 B2)
#
# 端口:后端 6931 / 开发服务器 6932(写死);启动前用 lsof 确认空闲,被占就退出,不会去抢。
#       硬拒 6677 / 6689 / 6710 / 8788 / 8789 / 8798 / 8799。
# 隔离:HOME 与 USERPROFILE 都指到本套件 .artifacts/runtime-data/home;后端进程(只有后端)带 tests/unit/q8-helpers/cu-preload.mjs 预加载,
#       CU_TEST_HOME 指向同一个假家目录;PATH 最前面挂假 claude;任何 CU_ALLOW_* 一律 unset;ANTHROPIC_* 全部剥掉。
#       后端目录监听关闭(CGUI_DISABLE_FILE_WATCHER=1),用例改会话记录文件时页面不会自动刷新。后端 stdout 落 server.stdout.log、stderr 落 server.stderr.log(用例读 stderr 里的 [history-op] 行)。
# 收尾:kill 只按 .artifacts/pids 里记录的 pid(先温和、再对仍存活的强制),绝不 pkill / 不按端口或进程名去杀。
# 本套件不要和别的验收套件同时运行,也不要同时跑两份。
set -uo pipefail

SUITE="$(cd "$(dirname "$0")" && pwd)"
ART="$SUITE/.artifacts"
WORKTREE="$(cd "$SUITE/../../.." && pwd)"
ROOT="$ART/runtime-data"
PIDFILE="$ART/pids"
BPORT=6931
VPORT=6932
for p in "$BPORT" "$VPORT"; do
  case " 6677 6689 6710 8788 8789 8798 8799 " in *" $p "*) echo "拒绝端口 $p" >&2; exit 1;; esac
  [ -z "$(lsof -nP -iTCP:"$p" -sTCP:LISTEN -t 2>/dev/null || true)" ] || { echo "端口 $p 已被占用(lsof 查到监听者),不抢,退出" >&2; exit 1; }
done

for v in $(env | grep -oE '^(CU_ALLOW_|ANTHROPIC_|CLAUDE_CODE_)[A-Za-z0-9_]*'); do unset "$v"; done
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy
export NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost

mkdir -p "$ART"
# 后端沙箱规则(接口文件给定的内容,逐字):挡真实钥匙串与一切对外网络,只放行本机后端端口。
cat > "$ART/sandbox.sb" <<SBEOF
(version 1)
(allow default)
(deny network-outbound (remote ip "*:*"))
(allow network-outbound (remote ip "localhost:$BPORT"))
(deny process-exec (literal "/usr/bin/security"))
SBEOF
mkdir -p "$ROOT/home/.claude" "$ROOT/home/.claude-gui" "$ROOT/fixture-workspace"
node "$SUITE/helpers/fixtures.mjs" >/dev/null || { echo "夹具生成失败" >&2; exit 1; }
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
# INT / TERM 先退出,由 EXIT 触发清理(原来交给 cleanup,它不退出,「只起实例」的等待循环会接着转,脚本结束不掉)
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

set -e
cd "$ROOT"
env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_MODEL -u ANTHROPIC_API_KEY \
  -u CLAUDE_CODE_OAUTH_TOKEN \
  HOME="$ROOT/home" USERPROFILE="$ROOT/home" CU_TEST_HOME="$ROOT/home" PORT="$BPORT" \
  PATH="$ART/fakebin:$PATH" \
  CGUI_FAKE_CLAUDE_DIR="$ROOT/home/fake-claude" CGUI_DISABLE_FILE_WATCHER=1 \
  nohup sandbox-exec -f "$ART/sandbox.sb" node --import "$WORKTREE/tests/unit/q8-helpers/cu-preload.mjs" "$WORKTREE/server/index.js" > "$ROOT/server.stdout.log" 2> "$ROOT/server.stderr.log" &
echo "backend $!" >> "$PIDFILE"

for _ in $(seq 1 60); do
  curl -sf -m 2 "http://127.0.0.1:$BPORT/api/health" >/dev/null && break
  sleep 0.5
done
curl -sf -m 2 "http://127.0.0.1:$BPORT/api/health" >/dev/null \
  || { echo "后端起不来(端口 $BPORT):看 $ROOT/server.stdout.log / server.stderr.log" >&2; exit 1; }

# 注意:不能写成 `( cd … && … & )`——那样 $! 是子 shell 的 pid,收尾时杀不到真正的 vite 进程。
cd "$WORKTREE/client"
env HOME="$ROOT/home" USERPROFILE="$ROOT/home" R205_BACKEND_PORT="$BPORT" \
  nohup node node_modules/vite/bin/vite.js --config "$SUITE/vite.isolated.config.mjs" \
    --host 127.0.0.1 --port "$VPORT" --strictPort > "$ROOT/vite.log" 2>&1 &
echo "vite $!" >> "$PIDFILE"
cd "$WORKTREE"
for _ in $(seq 1 120); do
  curl -sf -m 3 "http://127.0.0.1:$VPORT/" >/dev/null && break
  sleep 0.5
done
curl -sf -m 3 "http://127.0.0.1:$VPORT/" >/dev/null \
  || { echo "Vite 起不来(端口 $VPORT):看 $ROOT/vite.log" >&2; exit 1; }

BASE_URL="http://127.0.0.1:$VPORT"
echo "$BASE_URL" > "$ART/base-url"
echo "[R205] 隔离实例就绪:$BASE_URL(后端端口 $BPORT;数据根 $ROOT;pids 记在 $PIDFILE)"

cd "$WORKTREE"
set +e
BASE_URL="$BASE_URL" npx playwright test -c "$SUITE/playwright.config.mjs" "$@"
rc=$?
echo "R205-EXIT $rc"
exit "$rc"
