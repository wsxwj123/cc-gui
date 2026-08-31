#!/usr/bin/env node
// 单测:r64 M9 —— 三个"把颜色算进 JS 而不是留给 CSS"的节点必须跟宿主主题走。
//   ① 明暗探测的判据(host-theme.ts,真跑);
//   ② diagram 调色板按宿主明暗选(theme.ts,真跑);
//   ③ mermaid 不再读 style.colorScheme,且切主题后会重新 initialize(源码锁);
//   ④ mermaid / diagram / echart 三处都把 themeEpoch 放进了 deps(源码锁)——
//      少一处,那类图就会停在旧主题直到刷新(INTERFACE §6 点名不许)。
//   ⑤ readToken 经离屏元素归一后才交给 ECharts(源码锁,§1.6.1 坑 A)。
// .tsx 裸 node 加载不了(ERR_UNKNOWN_FILE_EXTENSION),按仓内惯例
// (check-genui-fence-render / check-genui-state-key)对 .tsx 走源码锁,.ts 一律真跑。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// document 存根必须在 import 之前:模块加载期不碰它,但函数调用期会。
const attrs = new Map();
globalThis.document = {
  documentElement: {
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
  },
};
const setTheme = (theme, system) => {
  attrs.clear();
  if (theme !== null) attrs.set('data-theme', theme);
  if (system !== undefined) attrs.set('data-theme-system', system);
};

const { hostPrefersDark } = await import('../../client/src/genui/host/host-theme.ts');
const { resolvePalette } = await import('../../client/src/genui/upstream/blocks/diagram/theme.ts');

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
// "不许再读 style.colorScheme" 这类反向断言要看**代码**,不看注释 ——
// 补丁注释里正要写清楚"上游读的是 style.colorScheme",不剥注释就自己把自己判红了。
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');

// ── t1 明暗判据:与 index.css 的深色 mixin 选择器逐字对齐 ────────────────────
{
  setTheme('dark');
  assert.equal(hostPrefersDark(), true, 't1: [data-theme=dark] 是深色');
  setTheme('light');
  assert.equal(hostPrefersDark(), false, 't1: [data-theme=light] 是浅色');
  setTheme('auto', 'dark');
  assert.equal(hostPrefersDark(), true, 't1: auto + 系统深色 是深色');
  setTheme('auto', 'light');
  assert.equal(hostPrefersDark(), false, 't1: auto + 系统浅色 是浅色');
  setTheme('auto');
  assert.equal(hostPrefersDark(), false, 't1: auto 但系统档缺席 按浅色算(CSS 也是这么算的)');
  setTheme(null);
  assert.equal(hostPrefersDark(), false, 't1: 属性全缺席 按浅色算');

  // 反向:不许拿 style.colorScheme 当探测源 —— SPIKE V7 实测本仓 34/34 恒为空串。
  assert.doesNotMatch(code('client/src/genui/host/host-theme.ts'), /colorScheme/,
    't1: host-theme 不该再碰 style.colorScheme(本仓从不设它)');
}

// ── t2 diagram:缺省与 editorial 跟宿主;显式 light/dark 钉死 ─────────────────
{
  setTheme('dark');
  const darkPaper = resolvePalette(undefined, undefined).paper;
  setTheme('light');
  const lightPaper = resolvePalette(undefined, undefined).paper;
  assert.notEqual(darkPaper, lightPaper, 't2: 缺省 variant 必须跟宿主明暗翻转(上游恒得浅色)');

  setTheme('dark');
  assert.equal(resolvePalette('editorial', undefined).paper, darkPaper,
    't2: editorial 是"默认皮肤",跟宿主走(见 theme.ts 文件头)');
  assert.equal(resolvePalette('light', undefined).paper, lightPaper,
    't2: 显式 light 钉死,不被宿主深色翻掉');
  setTheme('light');
  assert.equal(resolvePalette('dark', undefined).paper, darkPaper,
    't2: 显式 dark 钉死,不被宿主浅色翻掉');

  // spec 级 theme 覆盖仍然优先(上游行为,别改坏)。
  assert.equal(resolvePalette(undefined, { paper: '#123456' }).paper, '#123456',
    't2: spec 里写死的 theme.paper 仍然最优先');
}

// ── t3 mermaid:换探测源 + 切主题后重新 initialize ───────────────────────────
{
  const core = read('client/src/genui/upstream/mermaid-core.ts');
  assert.doesNotMatch(code('client/src/genui/upstream/mermaid-core.ts'), /style\.colorScheme/,
    't3: mermaid 不该再按 style.colorScheme 判明暗(本仓恒为空串 ⟹ 恒定浅色)');
  assert.match(core, /hostPrefersDark/, 't3: 改读 host-theme 的探测');
  // mermaidPromise 是单例、initialize 只跑一次 ⟹ 必须在渲染前比对并重新 initialize。
  assert.match(core, /initializedDark/, 't3: 记住上次 initialize 用的明暗');
  assert.match(core, /if \(dark !== initializedDark\) initMermaid/,
    't3: 每次渲染前比对,不同则重新 initialize');
}

// ── t4 三处 themeEpoch:少一处,那类图就停在旧主题 ────────────────────────────
{
  const cases = [
    ['client/src/genui/upstream/blocks/advanced.tsx', /\}, \[code, themeEpoch\]\)/, 'mermaid 重画'],
    ['client/src/genui/upstream/blocks/diagram/index.tsx', /\[node\.variant, node\.theme, themeEpoch\]/, 'diagram 重算调色板'],
    ['client/src/genui/upstream/EChartNode.tsx', /\}, \[node, status, themeEpoch\]\)/, 'echart 重设 option'],
  ];
  for (const [file, re, what] of cases) {
    const src = read(file);
    assert.match(src, /useHostThemeEpoch\(\)/, `t4: ${file} 要订阅主题代际(${what})`);
    assert.match(src, re, `t4: ${file} 的 deps 里要带上 themeEpoch,否则${what}不会发生`);
  }
}

// ── t5 readToken 归一(§1.6.1 坑 A)────────────────────────────────────────
{
  const src = read('client/src/genui/upstream/EChartNode.tsx');
  assert.match(src, /function readToken[\s\S]{0,220}usedColor\(v\)/,
    't5: readToken 必须经 usedColor 归一后才返回 —— 自定义属性读回来的是声明串不是颜色');
  // 离屏元素必须挂到 body:WebKit 对游离元素的 getComputedStyle 返回空(SPIKE V7)。
  assert.match(src, /document\.body\.appendChild\(colorProbe\)/,
    't5: 取值元素必须 append 到 document.body,游离元素在 WebKit 下读回空');
  // 归一不了要退回 fallback,绝不能返回空串/黑。
  assert.match(src, /NORMALIZED_COLOR\.test\(used\) \? used : null/, 't5: 形态不合规就返回 null');
  assert.match(src, /\?\? fallback/, 't5: 归一失败退回上游 fallback');
  // 安全形态只认 hex 与 rgb/rgba —— zrender 认得的两种。color(srgb …) 之类一律不放行。
  assert.match(src, /const NORMALIZED_COLOR = \/\^\(\?:#\[0-9a-f\]\{3,8\}\|rgba\?\\\(\[\\d\.,\\s\]\+\\\)\)\$\/i/,
    't5: 安全形态正则被改动了,改之前先想清楚 zrender 认不认新形态');
}

console.log('check-genui-theme-follow: all passed');
