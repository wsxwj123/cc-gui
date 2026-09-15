#!/usr/bin/env bash
# 一条命令跑整套 T-1xx：自己起隔离实例（数据根 = 本套件 .artifacts/runtime-data），跑完杀掉。
#
#   ./run-isolated.sh                  # 全量
#   ./run-isolated.sh --grep 'T-1'     # 额外参数原样转给 playwright
#   BUGS_PORT=6750 ./run-isolated.sh   # 指定端口
#
# 端口：默认在 6700+ 里挑一个**当前空闲**的（避开用户正在用的 6677 / 6689）。
# 为什么必须脚本起实例：手工起很容易复制到别套件的启动命令（HOME/数据根不一样），
# 或图省事复用一个早就跑着的旧实例 —— 那样跑出来的红全是假的。
set -euo pipefail

SUITE="$(cd "$(dirname "$0")" && pwd)"
WORKTREE="$(cd "$SUITE/../../.." && pwd)"
ROOT="$SUITE/.artifacts/runtime-data"

pick_port() {
  python3 - <<'PY'
import socket
for port in range(6700, 6800):
    if port in (6677, 6689):
        continue
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", port))
        s.close()
        print(port)
        break
    except OSError:
        s.close()
        continue
else:
    raise SystemExit("no free port in 6700-6799")
PY
}

PORT="${BUGS_PORT:-$(pick_port)}"
[ "$PORT" != "6677" ] && [ "$PORT" != "6689" ] || { echo "拒绝使用用户实例端口 $PORT" >&2; exit 1; }

# 夹具（会话 / 生图历史 / 大文件）——幂等，已存在就跳过。
node "$SUITE/helpers/fixtures.mjs" >/dev/null

cd "$ROOT"
env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_MODEL -u ANTHROPIC_API_KEY \
  HOME="$ROOT/home" PORT="$PORT" CGUI_DISABLE_FILE_WATCHER=1 CGUI_ENABLE_LOCAL_ROUTES=1 \
  nohup node "$WORKTREE/server/index.js" > "$ROOT/server.log" 2>&1 &
INSTANCE_PID=$!
trap 'kill "$INSTANCE_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  curl -sf -m 2 "http://127.0.0.1:$PORT/api/health" >/dev/null && break
  sleep 0.5
done
curl -sf -m 2 "http://127.0.0.1:$PORT/api/health" >/dev/null \
  || { echo "实例起不来（端口 $PORT）：看 $ROOT/server.log" >&2; exit 1; }

echo "[BUGS] 隔离实例就绪：http://127.0.0.1:$PORT（数据根 $ROOT，server.log 同目录）"
cd "$WORKTREE"
BASE_URL="http://127.0.0.1:$PORT" \
  npx playwright test -c "$SUITE/playwright.config.mjs" "$@"
