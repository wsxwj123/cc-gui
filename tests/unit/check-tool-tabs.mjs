// r16-5:工具面板选项卡(MCP / 插件 / 外部项目)——照搬主题弹层那套。
// 结构抄 check-theme-tabs.mjs;多两条:①页签 id 与 MCPPanel 分支一一对应(防死页/漏改)
// ②页签条样式与 App.jsx 主题弹层逐字同款(两处观感必须一致)。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TOOL_TABS, DEFAULT_TOOL_TAB, readToolTab, writeToolTab } from '../../client/src/utils/toolTabs.js';

const panel = readFileSync(new URL('../../client/src/components/MCPPanel.jsx', import.meta.url), 'utf8');
const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');

// t1 清单与默认
{
  assert.deepEqual(TOOL_TABS.map((t) => t.id), ['mcp', 'plugins', 'external'], 't1: 三页签固定顺序');
  assert.deepEqual(TOOL_TABS.map((t) => t.label), ['MCP 服务器', '插件', '外部项目'], 't1: 页签文案');
  assert.equal(DEFAULT_TOOL_TAB, 'mcp', 't1: 默认 MCP 服务器页');
}

// t2 记忆(本设备)与非法值回落
{
  const store = new Map();
  const fake = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
  assert.equal(readToolTab(fake), 'mcp', 't2: 无存值回默认');
  assert.equal(writeToolTab('plugins', fake), true, 't2: 合法页签可写');
  assert.equal(readToolTab(fake), 'plugins', 't2: 读回上次页签');
  assert.equal(writeToolTab('不存在', fake), false, 't2: 非法页签拒写');
  assert.equal(readToolTab(fake), 'plugins', 't2: 拒写后旧值不变');
  assert.equal(writeToolTab('font', fake), false, 't2: 主题页签 id 在这里也非法');
  store.set('cgui-tool-tab', 'garbage');
  assert.equal(readToolTab(fake), 'mcp', 't2: 存了脏值也回默认');
  const boom = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };
  assert.equal(readToolTab(boom), 'mcp', 't2: storage 异常回默认');
  assert.equal(writeToolTab('external', boom), false, 't2: storage 异常写入返回 false');
}

// t3 localStorage key 独立(与主题页签不能撞,否则两处互相踩)
{
  const keys = [];
  const spy = { getItem: (k) => { keys.push(k); return null; }, setItem: (k) => { keys.push(k); } };
  readToolTab(spy);
  writeToolTab('external', spy);
  assert.deepEqual([...new Set(keys)], ['cgui-tool-tab'], 't3: 只读写 cgui-tool-tab');
  assert.ok(!keys.includes('cgui-theme-tab'), 't3: 不碰主题页签的 key');
  const themeSrc = readFileSync(new URL('../../client/src/utils/themeTabs.js', import.meta.url), 'utf8');
  assert.match(themeSrc, /LS_KEY = 'cgui-theme-tab'/, 't3: 主题页签 key 仍是 cgui-theme-tab(对照锚)');
}

// t4 接线守卫:TOOL_TABS 的 id 集合 ≡ MCPPanel 里 `tab === 'xxx'` 的实际分支。
// 双向断言 —— 少了 = 该页永远空白;多了 = 数组里没有的死页,点不到。
{
  assert.match(panel, /TOOL_TABS\.map/, 't4: 页签条来自清单');
  assert.match(panel, /role="tablist"/, 't4: 页签条(哨兵锚)');
  const branches = [...panel.matchAll(/tab === '([^']+)'/g)].map((m) => m[1]);
  const rendered = [...panel.matchAll(/\{tab === '([^']+)' &&/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(branches)].sort(), TOOL_TABS.map((t) => t.id).sort(),
    't4: tab === 分支与 TOOL_TABS id 一一对应(改了数组忘改分支/反之都会红)');
  assert.deepEqual(rendered.sort(), TOOL_TABS.map((t) => t.id).sort(), 't4: 每个页签各有一处条件渲染');
  // 三块的锚点标题各自落在对应页内(顺序即页序)
  const idx = (s) => { const i = panel.indexOf(s); assert.ok(i > 0, `t4: 找不到锚点 ${s}`); return i; };
  assert.ok(idx('没有配置 MCP 服务器') > idx("{tab === 'mcp' && ("), 't4: MCP 区块在 MCP 页内');
  assert.ok(idx('已安装插件') > idx("{tab === 'plugins' && ("), 't4: 插件区块在插件页内');
  assert.ok(idx('外部 MCP 项目') > idx("{tab === 'external' && ("), 't4: 外部项目区块在外部页内');
}

// t5 空态不因分页被吞:三页各自的空态文案都还在
{
  assert.match(panel, /没有配置 MCP 服务器/, 't5: MCP 空态');
  assert.match(panel, /没有已安装的插件/, 't5: 插件空态');
  assert.match(panel, /没有检测到外部 MCP 项目/, 't5: 外部项目空态(分页后新增,否则该页全白)');
}

// t6 页签条样式与主题弹层逐字同款(normalize 空白后比对,只差缩进)
{
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const btn = (src) => norm(src.match(/className=\{`([^`]*border-b-2 -mb-px[^`]*)`\}/)[1]);
  assert.equal(btn(panel), btn(app), 't6: 页签按钮 className 与 App.jsx 主题弹层一致');
  const bar = (src) => norm(src.match(/role="tablist"[^>]*className="([^"]+)"/)[1]);
  assert.equal(bar(panel), bar(app), 't6: 页签条容器 className 一致');
  assert.match(panel, /aria-selected=\{tab === t\.id\}/, 't6: 激活态无障碍属性照搬');
}

// t7 数据仍是一次拉全(不许改成按页懒加载,否则第一次切页要转圈)
{
  const effects = [...panel.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\n  \}, \[([^\]]*)\]\)/g)];
  const fetchEffect = effects.find((m) => m[1].includes('fetchData()'));
  assert.ok(fetchEffect, 't7: 挂载拉数据的 effect 还在');
  assert.equal(fetchEffect[2].trim(), '', 't7: 依赖数组为空 —— 不随 tab 重新拉');
}

console.log('check-tool-tabs: all passed (r16-5)');
