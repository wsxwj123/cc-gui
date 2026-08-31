#!/usr/bin/env node
// r64 M11 单测:genui 渲染开关(INTERFACE §4.1)。
//   t1 默认开(决策 7);t2 setter 双写 store + localStorage;t3 落盘的 '0' 下次启动仍是关;
//   t4 接线守卫(围栏经闸门、关掉时留 genui-source 锚、设置区三件锚 + 搜索索引登记)。
//
// 变异哨兵(逐条实际验证过红):
//   ① store 初值写成 === '1'(缺省变关) → t1 红
//   ② setGenuiRender 只 set 不写 localStorage → t2 红
//   ③ GenuiFenceGate 关掉时不打 genui-source 锚(只 return CodeBlock) → t4-b 红
//   ④ MarkdownRenderer 改回直接调 GenuiFence(开关失效) → t4-a 红
//   ⑤ 开关退回 input[type=checkbox](拨完 Esc 关不掉面板) → t4-c 红
// Run: node tests/unit/check-genui-render-toggle.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

// 内存 localStorage 替身:store 是浏览器模块,模块加载期就会读一次初值。
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
const STORE = new URL('../../client/src/stores/sessionStore.js', import.meta.url).href;

// t1 默认开:localStorage 干净时初值必须是 true(决策 7 默认开;默认关等于白做)
{
  const { useStore } = await import(STORE);
  assert.equal(useStore.getState().genuiRender, true, 't1: 无历史设置时渲染开关默认开');
  assert.equal(mem.has('cgui-genui'), false, 't1: 只读不写 —— 没动过开关就不该往 localStorage 塞值');
}

// t2 setter 双写:store 里的值与落盘的值一起变,且键是约定的 cgui-genui
{
  const { useStore } = await import(STORE);
  useStore.getState().setGenuiRender(false);
  assert.equal(useStore.getState().genuiRender, false, 't2: 关掉后 store 里是 false');
  assert.equal(mem.get('cgui-genui'), '0', 't2: 关掉必须落盘 0,否则刷新就回默认开');
  useStore.getState().setGenuiRender(true);
  assert.equal(useStore.getState().genuiRender, true, 't2: 再开回来 store 是 true');
  assert.equal(mem.get('cgui-genui'), '1', 't2: 开启落盘 1');
}

// t3 持久化真的生效:预置 '0' 后重新求值模块(带 query 绕开 ESM 模块缓存 = 模拟下次启动),
// 初值必须是关。只断言"setter 写了值"不够 —— 读的那一端写错(比如判 === '1')照样红不了。
{
  mem.set('cgui-genui', '0');
  const { useStore } = await import(`${STORE}?fresh=off`);
  assert.equal(useStore.getState().genuiRender, false, 't3: 上次关掉的设置,重启后仍是关');
  mem.set('cgui-genui', '1');
  const again = await import(`${STORE}?fresh=on`);
  assert.equal(again.useStore.getState().genuiRender, true, 't3: 上次开着的设置,重启后仍是开');
  // 非 0/1 的脏值(手改 localStorage / 旧版本残留)按"开"处理,不该变成关
  mem.set('cgui-genui', 'yes');
  const dirty = await import(`${STORE}?fresh=dirty`);
  assert.equal(dirty.useStore.getState().genuiRender, true, 't3: 脏值回落默认开');
}

// t4 接线守卫:纯函数测不到"这条开关有没有接上去",只能钉住源码里的几处接线。
{
  // (a) 围栏必须经闸门,不能直挂 GenuiFence —— 直挂等于开关关掉也照渲染
  const md = src('client/src/components/MarkdownRenderer.jsx');
  assert.match(md, /isGenuiLang\(lang\)\)\s*return\s*<GenuiFenceGate/,
    't4-a: cgui-ui 围栏必须交给 GenuiFenceGate(直接给 GenuiFence 则开关失效)');

  // (b) 关掉之后:不渲染组件,但原文必须仍以 genui-source 锚可见(§9.1 —— 走不通的每条路
  //     原始代码块都要在,用户永远不对着空白发呆)
  const gate = src('client/src/components/GenuiFenceGate.jsx');
  assert.match(gate, /useStore\(\(s\)\s*=>\s*s\.genuiRender\)/, 't4-b: 闸门必须订阅 store(否则关了不会当场重渲)');
  assert.match(gate, /data-testid="genui-source"/, 't4-b: 关掉后原始围栏代码块必须带 genui-source 锚');
  assert.match(gate, /if\s*\(on\)\s*return\s*<GenuiFence\b/, 't4-b: 开着才把围栏交给 GenuiFence');
  assert.equal((gate.match(/<GenuiFence\b/g) || []).length, 1,
    't4-b: GenuiFence 只该出现在"开着"那一条分支里(关掉的分支再渲染它 = 开关是摆设)');
  const offBranch = gate.slice(gate.search(/if\s*\(on\)\s*return[^\n]*\n/) + gate.match(/if\s*\(on\)\s*return[^\n]*\n/)[0].length);
  assert.match(offBranch, /<CodeBlock/, 't4-b: 关掉后走普通代码块');
  assert.match(offBranch, /data-testid="genui-source"/, 't4-b: 关掉后的代码块要带 genui-source 锚');

  // (c) 设置区:三件锚 + 搜索索引登记(§9.3/§9.7 的定位路径靠这两样)
  const panel = src('client/src/components/SettingsPanel.jsx');
  for (const tid of ['genui-settings-section', 'genui-render-toggle', 'genui-skill-state',
    'genui-skill-action', 'genui-skill-scope-note', 'settings-search']) {
    assert.ok(panel.includes(`data-testid="${tid}"`), `t4-c: 设置面板缺锚 ${tid}`);
  }
  assert.match(panel, /id:\s*'set-genui',\s*tab:\s*'general'/,
    't4-c: genui 必须登记进 SETTINGS_INDEX 且落默认 tab(否则搜到了也跳不过去/区块不在 DOM)');
  assert.match(panel, /keys:\s*'[^']*genui[^']*'/, 't4-c: 搜索关键词里要有 genui');
  // 开关不能是 input:面板的 Esc 关闭逻辑会把落在 INPUT 上的那一击当"取消编辑"截住
  const toggleTag = panel.slice(panel.indexOf('data-testid="genui-render-toggle"') - 200,
    panel.indexOf('data-testid="genui-render-toggle"') + 120);
  assert.match(toggleTag, /<button[^>]*data-testid="genui-render-toggle"[^>]*role="switch"/s,
    't4-c: 渲染开关必须是 button[role=switch](input 会让拨完开关后 Esc 关不掉面板)');
  assert.match(toggleTag, /aria-checked=\{on\}/, 't4-c: role=switch 必须带 aria-checked,否则无障碍与自动化都读不到状态');
}

console.log('✓ check-genui-render-toggle: t1 默认开 / t2 setter 双写 / t3 持久化 / t4 接线 —— 全通过');