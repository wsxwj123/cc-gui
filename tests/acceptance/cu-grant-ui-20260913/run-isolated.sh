#!/usr/bin/env bash
# cu-grant-ui-20260913 一条命令跑整套:自己起隔离实例(+ UI 的 dev server),跑完按 pid 杀。
#
#   ./run-isolated.sh             # 全量(HTTP + UI + MCP 三层)
#   ./run-isolated.sh --no-ui     # 只跑 HTTP/MCP 面(不起 dev server)
#   ./run-isolated.sh --ui        # 只跑 UI/MCP 面(浏览器相关)
#   ./run-isolated.sh -g 'CG-08'  # 额外参数原样转给 playwright
#
# 写授权的用例另需(缺了会报 ENVIRONMENT_BLOCKED,不会静默跳过):
#   CU_ALLOW_GRANT_WRITE=1         改真实授权状态(收尾按原字节还原)
#   CU_SCREEN_SCOPE_OPTED_IN=1     主屏范围开关的用例(读屏要操作者明确同意)
#   CU_ALLOW_FIXTURE=1 CU_ALLOW_INPUT=1  开临时 TextEdit 窗口/MCP 定向动作(CG-03/10/11)
#
# 端口:6700 起挑空闲,硬拒用户正在用的 6677 / 6689。杀进程一律按记录下来的 pid。
set -euo pipefail

SUITE="$(cd "$(dirname "$0")" && pwd)"
WORKTREE="$(cd "$SUITE/../../.." && pwd)"
ROOT="$SUITE/.artifacts/runtime-data"
UI_MODE=full
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --no-ui) UI_MODE=http ;;
    --ui) UI_MODE=ui ;;
    *) ARGS+=("$arg") ;;
  esac
done

# 用 lsof 看有没有听众挑端口。不用"自己 bind 一下试试":别的套件可能绑在 0.0.0.0:6700,
# 而 macOS 上对 127.0.0.1 的探测绑定照样能成功 —— 探出来是假的(本套件实测踩过:
# 请求全打给了另一个套件留在 6700 上的实例)。
# 用法: pick_port [已占用的端口...] —— 两个都被挑起时互相避开(都在起服务之前挑,不排他就撞一起)
pick_port() {
  local exclude=" $* "
  local port
  for port in $(seq 6700 6799); do
    case "$port" in 6677|6689) continue ;; esac
    case "$exclude" in *" $port "*) continue ;; esac
    if ! lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
      echo "$port"
      return 0
    fi
  done
  echo "6700-6799 没有空闲端口" >&2
  return 1
}

API_PORT="${CGUI_TEST_API_PORT:-$(pick_port)}"
case "$API_PORT" in 6677|6689) echo "拒绝使用用户实例端口 $API_PORT" >&2; exit 1 ;; esac
UI_PORT=""
if [ "$UI_MODE" != "http" ]; then
  UI_PORT="${CGUI_TEST_UI_PORT:-$(pick_port "$API_PORT")}"
  case "$UI_PORT" in 6677|6689) echo "拒绝使用用户实例端口 $UI_PORT" >&2; exit 1 ;; esac
fi

mkdir -p "$ROOT/home" "$SUITE/.artifacts/logs"
node "$SUITE/helpers/prepare-home.mjs" "$ROOT/home" "$WORKTREE"
# 备份授权真源(写授权的用例会改到它)。还原在 cleanup 里做 —— 不管 playwright 是绿是红、
# 还是根本没跑起来,退出时一定按原字节还回去。
node "$SUITE/helpers/grants-cli.mjs" backup

# ── 隔离实例(API 面)──────────────────────────────────────────────────
cd "$ROOT"
env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_MODEL -u ANTHROPIC_API_KEY \
  HOME="$ROOT/home" USERPROFILE="$ROOT/home" PORT="$API_PORT" CGUI_DISABLE_FILE_WATCHER=1 \
  nohup node "$WORKTREE/server/index.js" > "$ROOT/server.log" 2>&1 &
API_PID=$!

VITE_PID=""
VITE_WRAPPER_PID=""
cleanup() {
  [ -n "$VITE_PID" ] && kill "$VITE_PID" 2>/dev/null || true
  [ -n "$VITE_WRAPPER_PID" ] && kill "$VITE_WRAPPER_PID" 2>/dev/null || true
  kill "$API_PID" 2>/dev/null || true
  node "$SUITE/helpers/grants-cli.mjs" restore || true
}
trap cleanup EXIT

