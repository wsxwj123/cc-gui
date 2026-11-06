#!/usr/bin/env node
// r154 R3:三体 / 四体旋转的摆位公式 orbitPlacement 与共享动画循环 createOrbitTicker。
//
// 锁的事:
//   O1 n=3/4 一整个周期每帧结果有限,scale ∈ [0.58, 1.42],opacity ∈ [0.72, 1]。
//   O2 正圆(ui-live-line-v2):整圈采样各点到圆心距离最大偏差 < 2%,包围盒宽高比 1±0.03。
//   O3 spin 随时间单调递增,一个周期(3.4 秒)正好两圈。
//   O4 任意相位三点都在单位圆上,过水平线不再共线(旧版仰俯/侧倾把圆压扁了)。
//   O5 ticker:首个登记启动、最后一个注销停止、hidden 暂停与恢复、reduced 只摆一次静止帧、
//      转速 0.7 / 1 / 1.4 生效(同样帧数 fast 位移大于 normal 大于 slow)。
//
// 跑法:node tests/unit/check-r154-orbit.mjs
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeReport } from './q8-helpers/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const { orbitPlacement, orbitAngles, createOrbitTicker, STILL_T, orbitTicker } = await import(
  pathToFileURL(join(ROOT, 'client', 'src', 'utils', 'orbitTicker.js')).href
);
const report = makeReport('check-r154-orbit');
const PERIOD = 3.4;
const EPS = 1e-9;

// 由 th 反解 t(th 对 t 单调,二分即可)
function tForTh(target) {
  let lo = -PERIOD, hi = PERIOD;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (orbitAngles(mid).th < target) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

function maxInteriorAngleDeg(p) {
  const ang = (a, b, c) => {
    const v1 = [b.x - a.x, b.y - a.y], v2 = [c.x - a.x, c.y - a.y];
    const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2));
    return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
  };
  return Math.max(ang(p[0], p[1], p[2]), ang(p[1], p[2], p[0]), ang(p[2], p[0], p[1]));
}

await report.check('O1', '一整个周期每帧有限,scale ∈ [0.58,1.42],opacity ∈ [0.72,1]', 'red', () => {
  for (const n of [3, 4]) {
    for (let i = 0; i <= 600; i++) {
      const t = (PERIOD * i) / 600;
      const pts = orbitPlacement(n, t);
      assert.equal(pts.length, n);
      for (const p of pts) {
        for (const k of ['x', 'y', 'scale', 'opacity', 'z']) assert.ok(Number.isFinite(p[k]), `n=${n} t=${t} ${k}=${p[k]}`);
        assert.ok(p.scale >= 0.58 - EPS && p.scale <= 1.42 + EPS, `scale ${p.scale}`);
        assert.ok(p.opacity >= 0.72 - EPS && p.opacity <= 1 + EPS, `opacity ${p.opacity}`);
        assert.ok(Math.hypot(p.x, p.y) <= 1 + EPS, '点应在单位圆内');
        assert.ok(Number.isInteger(p.z) && p.z >= 0 && p.z <= 20);
      }
    }
  }
  assert.deepEqual(orbitPlacement(0, 1), []);
});

await report.check('O2', '正圆:整圈各点到圆心距离最大偏差 < 2%,包围盒宽高比 1±0.03', 'red', () => {
  for (const n of [3, 4]) {
    const all = [];
    for (let i = 0; i <= 600; i++) {
      const t = (PERIOD * i) / 600;
      all.push(...orbitPlacement(n, t));
    }
    const radii = all.map((p) => Math.hypot(p.x, p.y));
    const dev = (Math.max(...radii) - Math.min(...radii)) / Math.max(...radii);
    assert.ok(dev < 0.02, `n=${n} 半径最大偏差 ${(dev * 100).toFixed(2)}%`);
    const xs = all.map((p) => p.x);
    const ys = all.map((p) => p.y);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    assert.ok(Math.abs(w / h - 1) < 0.03, `n=${n} 包围盒宽高比 ${(w / h).toFixed(3)}`);
  }
});

await report.check('O3', 'spin 单调递增,一个周期 3.4 秒正好两圈', 'red', () => {
  let prev = -Infinity, prevTh = -Infinity;
  for (let i = 0; i <= 3400; i++) {
    const a = orbitAngles(i / 1000);
    assert.ok(a.th > prevTh && a.spin > prev, `t=${i / 1000} 不单调`);
    prev = a.spin; prevTh = a.th;
  }
  const turns = (orbitAngles(PERIOD).spin - orbitAngles(0).spin) / (2 * Math.PI);
  assert.ok(Math.abs(turns - 2) < 1e-9, `一周期圈数 ${turns}`);
});

