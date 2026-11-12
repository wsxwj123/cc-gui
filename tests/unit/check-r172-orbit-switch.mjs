#!/usr/bin/env node
// r172:随机模式换样式的过渡(orbitTicker 的 retarget / register enter)与按回合抽取的 switchedFrom / markShown。
//
// 锁的事:
//   S1 原位换样式:data-switch 先 in(旧样式、旧点数、圆点按比例收向中心),1000ms 处换成新样式与点数并变 out,
//      再 1000ms 后属性消失;in 末段与 out 初段圆点都在中心;收拢比例随时间单调。
//   S2 过渡时长按墙钟,与转速档位无关(fast / slow 一样长)。
//   S3 过渡中再次换目标:还在聚拢 → 只换目标,时长不延长;已经在展开 → 从当前位置重新聚拢,再展开成最新的;不抛错、最终无标记。
//   S4 减弱动画:retarget 直接换成新样式的静止帧,不出现 data-switch;过渡途中切到减弱动画 → 下一帧结束过渡。
//   S5 页面隐藏后回来:一帧推进到底,不卡在过渡中间。
//   S6 register enter:从中心展开(out),1000ms 后消失;减弱动画时不展开;不带 enter 时无标记。
//   S7 <i> 个数:不给 kids 时 ticker 按点数补齐;StrictMode 式「登记 → 注销 → 再登记」沿用已有的点、不重复补。
//   S8 loadingPrefs:REROLL_MIN_GAP_MS = 4000;store.roll 返回 switchedFrom(回合里显示过别的 id、这次给的不同),
//      重复调用答案不变;markShown 之后同 id 不再算换;新回合 / 未显示过为 null。
//
// 跑法:node tests/unit/check-r172-orbit-switch.mjs
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeReport } from './q8-helpers/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const T = await import(pathToFileURL(join(ROOT, 'client', 'src', 'utils', 'orbitTicker.js')).href);
const P = await import(pathToFileURL(join(ROOT, 'client', 'src', 'utils', 'loadingPrefs.js')).href);
const { createOrbitTicker, SWITCH_IN_MS, SWITCH_OUT_MS } = T;
const report = makeReport('check-r172-orbit-switch');

