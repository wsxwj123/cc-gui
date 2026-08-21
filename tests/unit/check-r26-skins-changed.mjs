#!/usr/bin/env node
// r26-D7(client 侧,契约 C-D7):WS 收到 { type:'skins-changed', deletedId } →
// 若 deletedId === 当前皮肤 id,deactivateSkin() 静默回默认。
// (服务端 broadcast 由 PKG-7 发;本包只负责 useWebSocket.js 的分支。)
// ①源码哨兵:分支存在、payload 键名逐字钉死、误判守卫(deletedId 等于当前皮肤才卸);
// ②行为层:真 skins.js 状态机跑一遍「删当前皮肤 → 卸下 / 删别的皮肤 → 不动」,
//   与 reducer 分支同一判据(getSkinState().id === deletedId → deactivateSkin())。
// Run: node tests/unit/check-r26-skins-changed.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 最小 DOM stub(与 tests/unit/check-skin-t2-chain.mjs 同形态)
const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => storage.get(k) ?? null,
  setItem: (k, v) => { storage.set(k, String(v)); },
  removeItem: (k) => { storage.delete(k); },
};
const de = {
  attrs: { 'data-theme': 'light' },
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
  setAttribute(k, v) { this.attrs[k] = String(v); },
  removeAttribute(k) { delete this.attrs[k]; },
  style: { setProperty() {}, removeProperty() {} },
};
globalThis.document = { documentElement: de, head: { appendChild() {} }, createElement: () => ({ setAttribute() {}, remove() {} }), querySelectorAll: () => [] };
globalThis.window = globalThis;
if (!globalThis.addEventListener) globalThis.addEventListener = () => {};
if (!globalThis.matchMedia) globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const { getSkinState, deactivateSkin, applySkinDom } = await import('../../client/src/utils/skins.js');

// reducer 分支的判据与动作(与 useWebSocket.js 逐字同语义)
const onSkinsChanged = (data) => {
  if (data.deletedId && getSkinState().id === data.deletedId) deactivateSkin();
};

// ② 行为层:删当前皮肤 → 卸下(静默回默认)
applySkinDom('skin-a', { shared: { vars: {} } });
assert.equal(getSkinState().id, 'skin-a', 'D7 夹具:皮肤已应用');
assert.equal(de.getAttribute('data-cgui-skin'), 'skin-a', 'D7 夹具:data-cgui-skin 属性已挂');
onSkinsChanged({ type: 'skins-changed', deletedId: 'skin-a' });
assert.equal(getSkinState().id, null, 'D7: 删除当前皮肤 → 静默卸下(状态回 null)');
assert.equal(de.getAttribute('data-cgui-skin'), null, 'D7: documentElement 无 data-cgui-skin 残留');

// ②b 误卸哨兵:删别的皮肤 → 当前皮肤不动
applySkinDom('skin-b', { shared: { vars: {} } });
onSkinsChanged({ type: 'skins-changed', deletedId: 'skin-other' });
assert.equal(getSkinState().id, 'skin-b', 'D7: deletedId ≠ 当前皮肤 → 不得误卸');
onSkinsChanged({ type: 'skins-changed' }); // 无 deletedId
assert.equal(getSkinState().id, 'skin-b', 'D7: 无 deletedId 的广播不动当前皮肤');

// ① 源码哨兵(契约形状逐字)
const src = readFileSync(new URL('../../client/src/hooks/useWebSocket.js', import.meta.url), 'utf8');
assert.match(src, /case 'skins-changed':/, 'D7: useWebSocket 必须有 skins-changed 分支');
assert.match(src, /data\.deletedId && getSkinState\(\)\.id === data\.deletedId\) deactivateSkin\(\)/,
  'D7: 判据必须是 deletedId === 当前皮肤才 deactivateSkin(误卸哨兵)');

console.log('PASS check-r26-skins-changed');
