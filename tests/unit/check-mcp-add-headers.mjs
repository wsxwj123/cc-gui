// Minimal runnable check for MCP headers support (server 侧纯逻辑)。
// Run: node tests/unit/check-mcp-add-headers.mjs
// 覆盖:buildAddArgs 的 -H 组装(http/sse 生效、非法键丢弃、stdio 忽略)、
// 注册表 remote 条目 headers 键名归一化(isSecret/isRequired 进 hint)。
import assert from 'node:assert';
import { buildAddArgs, parseHeadersFromDetails } from '../../server/routes/mcp.js';
import { normalizeRegistryEntry } from '../../server/services/mcp-registry.js';

// ---- buildAddArgs:http + headers → 每对一个 -H "Key: Value"(2026-07 `claude mcp add --help` 实抓形态) ----
const httpArgs = buildAddArgs({
  name: 'corridor', transport: 'http', url: 'https://app.corridor.dev/api/mcp',
  headers: { Authorization: 'Bearer tok-1', 'X-Custom': 'v1' }, env: {}, scope: 'user',
});
assert.deepStrictEqual(httpArgs, [
  'mcp', 'add', '-t', 'http', '-s', 'user', 'corridor',
  'https://app.corridor.dev/api/mcp',
  '-H', 'Authorization: Bearer tok-1',
  '-H', 'X-Custom: v1',
]);

// 非法键(含冒号/空格,可能破坏 "Key: Value" 形态)整对丢弃,合法键保留;env 仍在末尾。
const mixed = buildAddArgs({
  name: 's', transport: 'sse', url: 'https://x.dev/mcp',
  headers: { 'Bad Key': 'v', 'has:colon': 'v', 'X-Ok': 'v2' }, env: { K: '1' }, scope: 'user',
});
assert.deepStrictEqual(mixed.slice(mixed.indexOf('https://x.dev/mcp') + 1), ['-H', 'X-Ok: v2', '-e', 'K=1']);

// RFC 7230 token 字符集:下划线等合法键保留(实抓 2026-07 CLI 接受 X-Custom_Key);
// 被丢弃的键收集进 droppedHeaderKeys(只含键名不含值 —— 值可能是密钥,不得进响应/日志)。
const dropped = [];
const tokenArgs = buildAddArgs({
  name: 't', transport: 'http', url: 'https://x.dev/mcp',
  headers: { 'X-Custom_Key': 'v1', 'x-api.key': 'v2', 'Bad Key': 'secret-value', 'has:colon': 'v' }, env: {}, scope: 'user',
}, dropped);
assert.ok(tokenArgs.includes('X-Custom_Key: v1'), '下划线键名合法,不再被丢弃');
assert.ok(tokenArgs.includes('x-api.key: v2'), '点号键名合法(token 字符)');
assert.deepStrictEqual(dropped, ['Bad Key', 'has:colon'], '被丢弃的键名收集进 droppedHeaderKeys');
assert.ok(!JSON.stringify(dropped).includes('secret-value'), 'droppedHeaderKeys 不含 header 值');

// stdio:headers 不产生 -H(仅 http/sse 支持请求头)。
const stdioArgs = buildAddArgs({
  name: 'fs', transport: 'stdio', commandLine: 'npx -y pkg',
  headers: { 'X-Ok': 'v' }, env: {}, scope: 'user',
});
assert.ok(!stdioArgs.includes('-H'), 'stdio 不应带 -H');

// ---- parseHeadersFromDetails:`claude mcp get` 文本解析("禁用→启用带回 headers"与编辑回显全押在它身上) ----
// 样本为本机实抓(2026-07-17,claude mcp get cgui-test-hdr-sample),值已替换为占位。
// 关键形态:Headers 段两空格缩进、键值 `Key: value`、段后跟 "To remove..." 行。
const realGetOutput = `cgui-test-hdr-sample:
  Scope: User config (available in all your projects)
  Status: ✘ Failed to connect
  Type: http
  URL: http://127.0.0.1:9/mcp
  Headers:
    Authorization: Bearer dummy-token-123
    X-Custom_Key: v1

To remove this server, run: claude mcp remove cgui-test-hdr-sample -s user`;
assert.deepStrictEqual(parseHeadersFromDetails(realGetOutput), {
  Authorization: 'Bearer dummy-token-123',
  'X-Custom_Key': 'v1', // 下划线键:实抓 CLI 接受,解析侧同 RFC 7230 token 口径,不得丢
}, '标准 Headers 段:全部键值解析,To remove 行截断');

// 无 Headers 段(实抓同日 xiaohongshu-mcp 形态):返回空对象,不误把 URL/Scope 当 header。
const noHeadersOutput = `xiaohongshu-mcp:
  Scope: User config (available in all your projects)
  Status: ✔ Connected
  Type: http
  URL: http://localhost:18060/mcp

To remove this server, run: claude mcp remove xiaohongshu-mcp -s user`;
assert.deepStrictEqual(parseHeadersFromDetails(noHeadersOutput), {}, '无 Headers 段返回空对象');

// Authorization 值为 [REDACTED] 的行为(add 输出形态;get 当前输出明文,但若某版 CLI 改为
// 脱敏,解析结果就是字面 "[REDACTED]" —— 钉死现状:照常解析为值,不特殊处理不报错)。
assert.deepStrictEqual(
  parseHeadersFromDetails('x:\n  Type: http\n  Headers:\n    Authorization: [REDACTED]\n\nTo remove this server, run: claude mcp remove x'),
  { Authorization: '[REDACTED]' },
  '[REDACTED] 按字面值解析',
);

// 空入参 / 非字符串:不抛错,返回空对象。
assert.deepStrictEqual(parseHeadersFromDetails(''), {});
assert.deepStrictEqual(parseHeadersFromDetails(null), {});

// ---- 注册表 remote 条目:headers 声明 → 键名 + hint(值不预填) ----
const remote = normalizeRegistryEntry({
  server: {
    name: 'ai.smithery/x-github',
    remotes: [{
      type: 'streamable-http', url: 'https://server.smithery.ai/x/mcp',
      headers: [
        { name: 'Authorization', description: 'Bearer token.', isRequired: true, isSecret: true },
        { name: 'X-Region', description: 'optional region.' },
        { description: 'no name, dropped' },
      ],
    }],
  },
});
assert.strictEqual(remote.headers.length, 2);
assert.strictEqual(remote.headers[0].k, 'Authorization');
assert.ok(remote.headers[0].hint.includes('必填。'), 'isRequired 应体现在 hint');
assert.ok(remote.headers[0].hint.includes('密钥。'), 'isSecret 应体现在 hint');
assert.strictEqual(remote.headers[1].k, 'X-Region');

console.log('check-mcp-add-headers: all assertions passed');
// mcp.js 模块顶层有 setTimeout 预热(会 spawn claude CLI),显式退出避免测试进程挂 8s。
process.exit(0);
