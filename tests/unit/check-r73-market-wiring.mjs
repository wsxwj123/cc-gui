#!/usr/bin/env node
// r73 档A:统一「扩展市场」的接线审计。两件事(仿 r71 wiring 的①②节):
//   ① 三个页签真的接在既有数据源与既有链路上(锚点齐 + 复用而非复制 + 入口注册)
//   ② 零执行通道 —— 本轮红线:市场只"逛与装",不新增任何能执行外部数据的路径
// 纯源码断言,不跑浏览器。Run: node tests/unit/check-r73-market-wiring.mjs
//
// 变异哨兵(逐条实跑验证过红):
//   S7  MarketPanel 的技能页改成自己复制一份市场列表(删掉 <SkillsPanel marketOnly)→ ①红
//   S8  MCP 行「添加」改成直接 POST /api/mcp(不经 McpForm 确认)→ ②红
//   S9  SkillsPanel 忽略 marketQuery(统一搜索框与技能页失联)→ ①红
//   S10 注册表 remote URL 的 http/https 白名单被删(flag 注入防线)→ ②红
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf-8');
const market = read('client/src/components/MarketPanel.jsx');
const skills = read('client/src/components/SkillsPanel.jsx');
const mcpForm = read('client/src/components/McpForm.jsx');
const app = read('client/src/App.jsx');
const browse = read('client/src/utils/mcpBrowse.js');

