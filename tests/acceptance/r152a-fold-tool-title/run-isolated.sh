#!/usr/bin/env bash
# 一条命令跑整套 B1~B11：自己起隔离实例（数据根 = 本套件 .artifacts/runtime-data），跑完只杀自己起的那条 pid。
#
#   bash tests/acceptance/r152a-fold-tool-title/run-isolated.sh                 # 全量
#   bash tests/acceptance/r152a-fold-tool-title/run-isolated.sh --grep 'B1 '    # 额外参数原样转给 playwright
#   R152A_PORT=6781 bash .../run-isolated.sh                                    # 指定端口（只许 6700–6999）
#
# 端口：只在 6700–6999 里挑**当前空闲**的；硬拒 6677 / 6689 / 6710 / 8798 / 8799（用户在用或别人占用）。
# 实例必须由本脚本起（HOME / 数据根 / PATH 上的假 claude 都在这里定死），不复用任何已在跑的实例。
set -euo pipefail

SUITE="$(cd "$(dirname "$0")" && pwd)"
WORKTREE="$(cd "$SUITE/../../.." && pwd)"
ROOT="$SUITE/.artifacts/runtime-data"
DENY=" 6677 6689 6710 8798 8799 "

pick_port() {
  python3 - <<'PY'
import socket
deny = {6677, 6689, 6710, 8798, 8799}
for port in range(6700, 7000):
    if port in deny:
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
    raise SystemExit("no free port in 6700-6999")
PY
}

# 端口一律写死来源（不读 PORT 等环境变量）—— 防止继承到用户实例的 PORT=6677。
if [ -n "${R152A_PORT:-}" ]; then PORT="$R152A_PORT"; else PORT="$(pick_port)"; fi
case "$PORT" in ''|*[!0-9]*) echo "端口必须是数字：$PORT" >&2; exit 1;; esac
if [[ "$DENY" == *" $PORT "* ]] || [ "$PORT" -lt 6700 ] || [ "$PORT" -gt 6999 ]; then
  echo "拒绝端口 $PORT：只允许 6700–6999，且不得是 6677/6689/6710/8798/8799" >&2; exit 1
fi
if [ ! -f "$WORKTREE/client/dist/index.html" ]; then
  echo "缺少 client/dist（本套件跑构建产物，不自动 rebuild）：先在 client/ 下 npx vite build" >&2; exit 1
fi

node "$SUITE/helpers/fixtures.mjs" >/dev/null

mkdir -p "$ROOT/home/.claude" "$ROOT/home/.claude-gui" "$ROOT/fixture-workspace"

cd "$ROOT"
env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_MODEL -u ANTHROPIC_API_KEY \
  -u CLAUDE_CODE_OAUTH_TOKEN \
  HOME="$ROOT/home" USERPROFILE="$ROOT/home" PORT="$PORT" \
  PATH="$SUITE/.artifacts/fakebin:$PATH" \
  CGUI_FAKE_CLAUDE_DIR="$ROOT/home/fake-claude" \
  CGUI_DISABLE_FILE_WATCHER=1 CGUI_ENABLE_LOCAL_ROUTES=1 \
  nohup node "$WORKTREE/server/index.js" > "$ROOT/server.log" 2>&1 &
INSTANCE_PID=$!
# 收尾：只按自己记录的 pid 收（先温和、再强制），绝不按端口 / 进程名去杀别的进程。
cleanup() {
  kill "$INSTANCE_PID" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$INSTANCE_PID" 2>/dev/null || break; sleep 0.5; done
  kill -9 "$INSTANCE_PID" 2>/dev/null || true
}
trap cleanup EXIT

for _ in $(seq 1 60); do
  curl -sf -m 2 "http://127.0.0.1:$PORT/api/health" >/dev/null && break
  sleep 0.5
done
curl -sf -m 2 "http://127.0.0.1:$PORT/api/health" >/dev/null \
  || { echo "实例起不来（端口 $PORT）：看 $ROOT/server.log" >&2; exit 1; }

echo "[R152A] 隔离实例就绪：http://127.0.0.1:$PORT（数据根 $ROOT，pid $INSTANCE_PID）"
cd "$WORKTREE"
BASE_URL="http://127.0.0.1:$PORT" \
  npx playwright test -c "$SUITE/playwright.config.mjs" "$@"
