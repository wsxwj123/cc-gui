#!/usr/bin/env bash
# r142-wincu 一条命令跑一套:起隔离实例(可伪造成 win32 / darwin / linux)+ 可选 UI dev server,跑完按 pid 杀。
#
#   ./run-isolated.sh --platform win32                 # 平台分派验收(HTTP)
#   ./run-isolated.sh --platform win32 --no-venv       # 验「准备环境」/POST /prepare(要空运行时)
#   ./run-isolated.sh --platform win32 --ui            # 加 UI 用例(浏览器)
#   ./run-isolated.sh --platform darwin -g W-D         # macOS 反向守卫
#   ./run-isolated.sh --platform linux -g U-06         # 不支持平台的占位卡
#   ./run-isolated.sh --platform win32 -g W-01         # 单条
#
# 端口政策(与既有套件**故意不同**):7200-7299。6700-6999 归另一个代理的 r140 套件,不抢;
# 用户实例 6677 / 6689 硬拒。杀进程一律按记录下来的 pid。
#
# ⚠️ 前置(没做会红,不会静默跳过):本套件的实例必须用 --import helpers/win-preload.mjs 起,
# 否则 process.platform 还是 darwin,win32 用例会报 ENVIRONMENT_BLOCKED。
set -euo pipefail

SUITE="$(cd "$(dirname "$0")" && pwd)"
WORKTREE="$(cd "$SUITE/../../.." && pwd)"
ROOT="$SUITE/.artifacts/runtime-data"
PLATFORM="win32"
UI_MODE=off
NO_VENV=0
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --platform) PLATFORM="$2"; shift 2 ;;
    --ui) UI_MODE=on; shift ;;
    --no-venv) NO_VENV=1; shift ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
case "$PLATFORM" in win32|darwin|linux) ;; *) echo "未知平台 $PLATFORM" >&2; exit 2 ;; esac

pick_port() {
  local exclude=" $* "
  local port
  for port in $(seq 7200 7299); do
    case "$port" in 6677|6689) continue ;; esac
    case "$exclude" in *" $port "*) continue ;; esac
    if ! lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then echo "$port"; return 0; fi
  done
  echo "7200-7299 没有空闲端口" >&2
  return 1
}

API_PORT="${CGUI_TEST_API_PORT:-$(pick_port)}"
case "$API_PORT" in 6677|6689) echo "拒绝使用用户实例端口 $API_PORT" >&2; exit 1 ;; esac
UI_PORT=""
if [ "$UI_MODE" = "on" ]; then UI_PORT="${CGUI_TEST_UI_PORT:-$(pick_port "$API_PORT")}"; fi

mkdir -p "$ROOT" "$SUITE/.artifacts/logs"
PREP_FLAG=""
[ "$NO_VENV" = "1" ] && PREP_FLAG="--no-venv"
# CGUI_TEST_PLATFORM 必须一起传:夹具按它决定造 venv-win/Scripts\python.exe 还是 venv/bin/python3
CGUI_TEST_PLATFORM="$PLATFORM" node "$SUITE/helpers/prepare-home.mjs" "$ROOT/home" "$WORKTREE" $PREP_FLAG

# ── 隔离实例:平台伪装 + 夹具 HOME(产品代码零改动)────────────────────
cd "$ROOT"
# ⚠️ PATH 最前面那个 decoy 是**必须的**(2026-10-02 修,裁判实测根因):
# server/index.js:97-127 的 expandClaudePath() 用 `process.platform === 'win32' ? ';' : ':'` 切 PATH。
# 伪 win32 时它把整条 POSIX PATH 当成**一个**条目再 join(';'),产出的字符串按 ':' 拆开时,
# **原 PATH 的第一个 ':' 分量会被粘到那一长串后面而失效**。夹具的 bin 就排在第一,于是被粘掉、
# 本机 ~/.pyenv/shims/python 反而被找到 → 建出来的是真 venv(bin/python3.10)。
# 放一个不存在的 decoy 在第一,替夹具 bin 挡这一刀即可(真 darwin 那遍无副作用)。
PATH_DECOY="/nonexistent-r142-path-decoy"
env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_MODEL -u ANTHROPIC_API_KEY \
  HOME="$ROOT/home" USERPROFILE="$ROOT/home" PORT="$API_PORT" CGUI_DISABLE_FILE_WATCHER=1 \
  CGUI_TEST_PLATFORM="$PLATFORM" PATH="$PATH_DECOY:$ROOT/home/bin:$PATH" \
  CU_STUB_LOG="$ROOT/home/argv.jsonl" CU_STUB_SCENARIO="$ROOT/home/scenario.json" \
  nohup node --import "$SUITE/helpers/win-preload.mjs" "$WORKTREE/server/index.js" \
  > "$ROOT/server.log" 2>&1 &
