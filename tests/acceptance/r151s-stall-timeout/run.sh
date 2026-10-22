#!/usr/bin/env bash
# r151s 静默超时可设置 —— 验收,一条命令:
#   tests/acceptance/r151s-stall-timeout/run.sh                 # 全量(S01–S15)
#   tests/acceptance/r151s-stall-timeout/run.sh -g 'S07'        # 额外参数原样转给 playwright
# 结构照 r151h / r151n 的 run.sh:
#   - 接口用例(S01–S06)和看门狗用例(S07–S12)每条各起一次性实例(临时 HOME、自挑端口、用例自己 stop),全部走假 claude,不接真模型;
#   - 界面用例(S13–S15)用 run.sh 起的一个共享隔离实例 + vite dev server(页面来源 = 源码直出,/api、/ws 代理到隔离实例)。
# 隔离:HOME / USERPROFILE 全部指到本次运行的 .artifacts 目录,不读写真实 ~/.claude、~/.claude.json、~/.claude-gui;
# 端口只在 6700–6999 里挑空闲的,硬拒 6677 / 6689 / 6710(以及 8788 / 8789 / 8798 / 8799 / 8000);
# 收尾只按本套件记录里的 pid 收进程(instance-pids.txt、各实例假 claude 的 spawn.jsonl、本脚本起的两个进程),不用 pkill、不按端口段批量杀。
set -euo pipefail

SUITE="$(cd "$(dirname "$0")" && pwd)"
WORKTREE="$(cd "$SUITE/../../.." && pwd)"
ROOT="$SUITE/.artifacts/runs/$(date +%Y%m%d-%H%M%S)-$$"
LOGS="$ROOT/logs"
mkdir -p "$LOGS" "$ROOT/tmp"
export R151B_DATA_ROOT="$ROOT"
# 本机环境里残留的联调变量不能影响套件:时长一律由用例经 envExtra / 垫片显式给
unset CGUI_STALL_MS CGUI_KEEPALIVE_IDLE_MS

pick_port() {
  local exclude=" $* " port
  for port in $(seq 6700 6999); do
    case "$port" in 6677|6689|6710|8788|8789|8798|8799|8000) continue ;; esac
    case "$exclude" in *" $port "*) continue ;; esac
    if ! lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then echo "$port"; return 0; fi
  done
  echo "6700-6999 没有空闲端口" >&2; return 1
}
API_PORT="$(pick_port)"
UI_PORT="$(pick_port "$API_PORT")"
export R151S_API_PORT="$API_PORT" R151S_UI_PORT="$UI_PORT" R151S_UI_BASE="http://127.0.0.1:$UI_PORT" R151S_API_BASE="http://127.0.0.1:$API_PORT"
export R151S_HOME="$ROOT/home" R151S_VITE_CACHE="$ROOT/vite-cache"

node "$SUITE/helpers/home.mjs"

PIDS=()
VITE_PID=""
# 只收本套件记录里的 pid:一次性实例的 node server 记在 instance-pids.txt,假 claude 记在各自实例的 fake-claude/spawn.jsonl
recorded_pids() {
  {
    [ -f "$ROOT/instance-pids.txt" ] && cat "$ROOT/instance-pids.txt"
    for f in "$ROOT"/inst/*/home/fake-claude/spawn.jsonl "$ROOT"/home/fake-claude/spawn.jsonl; do
      [ -f "$f" ] || continue
      node -e 'const fs=require("fs");try{for(const l of fs.readFileSync(process.argv[1],"utf8").split("\n")){if(!l.trim())continue;try{const o=JSON.parse(l);if(o&&o.pid)console.log(o.pid)}catch{}}}catch{}' "$f" || true
    done
  } | sort -un
}
cleanup() {
  local p
  [ -n "$VITE_PID" ] && kill "$VITE_PID" 2>/dev/null || true
  for p in $(recorded_pids); do kill "$p" 2>/dev/null || true; done
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  sleep 1
  for p in $(recorded_pids); do kill -9 "$p" 2>/dev/null || true; done
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill -9 "$p" 2>/dev/null || true; done
}
trap cleanup EXIT

# ---- 共享隔离实例(界面用例用) ----
CTL="$ROOT/home/fake-claude"
cd "$ROOT"
env -i PATH="$ROOT/fakebin:$PATH" HOME="$ROOT/home" USERPROFILE="$ROOT/home" USER="${USER:-tester}" LOGNAME="${LOGNAME:-tester}" \
  SHELL=/bin/sh LANG=en_US.UTF-8 TMPDIR="$ROOT/tmp" PORT="$API_PORT" \
  CGUI_FAKE_CLAUDE_DIR="$CTL" CGUI_DISABLE_FILE_WATCHER=1 \
  nohup node "$WORKTREE/server/index.js" > "$LOGS/server.log" 2>&1 &
API_PID=$!; PIDS+=("$API_PID")
for _ in $(seq 1 60); do
  curl -sf -m 2 "http://127.0.0.1:$API_PORT/api/health" >/dev/null && break
  perl -e 'select(undef,undef,undef,0.5)'
done
kill -0 "$API_PID" 2>/dev/null || { echo "共享实例进程已退出:看 $LOGS/server.log" >&2; exit 1; }
lsof -nP -iTCP:"$API_PORT" -sTCP:LISTEN -t 2>/dev/null | grep -qx "$API_PID" \
  || { echo "端口 $API_PORT 上的监听者不是本实例(pid $API_PID)" >&2; exit 1; }
echo "[r151s] 共享隔离实例 http://127.0.0.1:$API_PORT(pid $API_PID,HOME=$ROOT/home)"

# ---- vite dev server(界面用例的页面来源) ----
( cd "$WORKTREE/client" && env R151S_API_PORT="$API_PORT" R151S_UI_PORT="$UI_PORT" R151S_VITE_CACHE="$R151S_VITE_CACHE" \
    nohup node "$WORKTREE/client/node_modules/vite/bin/vite.js" --config "$SUITE/vite.dev.config.mjs" \
    > "$LOGS/vite.log" 2>&1 & echo $! > "$LOGS/vite.pid" )
VITE_WRAPPER_PID="$(cat "$LOGS/vite.pid")"
PIDS+=("$VITE_WRAPPER_PID")
for _ in $(seq 1 100); do
  curl -sf -m 2 "http://127.0.0.1:$UI_PORT/" >/dev/null && break
  perl -e 'select(undef,undef,undef,0.5)'
done
LISTENER="$(lsof -nP -iTCP:"$UI_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)"
if [ -n "$LISTENER" ] && ps -p "$LISTENER" -o command= | grep -q "r151s-stall-timeout"; then
  VITE_PID="$LISTENER"
else
  echo "dev server 没起来或端口 $UI_PORT 上不是本套件的进程:看 $LOGS/vite.log" >&2; exit 1
fi
echo "[r151s] dev server http://127.0.0.1:$UI_PORT(pid $VITE_PID;/api、/ws 代理到 $API_PORT)"
echo "[r151s] 数据根 $ROOT"

cd "$WORKTREE"
set +e
"$WORKTREE/node_modules/.bin/playwright" test -c "$SUITE/playwright.config.mjs" "$@"
CODE=$?
set -e
echo "[r151s] playwright 退出码 $CODE(共享实例 $API_PID / dev server $VITE_PID;数据在 $ROOT)"
exit $CODE
