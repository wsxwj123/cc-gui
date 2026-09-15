#!/usr/bin/env bash
# 一条命令跑 Q8-13(进程早退被误报成初始化超时)的隔离验收:
#   ./run-isolated.sh            # 自己挑 6700–6999 的空闲端口起隔离实例,跑完按 pid 收尾
#   Q8_PORT=6740 ./run-isolated.sh
#
# 端口:硬拒用户正在用的 6677 / 6689 与他项目占用的 6710。
# HOME:一律指到本套件 .artifacts/runtime-data/home,绝不碰 ~/.claude、~/.claude-gui。
# 假 claude 挂在 PATH 最前(helpers/fake-claude-earlyexit.mjs),不碰真 CLI 与真凭证。
set -euo pipefail

SUITE="$(cd "$(dirname "$0")" && pwd)"
WORKTREE="$(cd "$SUITE/../../.." && pwd)"

pick_port() {
  python3 - <<'PY'
import socket
for port in range(6700, 7000):
    if port in (6677, 6689, 6710):
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

PORT="${Q8_PORT:-$(pick_port)}"
case "$PORT" in 6677|6689|6710) echo "拒绝使用端口 $PORT(用户实例/他项目)" >&2; exit 1;; esac

cd "$WORKTREE"
set +e
env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_MODEL -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN \
  Q8_PORT="$PORT" WORKTREE="$WORKTREE" \
  node "$SUITE/q13-early-exit.spec.mjs"
CODE=$?
set -e
echo "[quality8] 端口 $PORT,实例日志 $SUITE/.artifacts/runtime-data/server.log"
exit $CODE
