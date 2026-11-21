#!/usr/bin/env bash
# r207 打开超大会话 —— 验收,一条命令:
#   bash tests/acceptance/r207-huge-session-open/run.sh              # 接口 5 条(行为 1–5)+ 页面 4 条(行为 6–7)
#   bash tests/acceptance/r207-huge-session-open/run.sh --api-only   # 只跑接口部分(T1a T1b T2 T3 T4 T5)
#   bash tests/acceptance/r207-huge-session-open/run.sh --ui-only    # 只跑页面部分(T6a T6b T6c T7)
#   R207_KEEP=1 ...  保留大夹具(调试用;默认每组用例收尾时按文件名逐个删除自己写的会话文件)
# 接口部分:每组用例自己起一个一次性隔离后端(临时家目录、端口 6700–6799 里挑空闲的),夹具约 500–600MB,峰值磁盘约 400MB。
# 页面部分:隔离后端 6957 + Vite 源码直出 6958(写死;启动前 lsof 确认空闲,被占就退出),Playwright WebKit,假命令行。
# 都禁用 6677 / 6689 / 6710 / 8788 / 8789 / 8798 / 8799;后端带 tests/unit/q8-helpers/cu-preload.mjs、CU_TEST_HOME、CGUI_DISABLE_FILE_WATCHER=1、HOST=127.0.0.1,
# 不设 CGUI_ENABLE_LOCAL_ROUTES,ANTHROPIC_* 剥掉。收尾 kill 只按本次运行记录的 pid。本套件不要和别的验收套件同时运行。
set -uo pipefail

SUITE="$(cd "$(dirname "$0")" && pwd)"
WORKTREE="$(cd "$SUITE/../../.." && pwd)"
MAIN_CLIENT_NM=""
DO_API=1; DO_UI=1
for a in "$@"; do case "$a" in --api-only) DO_UI=0;; --ui-only) DO_API=0;; esac; done

RUN_ROOT="$SUITE/.artifacts/runs/$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$RUN_ROOT"
export R207_RUN_ROOT="$RUN_ROOT"
PIDFILE="$RUN_ROOT/pids.txt"; : > "$PIDFILE"
MADE_LINK=0

for v in $(env | sed -n 's/^\(CU_ALLOW_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done

cleanup() {
  local pid cmd i
  if [ -f "$PIDFILE" ]; then
    while read -r pid; do
      [ -n "$pid" ] || continue
      cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
      case "$cmd" in *"server/index.js"*|*"vite.js"*) kill "$pid" 2>/dev/null || true ;; esac
    done < "$PIDFILE"
    sleep 1
    while read -r pid; do
      [ -n "$pid" ] || continue
      cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
      case "$cmd" in *"server/index.js"*|*"vite.js"*) kill -9 "$pid" 2>/dev/null || true ;; esac
    done < "$PIDFILE"
  fi
  if [ "$MADE_LINK" = 1 ]; then unlink "$WORKTREE/client/node_modules" 2>/dev/null || true; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "[r207] 运行目录 $RUN_ROOT"
API_RC=0; UI_RC=0

if [ "$DO_API" = 1 ]; then
  echo "[r207] ===== 接口部分(行为 1–5)====="
  node --test --test-concurrency=1 "$SUITE/api.spec.mjs"
  API_RC=$?
  echo "[r207] 接口部分退出码 $API_RC"
fi

