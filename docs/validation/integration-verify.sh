#!/bin/bash
# 全量验证(在仓库根目录跑):bash docs/validation/integration-verify.sh [port]
#
# 合同(.devflow/INTERFACE.md「终端与代码块」末段):
#   - 省略端口:为本次验证自选空闲端口,不默认接管 6689/6677
#   - 给定非法/已占用端口:立即非零退出,且绝不杀占用者
#   - 语法、必需测试、MCP schema、生产构建、端点检查每项都成功才输出「全量验证通过」并退出 0
#   - 缺依赖/平台跑不了必需项/响应字段不符/工具超时/任一命令非零 → 整体非零 + 失败清单,不输出全过
#   - 必需检查不能靠 SKIP 变通过;脚本只结束自己启动的实例,完整日志留在 RUN_DIR
# 改动注意:不要改回 `npm run build:local` —— 它会跑 gen-release-notes.mjs 覆盖用户
# release-notes 脏文件;这里只做生产构建(vite build)。
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
ROOT="$PWD"

RUN_DIR=$(mktemp -d "${TMPDIR:-/tmp}/cc-gui-verify.XXXXXX") || { echo "无法创建临时目录" >&2; exit 2; }
mkdir -p "$RUN_DIR/home"
SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null; }
# 信号:先结束自己的实例再退出。只挂 EXIT 会被 SIGTERM 吞掉(外层超时杀不动脚本)
on_signal() { echo "$(basename "$0") 收到终止信号,清理自己的实例后退出" >&2; cleanup; exit 3; }
trap cleanup EXIT
trap on_signal INT TERM

die() { echo "$1" >&2; exit 2; }

# 端口占用探测:0.0.0.0 与 127.0.0.1 都必须能绑定,且此刻没有进程在监听。
# 只试 0.0.0.0 是不够的 —— macOS 允许 127.0.0.1:P 与 0.0.0.0:P 同时存在,只绑后者
# 会漏判"已被 127.0.0.1 占用"的端口(实测:占用者活着,脚本却继续往下跑)。
port_is_free() {
  node -e '
    const net = require("net");
    const port = Number(process.argv[1]);
    const tryBind = (host) => new Promise((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(false));
      srv.listen(port, host, () => srv.close(() => resolve(true)));
    });
    const tryConnect = () => new Promise((resolve) => {
      const sock = net.connect({ port, host: "127.0.0.1" });
      const done = (v) => { sock.destroy(); resolve(v); };
      sock.once("connect", () => done(true));
      sock.once("error", () => done(false));
      setTimeout(() => done(false), 1000);
    });
    (async () => {
      const v4 = await tryBind("0.0.0.0");
      const v1 = v4 && await tryBind("127.0.0.1");
      const busy = v1 ? await tryConnect() : true;
      process.exit(v4 && v1 && !busy ? 0 : 1);
    })();
  ' "$1" >/dev/null 2>&1
}

