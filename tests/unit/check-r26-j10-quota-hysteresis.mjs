#!/usr/bin/env node
// r26-J10【单测】:红点滞回 —— ≥90% 亮、<85% 才灭,边界抖动不闪。
// 修前:computeLow 单点阈值(≥90 亮、否则灭),用量在 89.9↔90.1 抖动时红点跟着闪。
// 哨兵:①序列 89.9→90→89→85.1→84.9 的红点状态钉死为 [灭,亮,亮,亮,灭]
//   (89% 时仍亮 = 滞回核心;84.9% 才灭);②'left' 方向同口径(剩余 10.1% 亮着不灭);
// ③value/max 形态同滞回;④钱类(无分母)不做滞回,单点照旧;⑤自定义阈值亮阈跟随
//   prefs(灭阈 = 亮阈 − 5pt 带宽);⑥computeLow 单点语义不动(既有测试回归);
// ⑦无数据(unlimited/无条目)不翻转状态。
// Run: node tests/unit/check-r26-j10-quota-hysteresis.mjs
import assert from 'node:assert/strict';
import { computeAlert, computeLow, QUOTA_ALERT_ON, QUOTA_ALERT_OFF } from '../../server/services/provider-quota.js';

let n = 0;
const ok = (v, m) => { assert.ok(v, m); n += 1; };
const used = (p) => ({ currency: null, items: [{ label: 'x', direction: 'used', percent: p }] });
const left = (p) => ({ currency: null, items: [{ label: 'x', direction: 'left', percent: p }] });
const ratio = (value, max) => ({ currency: null, items: [{ label: 'x', direction: 'left', value, max }] });
const money = (currency, value) => ({ currency, items: [{ label: '余额', direction: 'left', value }] });

// 常量钉死(文档口径)
assert.equal(QUOTA_ALERT_ON, 0.9);
assert.equal(QUOTA_ALERT_OFF, 0.85);
n += 2;

// ① 滞回序列(核心哨兵):89.9→90→89→85.1→84.9 ≡ [灭,亮,亮,亮,灭]
{
  let on = false;
  const seq = [];
  for (const p of [89.9, 90, 89, 85.1, 84.9]) {
    on = computeAlert(used(p), null, on);
    seq.push(on);
  }
  assert.deepEqual(seq, [false, true, true, true, false],
    `J10: 滞回序列必须 [灭,亮,亮,亮,灭](实际 ${seq}) —— 89% 仍亮、84.9% 才灭`);
  n += 1;
}
// ② 'left' 方向同口径:剩余 15%→10%→10.1%→14.9%→15.1% ≡ [灭,亮,亮,亮,灭]
{
  let on = false;
  const seq = [];
  for (const p of [15, 10, 10.1, 14.9, 15.1]) {
    on = computeAlert(left(p), null, on);
    seq.push(on);
  }
  assert.deepEqual(seq, [false, true, true, true, false], 'J10: left 方向滞回同口径');
  n += 1;
}
// ③ value/max 形态同滞回:max=1000,value 剩余 101→100→101→149→151 ≡ [灭,亮,亮,亮,灭]
{
  let on = false;
  const seq = [];
  for (const v of [101, 100, 101, 149, 151]) {
    on = computeAlert(ratio(v, 1000), null, on);
    seq.push(on);
  }
  assert.deepEqual(seq, [false, true, true, true, false], 'J10: value/max 形态滞回');
  n += 1;
}
// ④ 钱类不做滞回:¥9.99 亮、¥10.01 立灭(不等回落带宽)
{
  assert.equal(computeAlert(money('CNY', 9.99), null, false), true, 'J10: 钱类低额即亮');
  assert.equal(computeAlert(money('CNY', 10.01), null, true), false, 'J10: 钱类无滞回,超过即灭');
  n += 2;
}
// ⑤ 自定义阈值:usedPercent=50 → 亮阈 50%、灭阈 45%
{
  const th = { usedPercent: 50 };
  assert.equal(computeAlert(used(49.9), th, false), false, 'J10: 自定义亮阈 50% —— 49.9 不亮');
  assert.equal(computeAlert(used(50), th, false), true, 'J10: 自定义亮阈 50% —— 50 亮');
  assert.equal(computeAlert(used(45.1), th, true), true, 'J10: 自定义灭阈 45% —— 45.1 仍亮');
  assert.equal(computeAlert(used(44.9), th, true), false, 'J10: 自定义灭阈 45% —— 44.9 灭');
  // leftPercent 自定义语义不丢(回归哨兵):leftPercent=1 → 剩余 5%(已用 95%)不亮
  const thL = { leftPercent: 1 };
  assert.equal(computeAlert(ratio(5, 100), thL, false), false, 'J10: leftPercent=1 → 剩余 5% 不亮');
  assert.equal(computeAlert(ratio(0.5, 100), thL, false), true, 'J10: leftPercent=1 → 剩余 0.5% 亮');
  n += 6;
}
// ⑥ computeLow 单点语义不动(供钱类/旧消费方,回归)
{
  assert.equal(computeLow(used(90)), true);
  assert.equal(computeLow(used(89.9)), false);
  assert.equal(computeLow(left(10)), true);
  n += 3;
}
// ⑦ 无数据不翻转:unlimited / 空 items 时保持 prevOn 之外的明确 false 判定
{
  assert.equal(computeAlert({ currency: null, items: [{ unlimited: true }] }, null, true), false,
    'J10: 只剩 unlimited 条目 → 灭(没有可计量的用量)');
  assert.equal(computeAlert({ currency: null, items: [] }, null, false), false, 'J10: 空条目不亮');
  n += 2;
}

console.log(`PASS check-r26-j10-quota-hysteresis (${n} assertions)`);
