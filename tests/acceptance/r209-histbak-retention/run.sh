#!/usr/bin/env bash
# 一条命令跑整套 r209(会话记录备份保留规则):
#   bash tests/acceptance/r209-histbak-retention/run.sh              # 全量
#   bash tests/acceptance/r209-histbak-retention/run.sh -g L1        # 额外参数原样转给 playwright(两段都转;没匹配到用例的那段不算失败)
# 两个隔离后端(都用假家目录,绝不碰真实 ~/.claude、~/.claude-gui):
#   后端 A 端口 6811(开发服务器 6812):自动清理首轮延迟 2147483647 ms(用例期间不会自己清),跑 b/c/d 三组用例。
#   后端 B 端口 6813:首轮延迟 10000 ms、定时间隔 1000 ms,只跑 a-sweep(自动清理的时间线);B 在第二段开始前一刻才起,
#     因为它的时钟从「开始监听」算起。夹具文件在 B 起来之前一刻写好。
# 隔离:HOME 与 USERPROFILE 都指到 .artifacts/runtime-data/<home|home-sweep>;后端带 tests/unit/q8-helpers/cu-preload.mjs,CU_TEST_HOME 指向同一处;
#       PATH 最前面挂假 claude;ANTHROPIC_* / CU_ALLOW_* / CLAUDE_CODE_* 一律剥掉;文件监听关闭;sandbox-exec 挡一切对外网络(只放行本机后端端口)与 /usr/bin/security。
# 收尾:只按 .artifacts/pids 里记录的 pid 结束进程,不 pkill、不按端口或进程名杀。
# 本套件不要和别的验收套件同时运行,也不要同时跑两份。
set -uo pipefail

SUITE="$(cd "$(dirname "$0")" && pwd)"
ART="$SUITE/.artifacts"
WORKTREE="$(cd "$SUITE/../../.." && pwd)"
ROOT="$ART/runtime-data"
PIDFILE="$ART/pids"
APORT=6811
VPORT=6812
BPORT=6813
for p in "$APORT" "$VPORT" "$BPORT"; do
  case " 6677 6689 6710 8788 8789 8798 8799 " in *" $p "*) echo "拒绝端口 $p" >&2; exit 1;; esac
  [ -z "$(lsof -nP -iTCP:"$p" -sTCP:LISTEN -t 2>/dev/null || true)" ] || { echo "端口 $p 已被占用(lsof 查到监听者),不抢,退出" >&2; exit 1; }
done

for v in $(env | grep -oE '^(CU_ALLOW_|ANTHROPIC_|CLAUDE_CODE_|CGUI_HISTBAK_)[A-Za-z0-9_]*'); do unset "$v"; done
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy
export NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost

# 套件自己的 .artifacts 是可重建的临时目录:每次从干净状态开始(只删这一个固定子目录,且先确认路径形态)
case "$ART" in */tests/acceptance/r209-histbak-retention/.artifacts) rm -rf "$ROOT" "$ART/playwright" "$ART/playwright-sweep";; *) echo "路径异常,退出" >&2; exit 1;; esac
mkdir -p "$ART" "$ROOT"
for pair in "A:$APORT" "B:$BPORT"; do
  cat > "$ART/sandbox-${pair%%:*}.sb" <<SBEOF
(version 1)
(allow default)
(deny network-outbound (remote ip "*:*"))
(allow network-outbound (remote ip "localhost:${pair##*:}"))
(deny process-exec (literal "/usr/bin/security"))
SBEOF
done
: > "$PIDFILE"