await report.check('O4', '任意相位三点都在单位圆上,等边分布(y 不再被压扁),过水平线不共线', 'red', () => {
  for (const th of [0, Math.PI / 2, -Math.PI / 2, STILL_T]) {
    const p = orbitPlacement(3, tForTh(th));
    for (const q of p) assert.ok(Math.abs(Math.hypot(q.x, q.y) - 1) < 1e-9, `th=${th} 半径 ${Math.hypot(q.x, q.y)}`);
    const cross = (p[1].x - p[0].x) * (p[2].y - p[0].y) - (p[1].y - p[0].y) * (p[2].x - p[0].x);
    assert.ok(Math.abs(cross) > 0.1, `th=${th} 三点不应共线(cross=${cross})`);
    const deg = maxInteriorAngleDeg(p);
    assert.ok(Math.abs(deg - 60) < 1e-6, `th=${th} 正圆上三点应等边,最大内角 ${deg.toFixed(1)}°`);
  }
});

// ---- 假环境 ----
function fakeEnv() {
  const env = { queue: new Map(), seq: 0, isHidden: false, isReduced: false, visCbs: new Set(), now: 0 };
  env.raf = (cb) => { const id = ++env.seq; env.queue.set(id, cb); return id; };
  env.caf = (id) => { env.queue.delete(id); };
  env.hidden = () => env.isHidden;
  env.reduced = () => env.isReduced;
  env.onVisibility = (cb) => { env.visCbs.add(cb); return () => env.visCbs.delete(cb); };
  env.step = (ms = 16) => {
    env.now += ms;
    const cbs = [...env.queue.values()];
    env.queue.clear();
    for (const cb of cbs) cb(env.now);
    return cbs.length;
  };
  env.fireVis = () => { for (const cb of env.visCbs) cb(); };
  return env;
}
function fakeMark(n, speed, width = 20) {
  const kids = Array.from({ length: n }, () => {
    const style = { setProperty(k, v) { this[k] = v; } };
    return { style };
  });
  return { el: { clientWidth: width, dataset: speed ? { speed } : {}, isConnected: true }, kids, n };
}
const pos = (kid) => {
  const m = /translate\(([-\d.]+)px,([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(kid.style.transform || '');
  assert.ok(m, `transform 格式不对:${kid.style.transform}`);
  return [Number(m[1]), Number(m[2])];
};

await report.check('O5a', 'ticker:首个登记启动、最后一个注销停止,写 transform / opacity / zIndex', 'red', () => {
  const env = fakeEnv();
  const tk = createOrbitTicker(env);
  assert.equal(tk.running, false);
  const a = fakeMark(3, 'normal');
  const offA = tk.register(a);
  assert.equal(tk.running, true);
  assert.equal(env.queue.size, 1);
  // 登记时立即摆一帧
  assert.match(a.kids[0].style.transform, /^translate\(.+px,.+px\) scale\(.+\)$/);
  assert.ok(Number(a.kids[0].style.opacity) >= 0.72);
  assert.ok(/^\d+$/.test(a.kids[0].style.zIndex));
  const b = fakeMark(4, 'slow');
  const offB = tk.register(b);
  assert.equal(env.queue.size, 1, '全页面只有一个 rAF 循环');
  const before = a.kids[0].style.transform;
  env.step(); env.step();
  assert.notEqual(a.kids[0].style.transform, before, '跑了几帧点应该在动');
  assert.equal(env.queue.size, 1);
  offA();
  assert.equal(tk.running, true, '还有实例时不停');
  offB();
  assert.equal(tk.running, false, '最后一个注销后停止');
  assert.equal(env.queue.size, 0);
  assert.equal(env.visCbs.size, 0, '清空后退订可见性');
  offB(); // 重复注销无副作用
  assert.equal(env.step(), 0);
  // 半径:R = max(3.5, w/2 - 2.2);宽 0 时用 3.5
  const big = fakeMark(3, 'normal', 40);
  const offBig = tk.register(big);
  const r = Math.max(...big.kids.map((k) => Math.hypot(...pos(k))));
  assert.ok(r <= 40 / 2 - 2.2 + 0.02 && r > 10, `半径 ${r}`);
  offBig();
});

await report.check('O5b', 'ticker:hidden 暂停,可见时恢复', 'red', () => {
  const env = fakeEnv();
  const tk = createOrbitTicker(env);
  const a = fakeMark(3, 'normal');
  const off = tk.register(a);
  env.step(); env.step();
  env.isHidden = true;
  env.fireVis();
  assert.equal(tk.running, false);
  const frozen = a.kids[0].style.transform;
  assert.equal(env.step(), 0);
  assert.equal(a.kids[0].style.transform, frozen);
  env.isHidden = false;
  env.fireVis();
  assert.equal(tk.running, true);
  env.step(1000 * 60); // 隐藏期间过了很久,恢复后的首帧不应跳相位
  assert.equal(a.kids[0].style.transform, frozen, '恢复后首帧只记时间、不跳');
  env.step(); env.step();
  assert.notEqual(a.kids[0].style.transform, frozen);
  // 隐藏时登记不启动循环
  env.isHidden = true; env.fireVis();
  const b = fakeMark(3, 'normal');
  const offB = tk.register(b);
  assert.equal(tk.running, false);
  off(); offB();
});

await report.check('O5c', 'ticker:reduced 只摆一次静止帧(t=0.9),不跑循环', 'red', () => {
  const env = fakeEnv();
  env.isReduced = true;
  const tk = createOrbitTicker(env);
  const a = fakeMark(3, 'fast');
  const off = tk.register(a);
  assert.equal(tk.running, false);
  assert.equal(env.queue.size, 0);
  const expect = orbitPlacement(3, STILL_T);
  const p = pos(a.kids[0]);
  const R = 20 / 2 - 2.2;
  assert.ok(Math.abs(p[0] - expect[0].x * R) < 0.01 && Math.abs(p[1] - expect[0].y * R) < 0.01);
  // 运行中途切成减弱动画:摆静止帧并停下
  env.isReduced = false;
  const b = fakeMark(3, 'fast');
  const offB = tk.register(b);
  assert.equal(tk.running, true);
  env.step(); env.step();
  env.isReduced = true;
  env.step();
  assert.equal(tk.running, false);
  const q = pos(b.kids[0]);
  assert.ok(Math.abs(q[0] - expect[0].x * R) < 0.01);
  off(); offB();
});

await report.check('O5d', 'ticker:转速 slow 0.7 / normal 1 / fast 1.4(缺省按 slow)', 'red', () => {
  const env = fakeEnv();
  const tk = createOrbitTicker(env);
  const marks = { slow: fakeMark(3, 'slow'), normal: fakeMark(3, 'normal'), fast: fakeMark(3, 'fast'), none: fakeMark(3, null), bad: fakeMark(3, 'turbo') };
  const offs = Object.values(marks).map((m) => tk.register(m));
  const travel = Object.fromEntries(Object.keys(marks).map((k) => [k, 0]));
  let last = Object.fromEntries(Object.entries(marks).map(([k, m]) => [k, m.kids.map(pos)]));
  for (let i = 0; i < 60; i++) {
    env.step(16);
    for (const [k, m] of Object.entries(marks)) {
      const now = m.kids.map(pos);
      travel[k] += now.reduce((s, p, j) => s + Math.hypot(p[0] - last[k][j][0], p[1] - last[k][j][1]), 0);
      last[k] = now;
    }
  }
  assert.ok(travel.fast > travel.normal && travel.normal > travel.slow, JSON.stringify(travel));
  assert.ok(Math.abs(travel.none - travel.slow) < 1e-6, '缺省按 slow');
  assert.ok(Math.abs(travel.bad - travel.slow) < 1e-6, '非法值按 slow');
  // 中途改转速:只改 dataset,下一帧生效,不跳相位
  const m = marks.slow;
  m.el.dataset.speed = 'fast';
  const p0 = pos(m.kids[0]);
  env.step(16);
  const p1 = pos(m.kids[0]);
  assert.ok(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) < 2, '改转速后不应跳相位');
  offs.forEach((f) => f());
  assert.equal(tk.running, false);
});

await report.check('O6', '默认全局实例在非浏览器环境可导入且不跑循环', 'green', () => {
  const off = orbitTicker.register(fakeMark(3, 'slow'));
  assert.equal(orbitTicker.running, false);
  off();
  assert.equal(orbitTicker.size, 0);
});

process.exit(report.finish());
