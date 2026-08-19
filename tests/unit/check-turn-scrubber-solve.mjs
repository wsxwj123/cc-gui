#!/usr/bin/env node
// 单测:r11-④(鱼眼版)回合刻度 —— 等距紧凑布局 + distortPositions 不变量矩阵 +
// 变形坐标二分命中(import 真函数)+ 组件仪表化。
// 变异哨兵(实际验证过红):
//   S1 distortPositions 删重归一化(scale=1)→ t2 总高守恒红
//   S2 distortPositions 直接返回 base → t2 中心×3 红
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { layoutCompactPositions, distortPositions, buildTurnIndex, nearestTurnIndex, normalizePointerY } from '../../client/src/utils/turnWave.js';

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

// t5 r11-p5-1 无量纲比例法:0.2.293 真机(WKWebView)回归证明 ⑬ 比值法依赖
// 「clientHeight 与 rect.height 缩放语义关系」这一跨 API 引擎假设。fraction 法
// (同一次 rect 的同一坐标系取比例 × 自家布局高)对引擎语义免疫——用【两种相反的
// 引擎语义】各跑一遍矩阵,fraction 两种下都不漂;旧比值法在语义 B 下必炸(哨兵)。
// 哨兵(均实际验证过红):S1 调用点回退旧 clientHeight 口径(跨 API 依赖复活)→ 接线守卫红;
// S2 删 fraction [0,1] 夹紧 → 中心夹紧矩阵红。
// (注:给足真布局高的 raw*(th/rh) 与 fraction*th 数学等价,函数级换式在纯语义矩阵下
//  不红——真实杀伤面在跨 API 接线,故哨兵钉调用点与夹紧,「教训自检」断言钉住旧口径必漂。)
{
  const H = 300;       // 自家布局态 box.height(positions 坐标系)
  const zoom = 1.3;
  const base = layoutCompactPositions(101, H, 8);
  // 语义 A(Chromium 观测形态):CSSOM 视口随 zoom 缩放——rect 与 clientY 都是视觉像素。
  const semA = { rect: { top: 40 * zoom, height: H * zoom }, clientYOf: (y) => 40 * zoom + y * zoom };
  // 语义 B(WKWebView 推断形态):CSSOM 不随 zoom 缩放——rect 与 clientY 都是布局像素
  // (若某内核在此语义下还把 clientHeight 报成视觉值,旧比值法的 th/rh 假设即破产;
  //  fraction 法根本不读 clientHeight,天然免疫)。
  const semB = { rect: { top: 40, height: H }, clientYOf: (y) => 40 + y };
  for (const [name, sem] of [['A(缩放版)', semA], ['B(不缩放版)', semB]]) {
    for (const k of [0, 25, 50, 75, 100]) {
      const y = normalizePointerY(sem.clientYOf(base[k]), sem.rect, H);
      assert.ok(Math.abs(y - base[k]) < 1e-6, `t5: 语义${name} k=${k} 归一化精确`);
      assert.equal(nearestTurnIndex(buildTurnIndex(base), y), k, `t5: 语义${name} 第 ${k} 根命中不漂`);
    }
    // 鱼眼中心夹紧:任意指针(含越界)归一化后必落 [0, H] → 变形场中心永在条内,
    // 鱼眼不会因中心出界而整体消失(0.2.293 真机症状)。
    for (const cy of [-1e4, sem.rect.top - 50, sem.rect.top + sem.rect.height + 50, 1e4]) {
      const y = normalizePointerY(cy, sem.rect, H);
      assert.ok(y >= 0 && y <= H, `t5: 语义${name} 中心夹紧 [0,H](cy=${cy})`);
      const out = distortPositions(base, y, { factor: 3 });
      assert.ok(out.length === base.length && out[0] === base[0], `t5: 语义${name} 越界指针下鱼眼仍良构`);
    }
  }
  // 旧比值法在语义 B + clientHeight 被引擎报成视觉值(H*zoom)时必漂——这正是
  // fraction 法删掉 clientHeight 依赖的根据(教训自检,证明矩阵有杀伤力)。
  const oldRatio = (clientY, rect, ch) => {
    const raw = clientY - rect.top;
    return Math.max(0, Math.min(ch, raw * (ch / rect.height)));
  };
  const oldY = oldRatio(semB.clientYOf(base[50]), semB.rect, H * zoom); // 引擎报视觉 clientHeight
  assert.notEqual(nearestTurnIndex(buildTurnIndex(base), oldY), 50, 't5: 教训自检——旧比值法在跨 API 语义分歧下必漂');
  // clamp 与除零兜底
  assert.equal(normalizePointerY(140, { top: 40, height: 0 }, 260), 100, 't5: rect.height=0 兜底不除(退回视觉差值夹紧)');
  assert.equal(normalizePointerY(1e4, { top: 40, height: 0 }, 260), 260, 't5: 兜底路径也夹紧');
  assert.equal(normalizePointerY(140, { top: 40, height: 260 }, 260), 100, 't5: zoom=1 恒等');
  // 组件接线守卫:moveBar/clickBar 走 fraction 法(目标高=自家 box.height),
  // 每事件 DOM API(clientHeight)依赖清零
  const src = readFileSync(new URL('../../client/src/components/TurnScrubber.jsx', import.meta.url), 'utf8');
  // r13-p2-12:口径升级为 offsetY(见 t7);此处只钉"两处调用点同口径且都传 box.height"。
  assert.equal((src.match(/pointerLocalY\(e, box\.height\)/g) || []).length, 2, 't5: moveBar+clickBar 两处均走 box.height 口径');
  assert.doesNotMatch(src, /e\.currentTarget\.clientHeight/, 't5: 每事件 clientHeight 依赖清零(跨 API 假设根除)');
  assert.doesNotMatch(src, /Math\.min\(rect\.height, e\.clientY - rect\.top\)/, 't5: 旧视觉差值算式仍清零');
}