// ── ① 接线:锚点 / 复用 / 入口 ────────────────────────────────────────────────
for (const tid of ['ext-market', 'ext-market-tab', 'ext-market-search',
  'plugin-market-list', 'plugin-market-row', 'plugin-market-count', 'plugin-install-btn', 'plugin-install-count',
  'mcp-market-list', 'mcp-market-row', 'mcp-kind-facet', 'mcp-kind-chip', 'mcp-kind-count',
  'mcp-market-more', 'mcp-market-empty', 'mcp-market-error', 'mcp-prefill-btn']) {
  assert.ok(market.includes(`data-testid="${tid}"`), `扩展市场缺锚点 ${tid}`);
}
// 三个页签都在,且各自接既有端点(技能那条靠复用组件,不直接发请求)
assert.ok(/\{ id: 'skills'[\s\S]{0,400}\{ id: 'plugins'[\s\S]{0,400}\{ id: 'mcp'/.test(market), '页签必须是技能/插件/MCP 三类');
assert.ok(/<SkillsPanel marketOnly marketQuery=\{q\} \/>/.test(market),
  '技能页必须复用 SkillsPanel 的市场页(复制一份列表 = 分面/导入/重名裁决全要跟着分叉)');
assert.ok(!/\/api\/skills\//.test(market), '技能页不得在本组件里另起技能端点调用');
assert.ok(market.includes('/api/plugins/available?q='), '插件页接既有只读端点');
assert.ok(market.includes('/api/mcp/registry-search?q='), 'MCP 页接既有注册表端点');
assert.ok(/cursor=\$\{encodeURIComponent\(cursor\)\}/.test(market), 'MCP 页翻页必须把 cursor 透传给后端');
assert.ok(/appendPage\(prev, d\.items \|\| \[\]\)/.test(market) && /setMcpCursor\(String\(d\.nextCursor/.test(market),
  '翻页必须追加并接住 nextCursor,否则「加载更多」是摆设');
// 统一搜索框:一个输入框驱动当前页签
assert.ok(/value=\{q\} onChange=\{\(e\) => setQ\(e\.target\.value\)\} data-testid="ext-market-search"/.test(market), '统一搜索框是受控输入');
assert.ok(/`\/api\/plugins\/available\?q=\$\{encodeURIComponent\(q\.trim\(\)\)\}/.test(market), '插件页消费统一搜索词');
assert.ok(/const term = q\.trim\(\);/.test(market), 'MCP 页消费统一搜索词');
assert.ok(/marketQuery === undefined \? ownMq : marketQuery/.test(skills), '技能页消费统一搜索词(外部传入即接管自带搜索框)');
assert.ok(/export function SkillsPanel\(\{ marketOnly = false, marketQuery \}\)/.test(skills), 'SkillsPanel 的两个 prop 都是可选,不传即原行为');
assert.ok(/useState\(marketOnly \? 'import' : 'local'\)/.test(skills), 'marketOnly 时直接落在市场页');
// kind 分面接的是 normalize 已有的三类,计数口径写明是"已加载"
assert.ok(/countByKind\(mcpItems\)/.test(market) && /filterByKind\(mcpItems, kind\)/.test(market), 'kind 分面必须真驱动列表');
assert.ok(/mcpView\.map\(/.test(market), '列表渲染筛选后的 mcpView,不是原始 mcpItems');
assert.ok(market.includes('已加载 {mcpItems.length} 条内的分布'), '分面计数必须写明口径(浅翻拿不到全库统计,不许冒充)');
// 入口:收进既有设置面板坞,不新增顶栏按钮;既有三个入口全保留
assert.ok(/market: \{ label: '扩展市场（Skill · 插件 · MCP 浏览与安装）', icon: \w+, component: MarketPanel \}/.test(app), 'PANEL_MAP 必须注册 market');
assert.ok(/market: '市场'/.test(app), '面板坞短名要有 market(否则 rail 上显示的是整条长标签)');
assert.ok(/mcp: \{ label: '工具（MCP 服务器 · 插件）'/.test(app) && /skills: \{ label: 'Skill 市场（导入官方技能）'/.test(app),
  '既有两个入口必须保留(功能只加不减)');
// Cmd/Ctrl+1..9 按 PANEL_MAP 前 9 项取:market 必须排在第 9 项之后,不挤掉既有快捷键
const ids = [...app.matchAll(/^ {2}(\w+): \{ label: '/gm)].map((m) => m[1]);
assert.ok(ids.indexOf('market') >= 9, `market 必须排在第 10 位及以后(当前 ${ids.indexOf('market') + 1}),否则改动既有 Cmd/Ctrl+1..9`);
assert.equal(ids[ids.indexOf('market') - 1], 'image', 'market 插在 image 与 settings 之间');

// ── ② 零执行通道(本轮红线)──────────────────────────────────────────────────
// 注册表/插件目录是第三方外部数据:只能当纯文本渲染
const NO_EXEC = /dangerouslySetInnerHTML|\beval\(|new Function|srcdoc|<iframe/;
for (const [name, src] of [['MarketPanel', market], ['mcpBrowse', browse]]) {
  assert.ok(!NO_EXEC.test(src), `${name} 不得引入任何执行/注入通道`);
}
// MCP 行动作只能是"预填表单",绝不能直接落配置
assert.ok(/onClick=\{\(\) => setSeed\(it\)\}/.test(market), 'MCP 行「添加」只 setSeed(打开预填表单)');
assert.ok(!/'\/api\/mcp'/.test(market) && !/method: 'PUT'|method: 'DELETE'/.test(market),
  '市场页不得直接写 MCP 配置 / 不得有改删操作(全部经既有表单与既有面板)');
assert.ok(/<McpForm editing=\{null\} seed=\{seed\}/.test(market), '预填走既有 McpForm,校验与提交流程一字不改');
assert.ok(/if \(!isEdit && seed\) applyRegistryItem\(seed\)/.test(mcpForm), 'seed 只走既有 applyRegistryItem(与面板内搜索选中同一路径)');
assert.ok(!/seed[\s\S]{0,200}submit\(|seed[\s\S]{0,200}handleSave\(/.test(mcpForm), 'seed 只预填,绝不自动提交');
// 预填的信任边界(注册表 URL 协议白名单 + flag 注入防线)必须还在
const registry = read('server/services/mcp-registry.js');
for (const line of [
  "try { parsed = new URL(String(remote.url)); } catch { return null; }",
  "if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;",
]) assert.ok(registry.includes(line), `注册表预填防线被动过:缺 ${line.slice(0, 50)}`);
// 浏览层纯函数不发请求、不写操作
assert.ok(!/fetch\(/.test(browse), 'mcpBrowse.js 必须是纯函数模块');
assert.ok(!/method: 'POST'|method: 'DELETE'/.test(browse), 'mcpBrowse.js 不许有写操作');
// 服务端新增能力只有只读 GET
const routes = read('server/routes/mcp.js');
assert.ok(/router\.get\('\/mcp\/registry-search'/.test(routes) && /browseRegistry\(\{ q, cursor \}\)/.test(routes),
  '注册表浏览只在既有 GET 端点上扩展,不新增写端点');
assert.ok(/if \(q && !cursor\) return res\.json\(\{ items: await searchRegistry\(q\) \}\);/.test(routes),
  '既有搜索路径(McpForm 折叠搜索)的响应形状必须保持 { items }');

// 长列表沿用 r71 的零依赖方案
assert.ok(/contentVisibility: 'auto'/.test(market) && /style=\{ROW_CV\}/.test(market), '长列表须挂 content-visibility 占位');

console.log('r73 扩展市场接线审计通过(三页签复用既有链路 + 零新增执行通道)');
