#!/usr/bin/env node
// r31 钉子:disposeT2 不得误删 app 自持属性(data-theme / data-cgui-theme 等)。
// 根因:disposeT2 的「新增属性摘除」分支(①存活期新增、②装载期新增)对所有不在
// preSnap/loadedSnap 的属性一律 removeAttribute —— 皮肤存活期 app 被 sessionStore
// setTheme 写的 data-theme / data-cgui-theme(例如默认主题 cguiTheme='' 时 data-cgui-theme
// 缺席,用户切到某主题家族后 app 才补上)会被当成「新增」误删 → 停用皮肤=把用户主题摘掉。
// 修:定义 APP_ATTRS(data-theme/data-cgui-theme/data-theme-system/style)豁免摘除;
//      还原路径(if(inPre) setAttribute(preSnap))仍照常。
// 钉:①存活期 app 新增 data-cgui-theme → dispose 后保留;②装载期(加载窗口)app 新增
//    data-cgui-theme → dispose 后保留;③皮肤自己的新属性仍被摘除(豁免不过宽);
//    ④皮肤存活期用户改 data-theme 仍保留(已有行为哨兵)。
// Run: node tests/unit/check-r31-dispose-app-attrs.mjs
import assert from 'node:assert/strict';

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
  style: { setProperty() {}, removeProperty() {} },
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
  loadT2, disposeT2, setDevSkinsEnabled, getSkinState,
} = await import('../../client/src/utils/skins.js');

setDevSkinsEnabled(true);
const manifest = { tier: 2, skin_css: 'skin.css', client_js: 'client.js' };
const texts = { 'skin.css': ':root{x:1}', 'client.js': '/* noop */' };
const reset = async () => {
  globalThis.__onScriptAppend = null;
  disposeT2();
  head.children = [];
  // 默认主题(cguiTheme='')不设 data-cgui-theme;只留 data-theme
  resetAttrs({ 'data-theme': 'dark' });
  assert.equal(getSkinState().t2, null, '夹具:每例间引擎态清空');
};

// ① 存活期 app 新增 data-cgui-theme → dispose 后保留(修前被当「存活期新增」删掉)
{
  await reset();
  await loadT2('skin-a', manifest, texts);
  de.setAttribute('data-cgui-theme', 'rosepine'); // app setTheme 在皮肤存活期补上
  de.setAttribute('data-skin-new', 'y');          // 皮肤自己的新属性
  disposeT2();
  assert.equal(de.getAttribute('data-cgui-theme'), 'rosepine', '① app 存活期新增 data-cgui-theme 必须保留');
  assert.equal(de.getAttribute('data-skin-new'), null, '① 皮肤自己的新属性仍被摘除(豁免不过宽)');
}

// ② 装载期(app 在 preSnap→loadedSnap 窗口补 data-cgui-theme)→ dispose 后保留
{
  await reset();
  globalThis.__onScriptAppend = () => de.setAttribute('data-cgui-theme', 'catppuccin');
  await loadT2('skin-a', manifest, texts);
  disposeT2();
  assert.equal(de.getAttribute('data-cgui-theme'), 'catppuccin', '② 装载期 app 新增 data-cgui-theme 必须保留');
}

// ③ 皮肤存活期用户改 data-theme 仍保留(既有行为哨兵不回退)
{
  await reset();
  await loadT2('skin-a', manifest, texts);
  de.setAttribute('data-theme', 'light'); // 用户换主题
  disposeT2();
  assert.equal(de.getAttribute('data-theme'), 'light', '③ 用户改过的 data-theme 保留');
}

// ④ 还原路径仍生效:皮肤装载期改既有属性且没人再动 → 还原到装载前
{
  await reset();
  resetAttrs({ 'data-theme': 'dark', 'data-x': '1' });
  globalThis.__onScriptAppend = () => de.setAttribute('data-x', '2');
  await loadT2('skin-a', manifest, texts);
  disposeT2();
  assert.equal(de.getAttribute('data-x'), '1', '④ 皮肤改过且没人再动 → 还原装载前值');
  assert.equal(de.getAttribute('data-theme'), 'dark', '④ data-theme 还原到装载前(not clobbered)');
}

globalThis.__onScriptAppend = null;
console.log('PASS check-r31-dispose-app-attrs');
