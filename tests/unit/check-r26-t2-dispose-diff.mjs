#!/usr/bin/env node
// r26-D2【单测】:disposeT2 二次快照 diff(PLAN D2 验收点①–⑦)。
//   ① 装载后用户改 data-theme → dispose 保留用户值(核心哨兵);
//   ② 皮肤装载期设置的 attr 且之后没人动 → 还原装载前值/摘除装载期新增;
//   ③ 皮肤存活期新增的 attr → dispose 后移除;
//   ④ 装载后第三方改过的 attr → 保留新值;
//   ⑤ 模拟 watchThemeForSkin 触发 applySkinDom 后 dispose → appliedVars 全清、
//     data-theme 不回滚(明暗联动交互哨兵);
//   ⑥ 装载期删除还原哨兵:preSnap 有、皮肤装载期 removeAttribute、dispose 时仍缺席 → 还原;
//   ⑦ 同形态但 dispose 前第三方重设 → 保持新值不回滚(补丁分支哨兵)。
// 皮肤脚本「执行」用 shim 模拟:classic script append 即跑 → head.appendChild 对
// script 节点触发 __onScriptAppend 回调(恰落在 preSnap 与 loadedSnap 之间)。
// Run: node tests/unit/check-r26-t2-dispose-diff.mjs
import assert from 'node:assert/strict';