if [ "$#" -ge 1 ] && [ -n "${1:-}" ]; then
  case "$1" in
    *[!0-9]*) die "端口非法:$1(需 1-65535 的整数),本次验证未运行" ;;
  esac
  { [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; } || die "端口超范围:$1"
  port_is_free "$1" || die "端口 $1 已被占用,拒绝接管(请换端口,或先自行停掉占用者)"
  PORT="$1"
else
  # 用 process.stdout.write 而不是 console.log:调用方可能带 FORCE_COLOR=1(Playwright
  # worker 就会设),Node 会把 console.log 的数字也套上 ANSI 色码,端口就变成带转义的
  # 串、后面所有 URL 全废(实测:curl (3) bad range in URL)。tr 再兜一层。
  PORT=$(node -e 'const net=require("net");const s=net.createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})' | tr -cd '0-9')
  { [ -n "$PORT" ] && [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ]; } || die "无法探测空闲端口(拿到 '$PORT')"
fi

FAILED=()
run_step() { # run_step <日志名> <步骤名> <命令...>;stdout/stderr 全量进日志
  local key="$1" name="$2"; shift 2
  if "$@" >"$RUN_DIR/$key.log" 2>&1; then
    echo "  ok $name"
  else
    echo "  !! $name(完整日志 $RUN_DIR/$key.log)"
    FAILED+=("$name")
  fi
}

# ── 1/5 语法与依赖 ──
step_syntax() {
  local f
  for f in server/index.js server/routes/terminal.js server/routes/computer-use.js \
           server/routes/remote-control.js server/computer-use/mcp-server.js; do
    node --check "$f" || return 1
  done
  python3 -m py_compile server/computer-use/cu_helper.py || return 1
}

# ── 2/5 必需单测(缺依赖的跳过由 main 里的标记检查单独判失败) ──
# 这里每一项都是"必需检查":红就是整体非零,不能从列表里删掉来变通过(R29)。
# check-r94-panel / check-r95-image-nav 本轮带上"tests/acceptance/** 零改动"的冻结断言,
# 本批新增 tests/acceptance/first-batch-20260910/ 后它们会红 —— 由下一轮 dev-attachments
# 同步更新这两条锁,本脚本只保证:它们红时整体非零,不再打印"全量验证通过"。
step_tests() {
  node tests/unit/check-stream-image.mjs || return 1
  node tests/unit/check-terminal-pty.mjs || return 1
  node tests/unit/check-cu-mapping.mjs || return 1
  node tests/unit/check-r94-panel.mjs || return 1
  node tests/unit/check-r95-image-nav.mjs || return 1
}

# ── 3/5 MCP schema 冒烟 ──
step_mcp_schema() { node "$RUN_DIR/mcp-smoke.mjs"; }

# ── 4/5 生产构建(vite build,不碰用户 release-notes) ──
step_build() {
  ( cd client && ./node_modules/.bin/vite build ) || return 1
  [ -f client/dist/index.html ] || return 1
}

# ── 5/5 服务与端点(自己的隔离实例:自己的 HOME/端口/进程) ──
step_endpoints() {
  HOME="$RUN_DIR/home" USERPROFILE="$RUN_DIR/home" PORT="$PORT" node server/index.js >"$RUN_DIR/server.log" 2>&1 &
  SERVER_PID=$!
  # 就绪等待按墙钟算 60s(bash 内建 SECONDS):机器满载时 node 起服务可能十几秒,
  # 固定次数的小循环会误判"未就绪"。
  local ready="" attempts=0 deadline=$((SECONDS + 60))
  while [ "$SECONDS" -lt "$deadline" ]; do
    attempts=$((attempts + 1))
    if curl -sf --noproxy '*' -m 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then ready=1; break; fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then echo "服务进程已退出(PID $SERVER_PID)"; break; fi
    sleep 0.5
  done
  if [ -z "$ready" ]; then
    echo "服务未就绪(端口 $PORT,进程 $SERVER_PID,已等 ${attempts} 次)"
    echo "最后一次直连结果:"
    curl -sS --noproxy '*' -m 3 "http://127.0.0.1:$PORT/api/health" 2>&1 | head -3
    echo "server.log 尾部:"
    tail -5 "$RUN_DIR/server.log" 2>/dev/null
    kill "$SERVER_PID" 2>/dev/null; SERVER_PID=""
    return 1
  fi
  local rc=0
  node "$RUN_DIR/endpoint-checks.mjs" "http://127.0.0.1:$PORT" || rc=1
  kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; SERVER_PID=""
  return $rc
}

# 端点检查脚本:HTTP 200 不等于通过,逐项核对合同字段
cat > "$RUN_DIR/endpoint-checks.mjs" <<'EOF'
const base = process.argv[2];
const problems = [];
const show = (label, value) => console.log(`  ${label}: ${value}`);
const getJson = async (p) => {
  const r = await fetch(base + p, { signal: AbortSignal.timeout(10_000) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const checks = [
  ['/api/health', (s, b) => s === 200 && b?.ok === true, 'HTTP 200 且 ok:true'],
  ['/api/terminal/status', (s, b) => s === 200 && b?.available === true && b?.maxTerminals === 4, 'HTTP 200、available:true、maxTerminals:4'],
  ['/api/computer-use/status', (s, b) => s === 200 && b?.supported === true, 'HTTP 200 且 supported:true(当前只支持 macOS)'],
  ['/api/mcp', (s, b) => s === 200 && Array.isArray(b?.mcpServers), 'HTTP 200 且 mcpServers 为数组'],
];
for (const [path, ok, rule] of checks) {
  try {
    const { status, body } = await getJson(path);
    if (ok(status, body)) show(path, 'ok');
    else problems.push(`${path} 需 ${rule},实为 HTTP ${status} ${JSON.stringify(body)?.slice(0, 200)}`);
  } catch (err) {
    problems.push(`${path} 请求异常: ${err.message}`);
  }
}
if (problems.length) {
  console.log('端点检查未通过:');
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
EOF

# MCP schema 冒烟:initialize + tools/list,按名称/schema 核对 11 个既有工具
cat > "$RUN_DIR/mcp-smoke.mjs" <<'EOF'
import { spawn } from 'child_process';
const REQUIRED = ['screenshot', 'window_list', 'cursor_position', 'doctor', 'left_click',
  'double_click', 'right_click', 'drag', 'scroll', 'type', 'key'];
const srv = spawn('node', ['server/computer-use/mcp-server.js'], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
const pending = new Map();
let id = 0;
srv.stdout.on('data', (d) => {
  buf += d;
  let n;
  while ((n = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, n).trim();
    buf = buf.slice(n + 1);
    if (!line) continue;
    try { const m = JSON.parse(line); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {}
  }
});
const call = (method, params) => new Promise((resolve, reject) => {
  const i = ++id;
  pending.set(i, resolve);
  try { srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); }
  catch (err) { pending.delete(i); reject(err); return; }
  setTimeout(() => { pending.delete(i); reject(new Error(`timeout ${method}(8s)`)); }, 8000);
});
try {
  const init = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'iv', version: '1' } });
  if (!init?.result?.serverInfo) throw new Error('initialize 未返回 serverInfo');
  const list = await call('tools/list', {});
  const tools = list?.result?.tools || [];
  console.log(`  MCP tools=${tools.length}(必需 ${REQUIRED.length} 个按名称核对)`);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const missing = REQUIRED.filter((n) => !byName.has(n));
  if (missing.length) throw new Error(`缺少工具:${missing.join(',')}`);
  const noSchema = REQUIRED.filter((n) => byName.get(n).inputSchema?.type !== 'object');
  if (noSchema.length) throw new Error(`工具缺 inputSchema:${noSchema.join(',')}`);
  console.log('  ok MCP schema');
} catch (err) {
  console.log(`  MCP schema 检查未通过:${err.message}`);
  process.exitCode = 1;
} finally {
  try { srv.stdin.end(); } catch {}
  srv.kill();
}
EOF

echo "工作树 $ROOT"
echo "验证端口 $PORT(脚本自选/校验过的空闲端口;完整日志 $RUN_DIR)"
for tool in node python3 curl; do
  command -v "$tool" >/dev/null 2>&1 || FAILED+=("缺少依赖 $tool")
done

echo "── 1/5 语法与依赖 ──"
run_step syntax "语法检查(node --check + py_compile)" step_syntax

echo "── 2/5 必需单测 ──"
run_step tests "tests/unit 五项必需单测" step_tests
if grep -q "node-pty 不可用" "$RUN_DIR/tests.log" 2>/dev/null; then
  echo "  !! 终端 PTY 不可用:check-terminal-pty 按设计跳过,必需项不能算通过"
  FAILED+=("终端 PTY 不可用(node-pty 缺依赖,不能靠跳过算通过)")
fi

echo "── 3/5 MCP schema 冒烟 ──"
run_step mcp "MCP schema" step_mcp_schema

echo "── 4/5 生产构建 ──"
run_step build "client 生产构建(vite build)" step_build

echo "── 5/5 服务与端点(端口 $PORT) ──"
run_step endpoints "隔离实例 + 端点字段检查" step_endpoints

echo
if [ "${#FAILED[@]}" -eq 0 ]; then
  echo "── 全量验证通过 ──"
  echo "完整日志:$RUN_DIR"
  exit 0
fi
echo "── 本次全量验证未通过:${#FAILED[@]} 项 ──"
for f in "${FAILED[@]}"; do
  echo "  [!] $f"
done
echo "完整日志:$RUN_DIR" >&2
exit 1
