#!/usr/bin/env node
// r159 D2:16 种旋转动画的摆位公式(orbitVariants.js)与 ticker 按变体摆点。
//
// 锁的事:
//   V1 16 个变体的 id / 点数 / 中文标签;variantOf 找不到返回 null。
//   V2 RANDOM_POOL 恰为这 16 个 id,顺序固定。
//   V3 每个变体 0–20 秒(步长 0.02)x、y、d 全有限,|x|、|y| ≤ 1.6,d ∈ [-1, 1];同一 t 重复调用结果一致。
//   V4 dotPx 全程 ∈ [1.6, 2.5],每个变体最大 ≥ 2.2、最小 ≤ 1.95(有远近大小变化);FRONT_PX / BACK_PX 常量。
//   V5 静止帧 stillT 时任意两点中心距(×R=4.8,14px 基准指示器)≥ 3px。
//   V8 r161 整体放大:同一变体、同一时刻,指示器宽 w 时轨道半径与圆点缩放都是宽 14 时的 w / 14 倍。
//   V6 八字轨道积分表首尾闭合(积分一整周期后回到起点,差 < 1e-3)。
//   V7 ticker:register 带 variant 时按该变体摆点(transform 的 scale = dotPx/18),减弱动画摆变体的 stillT;
//      缺省 variant 按 n 取 orbit3 / orbit4。
//
// 跑法:node tests/unit/check-r159-orbit-variants.mjs
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeReport } from './q8-helpers/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const V = await import(pathToFileURL(join(ROOT, 'client', 'src', 'utils', 'orbitVariants.js')).href);
const T = await import(pathToFileURL(join(ROOT, 'client', 'src', 'utils', 'orbitTicker.js')).href);
const { ORBIT_VARIANTS, RANDOM_POOL, variantOf, dotPx, FRONT_PX, BACK_PX, DOT_BASE_PX, fig8Table } = V;
const report = makeReport('check-r159-orbit-variants');
const EPS = 1e-9;
const R14 = 4.8; // 14px 基准指示器的轨道半径(r161 起 R = 4.8 · w / 14)

const TABLE = [
  ['orbit3', 3, '三体旋转'], ['orbit4', 4, '四体旋转'],
  ['o3-v5', 3, '三体·摆动偏转'], ['o4-v5', 4, '四体·摆动偏转'],
  ['o3-v6', 3, '三体·忽停忽翻'], ['o4-v6', 4, '四体·忽停忽翻'],
  ['o3-tumble', 3, '三体·三维翻滚'], ['o4-tumble', 4, '四体·三维翻滚'],
  ['o3-breath', 3, '三体·呼吸环绕'], ['o4-breath', 4, '四体·呼吸环绕'],
  ['o3-fig8', 3, '三体·八字轨道'],
  ['o3-adj', 3, '三体·邻位交换'], ['o4-adj', 4, '四体·邻位交换'],
  ['o4-diag', 4, '四体·对角换位'], ['o4-counter', 4, '四体·内外对转'], ['o4-binary', 4, '四体·双星互绕'],
];

function points(v, t) {
  const out = [];
  for (let k = 0; k < v.n; k++) out.push(v.place(t, k, v.n));
  return out;
}
function minPairDist(pts, R) {
  let m = Infinity;
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
    m = Math.min(m, Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) * R);
  }
  return m;
}

await report.check('V1', '16 个变体的 id / 点数 / 标签;variantOf 找不到返回 null', 'red', () => {
  assert.equal(Object.keys(ORBIT_VARIANTS).length, 16);
  for (const [id, n, label] of TABLE) {
    const v = variantOf(id);
    assert.ok(v, `缺 ${id}`);
    assert.equal(v.id, id);
    assert.equal(v.n, n, `${id} 点数`);
    assert.equal(v.label, label, `${id} 标签`);
    assert.equal(typeof v.place, 'function');
  }
  for (const bad of ['cli', 'ring', 'random', '', null, undefined, 'toString', '__proto__']) {
    assert.equal(variantOf(bad), null, `variantOf(${String(bad)})`);
  }
});

await report.check('V2', 'RANDOM_POOL 恰为 16 个 id,顺序固定', 'red', () => {
  assert.deepEqual([...RANDOM_POOL], TABLE.map((r) => r[0]));
});