// ── 最小 DOM/localStorage shim(style 带记录,可观测 appliedVars 清理) ──
const styleMap = new Map();
const head = {
  children: [],
  appendChild(n) {
    this.children.push(n);
    n._attached = true;
    if (n.tagName === 'script' && typeof globalThis.__onScriptAppend === 'function') {
      globalThis.__onScriptAppend(); // classic 脚本 append 即执行
    }
  },
};
const de = {
  attrs: {},
  getAttributeNames() { return Object.keys(this.attrs); },
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
  setAttribute(k, v) { this.attrs[k] = String(v); },
  removeAttribute(k) { delete this.attrs[k]; },
  style: {
    setProperty(k, v) { styleMap.set(k, v); },
    removeProperty(k) { styleMap.delete(k); },
  },
};
const resetAttrs = (obj) => { de.attrs = { ...obj }; };
globalThis.document = {
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
globalThis.window = globalThis;
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
URL.createObjectURL = () => `blob:test-${++blobSeq}`;
URL.revokeObjectURL = () => {};

const {
  loadT2, disposeT2, applySkinDom, clearSkinDom, setDevSkinsEnabled, getSkinState,
} = await import('../../client/src/utils/skins.js');

setDevSkinsEnabled(true);
const manifest = { tier: 2, skin_css: 'skin.css', client_js: 'client.js' };
const texts = { 'skin.css': ':root{x:1}', 'client.js': '/* noop */' };
const reset = async () => {
  globalThis.__onScriptAppend = null;
  disposeT2();
  head.children = [];
  resetAttrs({ 'data-theme': 'light' });
  assert.equal(getSkinState().t2, null, '夹具:每例间引擎态清空');
};

// ① 核心哨兵:用户激活期间改主题不被回滚
{
  await reset();
  const r = await loadT2('skin-d2', manifest, texts);
  assert.equal(r.loaded, true, '①夹具:装载成功');
  de.setAttribute('data-theme', 'dark'); // 用户换主题
  disposeT2();
  assert.equal(de.getAttribute('data-theme'), 'dark', '① 用户改过的 data-theme 必须保留(修前被回滚 light)');
}

// ② 皮肤装载期设置的 attr 没人再动 → 还原/摘除
{
  await reset();
  resetAttrs({ 'data-theme': 'light', 'data-x': '1' });
  globalThis.__onScriptAppend = () => {
    de.setAttribute('data-x', '2');        // 皮肤改了既有属性
    de.setAttribute('data-skin-new', 'y'); // 皮肤新增属性
  };
  await loadT2('skin-d2', manifest, texts);
  assert.equal(de.getAttribute('data-x'), '2', '②夹具:皮肤改动落在 loadedSnap');
  disposeT2();
  assert.equal(de.getAttribute('data-x'), '1', '② 皮肤改过且没人再动 → 还原装载前值');
  assert.equal(de.getAttribute('data-skin-new'), null, '② 装载期新增 → 摘除');
}

// ③ 存活期新增(皮肤脚本异步/第三方)→ dispose 后移除
{
  await reset();
  await loadT2('skin-d2', manifest, texts);
  de.setAttribute('data-late', '1'); // loadedSnap 之后新增
  disposeT2();
  assert.equal(de.getAttribute('data-late'), null, '③ 存活期新增属性 → 移除');
}

// ④ 装载后第三方改过 → 保留新值
{
  await reset();
  resetAttrs({ 'data-theme': 'light', 'data-y': 'a' });
  globalThis.__onScriptAppend = () => de.setAttribute('data-y', 'b'); // 皮肤装载期改
  await loadT2('skin-d2', manifest, texts);
  de.setAttribute('data-y', 'c'); // 之后第三方再改
  disposeT2();
  assert.equal(de.getAttribute('data-y'), 'c', '④ 第三方改过的属性不回滚(cur≠loadedSnap → 不动)');
}

// ⑤ watchThemeForSkin 交互:明暗切换重跑 applySkinDom → dispose 后 appliedVars 全清、主题不回滚
{
  await reset();
  const m2 = { tier: 2, skin_css: 'skin.css',
    light: { vars: { '--color-accent': '#111111' } }, dark: { vars: { '--color-accent': '#222222' } } };
  await loadT2('skin-d2', m2, { 'skin.css': ':root{x:1}' });
  applySkinDom('skin-d2', m2); // 初次应用
  de.setAttribute('data-theme', 'dark'); // 用户切暗色
  applySkinDom('skin-d2', m2); // watchThemeForSkin 重跑(明暗切换)
  assert.ok(getSkinState().appliedVars.length > 0, '⑤夹具:变量已应用');
  clearSkinDom(); // 完整停用路径(disposeT2 → clearVars)
  assert.equal(getSkinState().appliedVars.length, 0, '⑤ appliedVars 全部清除');
  assert.equal(styleMap.has('--color-accent'), false, '⑤ 皮肤 inline 变量不泄漏(clearVars 精确清)');
  assert.equal(de.getAttribute('data-theme'), 'dark', '⑤ data-theme 不回滚');
}

// ⑥ 装载期删除还原哨兵:preSnap 有、皮肤装载期删掉、dispose 时仍缺席 → 还原
{
  await reset();
  resetAttrs({ 'data-theme': 'light', 'data-x': '1' });
  globalThis.__onScriptAppend = () => de.removeAttribute('data-x'); // 皮肤装载期删除
  await loadT2('skin-d2', manifest, texts);
  assert.equal(de.getAttribute('data-x'), null, '⑥夹具:装载期删除生效(loadedSnap 无此键)');
  disposeT2();
  assert.equal(de.getAttribute('data-x'), '1', '⑥ 装载期删除且仍缺席 → 还原 preSnap 值(迭代域含 keys(preSnap) 哨兵)');
}

// ⑦ 补丁分支哨兵:装载期删除、但 dispose 前第三方重设 → 保持新值
{
  await reset();
  resetAttrs({ 'data-theme': 'light', 'data-x': '1' });
  globalThis.__onScriptAppend = () => de.removeAttribute('data-x');
  await loadT2('skin-d2', manifest, texts);
  de.setAttribute('data-x', '2'); // 第三方重设
  disposeT2();
  assert.equal(de.getAttribute('data-x'), '2', '⑦ 皮肤删掉但第三方重设 → 保留现状不回滚');
}

globalThis.__onScriptAppend = null;
console.log('PASS check-r26-t2-dispose-diff');
