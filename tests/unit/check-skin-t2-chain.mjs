#!/usr/bin/env node
// 单测:r11-p2-1 T2 应用链路取证 —— 用最小 DOM shim 真跑 loadT2/disposeT2(非 grep):
// 样式节点真的挂进 head 且带 data-cgui-skin-style 标记、总开关门控、黑名单拒载、
// 三重卸载(disposer 调用/标记节点清零/documentElement 属性快照恢复)。
// 脚本"执行"本身是浏览器行为(append 即跑经典脚本),shim 里以节点挂载+blob URL 生成为证。
// 另:内置 T2 示例的 skin.css 锚点选择器逐个与真实挂点交叉验证(选择器必命中)。
// 变异哨兵(实际验证过红):loadT2 删 style 节点 appendChild → t2 红。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { globSync } from 'glob';

// ── 最小 DOM shim(import skins.js 之前就位;sessionStore 模块初始化也吃它) ──
const head = { children: [], appendChild(n) { this.children.push(n); n._attached = true; } };
const de = {
  attrs: { 'data-theme': 'light' },
  getAttributeNames() { return Object.keys(this.attrs); },
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
  setAttribute(k, v) { this.attrs[k] = String(v); },
  removeAttribute(k) { delete this.attrs[k]; },
  style: { setProperty() {}, removeProperty() {} },
};
const fakeDocument = {
  head,
  documentElement: de,
  createElement(tag) {
    return {
      tagName: tag, attrs: {}, textContent: '', _attached: false, src: '',
      setAttribute(k, v) { this.attrs[k] = String(v); },
      remove() { this._attached = false; head.children = head.children.filter((x) => x !== this); },
    };
  },
  querySelectorAll(sel) {
    if (sel === '[data-cgui-skin-style]') return head.children.filter((n) => 'data-cgui-skin-style' in n.attrs);
    return [];
  },
};
globalThis.document = fakeDocument;
globalThis.window = globalThis;
// sessionStore 模块初始化会挂 window 监听/查询系统主题,shim 出 no-op 面
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.dispatchEvent = () => {};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const lsMap = new Map();
globalThis.localStorage = {
  getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null),
  setItem: (k, v) => lsMap.set(k, String(v)),
  removeItem: (k) => lsMap.delete(k),
};
let blobSeq = 0;
const madeBlobs = [];
URL.createObjectURL = (b) => { madeBlobs.push(b); return `blob:test-${++blobSeq}`; };
URL.revokeObjectURL = () => {};

const { loadT2, disposeT2, setDevSkinsEnabled, devSkinsEnabled, getSkinState } =
  await import('../../client/src/utils/skins.js');

// r13-p2-10:内置示例皮肤退役 → 夹具内联(不依赖出厂内容,覆盖面不减)。
const manifest = {
  format: 'cgui-skin/1', name: 'T2 夹具', tier: 2,
  skin_css: 'skin.css', client_js: 'client.js', a11y_css: 'a11y.css',
  light: { vars: { '--color-accent': '#0B8A2D' } },
  dark: { vars: { '--color-accent': '#39FF14' } },
};
const texts = {
  'skin.css': '[data-cgui="send-btn"] { border-radius: 999px !important; }\n[data-cgui="topbar"] { border-bottom: 1px solid var(--color-accent) !important; }\n[data-cgui="sidebar"] { background-image: repeating-linear-gradient(0deg, transparent 0 2px) !important; }',
  'client.js': "document.documentElement.setAttribute('data-skin-demo','fixture');\nwindow.__cguiSkinDispose = () => document.documentElement.removeAttribute('data-skin-demo');",
  'a11y.css': '[data-cgui="send-btn"]:focus-visible { outline: 2px solid var(--color-accent) !important; }',
};