if [ "$DO_UI" = 1 ]; then
  echo "[r207] ===== 页面部分(行为 6–7)====="
  BPORT=6957; VPORT=6958
  for p in "$BPORT" "$VPORT"; do
    case " 6677 6689 6710 8788 8789 8798 8799 " in *" $p "*) echo "拒绝端口 $p" >&2; exit 1;; esac
    [ -z "$(lsof -nP -iTCP:"$p" -sTCP:LISTEN -t 2>/dev/null || true)" ] || { echo "端口 $p 已被占用,不抢,退出" >&2; exit 1; }
  done
  # 工作树里没有 client/node_modules 时,软链到主仓那份(只在本次运行期间存在,结束时 unlink)
  if [ ! -e "$WORKTREE/client/node_modules" ]; then
    MAIN="$(git -C "$WORKTREE" worktree list --porcelain | sed -n '1s/^worktree //p')"
    [ -d "$MAIN/client/node_modules" ] || { echo "找不到 $MAIN/client/node_modules,没法起 Vite" >&2; exit 1; }
    ln -s "$MAIN/client/node_modules" "$WORKTREE/client/node_modules" && MADE_LINK=1
  fi
  UIROOT="$RUN_ROOT/ui"
  mkdir -p "$UIROOT/home/.claude" "$UIROOT/home/.claude-gui"
  export R207_DATA_ROOT="$UIROOT"
  node "$SUITE/helpers/ui-fixtures.mjs" >/dev/null || { echo "夹具生成失败" >&2; exit 1; }
  CTL="$UIROOT/home/fake-claude"
  SBPROFILE="$SUITE/.artifacts/deny-ports.sb"
  { echo '(version 1)'; echo '(allow default)'
    for p in 6677 6689 6710 8788 8789 8798 8799; do echo "(deny network-outbound (remote ip \"*:$p\"))"; done; } > "$SBPROFILE"
  sandbox-exec -f "$SBPROFILE" /usr/bin/true || { echo "sandbox-exec 不可用,不起后端" >&2; exit 1; }

  ( cd "$UIROOT" && exec env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_MODEL -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN \
      HOME="$UIROOT/home" USERPROFILE="$UIROOT/home" CU_TEST_HOME="$UIROOT/home" PORT="$BPORT" HOST=127.0.0.1 \
      PATH="$UIROOT/fakebin:$PATH" CGUI_FAKE_CLAUDE_DIR="$CTL" CGUI_DISABLE_FILE_WATCHER=1 \
      sandbox-exec -f "$SBPROFILE" node --import "$WORKTREE/tests/unit/q8-helpers/cu-preload.mjs" "$WORKTREE/server/index.js" ) > "$UIROOT/server.log" 2>&1 < /dev/null &
  echo $! >> "$PIDFILE"
  for _ in $(seq 1 60); do curl -sf -m 2 --noproxy '*' "http://127.0.0.1:$BPORT/api/health" >/dev/null && break; sleep 0.5; done
  curl -sf -m 2 --noproxy '*' "http://127.0.0.1:$BPORT/api/health" >/dev/null || { echo "后端起不来(端口 $BPORT):看 $UIROOT/server.log" >&2; exit 1; }

  ( cd "$WORKTREE/client" && exec env HOME="$UIROOT/home" USERPROFILE="$UIROOT/home" R207_BACKEND_PORT="$BPORT" \
      node node_modules/vite/bin/vite.js --config "$SUITE/vite.isolated.config.mjs" --host 127.0.0.1 --port "$VPORT" --strictPort ) > "$UIROOT/vite.log" 2>&1 < /dev/null &
  echo $! >> "$PIDFILE"
  for _ in $(seq 1 120); do curl -sf -m 3 --noproxy '*' "http://127.0.0.1:$VPORT/" >/dev/null && break; sleep 0.5; done
  curl -sf -m 3 --noproxy '*' "http://127.0.0.1:$VPORT/" >/dev/null || { echo "Vite 起不来(端口 $VPORT):看 $UIROOT/vite.log" >&2; exit 1; }
  echo "[r207] 页面实例就绪:http://127.0.0.1:$VPORT(后端 $BPORT;数据根 $UIROOT)"

  ( cd "$WORKTREE" && R207_UI_BASE="http://127.0.0.1:$VPORT" R207_API_BASE="http://127.0.0.1:$BPORT" R207_CTL="$CTL" \
      NO_PROXY='127.0.0.1,localhost' no_proxy='127.0.0.1,localhost' \
      npx playwright test -c "$SUITE/playwright.config.mjs" )
  UI_RC=$?
  echo "[r207] 页面部分退出码 $UI_RC"
fi

echo "[r207] 接口 $API_RC / 页面 $UI_RC(0 = 全绿;日志与夹具在 $RUN_ROOT)"
[ "$API_RC" = 0 ] && [ "$UI_RC" = 0 ]
