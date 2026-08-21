#!/usr/bin/env node
// r26-D1【复现+幂等并发】:T2 装载无代际防护,快速切换串皮。
// 场景:activateSkin 快速连切两个 T2 皮肤(或 StrictMode 双跑),loadT2 多次 await 后
// 无条件插节点、覆盖 state.t2 —— 先发的慢装载 A 后完成,把 A 的样式节点插进 head 并
// 覆盖掉后发的 B 的引擎态 → 界面显示 B 的名字、挂着 A+B 两套样式(串皮)。
// 修复后期望:代际防护(每次装载递增 token,完成时比对,过期则不插入/不覆盖 state.t2)
// 或等价串行化 —— 可观测:两次并发装载结束后,head 里只有 B(后激活者)的节点,
// state.t2 也是 B 的。
// Run: node tests/acceptance/r26/d1-t2-generation-race.mjs
import assert from 'node:assert/strict';
import { stubLocalStorage, stubDom, sleep } from './lib.mjs';

stubLocalStorage();
const { head } = stubDom();

// fetch 桩:皮肤 A 的资源慢(60ms),皮肤 B 的快(5ms)——制造「先发后至」的真实竞态。
const realFetch = globalThis.fetch;
globalThis.fetch = (url) => {
  const slow = String(url).includes('/skins/skin-a/');
  return new Promise((resolve) => setTimeout(() => resolve({
    ok: true,
    text: async () => `/* css of ${slow ? 'A' : 'B'} */`,
  }), slow ? 60 : 5));
};

const { loadT2, disposeT2, setDevSkinsEnabled, getSkinState } = await import('../../../client/src/utils/skins.js');

try {
  setDevSkinsEnabled(true);
  const mA = { tier: 2, skin_css: 'skin.css' };
  const mB = { tier: 2, skin_css: 'skin.css' };

  // 并发:A 先开始(慢),B 后开始(快)——用户最后一次激活的是 B,B 必须赢。
  const pA = loadT2('skin-a', mA);
  const pB = loadT2('skin-b', mB);
  await Promise.all([pA, pB]);

  const skinNodes = head.children.filter((n) => 'data-cgui-skin-style' in n.attrs);
  assert.ok(skinNodes.length > 0, 'D1 夹具:至少 B 的节点应挂上');
  assert.ok(
    skinNodes.every((n) => n.attrs['data-cgui-skin-style'] === 'skin-b'),
    `D1: 后激活的 skin-b 应独占 head,实际挂着 [${skinNodes.map((n) => n.attrs['data-cgui-skin-style']).join(', ')}] —— 慢一拍的 skin-a 串进来了`,
  );
  const t2 = getSkinState().t2;
  assert.ok(t2, 'D1: state.t2 应指向最后激活的皮肤');
  assert.ok(
    (t2.styleNodes || []).every((n) => n.attrs['data-cgui-skin-style'] === 'skin-b'),
    'D1: state.t2 被慢一拍的 skin-a 覆盖(引擎态与界面不一致,卸载时会漏清)',
  );

  // 卸载兜底:串皮修好后 dispose 必须清得一个不剩
  disposeT2();
  assert.equal(head.children.filter((n) => 'data-cgui-skin-style' in n.attrs).length, 0,
    'D1: dispose 后 head 不得残留任何皮肤节点');
} finally {
  globalThis.fetch = realFetch;
}

console.log('PASS r26-d1-t2-generation-race');