for _ in $(seq 1 60); do
  curl -sf -m 2 "http://127.0.0.1:$API_PORT/api/health" >/dev/null && break
  sleep 0.5
done
curl -sf -m 2 "http://127.0.0.1:$API_PORT/api/health" >/dev/null \
  || { echo "实例起不来(端口 $API_PORT):看 $ROOT/server.log" >&2; exit 1; }
# 端口上答话的必须是刚起的这个 pid —— 这台机器上并行跑着别的套件,它们也会挑 6700+ 的端口,
# 只看 /api/health 200 会把别人的实例当成自己的。
kill -0 "$API_PID" 2>/dev/null \
  || { echo "实例进程 $API_PID 已退出(端口 $API_PORT 多半被别的实例占了)" >&2; exit 1; }
lsof -nP -iTCP:"$API_PORT" -sTCP:LISTEN -t 2>/dev/null | grep -qx "$API_PID" \
  || { echo "端口 $API_PORT 上的听众不是本实例(pid $API_PID);换端口重跑" >&2; exit 1; }
echo "[cu-grant-ui] 隔离实例就绪:http://127.0.0.1:$API_PORT(夹具 HOME $ROOT/home)"

# ── UI:dev server(源码直出,不产 client/dist)────────────────────────
UI_BASE=""
if [ "$UI_MODE" != "http" ]; then
  ( cd "$WORKTREE/client" && CGUI_TEST_API_PORT="$API_PORT" CGUI_TEST_UI_PORT="$UI_PORT" \
      nohup node "$WORKTREE/client/node_modules/vite/bin/vite.js" --config "$SUITE/vite.dev.config.mjs" \
      > "$SUITE/.artifacts/logs/vite.log" 2>&1 & echo $! > "$SUITE/.artifacts/logs/vite.pid" )
  VITE_WRAPPER_PID="$(cat "$SUITE/.artifacts/logs/vite.pid")"
  for _ in $(seq 1 60); do
    curl -sf -m 2 "http://127.0.0.1:$UI_PORT/" >/dev/null && break
    sleep 0.5
  done
  curl -sf -m 2 "http://127.0.0.1:$UI_PORT/" >/dev/null \
    || { echo "dev server 起不来(端口 $UI_PORT):看 $SUITE/.artifacts/logs/vite.log" >&2; exit 1; }
  # vite 有一个 wrapper 父进程 + 真正监听的那个子进程($! 记的是前者):真身份按"监听者 + 命令行"钉。
  # 即便下面这步判失败,VITE_PID 也先钉成监听者 —— 退出时的 cleanup 才收得掉真身(踩过:只杀 wrapper 会留下孤儿)。
  VITE_LISTENER="$(lsof -nP -iTCP:"$UI_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)"
  if [ -n "$VITE_LISTENER" ] && ps -p "$VITE_LISTENER" -o command= | grep -q "cu-grant-ui-20260913"; then
    VITE_PID="$VITE_LISTENER"
  else
    echo "端口 $UI_PORT 上的听众不是本套件的 dev server(监听者 ${VITE_LISTENER:-无});换端口重跑" >&2
    exit 1
  fi
  UI_BASE="http://127.0.0.1:$UI_PORT"
  echo "[cu-grant-ui] dev server 就绪:$UI_BASE(源码直出;/api、/ws 代理到 $API_PORT)"
fi

# ── 跑用例 ────────────────────────────────────────────────────────────
cd "$WORKTREE"
set +e
CGUI_TEST_API_PORT="$API_PORT" CGUI_TEST_UI_PORT="$UI_PORT" CGUI_TEST_UI_BASE="$UI_BASE" WORKTREE="$WORKTREE" \
  BASE_URL="http://127.0.0.1:$API_PORT" \
  npx playwright test -c "$SUITE/playwright.config.mjs" ${ARGS+"${ARGS[@]}"}
CODE=$?
set -e

echo "[cu-grant-ui] 退出码 $CODE(实例 pid $API_PID / dev server pid ${VITE_PID:-无})"
exit $CODE
