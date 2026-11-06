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
    raise SystemExit("no free port in 6700-6799")
PY
}

# 端口一律写死来源（不读环境变量默认值）—— 本批有代理因继承 PORT=6677 误打过用户实例。
if [ -n "${SF_PORT:-}" ]; then PORT="$SF_PORT"; else PORT="$(pick_port)"; fi
if [ "$PORT" = "6677" ] || [ "$PORT" = "6689" ] || [ "$PORT" = "6710" ]; then
  echo "拒绝使用用户实例端口 $PORT" >&2; exit 1
fi

# 同一个套件不得同时跑两份(共用数据根与场景文件;并发会互相挪走对方在用的根):上一份还活着就拒绝。
mkdir -p "$SUITE/.artifacts"
LOCK="$SUITE/.artifacts/.run.lock"
if [ -f "$LOCK" ] && kill -0 "$(cat "$LOCK" 2>/dev/null)" 2>/dev/null; then
  echo "stripfold 套件已有一份在跑(pid $(cat "$LOCK"))，不并发跑第二份" >&2; exit 1
fi
echo "$$" > "$LOCK"
INSTANCE_PID=""
cleanup() {
  # 收尾两道：先杀自己起的那条，再按端口兜一次（实测服务端进程偶发脱离父 shell 存活）;最后放掉锁。
  if [ -n "$INSTANCE_PID" ]; then
    kill "$INSTANCE_PID" 2>/dev/null || true
    lsof -ti:"$PORT" 2>/dev/null | xargs -r kill 2>/dev/null || true
  fi
  if [ "$(cat "$LOCK" 2>/dev/null)" = "$$" ]; then rm -f "$LOCK"; fi
}
trap cleanup EXIT

# r154 后续(2026-11-06):每次运行前把上一轮的数据根改名挪开(不删),从干净的数据根起跑。
# 旧根里每跑一轮都会多出一批 cgui-title-* 临时工作区,累积到几十个后把 fixture-workspace 挤出侧栏前几项,
# newSessionInFixtureProject 在侧栏找不到夹具项目(实测 sf-2 六条因此红)。旧根留作 .prev-<时间>,在已忽略的 .artifacts 里,可随时手工清
# (每跑一次多留一份,量小;想沿用上一轮的根:SF_KEEP_ROOT=1)。
if [ -d "$ROOT" ] && [ "${SF_KEEP_ROOT:-}" != "1" ]; then mv "$ROOT" "$ROOT.prev-$(date +%Y%m%d-%H%M%S)"; fi

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

for _ in $(seq 1 60); do
  curl -sf -m 2 "http://127.0.0.1:$PORT/api/health" >/dev/null && break
  sleep 0.5
done
curl -sf -m 2 "http://127.0.0.1:$PORT/api/health" >/dev/null \
  || { echo "实例起不来（端口 $PORT）：看 $ROOT/server.log" >&2; exit 1; }

# 新数据根冷启动:后端的会话索引还没建好时,第一条用例(SF-100)会在 25 秒内看不到夹具会话(对照实验:新根两遍都红、沿用根两遍都不红)。
# 健康检查通过后再等"按夹具标记搜得到命中"(最多 60 秒);搜索请求本身也会把索引预热。
for _ in $(seq 1 120); do
  curl -sf -m 3 "http://127.0.0.1:$PORT/api/search?q=SF20260913STRIPA" 2>/dev/null | grep -q '"hits":\[{' && break
  sleep 0.5
done

echo "[SF] 隔离实例就绪：http://127.0.0.1:$PORT（数据根 $ROOT，server.log 同目录，pid $INSTANCE_PID）"
cd "$WORKTREE"
BASE_URL="http://127.0.0.1:$PORT" \
  npx playwright test -c "$SUITE/playwright.config.mjs" "$@"
