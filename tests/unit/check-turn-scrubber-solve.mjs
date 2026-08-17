#!/usr/bin/env node
// 单测:r11-④ 回合刻度高密度重做 —— 单容器解算(二分最近回合)+ 抽稀矩阵。
// import 真函数。变异哨兵(实际验证过红;规格注:把二分改线性猜不可观测,故哨兵锚
// 定为「删解算函数」→ import 即红):
//   S1 删 nearestTurnIndex 导出 → 本文件 import 红
//   S2 shouldRenderTick 删首尾恒画 → t4 红
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildTurnIndex, nearestTurnIndex, decimationStep, shouldRenderTick } from '../../client/src/utils/turnWave.js';

// t1 等距矩阵:5 个等距点,任意 frac 落到最近点;首尾越界收敛到首/尾
{
  const positions = [0.1, 0.3, 0.5, 0.7, 0.9];
  const idx = buildTurnIndex(positions);
  assert.equal(nearestTurnIndex(idx, 0), 0, 't1: 顶部越界 → 首点');
  assert.equal(nearestTurnIndex(idx, 1), 4, 't1: 底部越界 → 末点');
  assert.equal(nearestTurnIndex(idx, 0.31), 1, 't1: 靠近 0.3');
  assert.equal(nearestTurnIndex(idx, 0.44), 2, 't1: 靠近 0.5');
  assert.equal(nearestTurnIndex(idx, 0.79), 3, 't1: 靠近 0.7 一侧');
  assert.equal(nearestTurnIndex(idx, 0.81), 4, 't1: 靠近 0.9 一侧');
  // 精确落点与中点平票:等距取更早回合(行为钉死,防抖动)。平票用二进制可精确表示的
  // 0.25/0.5/0.75(0.3/0.4 这类十进制在 FP 里不是精确中点,会误红)。
  assert.equal(nearestTurnIndex(idx, 0.5), 2, 't1: 精确命中');
  assert.equal(nearestTurnIndex(buildTurnIndex([0.25, 0.75]), 0.5), 0, 't1: 正中平票取更早回合');
}

// t2 null 洞(measure 落空的回合)被剔除,解算映射回原始索引
{
  const idx = buildTurnIndex([null, 0.2, null, 0.6, undefined, 0.8]);
  assert.deepEqual(idx.fracs, [0.2, 0.6, 0.8], 't2: 紧凑化');
  assert.deepEqual(idx.idxs, [1, 3, 5], 't2: 原索引保留');
  assert.equal(nearestTurnIndex(idx, 0.55), 3, 't2: 解算回原始索引');
  assert.equal(nearestTurnIndex(idx, 0.99), 5, 't2: 末点原始索引');
}

// t3 空集与单点
{
  assert.equal(nearestTurnIndex(buildTurnIndex([]), 0.5), -1, 't3: 空集 → -1');
  assert.equal(nearestTurnIndex(buildTurnIndex([null, null]), 0.5), -1, 't3: 全 null → -1');
  assert.equal(nearestTurnIndex(buildTurnIndex([0.4]), 0.99), 0, 't3: 单点恒中');
}

// t4 抽稀:回合数 ≤ 容器高/3px 不抽稀;超出则步长取整,首尾恒画;高度未知不抽稀
{
  assert.equal(decimationStep(100, 600, 3), 1, 't4: 200 槽位容得下 100 → 不抽稀');
  const step = decimationStep(500, 600, 3);
  assert.equal(step, 3, 't4: 500 回合 / 200 槽位 → 每 3 条画 1 条');
  assert.equal(decimationStep(500, 0, 3), 1, 't4: 高度 0(首帧) → 不抽稀');
  assert.equal(shouldRenderTick(0, 500, step), true, 't4: 首条恒画');
  assert.equal(shouldRenderTick(499, 500, step), true, 't4: 末条恒画');
  assert.equal(shouldRenderTick(3, 500, step), true, 't4: 步长命中画');
  assert.equal(shouldRenderTick(4, 500, step), false, 't4: 步长间隔不画');
  assert.equal(shouldRenderTick(4, 500, 1), true, 't4: step=1 全画');
}

// t5 抽稀映射:抽稀只影响渲染,解算仍精确到被抽掉的真实回合
{
  const positions = Array.from({ length: 300 }, (_, i) => 0.02 + (0.96 * i) / 299);
  const idx = buildTurnIndex(positions);
  const step = decimationStep(positions.length, 450, 3); // 150 槽位 → step 2
  assert.ok(step > 1, 't5: 该密度必须触发抽稀');
  const target = 151; // 被抽掉的奇数索引(151 % 2 !== 0)
  assert.equal(shouldRenderTick(target, positions.length, step), false, 't5: 该回合不渲染');
  assert.equal(nearestTurnIndex(idx, positions[target]), target, 't5: 解算仍命中被抽掉的真实回合');
}

// t6 仪表化判据:组件层退役 per-刻度 button 热区,容器承担交互与可达性
{
  const src = readFileSync(new URL('../../client/src/components/TurnScrubber.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /<button/, 't6: 刻度不再是 button 热区');
  assert.doesNotMatch(src, /onMouseEnter/, 't6: 不再按刻度 mouseenter 命中');
  assert.match(src, /nearestTurnIndex\(/, 't6: 解算函数在用');
  assert.match(src, /onClick=\{clickBar\}/, 't6: 容器级 click');
  assert.match(src, /role="slider"/, 't6: role=slider');
  assert.match(src, /aria-valuetext=\{`第 /, 't6: aria-valuetext 第N回合');
  assert.match(src, /ArrowDown|ArrowUp/, 't6: 键盘步进');
  assert.match(src, /decimationStep\(/, 't6: 抽稀接线');
  assert.match(src, /cancelAnimationFrame\(pointerFrame\.current\)/, 't6: 卸载清理 rAF');
}

console.log('check-turn-scrubber-solve: all passed');
