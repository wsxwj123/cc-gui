#!/usr/bin/env bash
# 一条命令跑整套 PA-*：自己起隔离实例（数据根 = 本套件 .artifacts/runtime-data），跑完杀掉。
#
#   ./run-isolated.sh                  # 全量（含 UI 组，自动 PA_ALLOW_UI=1）
#   ./run-isolated.sh --grep 'PA-3'    # 额外参数原样转给 playwright
#   PA_PORT=57301 ./run-isolated.sh    # 指定端口
#
# 为什么要用脚本起实例：手工起很容易复制到别套件的启动命令（HOME/数据根不一样），
# 或图省事复用一个早就跑着的旧实例 —— 那样跑出来的红全是假的（实测 20 条里 14 条是这么来的）。
# 套件自己也会在开跑前预检一次（global-setup.mjs）。
set -euo pipefail

SUITE="$(cd "$(dirname "$0")" && pwd)"
WORKTREE="$(cd "$SUITE/../../.." && pwd)"
ROOT="$SUITE/.artifacts/runtime-data"
PORT="${PA_PORT:-$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));p=s.getsockname()[1];s.close();print(p)')}"

mkdir -p "$ROOT/home/.claude" "$ROOT/home/.claude-gui" "$ROOT/fixture-workspace"
cd "$ROOT"
env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_MODEL \
  HOME="$ROOT/home" PORT="$PORT" CGUI_DISABLE_FILE_WATCHER=1 CGUI_ENABLE_LOCAL_ROUTES=1 CGUI_TAURI=1 \
  nohup node "$WORKTREE/server/index.js" > "$ROOT/server.log" 2>&1 &
INSTANCE_PID=$!
trap 'kill "$INSTANCE_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  curl -sf -m 2 "http://127.0.0.1:$PORT/api/health" >/dev/null && break
  sleep 0.5
done
curl -sf -m 2 "http://127.0.0.1:$PORT/api/health" >/dev/null \
  || { echo "实例起不来（端口 $PORT）：看 $ROOT/server.log" >&2; exit 1; }

cd "$WORKTREE"
BASE_URL="http://127.0.0.1:$PORT" PA_ALLOW_UI="${PA_ALLOW_UI:-1}" \
  npx playwright test -c "$SUITE/playwright.config.mjs" "$@"
