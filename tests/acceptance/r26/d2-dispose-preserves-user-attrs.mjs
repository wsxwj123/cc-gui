#!/usr/bin/env node
// r26-D2【复现+反向】:disposeT2 快照回滚误伤用户改动。
// 场景:T2 皮肤激活期间,用户手动换了主题(data-theme: light → dark)。卸皮肤时
// disposeT2 拿「装载前的全量属性快照」无差别还原 → 用户刚换的主题被回滚成激活前的值。
// (同理适用于字体/透明度/缩放等任何挂在 documentElement 上的用户设置。)
// 修复后期望:只还原「皮肤自己改过的」属性;皮肤激活期间用户改动的属性必须保留。
// 可观测锚:① 用户改过的在快照里的属性 → 保留新值;② 皮肤新增的属性 → 仍被清除
// (与 tests/unit/check-skin-t2-chain.mjs t3 同口径);③ 没人动过的快照属性 → 原样。
// Run: node tests/acceptance/r26/d2-dispose-preserves-user-attrs.mjs
import assert from 'node:assert/strict';
import { stubLocalStorage, stubDom } from './lib.mjs';

stubLocalStorage();
const { de, head } = stubDom({ 'data-theme': 'light', 'data-font': 'serif' });

const { loadT2, disposeT2, setDevSkinsEnabled } = await import('../../../client/src/utils/skins.js');

setDevSkinsEnabled(true);
const manifest = { tier: 2, skin_css: 'skin.css' };
const texts = { 'skin.css': ':root { --x: 1; }' };

const r = await loadT2('skin-d2', manifest, texts);
assert.equal(r.loaded, true, 'D2 夹具:装载应成功');
assert.ok(head.children.length > 0, 'D2 夹具:样式节点已挂');

// 皮肤激活期间:用户手动换主题(快照里有 data-theme=light,用户改成 dark)
de.setAttribute('data-theme', 'dark');
// 模拟皮肤脚本自己的痕迹:新增一个属性(shim 不执行 js,手动打标)
de.setAttribute('data-skin-demo', '1');

disposeT2();

// ① 核心断言(修前必红):用户的主题改动必须活过卸皮肤
assert.equal(de.getAttribute('data-theme'), 'dark',
  'D2: 卸皮肤把用户在皮肤激活期间换的主题回滚成了激活前的 light —— 快照无差别还原误伤用户改动');

// ② 反向钉:皮肤自己新增的属性仍必须被清掉(不许为了保用户改动把皮肤痕迹也留下)
assert.equal(de.getAttribute('data-skin-demo'), null,
  'D2: 皮肤脚本新增的属性在卸载后必须清除(不能因保用户改动而漏清皮肤痕迹)');

// ③ 没人动过的快照属性原样保留
assert.equal(de.getAttribute('data-font'), 'serif', 'D2: 未被动过的属性不许误伤');

console.log('PASS r26-d2-dispose-preserves-user-attrs');
