#!/usr/bin/env bash
# r151u 收尾等待窗内接着开始的回合不应被提前收尾 —— 验收,一条命令:
#   tests/acceptance/r151u-prediction-early-done/run.sh                 # 全量(U01–U12)
#   tests/acceptance/r151u-prediction-early-done/run.sh -g 'U07'        # 额外参数原样转给 playwright
# 机器可读报告:环境变量 R151U_PW_JSON 指定路径,没设就落 <套件>/.artifacts/last-run.json。
# 每条用例各起一次性实例(临时 HOME、自挑端口、用例自己 stop),全走假命令行(helpers/fx-cli.mjs),不接模型、不用密钥,不需要页面 / vite / 浏览器。
# 隔离:HOME / USERPROFILE / TMPDIR 指到本次运行的 .artifacts 目录,不读写真实 ~/.claude、~/.claude.json、~/.claude-gui;
# 端口只在 6700–6999 里挑空闲的,跳过 6677 / 6689 / 6710 / 8000 / 8788 / 8789 / 8798 / 8799;
# 收尾只按本套件记录里的 pid 收进程(instance-pids.txt、各实例假命令行的 spawn.jsonl),且先核对命令行,不用 pkill / killall、不按端口段批量杀。
set -euo pipefail

SUITE="$(cd "$(dirname "$0")" && pwd)"
WORKTREE="$(cd "$SUITE/../../.." && pwd)"
ROOT="$SUITE/.artifacts/runs/$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$ROOT/tmp" "$ROOT/logs"
export R151U_DATA_ROOT="$ROOT"
export R151U_PW_JSON="${R151U_PW_JSON:-$SUITE/.artifacts/last-run.json}"
mkdir -p "$(dirname "$R151U_PW_JSON")"
# 本机环境里残留的联调变量不能影响套件:时长一律由用例经 envExtra 显式给
unset CGUI_STALL_MS CGUI_KEEPALIVE_IDLE_MS

# 记录里的 pid:服务进程(核对命令行含 server/index.js)、假命令行(核对含 fx-cli.mjs)
reap() {
  local sig="$1" p
  if [ -f "$ROOT/instance-pids.txt" ]; then
    for p in $(sort -un "$ROOT/instance-pids.txt"); do
      ps -p "$p" -o command= 2>/dev/null | grep -q "server/index.js" && kill "-$sig" "$p" 2>/dev/null || true
    done
  fi
  for f in "$ROOT"/inst/*/home/fake-cli/spawn.jsonl; do
    [ -f "$f" ] || continue
    for p in $(node -e 'const fs=require("fs");const s=new Set();for(const l of fs.readFileSync(process.argv[1],"utf8").split("\n")){try{const o=JSON.parse(l);if(o&&o.pid)s.add(o.pid)}catch{}}console.log([...s].join(" "))' "$f"); do
      ps -p "$p" -o command= 2>/dev/null | grep -q "fx-cli.mjs" && kill "-$sig" "$p" 2>/dev/null || true
    done
  done
}
cleanup() { reap TERM; sleep 1; reap KILL; }
trap cleanup EXIT

echo "[r151u] 数据根 $ROOT"
cd "$WORKTREE"
set +e
"$WORKTREE/node_modules/.bin/playwright" test -c "$SUITE/playwright.config.mjs" "$@"
CODE=$?
set -e
echo "[r151u] playwright 退出码 $CODE(JSON 报告 $R151U_PW_JSON;数据在 $ROOT)"
exit $CODE
