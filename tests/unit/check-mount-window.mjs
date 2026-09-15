#!/usr/bin/env node
// 渐进挂载(W-C)的挂载集合纯逻辑:initialSpan / extendUp / needsExtend / sliceRows。
// 核心不变量:**这里没有任何高度概念** —— 未挂载的行在几何上不存在(已挂部分 100% 真实),
// 所以吸底/比例搬迁/进度条刻度那几处读 scrollHeight/offsetTop 的机制语义不变。
// 变异哨兵:extendUp 改成不钳 0 → t3 红;initialSpan 改成 from=0 → t2 红。
import assert from 'node:assert/strict';
import { initialSpan, extendUp, needsExtend, sliceRows } from '../../client/src/utils/mountWindow.js';

const K = 30;

// ── t1 默认窗 = 最近 K 行 ──
{
  assert.deepEqual(initialSpan(320, K), { from: 290, to: 320 }, '320 行 → 挂最近 30 行');
  assert.deepEqual(initialSpan(31, K), { from: 1, to: 31 }, '刚过 K → from=1');
  assert.deepEqual(initialSpan(30, K), { from: 0, to: 30 }, '正好 K → 全挂(from=0,不裁)');
  assert.deepEqual(initialSpan(5, K), { from: 0, to: 5 }, '不足 K → 全挂,不越界');
  assert.deepEqual(initialSpan(0, K), { from: 0, to: 0 }, '空列表');
  assert.deepEqual(initialSpan(-3, K), { from: 0, to: 0 }, '负数按空处理');
  assert.deepEqual(initialSpan(320, 0), { from: 320, to: 320 }, 'K=0 → 不挂任何行(退化输入不抛)');
  // 不变量:0 ≤ from ≤ to ≤ total 且 to-from ≥ min(K,total)
  for (const total of [0, 1, 7, 30, 31, 320]) {
    const s = initialSpan(total, K);
    assert.ok(s.from >= 0 && s.from <= s.to && s.to <= total, `不变量 from ≤ to ≤ total(total=${total})`);
    assert.ok(s.to - s.from >= Math.min(K, total), `不变量 窗口 ≥ min(K,total)(total=${total})`);
  }
}

// ── t2 向上补齐:一批 K 行、幂等、不越界 ──
{
  assert.equal(extendUp(290, K, 320), 260, '补一批 → from 减 K');
  assert.equal(extendUp(260, K, 320), 230, '再补一批');
  assert.equal(extendUp(10, K, 320), 0, '不足一批 → 钳到 0');
  assert.equal(extendUp(0, K, 320), 0, '已到顶 → 原样返回 0(幂等)');
  assert.equal(extendUp(-5, K, 320), 0, '负数 from 钳到 0');
  assert.equal(extendUp(400, K, 320), 290, '越界 from 钳回默认窗起点');
  assert.equal(extendUp(290, K, 320), extendUp(290, K, 320), '同一输入同一输出(无时间/随机)');
  // 幂等性:从同一个 from 连续调用两次,结果相同(补齐是幂等的,重复触发只合并批次)
  const once = extendUp(290, K, 320);
  assert.equal(extendUp(290, K, 320), once, '幂等');
}

// ── t3 补齐判据:滚到顶(留一屏余量)才补 ──
{
  assert.equal(needsExtend({ scrollTop: 0, padPx: 579 }), true, '在顶部 → 该补');
  assert.equal(needsExtend({ scrollTop: 579, padPx: 579 }), true, '正好一屏余量 → 该补');
  assert.equal(needsExtend({ scrollTop: 580, padPx: 579 }), false, '越过一屏 → 不补');
  assert.equal(needsExtend({ scrollTop: 5000, padPx: 579 }), false, '在底部 → 不补');
  assert.equal(needsExtend({ scrollTop: -1, padPx: 579 }), true, '负值(瞬时抖动)→ 判该补,补齐自身幂等');
  assert.equal(needsExtend({}), true, '缺参 → 视作顶部(不抛)');
}

// ── t4 切片:不改入参、越界钳住 ──
{
  const rows = Array.from({ length: 10 }, (_, i) => ({ i }));
  const copy = JSON.stringify(rows);
  assert.deepEqual(sliceRows(rows, { from: 7, to: 10 }).map((r) => r.i), [7, 8, 9], '取尾段');
  assert.deepEqual(sliceRows(rows, { from: 0, to: 3 }).map((r) => r.i), [0, 1, 2], '取头段');
  assert.deepEqual(sliceRows(rows, { from: 4, to: 4 }), [], '空窗');
  assert.deepEqual(sliceRows(rows, { from: -5, to: 100 }).length, 10, '两端越界 → 钳到全量');
  assert.equal(JSON.stringify(rows), copy, 'sliceRows 不得修改入参');
  assert.deepEqual(sliceRows([], { from: 0, to: 5 }), [], '空列表');
  assert.deepEqual(sliceRows(null, { from: 0, to: 5 }), [], '非数组 → 空(不抛)');
  assert.deepEqual(sliceRows(rows, {}).length, 10, '缺 from/to → 全量');
  // 同输入同输出。⚠️ slice() 恒返回新数组 —— 保住 MessageList.memo 的是**调用方**的
  // "不裁时直接 return 原数组"短路(App.jsx 的 mountedMessages),不是这里。
  assert.deepEqual(sliceRows(rows, { from: 0, to: 10 }), rows, '全量切片内容一致');
  assert.notEqual(sliceRows(rows, { from: 0, to: 10 }), rows, 'slice 恒是新数组(引用稳定性由调用方短路保证)');
}

console.log('check-mount-window: all passed');
