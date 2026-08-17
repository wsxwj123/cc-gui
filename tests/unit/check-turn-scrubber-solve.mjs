#!/usr/bin/env node
// 单测:r11-④(鱼眼版)回合刻度 —— 等距紧凑布局 + distortPositions 不变量矩阵 +
// 变形坐标二分命中(import 真函数)+ 组件仪表化。
// 变异哨兵(实际验证过红):
//   S1 distortPositions 删重归一化(scale=1)→ t2 总高守恒红
//   S2 distortPositions 直接返回 base → t2 中心×3 红
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { layoutCompactPositions, distortPositions, buildTurnIndex, nearestTurnIndex } from '../../client/src/utils/turnWave.js';

const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// t1 等距紧凑布局:等距/整簇居中/永不溢出/压缩间距
{
  const p = layoutCompactPositions(5, 400, 8);
  const gaps = p.slice(1).map((v, i) => v - p[i]);
  assert.ok(gaps.every((g) => approx(g, 8)), 't1: 未超高时用首选间距等距');
  assert.ok(approx(p[0], (400 - 32) / 2) && approx(p[4], 400 - (400 - 32) / 2), 't1: 整簇垂直居中');
  const dense = layoutCompactPositions(500, 400, 8);
  assert.equal(dense.length, 500, 't1: 全部回合始终渲染(无抽稀)');
  assert.ok(dense[0] >= 0 && dense[499] <= 400, 't1: 永不溢出容器');
  const dg = dense.slice(1).map((v, i) => v - dense[i]);
  assert.ok(dg.every((g) => approx(g, 400 / 499)), 't1: 超高时整体压缩为等距');
  assert.deepEqual(layoutCompactPositions(1, 400), [200], 't1: 单点居中');
  assert.deepEqual(layoutCompactPositions(0, 400), [], 't1: 空集');
  assert.deepEqual(layoutCompactPositions(5, 0), [], 't1: 高度未知安全返回');
}

// t2 鱼眼不变量矩阵
{
  const base = layoutCompactPositions(41, 400, 8); // 间距 8,簇高 320
  const mid = base[20];
  const out = distortPositions(base, mid, { factor: 3 });
  // 总高守恒/簇边界不变(首尾钉死)
  assert.ok(approx(out[0], base[0]) && approx(out[40], base[40]), 't2: 总高守恒,簇边界不变');
  // 序号单调性守恒
  for (let i = 1; i < out.length; i++) assert.ok(out[i] > out[i - 1], 't2: 单调性守恒');
  // 中心间距×3(相对远端衰减后的间距;重归一化整体缩放,比值不受影响)
  const gap = (a, i) => a[i + 1] - a[i];
  const centerGap = gap(out, 20);
  const farGap = gap(out, 0);
  assert.ok(centerGap / farGap > 2.5 && centerGap / farGap <= 3.05, `t2: 中心/远端间距比≈3(实测 ${(centerGap / farGap).toFixed(2)})`);
  // 远端补偿:重归一化后远处间距被压缩(小于等距原值)
  assert.ok(farGap < gap(base, 0), 't2: 远端间距被按比例压缩补偿');
  // ±3 根内明显,远处回到 1x 量级
  assert.ok(gap(out, 17) / gap(base, 17) > 1.4, 't2: ±3 根内变形明显');
  assert.ok(gap(out, 2) / gap(base, 2) < 1.05, 't2: 远处回到 1x 量级');
  // 无指针 = 等距原样(引用/逐值)
  assert.deepEqual(distortPositions(base, null), base, 't2: 无指针原样返回');
  // 指针压在簇端:边界回合仍钉在簇端不越界
  const edge = distortPositions(base, base[0], { factor: 3 });
  assert.ok(approx(edge[0], base[0]) && approx(edge[40], base[40]), 't2: 指针压边界仍不越界');
  for (let i = 1; i < edge.length; i++) assert.ok(edge[i] > edge[i - 1], 't2: 边界情形单调仍守恒');
}

// t3 变形坐标二分命中:指针下那根 = 命中那根(所见即所得)
{
  const base = layoutCompactPositions(101, 300, 8);
  const pointer = base[50] + 1.2; // 指针略偏,变形以指针为中心
  const distorted = distortPositions(base, pointer, { factor: 3 });
  const idx = buildTurnIndex(distorted);
  for (const k of [0, 3, 47, 50, 53, 100]) {
    assert.equal(nearestTurnIndex(idx, distorted[k]), k, `t3: 精确落在第 ${k} 根命中它`);
  }
  // 二分与线性一致性抽查(等价性,防边界off-by-one)
  const linear = (arr, y) => arr.reduce((b, v, i) => (Math.abs(v - y) < Math.abs(arr[b] - y) ? i : b), 0);
  for (let y = 0; y <= 300; y += 7) {
    const bi = nearestTurnIndex(idx, y);
    const li = linear(distorted, y);
    assert.ok(Math.abs(distorted[bi] - y) <= Math.abs(distorted[li] - y) + 1e-9, `t3: y=${y} 二分不劣于线性`);
  }
  assert.equal(nearestTurnIndex(buildTurnIndex([]), 10), -1, 't3: 空集 -1');
}

// t4 组件仪表化:全量渲染(无抽稀)、变形坐标接线、跟手过渡≤80ms、回弹、可达性、清理
{
  const src = readFileSync(new URL('../../client/src/components/TurnScrubber.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /shouldRenderTick|decimationStep/, 't4: 抽稀已废弃,全量渲染');
  assert.doesNotMatch(src, /<button/, 't4: 刻度不再是 button 热区');
  assert.doesNotMatch(src, /onMouseEnter/, 't4: 不再按刻度 mouseenter 命中');
  assert.match(src, /layoutCompactPositions\(turns\.length/, 't4: 等距紧凑基线');
  assert.match(src, /distortPositions\(base, next, FISHEYE\)/, 't4: 解算走变形后坐标(与渲染同一输入)');
  assert.match(src, /turnWaveWidth\(Math\.abs\(pointerY - n\)\)/, 't4: 波形距离用变形后坐标');
  const m = /transition: 'transform (\d+)ms/.exec(src);
  assert.ok(m && Number(m[1]) <= 80, 't4: 线条 transform 过渡 ≤80ms');
  assert.match(src, /setPointerY\(null\); \/\/ 回弹等距/, 't4: pointerleave 回弹等距');
  assert.match(src, /onClick=\{clickBar\}/, 't4: 容器级 click');
  assert.match(src, /role="slider"/, 't4: role=slider');
  assert.match(src, /ArrowDown|ArrowUp/, 't4: 键盘步进');
  assert.match(src, /cancelAnimationFrame\(pointerFrame\.current\)/, 't4: 卸载清理 rAF');
}

console.log('check-turn-scrubber-solve: all passed');
