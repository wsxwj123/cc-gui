#!/usr/bin/env node
// r73 档0b:插件只读端点的形状与排序(server/routes/mcp.js 的 normalizeAvailablePlugins)。
// 数据源是 `claude plugin list --available --json`(壳子原则:CLI 已聚合所有已配置 marketplace,
// 不自己爬网页)。这里锁三件事:① 条目形状(前端渲染与安装都按它取字段)② installCount 归一
// ③ **服务端**按热度降序 —— 路由是先过滤再 slice(60),排序若放前端只排得到被截断后的 60 条。
// 不跑 CLI、不联网、不碰 ~/.claude(只调纯函数 + 读路由源码做只读断言)。
// Run: node tests/unit/check-r73-plugin-market.mjs
//
// 变异哨兵(逐条实跑验证过红):
//   S5 normalizeAvailablePlugins 去掉 .sort → t2 红(热度排序失效)
//   S6 installCount 缺失时不兜底(Number(undefined)=NaN)→ t2/t3 红(排序被 NaN 搅乱)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { normalizeAvailablePlugins } from '../../server/routes/mcp.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf-8');

// 真实 CLI 输出片段(2026-09 本机实测:installed 39 / available 279,installCount 最大 1,081,334)
const CLI_OUT = {
  installed: [
    { id: 'code-review@claude-plugins-official', version: '1.0.0', scope: 'user', enabled: true },
    { id: 'claude-mem@thedotmack', version: '2.3.1', scope: 'user', enabled: true },
  ],
  available: [
    { pluginId: 'playwright@claude-plugins-official', name: 'playwright', description: 'Browser automation', marketplaceName: 'claude-plugins-official', installCount: 342205 },
    { pluginId: 'superpowers@claude-plugins-official', name: 'superpowers', description: 'Superpowers teaches Claude', marketplaceName: 'claude-plugins-official', installCount: 1081334 },
    { pluginId: 'code-review@claude-plugins-official', name: 'code-review', description: 'Reviews code', marketplaceName: 'claude-plugins-official', installCount: 200000 },
    { pluginId: 'no-count@claude-plugins-official', name: 'no-count', marketplaceName: 'claude-plugins-official' },              // 实测 279 条里有 1 条没有 installCount
    { pluginId: 'bad-count@mk', name: 'bad-count', marketplaceName: 'mk', installCount: 'many' },                                 // CLI 输出是外部数据,类型不保证
    { name: 'no-id', description: '', installCount: 1 },                                                                          // 缺 pluginId → 自行拼
    null, { description: '无名条目' },                                                                                            // 脏数据必须被丢弃
  ],
};

// ── t1 形状:前端要的字段一个不少,且不多带 CLI 的其它字段 ────────────────────────
const items = normalizeAvailablePlugins(CLI_OUT);
assert.deepEqual(Object.keys(items[0]).sort(),
  ['description', 'installCount', 'installed', 'marketplace', 'name', 'pluginId'].sort(),
  't1: 条目字段形状固定(市场行渲染 + 安装请求体都按它取)');
assert.equal(items.length, 6, 't1: null / 无名条目被丢弃');
assert.equal(items.find((i) => i.name === 'no-id').pluginId, 'no-id@', 't1: 缺 pluginId 时按 name@marketplace 拼');

// ── t2 排序:installCount 降序,同分按名称(服务端排,路由随后才 slice)──────────────
assert.deepEqual(items.map((i) => i.name),
  ['superpowers', 'playwright', 'code-review', 'no-id', 'bad-count', 'no-count'],
  't2: 必须按 installCount 降序(缺失/非法计 0 排末尾,同分按名称)');
assert.ok(items.every((it, i, a) => i === 0 || a[i - 1].installCount >= it.installCount), 't2: 单调不增');

// ── t3 installCount 归一:缺失/非数字 → 0,不造假、不 NaN ─────────────────────────
assert.equal(items.find((i) => i.name === 'no-count').installCount, 0);
assert.equal(items.find((i) => i.name === 'bad-count').installCount, 0);
assert.equal(items.find((i) => i.name === 'superpowers').installCount, 1081334, 't3: 有值的原样保留,不做区间/取整加工');

// ── t4 已安装标记:按裸名(去掉 @marketplace)比对 ──────────────────────────────
assert.equal(items.find((i) => i.name === 'code-review').installed, true, 't4: 已装项标出来,不诱导重复安装');
assert.equal(items.find((i) => i.name === 'playwright').installed, false);
assert.deepEqual(normalizeAvailablePlugins({}), [], 't4: 空输入不抛');
assert.deepEqual(normalizeAvailablePlugins(null), []);

// ── t5 路由是只读 GET,且排序发生在归一里(先排后截)──────────────────────────────
const routes = read('server/routes/mcp.js');
assert.ok(/router\.get\('\/plugins\/available'/.test(routes), 't5: 端点是 GET');
assert.ok(/const items = normalizeAvailablePlugins\(parsed\);/.test(routes), 't5: 加载路径必须走归一函数(否则排序绕过)');
assert.ok(/\.sort\(\(x, y\) => y\.installCount - x\.installCount/.test(routes), 't5: 排序在归一里,先排后 slice');
const handler = routes.slice(routes.indexOf("router.get('/plugins/available'"), routes.indexOf("router.post('/plugins/install'"));
assert.ok(/filtered\.slice\(0, LIMIT\)/.test(handler), 't5: 仍是限量返回,不把 279 条整包推给前端');
assert.ok(!/runClaude\(\[\s*'plugin',\s*'install'/.test(handler) && !/spawn|exec/.test(handler),
  't5: 浏览端点不得触发任何安装/执行');

// ── t6 市场页的安装走既有 claude plugin CLI 通道,不新造 ─────────────────────────
const panel = read('client/src/components/MarketPanel.jsx');
assert.ok(panel.includes("await fetch('/api/plugins/install', {"), 't6: 安装仍走既有端点');
assert.ok(/body: JSON\.stringify\(\{ name: row\.name, \.\.\.\(row\.marketplace \? \{ marketplace: row\.marketplace \} : \{\}\) \}\)/.test(panel),
  't6: 请求体与既有插件面板同形(name + marketplace,不带 repo 就不会误落官方源)');
assert.ok(panel.includes('pluginInstallErrorMessage'), 't6: 错误文案复用既有映射,不另写一套');
assert.ok(!/\/api\/plugins\/[^ ']*', \{\s*method: 'DELETE'/.test(panel), 't6: 市场页不提供卸载/删除(管理留在既有面板)');

console.log('r73 插件市场端点自检通过(形状 / 热度排序 / installCount 归一 / 已装标记 / 只读 GET / 复用安装链路)');
