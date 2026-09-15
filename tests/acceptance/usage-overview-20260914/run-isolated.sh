#!/usr/bin/env bash
# 一条命令跑「用量总览冷启动」验收:
#   ./run-isolated.sh          # U1~U7 + U10(合成夹具,秒级)
#   ./run-isolated.sh --ui     # UI-1/UI-2(浏览器层:stale 文案 + 广播→静默刷新)
#   ./run-isolated.sh --real   # U8(只读软链真实 ~/.claude/projects,会真读 6GB+)
#   ./run-isolated.sh --u9     # U9(回归既有三个套件;在 /tmp 复印件里跑,不动原目录)
#   USAGE_PORT=6750 ./run-isolated.sh
#
# 端口:默认从 6700 起挑空闲,**硬拒用户正在用的 6677 / 6689**。
# --ui 需要 client/dist 是**当前源码构建出来的**(ui-runtime.mjs 会预检,旧了直接报环境错):
#   cd client && npx vite build
# HOME:一律指到本套件 .artifacts/runtime-data/home*,绝不碰用户的 ~/.claude、~/.claude-gui。
# 为什么必须脚本起:手工起很容易把夹具 HOME / 端口配串,跑出来的红全是假的。
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

PORT="${USAGE_PORT:-$(pick_port)}"
if [ "$PORT" = "6677" ] || [ "$PORT" = "6689" ]; then
  echo "拒绝使用用户实例端口 $PORT" >&2
  exit 1
fi

cd "$WORKTREE"
mkdir -p "$ROOT"
set +e
case "${1:-}" in
  --real)
    env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_MODEL -u ANTHROPIC_API_KEY \
      HOME="$HOME" WORKTREE="$WORKTREE" USAGE_PORT="$PORT" \
      node "$SUITE/real-data.mjs"
    ;;
  --u9)
    "$SUITE/u9-regression.sh"
    ;;
  --ui)
    # HOME 不指到夹具:playwright 自己的浏览器在 ~/Library/Caches 里找,指歪了起不来。
    # 实例的 HOME 由 spec 的 startInstance 逐实例给(= 夹具 home)。
    shift
    env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_MODEL -u ANTHROPIC_API_KEY \
      USAGE_PORT="$PORT" WORKTREE="$WORKTREE" \
      npx playwright test -c "$SUITE/playwright.config.mjs" "$@"
    ;;
  *)
    env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_MODEL -u ANTHROPIC_API_KEY \
      HOME="$ROOT/home" USERPROFILE="$ROOT/home" USAGE_PORT="$PORT" WORKTREE="$WORKTREE" \
      node "$SUITE/usage-cold.spec.mjs"
    ;;
esac
CODE=$?
set -e
echo "[usage-overview] 端口 $PORT,实例日志 $ROOT/logs/"
exit $CODE