await report.check('V3', '0–20 秒每帧有限、|x|,|y| ≤ 1.6、d ∈ [-1,1];同一 t 结果一致', 'red', () => {
  for (const id of RANDOM_POOL) {
    const v = ORBIT_VARIANTS[id];
    for (let i = 0; i <= 1000; i++) {
      const t = i * 0.02;
      const pts = points(v, t);
      for (const p of pts) {
        for (const key of ['x', 'y', 'd']) assert.ok(Number.isFinite(p[key]), `${id} t=${t} ${key}=${p[key]}`);
        assert.ok(Math.abs(p.x) <= 1.6 && Math.abs(p.y) <= 1.6, `${id} t=${t} 越界 (${p.x},${p.y})`);
        assert.ok(p.d >= -1 - EPS && p.d <= 1 + EPS, `${id} t=${t} d=${p.d}`);
      }
      if (i % 50 === 0) assert.deepEqual(points(v, t), pts, `${id} t=${t} 重复调用不一致`);
    }
  }
});

await report.check('V4', 'dotPx 全程 ∈ [1.6,2.5],每个变体最大 ≥ 2.2、最小 ≤ 1.95', 'red', () => {
  assert.equal(FRONT_PX, 2.5);
  assert.equal(BACK_PX, 1.6);
  assert.equal(DOT_BASE_PX, 18);
  assert.ok(Math.abs(dotPx(1) - 2.5) < EPS && Math.abs(dotPx(-1) - 1.6) < EPS);
  assert.ok(Math.abs(dotPx(5) - 2.5) < EPS && Math.abs(dotPx(-5) - 1.6) < EPS, '超出 ±1 时夹住');
  for (const id of RANDOM_POOL) {
    const v = ORBIT_VARIANTS[id];
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i <= 1000; i++) {
      for (const p of points(v, i * 0.02)) {
        const px = dotPx(p.d);
        assert.ok(px >= 1.6 - EPS && px <= 2.5 + EPS, `${id} px=${px}`);
        lo = Math.min(lo, px); hi = Math.max(hi, px);
      }
    }
    assert.ok(hi >= 2.2, `${id} 最大 ${hi.toFixed(3)}px`);
    assert.ok(lo <= 1.95, `${id} 最小 ${lo.toFixed(3)}px`);
  }
});

const stillReport = [];
await report.check('V5', '静止帧 stillT 两两中心距(R=4.8)≥ 3px', 'red', () => {
  for (const id of RANDOM_POOL) {
    const v = ORBIT_VARIANTS[id];
    const st = Number.isFinite(v.stillT) ? v.stillT : T.STILL_T;
    const m = minPairDist(points(v, st), R14);
    stillReport.push(`${id}@${st}=${m.toFixed(2)}`);
    assert.ok(m >= 3, `${id} 静止帧最小点距 ${m.toFixed(3)}px`);
  }
  assert.equal(ORBIT_VARIANTS.orbit3.stillT, T.STILL_T);
  assert.equal(ORBIT_VARIANTS.orbit4.stillT, T.STILL_T);
});
if (process.env.SHOW_STILL) console.log(stillReport.join('  '));

await report.check('V6', '八字积分表首尾闭合(差 < 1e-3),1500 步', 'red', () => {
  const F = fig8Table();
  assert.equal(F.N, 1500);
  assert.equal(fig8Table(), F, '积分表缓存');
  for (let k = 0; k < 3; k++) {
    assert.equal(F.X[k].length, 1500);
    const dx = F.end[k][0] - F.X[k][0], dy = F.end[k][1] - F.Y[k][0];
    assert.ok(Math.hypot(dx, dy) < 1e-3, `天体 ${k} 首尾差 ${Math.hypot(dx, dy)}`);
  }
});

