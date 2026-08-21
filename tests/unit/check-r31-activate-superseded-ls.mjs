#!/usr/bin/env node
// r31 钉子:被 superseded 的慢皮肤 loadT2 完成后不得写 LS_ID/缓存。
// 根因:activateSkin 里 `if (!tryOn)` 写缓存段在 `await loadT2(...)` 之后 —— 快速连切时
// 先发的慢皮肤在 await 期间被后发的皮肤越代(++t2Gen),loadT2 返回 reason:'superseded',
// 但旧代码照样把已被替代的皮写进 LS_ID → 重启 bootReplaySkin 回放到旧皮。
// 修:写缓存段加 `gen === t2Gen` 代际守卫(superseded 不写)。
// 钉:①快速连切后 LS_ID/LS_CACHE 属于后激活者(superseded 的皮不落盘);②停用清空;
//      ③正常单发不受影响;④tier-1 无 await 也不受影响。
// Run: node tests/unit/check-r31-activate-superseded-ls.mjs
import assert from 'node:assert/strict';

// ── 最小 DOM/localStorage shim(形态对齐 check-r26-t2-generation.mjs) ──
const head = { children: [], appendChild(n) { this.children.push(n); n._attached = true; } };
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

const realFetch = globalThis.fetch;
globalThis.fetch = (url) => {
  const slow = String(url).includes('/skins/skin-slow/');
  return new Promise((resolve) => setTimeout(() => resolve({
    ok: true,
    text: async () => `/* css of ${slow ? 'slow' : 'fast'} */`,
  }), slow ? 60 : 5));
};

const {
  activateSkin, deactivateSkin, getSkinState, setDevSkinsEnabled,
} = await import('../../client/src/utils/skins.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const m = { tier: 2, skin_css: 'skin.css' };
const LS_ID = 'cgui-skin-id', LS_CACHE = 'cgui-skin-cache';
const lsId = () => localStorage.getItem(LS_ID);
const lsCacheId = () => { try { return JSON.parse(localStorage.getItem(LS_CACHE) || 'null')?.id || null; } catch { return null; } };

try {
  setDevSkinsEnabled(true);

  // ① 快速连切:先 A(慢)后 B(快) → B supersede A → 只有 B 落盘
  {
    const pA = activateSkin({ id: 'skin-slow', manifest: m });
    const pB = activateSkin({ id: 'skin-fast', manifest: m });
    const [rA, rB] = await Promise.all([pA, pB]);
    assert.equal(rB.t2.loaded, true, '①夹具:后激活者装载成功');
    assert.equal(rA.t2.reason, 'superseded', '①夹具:先激活者在途装载 superseded');
    assert.equal(getSkinState().t2?.styleNodes?.[0]?.attrs?.['data-cgui-skin-style'], 'skin-fast',
      '① state.t2 属于后激活者');
    // 核心:superseded 的皮绝不能写进 LS_ID
    assert.equal(lsId(), 'skin-fast', '① superseded(skin-slow)不写 LS_ID,只留后激活者 skin-fast');
    assert.equal(lsCacheId(), 'skin-fast', '① LS_CACHE 同样是后激活者(superseded 不写缓存)');
    deactivateSkin();
    assert.equal(lsId(), null, '① 停用清空 LS_ID');
  }

  // ② 单发(superseded 不适用):照常写入
  {
    await activateSkin({ id: 'skin-fast', manifest: m });
    assert.equal(lsId(), 'skin-fast', '② 单发激活照常落盘');
    deactivateSkin();
    assert.equal(lsId(), null, '② 停用清空');
  }

  // ③ tier-1 无 await:gen===t2Gen 恒真,照常落盘
  {
    await activateSkin({ id: 'skin-t1', manifest: { tier: 1 } });
    assert.equal(lsId(), 'skin-t1', '③ tier-1 无 await,照常落盘(守卫不误伤)');
    deactivateSkin();
  }

  await sleep(80); // 慢 fetch 尾包回来也不得复活 LS_ID/节点
  assert.equal(lsId(), null, '尾包不复活 LS_ID');
} finally {
  globalThis.fetch = realFetch;
}

console.log('PASS check-r31-activate-superseded-ls');
