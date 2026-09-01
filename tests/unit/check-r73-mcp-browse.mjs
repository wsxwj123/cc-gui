#!/usr/bin/env node
// r73 档0:MCP 注册表「可浏览」的行为锁(server/services/mcp-registry.js + client/src/utils/mcpBrowse.js)。
// 覆盖:① 空词 = 拉首页(不带 search 参数)② cursor 透传 + nextCursor 回传 ③ 缓存 keyed by
//      (q,cursor) ④ 上游 500 / 网络失败 → 可读错误(不静默空列表)⑤ 空/畸形响应不抛
//      ⑥ kind 分面计数与筛选 ⑦ searchRegistry 旧契约不变(数组 + 空词不打上游)。
// 全走注入的 mock fetchImpl,无网络、不碰 ~/.claude。
// Run: node tests/unit/check-r73-mcp-browse.mjs
//
// 变异哨兵(逐条实跑验证过红):
//   S1 browseRegistry 去掉 `if (term)` 守卫改成恒设 search= → t1 红(浏览退化成搜空串)
//   S2 缓存 key 去掉 cursor 段 → t3b 红(翻页拿到上一页的缓存)
//   S3 上游非 2xx 改成 return { items: [] } → t4 红(静默空列表,用户看不到翻页失败)
//   S4 mcpBrowse.filterByKind 的 === 改成 !== → t6 红
import assert from 'node:assert/strict';
import { browseRegistry, searchRegistry, normalizeRegistryEntry } from '../../server/services/mcp-registry.js';
import { ALL_KINDS, KIND_LABELS, countByKind, filterByKind, appendPage } from '../../client/src/utils/mcpBrowse.js';

// 实测响应形状(2026-09 registry.modelcontextprotocol.io/v0/servers)
const entry = (name, kind = 'npm') => ({
  server: {
    name, version: '1.0.0', description: `${name} desc`,
    ...(kind === 'remote'
      ? { remotes: [{ type: 'streamable-http', url: `https://${name.split('/').pop()}.example/mcp` }] }
      : { packages: [{ registryType: kind, identifier: `${name.split('/').pop()}-mcp` }] }),
  },
});
const body = (names, nextCursor = '') => ({
  servers: names.map(([n, k]) => entry(n, k)),
  metadata: { count: names.length, ...(nextCursor ? { nextCursor } : {}) },
});
// 记录每次请求 URL 的 mock;每个用例自己一份,避免互相计数。
const mock = (payload) => {
  const urls = [];
  return {
    urls,
    fetchImpl: async (url) => {
      urls.push(String(url));
      return { ok: true, status: 200, json: async () => (typeof payload === 'function' ? payload(String(url)) : payload), text: async () => '' };
    },
  };
};
const params = (u) => new URL(u).searchParams;

// ── t1 空词 = 浏览首页:不带 search 参数,limit 用浏览页大小 ────────────────────
{
  const m = mock(body([['a.b/one', 'npm'], ['c.d/two', 'remote']], 'CUR-1'));
  const r = await browseRegistry({ q: '', fetchImpl: m.fetchImpl, ttlMs: 0 });
  const p = params(m.urls[0]);
  assert.equal(p.has('search'), false, 't1: 浏览首页不得带 search 参数(带了就是"搜空串",上游语义不同)');
  assert.equal(p.get('version'), 'latest');
  assert.ok(Number(p.get('limit')) > 20, 't1: 浏览页大小应大于搜索的 20');
  assert.ok(Number(p.get('limit')) <= 100, 't1: 页大小不得超过上游上限,且不做全量镜像');
  assert.equal(r.items.length, 2);
  assert.equal(r.nextCursor, 'CUR-1', 't1: nextCursor 必须回传,否则前端翻不了页');
  assert.deepEqual(r.items.map((i) => i.kind), ['npm', 'remote']);
}

// ── t2 带词搜索:search 参数存在,页大小回到 20 ────────────────────────────────
{
  const m = mock(body([['x.y/git-hub', 'npm']]));
  const r = await browseRegistry({ q: '  GitHub ', fetchImpl: m.fetchImpl, ttlMs: 0 });
  const p = params(m.urls[0]);
  assert.equal(p.get('search'), 'GitHub', 't2: 关键词原样透传(仅去首尾空白)');
  assert.equal(p.get('limit'), '20');
  assert.equal(r.nextCursor, '', 't2: 上游没给 nextCursor 就是空串(不是 undefined,前端按真值判"还有下一页")');
  assert.equal(r.items.length, 1);
}

// ── t3 cursor 透传 + 缓存 keyed by (q,cursor) ───────────────────────────────
// (用独立关键词,免得与 t1 共用缓存键;缓存分键这件事与 q 是否为空无关)
{
  const m = mock((u) => (params(u).get('cursor') === 'CUR-1'
    ? body([['p2.a/two', 'npm']], 'CUR-2')
    : body([['p1.a/one', 'npm']], 'CUR-1')));
  const p1 = await browseRegistry({ q: 'pagetest', fetchImpl: m.fetchImpl });
  const p2 = await browseRegistry({ q: 'pagetest', cursor: 'CUR-1', fetchImpl: m.fetchImpl });
  assert.equal(params(m.urls[1]).get('cursor'), 'CUR-1', 't3: cursor 必须原样透传给上游');
  assert.equal(p2.items[0].id, 'two', 't3: 第二页拿到的是新内容');
  assert.equal(p2.nextCursor, 'CUR-2');
  // t3b 缓存键含 cursor:同 q 不同 cursor 必须各打一次上游;同 (q,cursor) 命中缓存
  assert.equal(m.urls.length, 2, 't3b: 同 q 不同 cursor 不得互相命中缓存');
  const again = await browseRegistry({ q: 'pagetest', cursor: 'CUR-1', fetchImpl: m.fetchImpl });
  assert.equal(m.urls.length, 2, 't3b: 同 (q,cursor) 应命中缓存');
  assert.equal(again.items[0].id, 'two');
  assert.equal(p1.items[0].id, 'one');
}

