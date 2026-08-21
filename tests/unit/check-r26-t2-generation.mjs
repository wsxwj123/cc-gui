#!/usr/bin/env node
// r26-D1【单测】:T2 装载代际 token(PLAN D1 验收点)。
//   ①串皮哨兵:A 慢 B 快并发装载 → 文档里只有 B 的节点、state.t2 属 B、A 返回
//     reason === 'superseded';
//   ②停用失效哨兵:装载在途时 deactivateSkin → 在途装载回来到点即弃,零节点零覆盖;
//   ③正常路径回归:单发装载不受影响(loaded:true)。
// Run: node tests/unit/check-r26-t2-generation.mjs
import assert from 'node:assert/strict';

// ── 最小 DOM/localStorage shim(形态对齐 check-skin-t2-chain.mjs) ──
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

// fetch 桩:skin-slow 慢(60ms)、skin-fast 快(5ms)——制造「先发后至」竞态
const realFetch = globalThis.fetch;
globalThis.fetch = (url) => {
  const slow = String(url).includes('/skins/skin-slow/');
  return new Promise((resolve) => setTimeout(() => resolve({
    ok: true,
    text: async () => `/* css of ${slow ? 'slow' : 'fast'} */`,
  }), slow ? 60 : 5));
};

const {
  loadT2, disposeT2, activateSkin, deactivateSkin, setDevSkinsEnabled, getSkinState,
} = await import('../../client/src/utils/skins.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const skinNodes = () => head.children.filter((n) => 'data-cgui-skin-style' in n.attrs);
const m = { tier: 2, skin_css: 'skin.css' };

try {
  setDevSkinsEnabled(true);

  // ③ 正常路径回归:单发装载不受影响
  {
    const r = await loadT2('skin-fast', m);
    assert.equal(r.loaded, true, 't3: 单发装载正常');
    assert.equal(skinNodes().length, 1, 't3: 节点挂载');
    disposeT2();
    assert.equal(skinNodes().length, 0, 't3: 卸载清零');
  }

  // ① 串皮哨兵:A(慢)先发、B(快)后发 → B 独占,A superseded
  {
    const pA = loadT2('skin-slow', m);
    const pB = loadT2('skin-fast', m);
    const [rA, rB] = await Promise.all([pA, pB]);
    assert.equal(rB.loaded, true, 't1: 后激活的 B 装载成功');
    assert.equal(rA.loaded, false, 't1: 慢一拍的 A 被拒');
    assert.equal(rA.reason, 'superseded', 't1: A 的拒因 = superseded(哨兵锚)');
    assert.ok(skinNodes().length > 0, 't1: 夹具有效(至少 B 挂上)');
    assert.ok(skinNodes().every((n) => n.attrs['data-cgui-skin-style'] === 'skin-fast'),
      't1: head 里只有后激活的 skin-fast(串皮哨兵)');
    const t2 = getSkinState().t2;
    assert.ok(t2, 't1: state.t2 指向最后激活者');
    assert.ok((t2.styleNodes || []).every((n) => n.attrs['data-cgui-skin-style'] === 'skin-fast'),
      't1: state.t2 未被慢一拍的 A 覆盖');
    disposeT2();
    assert.equal(skinNodes().length, 0, 't1: 卸载后零残留');
  }

  // ② 停用失效哨兵:activateSkin 在途 → deactivateSkin → 在途装载到点即弃
  {
    const p = activateSkin({ id: 'skin-slow', manifest: m });
    deactivateSkin(); // 停用递增代际,在途装载失效
    const { t2 } = await p;
    assert.equal(t2.loaded, false, 't2: 停用后在途装载被拒');
    assert.equal(t2.reason, 'superseded', 't2: 拒因 = superseded');
    assert.equal(skinNodes().length, 0, 't2: 零节点插入');
    assert.equal(getSkinState().t2, null, 't2: state.t2 不被覆盖');
  }

  // ②b 快速连切 activateSkin:旧激活的在途装载同样失效
  {
    const pA = activateSkin({ id: 'skin-slow', manifest: m });
    const pB = activateSkin({ id: 'skin-fast', manifest: m });
    const [rA, rB] = await Promise.all([pA, pB]);
    assert.equal(rB.t2.loaded, true, 't2b: 后激活者装载成功');
    assert.equal(rA.t2.reason, 'superseded', 't2b: 先激活者在途装载 superseded');
    assert.ok(skinNodes().every((n) => n.attrs['data-cgui-skin-style'] === 'skin-fast'),
      't2b: activateSkin 连切不串皮');
    deactivateSkin();
    assert.equal(skinNodes().length, 0, 't2b: 停用清零');
    await sleep(80); // 慢 fetch 尾包回来也不得有节点复活
    assert.equal(skinNodes().length, 0, 't2b: 尾包不复活节点');
  }
} finally {
  globalThis.fetch = realFetch;
}

console.log('PASS check-r26-t2-generation');
