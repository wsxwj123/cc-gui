#!/usr/bin/env bash
# 隧道鉴权验收测试入口:bash tests/acceptance/run-tunnel.sh
#
# 做什么:
#   1. 备份 ~/.claude-gui/network.json(与生产实例共享,跑完逐字节还原,trap 兜底)
#   2. 起开发仓 server 到独立端口(16677-16681 候选,绝不碰生产 6677)
#   3. 三个相位跑 tests/acceptance/tunnel-*.acceptance.mjs
#   4. 杀测试 server、还原配置、cmp 验证逐字节一致
#
# 需要真实密码的成功路径:CGUI_TEST_PASSWORD=<你的登录密码> bash tests/acceptance/run-tunnel.sh
#   不传也能跑:login/限速/带cookie的用例整体 SKIP,其余照跑。
#
# 退出码:任一断言失败 → 非零;仅 SKIP → 0。

set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1

CONF="$HOME/.claude-gui/network.json"
TUNNEL_HOSTNAME="${TUNNEL_HOSTNAME:-tunnel.example.com}"
[ -f "$CONF" ] || { echo "缺 $CONF,无法备份/写配置"; exit 1; }

BACKUP="$(mktemp -t cgui-network-backup)" || exit 1
cp -p "$CONF" "$BACKUP" || { echo "备份失败"; exit 1; }
SRV_LOG="$(mktemp -t cgui-tunnel-server-log)"
SRV_PID=""
FAIL=0

cleanup() {
  [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null
  cp -p "$BACKUP" "$CONF"
  if cmp -s "$BACKUP" "$CONF"; then
    echo "[restore] network.json 已逐字节还原(cmp 通过)"
  else
    echo "[restore] 还原后与原值不一致!手工备份在:$BACKUP" >&2
    FAIL=1
  fi
  rm -f "$BACKUP"
  exit $FAIL
}
trap cleanup EXIT INT TERM

# 只改 tunnelHostname 一个键,其余字段原样保留
edit_conf() {
  node -e '
    const fs = require("fs");
    const [p, mode, val] = process.argv.slice(1);
    const o = JSON.parse(fs.readFileSync(p, "utf8"));
    if (mode === "unset") delete o.tunnelHostname; else o.tunnelHostname = val;
    fs.writeFileSync(p, JSON.stringify(o, null, 2) + "\n");
  ' "$CONF" "$@"
}

run_suite() {
  echo
  echo "== $(basename "$1") =="
  node "$1" || FAIL=1
}

[ -n "${CGUI_TEST_PASSWORD:-}" ] || {
  echo "提示:未设 CGUI_TEST_PASSWORD,login/限速/带cookie用例将 SKIP。"
  echo "      完整跑:CGUI_TEST_PASSWORD=<登录密码> $0"
}

# ── 相位 1:无 tunnelHostname(回归零差异)────────────────────────
edit_conf unset

PORT=""
for p in 16677 16678 16679 16680 16681; do
  PORT="$p" HOST="0.0.0.0" CGUI_DISABLE_FILE_WATCHER=1 CGUI_ENABLE_LOCAL_ROUTES=0 \
    node server/index.js >"$SRV_LOG" 2>&1 &
  SRV_PID=$!
  ok=""
  for _ in $(seq 1 40); do
    if curl -sf "http://127.0.0.1:$p/api/health" >/dev/null 2>&1; then ok=1; break; fi
    kill -0 "$SRV_PID" 2>/dev/null || break
    sleep 0.25
  done
  if [ -n "$ok" ]; then PORT="$p"; break; fi
  kill "$SRV_PID" 2>/dev/null; wait "$SRV_PID" 2>/dev/null; SRV_PID=""; PORT=""
done
if [ -z "$PORT" ]; then
  echo "测试 server 起不来(候选端口 16677-16681)。日志:" >&2
  tail -30 "$SRV_LOG" >&2
  exit 1
fi
[ "$PORT" = "6677" ] && { echo "绝不许用 6677" >&2; exit 1; }
export CGUI_TEST_PORT="$PORT" TUNNEL_HOSTNAME
echo "测试 server:127.0.0.1:$PORT / LAN 也可达(PID $SRV_PID)。生产 6677 全程不触碰。"

run_suite tests/acceptance/tunnel-noconfig.acceptance.mjs

# ── 相位 2:写入占位 tunnelHostname(同一进程,验"每请求现读")────────
edit_conf set "$TUNNEL_HOSTNAME"
echo
echo "[config] tunnelHostname=$TUNNEL_HOSTNAME 已写入(server 未重启,PID 仍是 $SRV_PID)"
run_suite tests/acceptance/tunnel-matrix-anon.acceptance.mjs
run_suite tests/acceptance/tunnel-login.acceptance.mjs
run_suite tests/acceptance/tunnel-ws.acceptance.mjs

# ── 相位 3:非法值(写错不炸,隧道域名依旧 403)────────────────────
for bad in "https://$TUNNEL_HOSTNAME" "$TUNNEL_HOSTNAME:443"; do
  edit_conf set "$bad"
  echo
  echo "[config] 写入非法 tunnelHostname=$bad"
  run_suite tests/acceptance/tunnel-badconfig.acceptance.mjs
done

echo
echo "全部相位结束。失败即非零退出。"
exit $FAIL