// ---- 假环境(同 check-r154-orbit.mjs) ----
function fakeEnv() {
  const env = { queue: new Map(), seq: 0, isReduced: false, now: 0 };
  env.raf = (cb) => { const id = ++env.seq; env.queue.set(id, cb); return id; };
  env.caf = (id) => { env.queue.delete(id); };
  env.hidden = () => false;
  env.reduced = () => env.isReduced;
  return env;
}
function fakeMark(n, variant, width = 14) {
  const kids = Array.from({ length: n }, () => ({ style: { setProperty(k, v) { this[k] = v; } } }));
  return { el: { clientWidth: width, dataset: { speed: 'slow' }, isConnected: true }, kids, n, variant };
}
const parse = (kid) => {
  const m = /translate\(([-\d.]+)px,([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(kid.style.transform || '');
  assert.ok(m, `transform 格式不对:${kid.style.transform}`);
  return { x: Number(m[1]), y: Number(m[2]), s: Number(m[3]) };
};

await report.check('V7', 'ticker 按变体摆点,减弱动画用变体 stillT,缺省按 n 取 orbit3 / orbit4', 'red', () => {
  const env = fakeEnv();
  env.isReduced = true;
  const tk = T.createOrbitTicker(env);
  for (const id of RANDOM_POOL) {
    const v = ORBIT_VARIANTS[id];
    const mark = fakeMark(v.n, id);
    const off = tk.register(mark);
    for (let k = 0; k < v.n; k++) {
      const got = parse(mark.kids[k]);
      const p = v.place(v.stillT, k, v.n);
      assert.ok(Math.abs(got.x - p.x * R14) < 0.01 && Math.abs(got.y - p.y * R14) < 0.01, `${id} 点 ${k} 位置`);
      assert.ok(Math.abs(got.s - dotPx(p.d) / 18) < 0.001, `${id} 点 ${k} scale ${got.s}`);
      const u = (Math.max(-1, Math.min(1, p.d)) + 1) / 2;
      assert.ok(Math.abs(Number(mark.kids[k].style.opacity) - (0.72 + 0.28 * u)) < 0.001, `${id} opacity`);
      assert.equal(mark.kids[k].style.zIndex, String(Math.round(u * 20)));
    }
    off();
  }
  for (const [n, id] of [[3, 'orbit3'], [4, 'orbit4']]) {
    const mark = fakeMark(n, undefined);
    const off = tk.register(mark);
    const p = ORBIT_VARIANTS[id].place(T.STILL_T, 0, n);
    const got = parse(mark.kids[0]);
    assert.ok(Math.abs(got.x - p.x * R14) < 0.01 && Math.abs(got.y - p.y * R14) < 0.01, `缺省 n=${n}`);
    off();
  }
  // 未知 id 回落到按点数的默认变体
  const odd = fakeMark(4, 'no-such');
  const offOdd = tk.register(odd);
  const p4 = ORBIT_VARIANTS.orbit4.place(T.STILL_T, 1, 4);
  assert.ok(Math.abs(parse(odd.kids[1]).x - p4.x * R14) < 0.01);
  offOdd();
});

await report.check('V8', 'r161 整体放大:指示器宽 w 时,轨道半径与圆点 scale 都是宽 14 时的 w/14 倍(位置、scale 同比,opacity / z 不变)', 'red', () => {
  const env = fakeEnv();
  env.isReduced = true; // 减弱动画:只摆静止帧,结果确定
  const tk = T.createOrbitTicker(env);
  for (const id of RANDOM_POOL) {
    const v = ORBIT_VARIANTS[id];
    const base = fakeMark(v.n, id, 14);
    const offBase = tk.register(base);
    for (const w of [20, 28, 40]) {
      const k = w / 14;
      const big = fakeMark(v.n, id, w);
      const off = tk.register(big);
      for (let j = 0; j < v.n; j++) {
        const a = parse(base.kids[j]); const b = parse(big.kids[j]);
        assert.ok(Math.abs(b.x - a.x * k) < 0.02 && Math.abs(b.y - a.y * k) < 0.02, `${id} w=${w} 点 ${j} 位置 ${b.x},${b.y} 应为 ${(a.x * k).toFixed(2)},${(a.y * k).toFixed(2)}`);
        assert.ok(Math.abs(b.s - a.s * k) < 0.002, `${id} w=${w} 点 ${j} scale ${b.s} 应为 ${(a.s * k).toFixed(3)}`);
        assert.equal(big.kids[j].style.opacity, base.kids[j].style.opacity, `${id} opacity 不随放大变`);
        assert.equal(big.kids[j].style.zIndex, base.kids[j].style.zIndex, `${id} z 不随放大变`);
      }
      off();
    }
    offBase();
  }
  // 宽 20 的直径范围:最远 1.6 · k、最近 2.5 · k(k = 20/14)
  const k20 = 20 / 14;
  const mark = fakeMark(3, 'orbit3', 20);
  const off20 = tk.register(mark);
  const s = parse(mark.kids[0]).s * 18;
  assert.ok(s >= BACK_PX * k20 - 0.01 && s <= FRONT_PX * k20 + 0.01, `宽 20 的圆点直径 ${s.toFixed(3)} 应 ∈ [${(BACK_PX * k20).toFixed(3)}, ${(FRONT_PX * k20).toFixed(3)}]`);
  off20();
});

process.exit(report.finish());
