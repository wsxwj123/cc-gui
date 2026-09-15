#!/usr/bin/env bash
# 一条命令跑整套「加载慢」验收:自己挑空闲端口、自己铺夹具、用夹具 HOME 跑用例,
# 用例自己起停隔离实例(要重启进程量冷态),跑完按 pid 收尾。
#
#   ./run-isolated.sh                 # 夹具口径(默认,含 G1~G6 + 反向用例 + 数据对拍)
#   ./run-isolated.sh --real          # 真实数据口径(只读 ~/.claude/projects,函数级)
#   SLOWLOAD_PORT=6750 ./run-isolated.sh
#
# 端口:默认在 6700-6799 里挑一个当前空闲的,**硬拒用户的 6677 / 6689**。
# 为什么必须脚本起:手工起很容易把夹具 HOME / 索引目录 / 端口配串,跑出来的红全是假的。
set -euo pipefail

SUITE="$(cd "$(dirname "$0")" && pwd)"
WORKTREE="$(cd "$SUITE/../../.." && pwd)"
ROOT="$SUITE/.artifacts/runtime-data"
REAL_HOME="${HOME}"

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

if [ "${1:-}" = "--real" ]; then
  # 真实数据口径:不起服务端(免得写用户的运行态),只在函数级量 G1~G4。
  cd "$WORKTREE"
  REAL_HOME="$REAL_HOME" WORKTREE="$WORKTREE" node "$SUITE/real-data.mjs"
  exit $?
fi

PORT="${SLOWLOAD_PORT:-$(pick_port)}"
[ "$PORT" != "6677" ] && [ "$PORT" != "6689" ] || { echo "拒绝使用用户实例端口 $PORT" >&2; exit 1; }

node "$SUITE/helpers/fixtures.mjs" > /dev/null

cd "$WORKTREE"
set +e
env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_MODEL -u ANTHROPIC_API_KEY \
  HOME="$ROOT/home" USERPROFILE="$ROOT/home" SLOWLOAD_PORT="$PORT" WORKTREE="$WORKTREE" \
  node "$SUITE/slowload.spec.mjs"
CODE=$?
set -e
echo "[slowload] 端口 $PORT、实例日志 $ROOT/server.log"
exit $CODE
