#!/usr/bin/env bash
# 一条命令跑整套 SF-*：自己起隔离实例（数据根 = 本套件 .artifacts/runtime-data），跑完杀掉。
#
#   ./run-isolated.sh                  # 全量（含 120s 静置与 60 格拖拽两条慢用例）
#   ./run-isolated.sh --grep 'SF-1'    # 额外参数原样转给 playwright
#   SF_PORT=6781 ./run-isolated.sh     # 指定端口
#
# 端口：默认在 6700+ 里挑一个**当前空闲**的（避开用户正在用的 6677 / 6689）。
# 为什么必须脚本起实例：手工起很容易复制到别套件的启动命令（HOME/数据根/fakebin 不一样），
# 或图省事复用一个早就跑着的旧实例 —— 那样跑出来的红全是假的。
#
# PATH 上挂**假 claude**（helpers/fake-claude.mjs 的薄壳）：真回合的现场（流式/中断/报错/权限弹窗）
# 全靠它造，不碰用户的真 CLI 与真凭证。
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

# 端口一律写死来源（不读环境变量默认值）—— 本批有代理因继承 PORT=6677 误打过用户实例。
if [ -n "${SF_PORT:-}" ]; then PORT="$SF_PORT"; else PORT="$(pick_port)"; fi
if [ "$PORT" = "6677" ] || [ "$PORT" = "6689" ]; then
  echo "拒绝使用用户实例端口 $PORT" >&2; exit 1
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
# 收尾两道：先杀自己起的那条，再按端口兜一次（实测服务端进程偶发脱离父 shell 存活）。
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

echo "[SF] 隔离实例就绪：http://127.0.0.1:$PORT（数据根 $ROOT，server.log 同目录，pid $INSTANCE_PID）"
cd "$WORKTREE"
BASE_URL="http://127.0.0.1:$PORT" \
  npx playwright test -c "$SUITE/playwright.config.mjs" "$@"