cleanup() {
  local name pid i alive
  [ -f "$PIDFILE" ] || return 0
  while read -r name pid; do [ -n "${pid:-}" ] && kill "$pid" 2>/dev/null || true; done < "$PIDFILE"
  for i in 1 2 3 4 5 6 7 8 9 10; do
    alive=0
    while read -r name pid; do if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then alive=1; fi; done < "$PIDFILE"
    [ "$alive" = 0 ] && break
    sleep 0.5
  done
  while read -r name pid; do if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" 2>/dev/null || true; fi; done < "$PIDFILE"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# 起一个后端:start_backend <名字> <端口> <假家目录> <沙箱文件> <首轮延迟> <间隔或空>
start_backend() {
  local name="$1" port="$2" home="$3" sb="$4" delay="$5" interval="$6"
  local extra=()
  [ -n "$interval" ] && extra+=("CGUI_HISTBAK_SWEEP_INTERVAL_MS=$interval")
  cd "$ROOT"
  env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_MODEL -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN \
    HOME="$home" USERPROFILE="$home" CU_TEST_HOME="$home" PORT="$port" PATH="$ART/fakebin:$PATH" \
    CGUI_FAKE_CLAUDE_DIR="$home/fake-claude" CGUI_DISABLE_FILE_WATCHER=1 CGUI_HISTBAK_SWEEP_DELAY_MS="$delay" ${extra[@]+"${extra[@]}"} \
    nohup sandbox-exec -f "$sb" node --import "$WORKTREE/tests/unit/q8-helpers/cu-preload.mjs" "$WORKTREE/server/index.js" \
    > "$ROOT/server-$name.stdout.log" 2> "$ROOT/server-$name.stderr.log" &
  echo "backend-$name $!" >> "$PIDFILE"
  local i
  for i in $(seq 1 60); do curl -sf -m 2 "http://127.0.0.1:$port/api/health" >/dev/null && return 0; sleep 0.5; done
  echo "后端 $name 起不来(端口 $port):看 $ROOT/server-$name.*.log" >&2; return 1
}

node "$SUITE/helpers/fixtures.mjs" main >/dev/null || { echo "夹具(main)生成失败" >&2; exit 1; }
start_backend A "$APORT" "$ROOT/home" "$ART/sandbox-A.sb" 2147483647 "" || exit 1

cd "$WORKTREE/client"
env HOME="$ROOT/home" USERPROFILE="$ROOT/home" R209_BACKEND_PORT="$APORT" \
  nohup node node_modules/vite/bin/vite.js --config "$SUITE/vite.isolated.config.mjs" --host 127.0.0.1 --port "$VPORT" --strictPort > "$ROOT/vite.log" 2>&1 &
echo "vite $!" >> "$PIDFILE"
cd "$WORKTREE"
for _ in $(seq 1 120); do curl -sf -m 3 "http://127.0.0.1:$VPORT/" >/dev/null && break; sleep 0.5; done
curl -sf -m 3 "http://127.0.0.1:$VPORT/" >/dev/null || { echo "Vite 起不来(端口 $VPORT):看 $ROOT/vite.log" >&2; exit 1; }

echo "[R209] 第一段:后端 A=$APORT 页面 http://127.0.0.1:$VPORT(数据根 $ROOT)"
set +e
BASE_URL="http://127.0.0.1:$VPORT" R209_BACKEND_URL="http://127.0.0.1:$APORT" npx playwright test -c "$SUITE/playwright.config.mjs" --pass-with-no-tests "$@"
rc1=$?

# 第二段:先写夹具,紧接着起后端 B,再马上开跑(B 的首轮在监听后 10 秒)
node "$SUITE/helpers/fixtures.mjs" sweep >/dev/null || { echo "夹具(sweep)生成失败" >&2; exit 1; }
start_backend B "$BPORT" "$ROOT/home-sweep" "$ART/sandbox-B.sb" 10000 1000 || exit 1
echo "[R209] 第二段:后端 B=$BPORT(首轮 10s、间隔 1s)"
node "$SUITE/helpers/record-sweep.mjs"
R209_BACKEND_URL="http://127.0.0.1:$BPORT" npx playwright test -c "$SUITE/playwright.sweep.config.mjs" --pass-with-no-tests "$@"
rc2=$?
echo "R209-EXIT first=$rc1 sweep=$rc2"
[ "$rc1" = 0 ] && [ "$rc2" = 0 ]
