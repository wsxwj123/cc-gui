#!/usr/bin/env node
// r26-D8【单测】:reconcileSkinOnBoot 先查服务端列表再判 builtin- 分支(PLAN D8 验收点)。
//   ① 用户皮肤叫 "builtin xxx" 得的 builtin- 前缀 id,服务端列表命中 → 按服务端
//     manifest 激活(修前被 builtin- 本地分支静默 deactivate——前缀劫持哨兵);
//   ② 服务端列表查无且 builtin- 前缀 → deactivate(退役清理语义保留哨兵);
//   ③ 服务端查无、非 builtin- 前缀 → deactivate(失效清理回归);
//   ④ fetch 失败 → 保持缓存重放原样(网络异常不动现状哨兵)。
// Run: node tests/unit/check-r26-reconcile-builtin.mjs
import assert from 'node:assert/strict';

// ── 最小 DOM/localStorage shim ──
const head = { children: [], appendChild(n) { this.children.push(n); } };
const de = {
  attrs: { 'data-theme': 'light' },
  getAttributeNames() { return Object.keys(this.attrs); },
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
  setAttribute(k, v) { this.attrs[k] = String(v); },
  removeAttribute(k) { delete this.attrs[k]; },
  style: { setProperty() {}, removeProperty() {} },
};
globalThis.document = {
  head,
  documentElement: de,
  createElement(tag) {
    return { tagName: tag, attrs: {}, setAttribute(k, v) { this.attrs[k] = String(v); }, remove() {} };
  },
  querySelectorAll() { return []; },
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

const realFetch = globalThis.fetch;
let fetchImpl = () => Promise.reject(new Error('no stub'));
globalThis.fetch = (...a) => fetchImpl(...a);
const stubList = (skins) => {
  fetchImpl = async (url) => {
    assert.equal(url, '/api/skins', 'reconcile 只拉 /api/skins');
    return { ok: true, json: async () => ({ skins }) };
  };
};

const { reconcileSkinOnBoot, getSkinState, deactivateSkin } = await import('../../client/src/utils/skins.js');

const LS_ID = 'cgui-skin-id';
const userManifest = {
  format: 'cgui-skin/1', name: 'builtin 望远镜', tier: 1,
  light: { vars: { '--color-accent': '#123456' } },
};
const reset = (id) => {
  deactivateSkin();
  lsMap.clear();
  if (id != null) lsMap.set(LS_ID, id);
  de.attrs = { 'data-theme': 'light' };
};

try {
  // ① 服务端列表命中的 builtin- 前缀用户皮肤 → 激活(不 deactivate)
  {
    reset('builtin-wangyuanjing-a1b2c3');
    stubList([{ id: 'builtin-wangyuanjing-a1b2c3', name: 'builtin 望远镜', manifest: userManifest }]);
    await reconcileSkinOnBoot();
    assert.equal(getSkinState().id, 'builtin-wangyuanjing-a1b2c3',
      '① builtin- 前缀用户皮肤必须按服务端 manifest 激活(修前被前缀劫持静默卸)');
    assert.equal(getSkinState().manifest, userManifest, '① 用的是服务端 manifest');
    assert.equal(de.getAttribute('data-cgui-skin'), 'builtin-wangyuanjing-a1b2c3', '① 皮肤属性已挂');
    assert.equal(lsMap.get(LS_ID), 'builtin-wangyuanjing-a1b2c3', '① 激活态保留');
  }

  // ② 服务端查无 + builtin- 前缀 → deactivate(退役清理语义保留)
  {
    reset('builtin-retired-old');
    stubList([]);
    await reconcileSkinOnBoot();
    assert.equal(getSkinState().id, null, '② 查无的 builtin- 前缀 → 停用(BUILTIN_SKINS 已空)');
    assert.equal(lsMap.get(LS_ID) ?? null, null, '② localStorage 激活态已清');
    assert.equal(de.getAttribute('data-cgui-skin'), null, '② 皮肤属性已卸');
  }

  // ③ 服务端查无 + 非 builtin- 前缀 → deactivate(失效清理回归)
  {
    reset('user-gone-x1y2z3');
    stubList([]);
    await reconcileSkinOnBoot();
    assert.equal(getSkinState().id, null, '③ 失效用户皮肤 → 静默清');
    assert.equal(lsMap.get(LS_ID) ?? null, null, '③ localStorage 激活态已清');
  }

  // ④ fetch 失败 → 保持现状不动(缓存重放的样子)
  {
    reset('builtin-wangyuanjing-a1b2c3');
    getSkinState().id = 'cached-replay'; // 模拟 bootReplaySkin 已重放的引擎态
    fetchImpl = async () => { throw new Error('network down'); };
    await reconcileSkinOnBoot();
    assert.equal(getSkinState().id, 'cached-replay', '④ 网络失败保持缓存重放原样(不 deactivate)');
  }
} finally {
  globalThis.fetch = realFetch;
}

console.log('PASS check-r26-reconcile-builtin');