API_PID=$!

VITE_PID=""
cleanup() {
  [ -n "$VITE_PID" ] && kill "$VITE_PID" 2>/dev/null || true
  kill "$API_PID" 2>/dev/null || true
}
trap cleanup EXIT

for _ in $(seq 1 60); do
  curl -sf -m 2 "http://127.0.0.1:$API_PORT/api/health" >/dev/null && break
  sleep 0.5
done
curl -sf -m 2 "http://127.0.0.1:$API_PORT/api/health" >/dev/null \
  || { echo "实例起不来(端口 $API_PORT):看 $ROOT/server.log" >&2; exit 1; }
kill -0 "$API_PID" 2>/dev/null || { echo "实例进程 $API_PID 已退出" >&2; exit 1; }
lsof -nP -iTCP:"$API_PORT" -sTCP:LISTEN -t 2>/dev/null | grep -qx "$API_PID" \
  || { echo "端口 $API_PORT 上的听众不是本实例(pid $API_PID);换端口重跑" >&2; exit 1; }
echo "[r142-wincu] 隔离实例就绪:http://127.0.0.1:$API_PORT(伪装平台 $PLATFORM,夹具 HOME $ROOT/home)"

# ── UI:dev server ─────────────────────────────────────────────────────
UI_BASE=""
if [ "$UI_MODE" = "on" ]; then
  ( cd "$WORKTREE/client" && CGUI_TEST_API_PORT="$API_PORT" CGUI_TEST_UI_PORT="$UI_PORT" \
      nohup node "$WORKTREE/client/node_modules/vite/bin/vite.js" --config "$SUITE/vite.dev.config.mjs" \
      > "$SUITE/.artifacts/logs/vite.log" 2>&1 & echo $! > "$SUITE/.artifacts/logs/vite.pid" )
  for _ in $(seq 1 60); do curl -sf -m 2 "http://127.0.0.1:$UI_PORT/" >/dev/null && break; sleep 0.5; done
  curl -sf -m 2 "http://127.0.0.1:$UI_PORT/" >/dev/null \
    || { echo "dev server 起不来(端口 $UI_PORT):看 $SUITE/.artifacts/logs/vite.log" >&2; exit 1; }
  VITE_PID="$(lsof -nP -iTCP:"$UI_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)"
  UI_BASE="http://127.0.0.1:$UI_PORT"
  echo "[r142-wincu] dev server 就绪:$UI_BASE"
fi

# UI 关掉时只跑 HTTP 两个 spec,别让 UI 用例报 ENVIRONMENT_BLOCKED
if [ "$UI_MODE" = "off" ] && [ ${#ARGS[@]} -eq 0 ]; then
  ARGS=(wincu-win.spec.mjs wincu-mac.spec.mjs)
fi

cd "$WORKTREE"
set +e
CGUI_TEST_API_PORT="$API_PORT" CGUI_TEST_UI_PORT="$UI_PORT" CGUI_TEST_UI_BASE="$UI_BASE" \
  CGUI_TEST_PLATFORM="$PLATFORM" CGUI_TEST_HOME="$ROOT/home" WORKTREE="$WORKTREE" \
  BASE_URL="http://127.0.0.1:$API_PORT" \
  npx playwright test -c "$SUITE/playwright.config.mjs" ${ARGS+"${ARGS[@]}"}
CODE=$?
set -e
echo "[r142-wincu] 退出码 $CODE(实例 pid $API_PID / dev server ${VITE_PID:-无})"
exit $CODE