// t1 总开关门控:默认关 → 不载零节点
{
  assert.equal(devSkinsEnabled(), false, 't1: 默认关');
  const r = await loadT2('builtin-dev', manifest, texts);
  assert.deepEqual(r, { loaded: false, reason: 'disabled' }, 't1: 关闭态拒载');
  assert.equal(head.children.length, 0, 't1: 零注入');
}

// t2 开启后真跑注入:样式节点挂进 head 带标记与原文;script 节点挂载 + Blob URL 生成
{
  setDevSkinsEnabled(true);
  const r = await loadT2('builtin-dev', manifest, texts);
  assert.equal(r.loaded, true, 't2: 载入成功');
  const styles = head.children.filter((n) => n.tagName === 'style');
  const scripts = head.children.filter((n) => n.tagName === 'script');
  assert.equal(styles.length, 2, 't2: skin.css + a11y.css 两个样式节点真挂进 head(哨兵锚)');
  for (const n of styles) assert.equal(n.attrs['data-cgui-skin-style'], 'builtin-dev', 't2: 样式节点带卸载标记');
  assert.equal(styles[0].textContent, texts['skin.css'], 't2: skin.css 原文注入');
  assert.equal(styles[1].textContent, texts['a11y.css'], 't2: a11y.css 原文注入');
  assert.equal(scripts.length, 1, 't2: client.js 脚本节点挂载(浏览器 append 即执行经典脚本)');
  assert.match(scripts[0].src, /^blob:test-/, 't2: Blob-URL 经典脚本形态');
  assert.equal(madeBlobs.length, 1, 't2: Blob 已生成');
}

// t3 三重卸载:disposer 被调 → 标记节点清零 → documentElement 属性恢复快照
{
  let disposed = 0;
  // 模拟皮肤脚本运行后的效果(shim 不执行 js):打标记 + 注册卸载器
  de.setAttribute('data-skin-demo', '1');
  globalThis.window.__cguiSkinDispose = () => { disposed++; };
  disposeT2();
  assert.equal(disposed, 1, 't3: ①皮肤自注册 disposer 被调用');
  assert.equal(fakeDocument.querySelectorAll('[data-cgui-skin-style]').length, 0, 't3: ②标记节点逐项移除清零');
  assert.equal(head.children.length, 0, 't3: head 无残留');
  assert.equal(de.getAttribute('data-skin-demo'), null, 't3: ③documentElement 属性快照恢复(脚本痕迹清除)');
  assert.equal(de.getAttribute('data-theme'), 'light', 't3: 快照外属性原样保留');
  assert.equal(getSkinState().t2, null, 't3: 引擎态清空');
}

// t4 黑名单拒载(链路级,与静态校验器同刀)
{
  const r = await loadT2('x', { tier: 2 }, { 'client.js': 'fetch("/steal")' });
  assert.equal(r.loaded, false, 't4: 拒载');
  assert.deepEqual(r.hits, ['fetch('], 't4: 命中清单');
  assert.equal(head.children.length, 0, 't4: 拒载零注入');
  setDevSkinsEnabled(false);
}

// t5 锚点选择器命中取证:内置示例 skin.css/a11y.css 引用的每个 data-cgui 锚点
//    都真实挂在源码上(选择器必命中真实 DOM)
{
  const root = fileURLToPath(new URL('../..', import.meta.url));
  let all = '';
  for (const f of globSync('client/src/**/*.jsx', { cwd: root })) all += readFileSync(`${root}/${f}`, 'utf8');
  const css = texts['skin.css'] + '\n' + texts['a11y.css'];
  const used = [...css.matchAll(/\[data-cgui="([a-z0-9-]+)"\]/g)].map((m) => m[1]);
  assert.ok(new Set(used).size >= 3, `t5: 示例引用 ≥3 个锚点(实际 ${new Set(used).size})`);
  for (const id of new Set(used)) {
    assert.ok(all.includes(`data-cgui="${id}"`), `t5: 锚点 ${id} 已挂载,选择器命中`);
  }
}

console.log('check-skin-t2-chain: all passed');
