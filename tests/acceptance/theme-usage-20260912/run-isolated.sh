#!/usr/bin/env bash
# 一条命令跑整套 TU-*：自己起隔离实例（数据根 = 本套件 .artifacts/runtime-data），跑完杀掉。
#
#   ./run-isolated.sh                  # 全量
#   ./run-isolated.sh --grep 'TU-5'    # 额外参数原样转给 playwright
#   TU_PORT=6712 ./run-isolated.sh     # 指定端口（默认从 6700 起挑空闲，避开 6677/6689）
#
# 为什么必须用脚本起实例：手工起很容易复制到别套件的启动命令（HOME/数据根不一样），
# 或图省事复用一个早就跑着的旧实例 —— 那样跑出来的红全是假的。套件开跑前还会预检一次
# （global-setup.mjs）。
#
# 端口：绝不用 6677 / 6689（用户正在用的实例）。
set -euo pipefail

SUITE="$(cd "$(dirname "$0")" && pwd)"
WORKTREE="$(cd "$SUITE/../../.." && pwd)"
ROOT="$SUITE/.artifacts/runtime-data"

# 端口从 6700 起挑一个空闲的（避开用户实例 6677 / 6689；6700-6799 里都被占才退回随机高位端口）。
pick_port() {
  python3 - <<'PY'
import socket
def free(port):
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()
for port in range(6700, 6800):
    if port in (6677, 6689):
        continue
    if free(port):
        print(port)
        raise SystemExit
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
}
PORT="${TU_PORT:-$(pick_port)}"

mkdir -p "$ROOT/home/.claude" "$ROOT/home/.claude-gui" "$ROOT/fixture-workspace"
cd "$ROOT"
env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_MODEL \
  HOME="$ROOT/home" PORT="$PORT" CGUI_DISABLE_FILE_WATCHER=1 CGUI_ENABLE_LOCAL_ROUTES=1 CGUI_TAURI=1 \
  nohup node "$WORKTREE/server/index.js" > "$ROOT/server.log" 2>&1 &
INSTANCE_PID=$!
# 收尾两道：先杀自己起的那条，再按端口兜一次（实测服务端进程偶发脱离父 shell 存活，
# 留着会在同一数据根上继续跑，下一次跑套件时容易被误当成本次实例）。
cleanup() {
  kill "$INSTANCE_PID" 2>/dev/null || true
  lsof -ti:"$PORT" 2>/dev/null | xargs -r kill 2>/dev/null || true
}
trap cleanup EXIT

for _ in $(seq 1 60); do
  curl -sf -m 2 "http://127.0.0.1:$PORT/api/health" >/dev/null && break
  sleep 0.5
done
curl -sf -m 2 "http://127.0.0.1:$PORT/api/health" >/dev/null \
  || { echo "实例起不来（端口 $PORT）：看 $ROOT/server.log" >&2; exit 1; }

cd "$WORKTREE"
BASE_URL="http://127.0.0.1:$PORT" \
  npx playwright test -c "$SUITE/playwright.config.mjs" "$@"
