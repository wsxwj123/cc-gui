#!/usr/bin/env bash
# 一条命令跑整套 T1~T8(共 10 条用例):自己起隔离后端 + Vite 源码直出(不用 client/dist),跑完只杀自己记录的 pid。
#
#   bash tests/acceptance/r194-title-sync/run-isolated.sh                  # 全量:两趟(主趟:后端 CGUI_DISABLE_FILE_WATCHER=1;监听趟:后端不设该变量,只跑 T4-watch / T5-watch)
#   R194_PASS=main  bash .../run-isolated.sh                               # 只跑主趟
#   R194_PASS=watch bash .../run-isolated.sh                               # 只跑监听趟
#   R194_PASS=main bash .../run-isolated.sh -g "T3 "                       # 单跑一条(额外参数原样转给 playwright)
#   R194_HOLD=1 R194_PASS=main bash .../run-isolated.sh                    # 只起实例不跑用例(调试用)
#
# 端口:主趟 后端 6951 / 开发服务器 6952;监听趟 后端 6953 / 开发服务器 6954(写死);启动前用 lsof 确认空闲,被占就退出,不会去抢。
#       硬拒 6677 / 6689 / 6710 / 8788 / 8789 / 8798 / 8799。
# 隔离:HOME 与 USERPROFILE 都指到本套件 .artifacts/runtime-data/home;后端进程(只有后端)带 tests/unit/q8-helpers/cu-preload.mjs 预加载,
#       CU_TEST_HOME 指向同一个假家目录;PATH 最前面挂假 claude;任何 CU_ALLOW_* 一律 unset;ANTHROPIC_* 全部剥掉。
# 收尾:kill 只按 .artifacts/pids 里记录的 pid(先温和、再对仍存活的强制),绝不 pkill / 不按端口或进程名去杀。
# 脚本结束时打印通过 / 失败 / 跳过的计数。本套件不要和别的验收套件同时运行,也不要同时跑两份。
set -uo pipefail

SUITE="$(cd "$(dirname "$0")" && pwd)"
ART="$SUITE/.artifacts"

# ───────── 外层:没指定趟次就依次跑两趟并汇总 ─────────
if [ -z "${R194_PASS:-}" ]; then
  mkdir -p "$ART"
  rc=0
  for pass in main watch; do
    R194_PASS="$pass" bash "$0" "$@" 2>&1 | tee "$ART/pass-$pass.log" || true
    grep -q 'R194-PASS-EXIT 0' "$ART/pass-$pass.log" || rc=1
  done
  num() { cat "$ART/pass-main.log" "$ART/pass-watch.log" | grep -Eo "^ *[0-9]+ $1" | grep -Eo '[0-9]+' | paste -sd+ - | bc 2>/dev/null; }
  echo "[R194] 汇总:通过 $(num passed) / 失败 $(num failed) / 跳过 $(num skipped)(两趟合计;每趟的 skipped 是另一趟负责的用例)"
  exit "$rc"
fi

set -e
WORKTREE="$(cd "$SUITE/../../.." && pwd)"
ROOT="$ART/runtime-data"
PIDFILE="$ART/pids-$R194_PASS"
if [ "$R194_PASS" = watch ]; then BPORT=6953; VPORT=6954; WATCH_ENV=(); else BPORT=6951; VPORT=6952; WATCH_ENV=(CGUI_DISABLE_FILE_WATCHER=1); fi
for p in "$BPORT" "$VPORT"; do
  case " 6677 6689 6710 8788 8789 8798 8799 " in *" $p "*) echo "拒绝端口 $p" >&2; exit 1;; esac
  [ -z "$(lsof -nP -iTCP:"$p" -sTCP:LISTEN -t 2>/dev/null || true)" ] || { echo "端口 $p 已被占用(lsof 查到监听者),不抢,退出" >&2; exit 1; }
done

for v in $(env | sed -n 's/^\(CU_ALLOW_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done

mkdir -p "$ROOT/home/.claude" "$ROOT/home/.claude-gui"
node "$SUITE/helpers/fixtures.mjs" >/dev/null
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

# 后端:端口由本脚本写死;ANTHROPIC_* 全部剥掉;预加载只加在后端进程上;监听趟不设 CGUI_DISABLE_FILE_WATCHER。
cd "$ROOT"
env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_MODEL -u ANTHROPIC_API_KEY \
  -u CLAUDE_CODE_OAUTH_TOKEN -u CGUI_DISABLE_FILE_WATCHER \
  HOME="$ROOT/home" USERPROFILE="$ROOT/home" CU_TEST_HOME="$ROOT/home" PORT="$BPORT" \
  PATH="$ART/fakebin:$PATH" \
  CGUI_FAKE_CLAUDE_DIR="$ROOT/home/fake-claude" CGUI_ENABLE_LOCAL_ROUTES=1 ${WATCH_ENV[@]+"${WATCH_ENV[@]}"} \
  nohup node --import "$WORKTREE/tests/unit/q8-helpers/cu-preload.mjs" "$WORKTREE/server/index.js" > "$ROOT/server-$R194_PASS.log" 2>&1 &
echo "backend $!" >> "$PIDFILE"

for _ in $(seq 1 60); do
  curl -sf -m 2 "http://127.0.0.1:$BPORT/api/health" >/dev/null && break
  sleep 0.5
done
curl -sf -m 2 "http://127.0.0.1:$BPORT/api/health" >/dev/null \
  || { echo "后端起不来(端口 $BPORT):看 $ROOT/server-$R194_PASS.log" >&2; exit 1; }

# 注意:不能写成 `( cd … && … & )`——那样 $! 是子 shell 的 pid,收尾时杀不到真正的 vite 进程。
cd "$WORKTREE/client"
env HOME="$ROOT/home" USERPROFILE="$ROOT/home" R194_BACKEND_PORT="$BPORT" \
  nohup node node_modules/vite/bin/vite.js --config "$SUITE/vite.isolated.config.mjs" \
    --host 127.0.0.1 --port "$VPORT" --strictPort > "$ROOT/vite-$R194_PASS.log" 2>&1 &
echo "vite $!" >> "$PIDFILE"
cd "$WORKTREE"
for _ in $(seq 1 120); do
  curl -sf -m 3 "http://127.0.0.1:$VPORT/" >/dev/null && break
  sleep 0.5
done
curl -sf -m 3 "http://127.0.0.1:$VPORT/" >/dev/null \
  || { echo "Vite 起不来(端口 $VPORT):看 $ROOT/vite-$R194_PASS.log" >&2; exit 1; }

BASE_URL="http://127.0.0.1:$VPORT"
echo "$BASE_URL" > "$ART/base-url"
echo "[R194] 隔离实例就绪(趟次 $R194_PASS):$BASE_URL(后端端口 $BPORT;数据根 $ROOT;pids 记在 $PIDFILE)"

if [ -n "${R194_HOLD:-}" ]; then
  while :; do sleep 2; done
fi

cd "$WORKTREE"
set +e
BASE_URL="$BASE_URL" R194_PASS="$R194_PASS" npx playwright test -c "$SUITE/playwright.config.mjs" "$@"
rc=$?
echo "R194-PASS-EXIT $rc"
exit "$rc"