// ---- 假环境:帧调度与墙钟共用一个假时间 ----
function fakeEnv() {
  const env = { queue: new Map(), seq: 0, isHidden: false, isReduced: false, visCbs: new Set(), now: 0 };
  env.raf = (cb) => { const id = ++env.seq; env.queue.set(id, cb); return id; };
  env.caf = (id) => { env.queue.delete(id); };
  env.hidden = () => env.isHidden;
  env.reduced = () => env.isReduced;
  env.clock = () => env.now;
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
// 假 DOM:根元素有属性表、子元素列表、ownerDocument.createElement
function fakeKid() {
  return { tagName: 'I', parentNode: null, style: { setProperty(k, v) { this[k] = v; } } };
}
function fakeRoot(speed = 'normal', width = 20) {
  const el = {
    clientWidth: width, isConnected: true, dataset: { speed }, attrs: {}, children: [],
    setAttribute(k, v) { this.attrs[k] = String(v); },
    removeAttribute(k) { delete this.attrs[k]; },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) { this.children.splice(this.children.indexOf(c), 1); c.parentNode = null; return c; },
  };
  el.ownerDocument = { createElement: () => fakeKid() };
  return el;
}
const sw = (el) => (Object.prototype.hasOwnProperty.call(el.attrs, 'data-switch') ? el.attrs['data-switch'] : null);
const pos = (kid) => {
  const m = /translate\(([-\d.]+)px,([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(kid.style.transform || '');
  assert.ok(m, `transform 格式不对:${kid.style.transform}`);
  return [Number(m[1]), Number(m[2])];
};
const maxR = (el) => Math.max(...el.children.map((k) => Math.hypot(...pos(k))));

// 跑到 data-switch 变化或超时,返回变化时刻(相对开始的毫秒)
function runUntil(env, el, pred, limitMs = 5000, dt = 16) {
  const t0 = env.now;
  while (env.now - t0 < limitMs) { env.step(dt); if (pred()) return env.now - t0; }
  return -1;
}

await report.check('S1', '原位换样式:in(旧点数、收向中心)→ 1000ms 换样式与点数变 out → 再 1000ms 属性消失', 'red', () => {
  const env = fakeEnv();
  const tk = createOrbitTicker(env);
  const el = fakeRoot();
  tk.register({ el, n: 3, variant: 'orbit3' });
  assert.equal(el.children.length, 3, '不给 kids 时应补齐 3 个 <i>');
  assert.equal(sw(el), null);
  for (let i = 0; i < 20; i++) env.step();
  const r0 = maxR(el);
  assert.ok(r0 > 3, `正常转动时圆点应离中心 > 3px(实测 ${r0})`);
  assert.equal(tk.retarget(el, 'orbit4'), true);
  assert.equal(sw(el), 'in', 'retarget 当下就带 in');
  assert.equal(el.children.length, 3, 'in 期间仍是旧点数');
  // 收拢比例随时间走:旧样式照转(形状本身的最远距离会变),但每一刻都不超过「轨道半径 × (1 − 缓动(p))」这条单调下降的包络
  const R = 4.8 * (20 / 14);
  const eio = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
  const rs = [];
  for (let k = 0; k < 9; k++) {
    for (let i = 0; i < 6; i++) env.step(16.6);
    const r = maxR(el);
    rs.push(r);
    assert.equal(sw(el), 'in');
    assert.equal(el.children.length, 3);
    const p = ((k + 1) * 6 * 16.6) / SWITCH_IN_MS;
    assert.ok(r <= R * (1 - eio(p)) + 0.05, `聚拢第 ${k + 1} 次读数 ${r.toFixed(2)} 应 ≤ 包络 ${(R * (1 - eio(p))).toFixed(2)}(${rs.map((x) => x.toFixed(2)).join(' ')})`);
  }
  assert.ok(rs[8] < 0.6, `聚拢到 90% 时应已接近中心(实测 ${rs[8].toFixed(2)})`);
  const tOut = runUntil(env, el, () => sw(el) === 'out');
  assert.ok(tOut >= 0, '应变为 out');
  const inMs = 9 * 6 * 16.6 + tOut;
  assert.ok(Math.abs(inMs - SWITCH_IN_MS) <= 20, `in 应持续约 ${SWITCH_IN_MS}ms(实测 ${inMs.toFixed(0)})`);
  assert.equal(el.children.length, 4, 'out 起是新样式点数');
  assert.ok(maxR(el) <= 0.05, `out 第一帧圆点应在中心(实测 ${maxR(el)})`);
  const tEnd = runUntil(env, el, () => sw(el) === null);
  assert.ok(Math.abs(tEnd - SWITCH_OUT_MS) <= 20, `out 应持续约 ${SWITCH_OUT_MS}ms(实测 ${tEnd})`);
  assert.equal(el.children.length, 4);
  for (let i = 0; i < 10; i++) env.step();
  assert.ok(maxR(el) > 3, '过渡结束后恢复正常转动');
});

await report.check('S1b', '4 点 → 3 点:多出来的 <i> 在中心那一刻摘掉', 'red', () => {
  const env = fakeEnv();
  const tk = createOrbitTicker(env);
  const el = fakeRoot();
  tk.register({ el, n: 4, variant: 'orbit4' });
  assert.equal(el.children.length, 4);
  tk.retarget(el, 'orbit3');
  runUntil(env, el, () => sw(el) === 'out');
  assert.equal(el.children.length, 3);
  assert.ok(el.children.every((k) => k.parentNode === el));
  runUntil(env, el, () => sw(el) === null);
  assert.equal(el.children.length, 3);
});

await report.check('S2', '过渡时长按墙钟,fast / slow 一样长', 'red', () => {
  for (const speed of ['slow', 'fast']) {
    const env = fakeEnv();
    const tk = createOrbitTicker(env);
    const el = fakeRoot(speed);
    tk.register({ el, n: 3, variant: 'orbit3' });
    env.step();
    tk.retarget(el, 'o4-diag');
    const tOut = runUntil(env, el, () => sw(el) === 'out', 5000, 10);
    const tEnd = runUntil(env, el, () => sw(el) === null, 5000, 10);
    assert.ok(Math.abs(tOut - SWITCH_IN_MS) <= 10, `${speed} in ${tOut}`);
    assert.ok(Math.abs(tEnd - SWITCH_OUT_MS) <= 10, `${speed} out ${tEnd}`);
  }
});

await report.check('S3', '过渡中再次换目标:聚拢中只换目标;展开中从当前位置重新聚拢;不抛错、最终无标记', 'red', () => {
  const env = fakeEnv();
  const tk = createOrbitTicker(env);
  const el = fakeRoot();
  tk.register({ el, n: 3, variant: 'orbit3' });
  env.step();
  tk.retarget(el, 'orbit4');
  for (let i = 0; i < 25; i++) env.step(16); // 400ms,仍在聚拢
  assert.equal(sw(el), 'in');
  tk.retarget(el, 'o3-v5'); // 只换目标
  const tOut = runUntil(env, el, () => sw(el) === 'out', 5000, 10);
  assert.ok(Math.abs(400 + tOut - SWITCH_IN_MS) <= 20, `聚拢中换目标不延长聚拢(实测 ${400 + tOut})`);
  assert.equal(el.children.length, 3, '换成最新目标 o3-v5(3 点)');
  // 展开到一半,再换目标 → 重新聚拢,起点是当前半径,不跳
  for (let i = 0; i < 30; i++) env.step(16);
  assert.equal(sw(el), 'out');
  const rBefore = maxR(el);
  tk.retarget(el, 'orbit4');
  assert.equal(sw(el), 'in');
  env.step(16);
  const rAfter = maxR(el);
  assert.ok(Math.abs(rAfter - rBefore) < 1.5, `展开中改目标不应跳(${rBefore.toFixed(2)} → ${rAfter.toFixed(2)})`);
  const t2 = runUntil(env, el, () => sw(el) === 'out', 5000, 10);
  assert.ok(t2 > 0);
  assert.equal(el.children.length, 4);
  const t3 = runUntil(env, el, () => sw(el) === null, 5000, 10);
  assert.ok(t3 > 0, '最终标记消失');
  // 不在过渡中换成同一个:什么都不做
  tk.retarget(el, 'orbit4');
  assert.equal(sw(el), null);
  // 没登记的元素:返回 false、不抛错
  assert.equal(tk.retarget(fakeRoot(), 'orbit3'), false);
});

await report.check('S4', '减弱动画:直接换成新样式静止帧、无 data-switch;过渡途中切到减弱动画 → 结束过渡', 'red', () => {
  const env = fakeEnv();
  env.isReduced = true;
  const tk = createOrbitTicker(env);
  const el = fakeRoot();
  tk.register({ el, n: 3, variant: 'orbit3' });
  tk.retarget(el, 'orbit4');
  assert.equal(sw(el), null);
  assert.equal(el.children.length, 4);
  const snap = el.children.map((k) => k.style.transform);
  for (let i = 0; i < 10; i++) env.step();
  assert.deepEqual(el.children.map((k) => k.style.transform), snap, '静止帧不动');
  assert.ok(maxR(el) > 3, '静止帧不缩在中心');
  // 途中切换
  const env2 = fakeEnv();
  const tk2 = createOrbitTicker(env2);
  const el2 = fakeRoot();
  tk2.register({ el: el2, n: 3, variant: 'orbit3' });
  env2.step();
  tk2.retarget(el2, 'orbit4');
  for (let i = 0; i < 10; i++) env2.step();
  assert.equal(sw(el2), 'in');
  env2.isReduced = true;
  env2.step();
  assert.equal(sw(el2), null);
  assert.equal(el2.children.length, 4, '直接换成目标');
});

await report.check('S5', '页面隐藏后回来:一帧推进到底,不卡在过渡中间', 'red', () => {
  const env = fakeEnv();
  const tk = createOrbitTicker(env);
  const el = fakeRoot();
  tk.register({ el, n: 3, variant: 'orbit3' });
  env.step();
  tk.retarget(el, 'orbit4');
  for (let i = 0; i < 5; i++) env.step();
  env.isHidden = true; env.fireVis();
  env.now += 10_000;
  assert.equal(env.step(), 0, '隐藏时循环停');
  env.isHidden = false; env.fireVis();
  env.step();
  assert.equal(sw(el), null);
  assert.equal(el.children.length, 4);
  env.step();
  assert.ok(maxR(el) > 3);
});

await report.check('S6', 'register enter:从中心展开 1000ms;减弱动画不展开;不带 enter 无标记', 'red', () => {
  const env = fakeEnv();
  const tk = createOrbitTicker(env);
  const el = fakeRoot();
  tk.register({ el, n: 4, variant: 'o4-diag', enter: true });
  assert.equal(sw(el), 'out', '第一帧起带 out');
  assert.ok(maxR(el) <= 0.05, '圆点都在中心');
  assert.ok(el.children.every((k) => Number(k.style.opacity) > 0), '已摆位、不透明');
  const tEnd = runUntil(env, el, () => sw(el) === null, 5000, 10);
  assert.ok(Math.abs(tEnd - SWITCH_OUT_MS) <= 10, `out ${tEnd}`);
  const env2 = fakeEnv(); env2.isReduced = true;
  const el2 = fakeRoot();
  createOrbitTicker(env2).register({ el: el2, n: 3, variant: 'orbit3', enter: true });
  assert.equal(sw(el2), null);
  assert.ok(maxR(el2) > 3);
  const el3 = fakeRoot();
  createOrbitTicker(fakeEnv()).register({ el: el3, n: 3, variant: 'orbit3' });
  assert.equal(sw(el3), null);
});

await report.check('S7', 'StrictMode 式登记 → 注销 → 再登记:沿用已有 <i>,不重复补', 'red', () => {
  const env = fakeEnv();
  const tk = createOrbitTicker(env);
  const el = fakeRoot();
  const off = tk.register({ el, n: 4, variant: 'orbit4', enter: true });
  off();
  assert.equal(tk.size, 0);
  tk.register({ el, n: 4, variant: 'orbit4', enter: true });
  assert.equal(el.children.length, 4);
  assert.equal(tk.size, 1);
  assert.equal(sw(el), 'out');
});

await report.check('S8', 'loadingPrefs:间隔 4000;switchedFrom / markShown', 'red', () => {
  assert.equal(P.REROLL_MIN_GAP_MS, 4000);
  const store = P.createScopedRollStore();
  const r0 = store.roll('A', { phase: 'thinking', key: 'thinking', nowMs: 0 }, () => 0);
  assert.equal(r0.switchedFrom, null, '回合第一次');
  // 没有 markShown 时即使换了也不算(没显示过)
  store.markShown('A', r0.id);
  const r1 = store.roll('A', { phase: 'text', key: 'text', nowMs: 4500 }, () => 0);
  assert.equal(r1.rolled, false); assert.equal(r1.switchedFrom, null, '换位置但没换样式');
  const r2 = store.roll('A', { phase: 'thinking', key: 'thinking', nowMs: 5500 }, () => 0);
  assert.equal(r2.rolled, true); assert.equal(r2.switchedFrom, r0.id, '换位置的同时换了样式');
  // 同一次挂载重复调用(StrictMode):答案不变
  const r3 = store.roll('A', { phase: 'thinking', key: 'thinking', nowMs: 5501 }, () => 0);
  assert.equal(r3.rolled, false); assert.equal(r3.id, r2.id); assert.equal(r3.switchedFrom, r0.id);
  store.markShown('A', r2.id);
  assert.equal(store.roll('A', { phase: 'thinking', key: 'thinking', nowMs: 5600 }, () => 0).switchedFrom, null);
  // 没抽过的回合 markShown 不记、不抛错
  store.markShown('nope', 'orbit3');
  assert.equal(store.roll('nope', { phase: 'thinking', key: 'thinking', nowMs: 0 }, () => 0).switchedFrom, null);
});

process.exit(report.finish());