// ── t4 上游失败 → 可读错误,不静默空列表(深翻到 1000 条上游会 500,前端要能说出原因)──
await assert.rejects(
  () => browseRegistry({ q: '', cursor: 'DEEP', fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'upstream boom' }) }),
  (e) => /HTTP 500/.test(e.message) && /upstream boom/.test(e.message) && /可重试/.test(e.message),
  't4: 上游 500 必须抛可读错误(含状态码与 body 片段),不得回空列表',
);
await assert.rejects(
  () => browseRegistry({ q: 'net', fetchImpl: async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }); } }),
  (e) => /网络不可达/.test(e.message) && /ENOTFOUND/.test(e.message),
  't4: 网络层失败给可读提示',
);
// 失败不落缓存:同键重试可成功
{
  const m = mock(body([['ok.a/one', 'npm']]));
  const r = await browseRegistry({ q: 'net', fetchImpl: m.fetchImpl });
  assert.equal(r.items.length, 1, 't4: 错误不得污染缓存');
}

// ── t5 空/畸形上游响应:不抛,给空列表 + 空游标(翻到底 / 全是不可预填条目)────────
{
  const m = mock({ servers: [], metadata: {} });
  assert.deepEqual(await browseRegistry({ q: 'empty-1', fetchImpl: m.fetchImpl }), { items: [], nextCursor: '' });
}
{
  const m = mock({ oops: true });
  assert.deepEqual(await browseRegistry({ q: 'empty-2', fetchImpl: m.fetchImpl }), { items: [], nextCursor: '' });
}
{
  // 仅 oci 镜像 / 非法协议的条目被 normalize 丢弃,不进浏览结果(选了也填不出配置)
  const m = mock({
    servers: [
      { server: { name: 'a/oci', packages: [{ registryType: 'oci', identifier: 'img' }] } },
      { server: { name: 'a/evil', remotes: [{ type: 'streamable-http', url: '-–flag-injection' }] } },
      entry('a/good', 'pypi'),
    ],
    metadata: { nextCursor: 'C' },
  });
  const r = await browseRegistry({ q: 'mixed', fetchImpl: m.fetchImpl });
  assert.deepEqual(r.items.map((i) => i.id), ['good'], 't5: 不可预填条目不进浏览列表(安全防线与搜索同一条)');
  assert.equal(r.items[0].commandLine, 'uvx good-mcp');
}

// ── t6 kind 分面(客户端纯函数):计数 / 筛选 / 追加去重 ──────────────────────────
{
  const list = [
    { name: 'a', kind: 'remote' }, { name: 'b', kind: 'npm' },
    { name: 'c', kind: 'remote' }, { name: 'd', kind: 'pypi' }, { name: 'e' },
  ];
  assert.deepEqual(countByKind(list), { remote: 2, npm: 1, pypi: 1 }, 't6: 只数真有 kind 的条目');
  assert.deepEqual(countByKind(null), {});
  assert.equal(filterByKind(list, ALL_KINDS), list, 't6: 全部时返回原数组身份');
  assert.deepEqual(filterByKind(list, 'remote').map((i) => i.name), ['a', 'c']);
  assert.deepEqual(filterByKind(list, 'pypi').map((i) => i.name), ['d']);
  assert.deepEqual(Object.keys(KIND_LABELS).sort(), ['npm', 'pypi', 'remote'], 't6: 分面维度就是 normalize 已有的三类,不新造');
  // 翻页追加按 name 去重(上游换页边界重复给同一条时不叠加)
  assert.deepEqual(appendPage(list.slice(0, 2), [{ name: 'b', kind: 'npm' }, { name: 'z', kind: 'npm' }]).map((i) => i.name),
    ['a', 'b', 'z'], 't6: 翻页追加必须按 name 去重');
}

// ── t7 旧契约不变:searchRegistry 仍返回数组,空词不打上游(McpForm 折叠搜索原路径)──
{
  const m = mock(body([['s.a/one', 'npm']]));
  const r = await searchRegistry('legacy-shape', { fetchImpl: m.fetchImpl });
  assert.ok(Array.isArray(r), 't7: searchRegistry 必须仍是数组形状');
  assert.equal(r[0].id, 'one');
  assert.deepEqual(await searchRegistry('   ', { fetchImpl: m.fetchImpl }), [], 't7: 空词返回空数组');
  assert.equal(m.urls.length, 1, 't7: 空词不得打上游(表单去抖清空时不该白拉首页)');
  // 预填字段仍是外部数据的安全子集
  assert.equal(normalizeRegistryEntry(entry('n.s/one', 'npm')).commandLine, 'npx -y one-mcp');
}

console.log('r73 MCP 浏览层自检通过(空词首页 / cursor 透传 / 缓存分键 / 上游失败可读 / kind 分面 / 旧契约不变)');
