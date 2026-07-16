// Minimal runnable check for MCP registry search (server/services/mcp-registry.js).
// Run: node tests/unit/check-mcp-registry-search.mjs
// 全部走注入的 mock fetchImpl,无网络依赖。覆盖:条目归一化(npm/pypi/remote/不可预填)、
// 缓存命中(同 q 二次调用不打上游)、上游错误 → 可读报错(网络层 + HTTP 非 2xx)。
import assert from 'node:assert';
import { normalizeRegistryEntry, searchRegistry } from '../../server/services/mcp-registry.js';

// ---- normalizeRegistryEntry:npm 包 → npx 命令 + env 提示(结构取自 2026-07 实测响应) ----
const npmEntry = {
  server: {
    name: 'com.pulsemcp/remote-filesystem',
    description: 'MCP server for remote filesystem operations.',
    version: '0.1.2',
    repository: { url: 'https://github.com/pulsemcp/mcp-servers' },
    packages: [{
      registryType: 'npm', identifier: 'remote-filesystem-mcp-server',
      transport: { type: 'stdio' },
      environmentVariables: [
        { name: 'GCS_BUCKET', description: 'bucket name.', isRequired: true },
        { name: 'GCS_PROJECT_ID', description: 'project id.' },
      ],
    }],
  },
};
const npm = normalizeRegistryEntry(npmEntry);
assert.strictEqual(npm.kind, 'npm');
assert.strictEqual(npm.transport, 'stdio');
assert.strictEqual(npm.commandLine, 'npx -y remote-filesystem-mcp-server');
assert.strictEqual(npm.id, 'remote-filesystem');
assert.strictEqual(npm.env.length, 2);
assert.strictEqual(npm.env[0].k, 'GCS_BUCKET');
assert.ok(npm.env[0].hint.startsWith('必填。'), 'isRequired 应体现在 hint');

// pypi → uvx
const pypi = normalizeRegistryEntry({ server: { name: 'io.x/py-srv', packages: [{ registryType: 'pypi', identifier: 'some-mcp' }] } });
assert.strictEqual(pypi.kind, 'pypi');
assert.strictEqual(pypi.commandLine, 'uvx some-mcp');

// remote(streamable-http)→ http URL;sse → sse
const remote = normalizeRegistryEntry({ server: { name: 'ai.smithery/x-github', remotes: [{ type: 'streamable-http', url: 'https://server.smithery.ai/x/mcp' }] } });
assert.strictEqual(remote.kind, 'remote');
assert.strictEqual(remote.transport, 'http');
assert.strictEqual(remote.url, 'https://server.smithery.ai/x/mcp');
const sse = normalizeRegistryEntry({ server: { name: 'a/b', remotes: [{ type: 'sse', url: 'https://x/sse' }] } });
assert.strictEqual(sse.transport, 'sse');

// remote.url 协议校验:`-` 开头串(会被 CLI 当 flag)/非 http(s) 协议 → null 不可预填;正常 https 通过
assert.strictEqual(normalizeRegistryEntry({ server: { name: 'a/evil', remotes: [{ type: 'streamable-http', url: '-–evil' }] } }), null);
assert.strictEqual(normalizeRegistryEntry({ server: { name: 'a/js', remotes: [{ type: 'streamable-http', url: 'javascript:alert(1)' }] } }), null);
assert.strictEqual(normalizeRegistryEntry({ server: { name: 'a/good', remotes: [{ type: 'streamable-http', url: 'https://ok.example/mcp' }] } })?.url, 'https://ok.example/mcp');

// 无 remotes / 无 npm/pypi 包(如仅 oci)→ null,不进结果
assert.strictEqual(normalizeRegistryEntry({ server: { name: 'a/oci-only', packages: [{ registryType: 'oci', identifier: 'img' }] } }), null);
assert.strictEqual(normalizeRegistryEntry({ server: { name: 'a/bare' } }), null);

// ---- searchRegistry:缓存命中(同 q 只打一次上游;大小写/空白归一同 key) ----
let calls = 0;
const okBody = { servers: [npmEntry], metadata: { count: 1 } };
const mockFetch = async () => { calls++; return { ok: true, status: 200, json: async () => okBody, text: async () => '' }; };
const r1 = await searchRegistry('CacheTest', { fetchImpl: mockFetch });
assert.strictEqual(r1.length, 1);
assert.strictEqual(calls, 1);
const r2 = await searchRegistry('  cachetest ', { fetchImpl: mockFetch }); // 归一后同 key → 命中缓存
assert.strictEqual(r2.length, 1);
assert.strictEqual(calls, 1, '同 q 二次调用应命中缓存,不再打上游');
await searchRegistry('other-query', { fetchImpl: mockFetch });
assert.strictEqual(calls, 2, '不同 q 应打上游');

// 空 q → 空列表,不打上游
assert.deepStrictEqual(await searchRegistry('   ', { fetchImpl: mockFetch }), []);
assert.strictEqual(calls, 2);

// ---- 上游错误 → 可读报错(不静默空列表) ----
// 网络层失败(TUN 劫持 / 断网 / 超时)
await assert.rejects(
  () => searchRegistry('net-fail', { fetchImpl: async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } }); } }),
  (e) => /网络不可达.*可重试/.test(e.message) && /ECONNRESET/.test(e.message),
);
// HTTP 非 2xx:状态码 + body 片段透传
await assert.rejects(
  () => searchRegistry('http-500', { fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'internal boom' }) }),
  (e) => /HTTP 500/.test(e.message) && /internal boom/.test(e.message),
);
// 错误不落缓存:同 q 重试应再次打上游并可成功
const recovered = await searchRegistry('net-fail', { fetchImpl: mockFetch });
assert.strictEqual(recovered.length, 1, '失败后重试同 q 应能成功(错误未污染缓存)');

console.log('check-mcp-registry-search OK — normalize(npm/pypi/remote/null) + cache + upstream errors');
