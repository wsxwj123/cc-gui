// Minimal runnable check for MCP headers support (server 侧纯逻辑)。
// Run: node tests/unit/check-mcp-add-headers.mjs
// 覆盖:buildAddArgs 的 -H 组装(http/sse 生效、非法键丢弃、stdio 忽略)、
// 注册表 remote 条目 headers 键名归一化(isSecret/isRequired 进 hint)。
import assert from 'node:assert';
import { buildAddArgs } from '../../server/routes/mcp.js';
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

// stdio:headers 不产生 -H(仅 http/sse 支持请求头)。
const stdioArgs = buildAddArgs({
  name: 'fs', transport: 'stdio', commandLine: 'npx -y pkg',
  headers: { 'X-Ok': 'v' }, env: {}, scope: 'user',
});
assert.ok(!stdioArgs.includes('-H'), 'stdio 不应带 -H');

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