console.log('check-turn-scrubber-solve: all passed');

// t7(r13-p2-12):指针本地 y 走 offsetY —— 容器自身坐标系,零缩放换算。
// 比例法(p5-1)要求 clientY 与 rect 同空间,WKWebView 的 zoom 下不成立(真机偏移);
// offsetY 规范定义即"相对目标 padding box",与 positions 同空间,任何内核都不需换算。
{
  const { pointerLocalY } = await import('../../client/src/utils/turnWave.js');
  const H = 600;
  // 任意"内核语义"下 offsetY 都直接可用(不查 rect,不乘除任何缩放)
  for (const y of [0, 1, 123.4, 599, 600]) {
    assert.equal(pointerLocalY({ nativeEvent: { offsetY: y } }, H), Math.max(0, Math.min(H, y)),
      `t7: offsetY=${y} 原样采用(夹紧到 [0,H])`);
  }
  assert.equal(pointerLocalY({ nativeEvent: { offsetY: -20 } }, H), 0, 't7: 负值夹紧');
  assert.equal(pointerLocalY({ nativeEvent: { offsetY: 9999 } }, H), H, 't7: 超界夹紧');
  // 无 offsetY 的引擎:回落比例法(仍可用,不崩)
  const fallback = pointerLocalY({ clientY: 300 }, H, { top: 100, height: 200 });
  assert.ok(fallback >= 0 && fallback <= H, 't7: 无 offsetY 时回落比例法且在界内');
  // 接线守卫:两处调用点都必须走 offsetY 口径(回退到 clientY 比例法 = 真机复发)
  const src = readFileSync(new URL('../../client/src/components/TurnScrubber.jsx', import.meta.url), 'utf8');
  assert.equal((src.match(/pointerLocalY\(e, box\.height\)/g) || []).length, 2,
    't7: moveBar 与 clickBar 都走 pointerLocalY(哨兵锚)');
  assert.doesNotMatch(src, /normalizePointerY\(e\.clientY/, 't7: 调用点不得回退旧比例法');
}

console.log('check-turn-scrubber-solve: t7 (offsetY 口径) passed');
