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

// ---- r172 修订:状态行换位置时按 handoffKey 接力 ----
// 旧指示器先转一会再注销,新指示器用同一个 key 登记
function moveLine(env, tk, key, fromVariant, toVariant, { beforeMs = 320, retargetTo = null, afterRetargetMs = 0 } = {}) {
  const oldEl = fakeRoot();
  const off = tk.register({ el: oldEl, n: 0, variant: fromVariant, handoffKey: key });
  for (let t = 0; t < beforeMs; t += 16) env.step(16);
  if (retargetTo) { tk.retarget(oldEl, retargetTo); for (let t = 0; t < afterRetargetMs; t += 10) env.step(10); }
  const oldState = { sw: sw(oldEl), n: oldEl.children.length, r: maxR(oldEl) };
  off();
  const el = fakeRoot();
  const off2 = tk.register({ el, n: 0, variant: toVariant, handoffKey: key });
  return { el, off: off2, oldState };
}

await report.check('S6', '换位置的同时换样式:新指示器第一帧 in、画旧样式(旧点数、不在中心),1000ms 后 out 新点数,再 1000ms 消失', 'red', () => {
  const env = fakeEnv();
  const tk = createOrbitTicker(env);
  const { el } = moveLine(env, tk, 'round-1', 'orbit3', 'orbit4');
  assert.equal(sw(el), 'in', '第一帧起带 in');
  assert.equal(el.children.length, 3, '画的是旧样式的点数');
  assert.ok(maxR(el) >= 3, `第一帧圆点在旧样式的正常位置上(实测最远 ${maxR(el).toFixed(2)}px)`);
  const tOut = runUntil(env, el, () => sw(el) === 'out', 5000, 10);
  assert.ok(Math.abs(tOut - SWITCH_IN_MS) <= 10, `in ${tOut}`);
  assert.equal(el.children.length, 4);
  assert.ok(maxR(el) <= 0.05);
  const tEnd = runUntil(env, el, () => sw(el) === null, 5000, 10);
  assert.ok(Math.abs(tEnd - SWITCH_OUT_MS) <= 10, `out ${tEnd}`);
  for (let i = 0; i < 10; i++) env.step();
  assert.ok(maxR(el) > 3);
});

await report.check('S6b', '换位置时上一个过渡没做完:新指示器接着做完(同一进度),不跳成新样式正常形态', 'red', () => {
  // 聚拢做到 400ms 时挪位置
  const env = fakeEnv();
  const tk = createOrbitTicker(env);
  const a = moveLine(env, tk, 'r-in', 'orbit3', 'orbit4', { retargetTo: 'orbit4', afterRetargetMs: 400 });
  assert.equal(a.oldState.sw, 'in');
  assert.equal(sw(a.el), 'in', '接着聚拢');
  assert.equal(a.el.children.length, 3);
  assert.ok(Math.abs(maxR(a.el) - a.oldState.r) < 0.6, `半径接得上(旧 ${a.oldState.r.toFixed(2)} 新 ${maxR(a.el).toFixed(2)})`);
  const tOut = runUntil(env, a.el, () => sw(a.el) === 'out', 5000, 10);
  assert.ok(Math.abs(400 + tOut - SWITCH_IN_MS) <= 20, `聚拢总长仍约 1000ms(实测 ${400 + tOut})`);
  assert.equal(a.el.children.length, 4);
  // 展开做到一半时挪位置(新指示器要显示的就是正在展开成的样式)
  const env2 = fakeEnv();
  const tk2 = createOrbitTicker(env2);
  const b = moveLine(env2, tk2, 'r-out', 'orbit3', 'o4-diag', { retargetTo: 'o4-diag', afterRetargetMs: 1500 });
  assert.equal(b.oldState.sw, 'out');
  assert.equal(sw(b.el), 'out', '接着展开');
  assert.equal(b.el.children.length, 4);
  assert.ok(Math.abs(maxR(b.el) - b.oldState.r) < 0.6, `半径接得上(旧 ${b.oldState.r.toFixed(2)} 新 ${maxR(b.el).toFixed(2)})`);
  const tEnd = runUntil(env2, b.el, () => sw(b.el) === null, 5000, 10);
  assert.ok(Math.abs(1500 + tEnd - SWITCH_IN_MS - SWITCH_OUT_MS) <= 20, `总长仍约 2000ms(实测 ${1500 + tEnd})`);
  // 展开中挪位置、且新指示器又换了样式:从当前半径重新聚拢
  const env3 = fakeEnv();
  const tk3 = createOrbitTicker(env3);
  const c = moveLine(env3, tk3, 'r-out2', 'orbit3', 'orbit3', { retargetTo: 'o4-diag', afterRetargetMs: 1500 });
  assert.equal(sw(c.el), 'in');
  assert.ok(Math.abs(maxR(c.el) - c.oldState.r) < 0.6);
  assert.ok(runUntil(env3, c.el, () => sw(c.el) === null, 5000, 10) > 0, '最终标记消失');
  assert.equal(c.el.children.length, 3);
});

await report.check('S6c', '换位置但样式没换:不出现过渡,相位接着转;不同 key / 不给 key 不接力', 'red', () => {
  const env = fakeEnv();
  const tk = createOrbitTicker(env);
  const oldEl = fakeRoot();
  const off = tk.register({ el: oldEl, n: 0, variant: 'orbit4', handoffKey: 'k' });
  for (let i = 0; i < 20; i++) env.step();
  const before = oldEl.children.map((k) => k.style.transform);
  off();
  const el = fakeRoot();
  tk.register({ el, n: 0, variant: 'orbit4', handoffKey: 'k' });
  assert.equal(sw(el), null);
  assert.deepEqual(el.children.map((k) => k.style.transform), before, '接着上一个的相位画,不跳回起点');
  const other = fakeRoot();
  tk.register({ el: other, n: 0, variant: 'orbit3', handoffKey: 'other' });
  assert.equal(sw(other), null);
  const none = fakeRoot();
  tk.register({ el: none, n: 0, variant: 'orbit3' });
  assert.equal(sw(none), null);
  assert.equal(none.children.length, 3);
});

await report.check('S7', 'StrictMode 式登记 → 注销 → 再登记:过渡进度不重置、沿用已有 <i>', 'red', () => {
  const env = fakeEnv();
  const tk = createOrbitTicker(env);
  const { el, off } = moveLine(env, tk, 's', 'orbit3', 'orbit4');
  for (let i = 0; i < 20; i++) env.step(10); // 200ms
  off();
  const kidsBefore = el.children.slice();
  tk.register({ el, n: 4, variant: 'orbit4', handoffKey: 's' });
  assert.equal(sw(el), 'in');
  assert.deepEqual(el.children, kidsBefore, '沿用已有 <i>,不重复补');
  assert.equal(tk.size, 1);
  const tOut = runUntil(env, el, () => sw(el) === 'out', 5000, 10);
  assert.ok(Math.abs(200 + tOut - SWITCH_IN_MS) <= 20, `进度不重置(实测 ${200 + tOut})`);
});

await report.check('S7b', '减弱动画:换位置的同时换样式直接显示新样式静止帧,无 data-switch', 'red', () => {
  const env = fakeEnv();
  const tk = createOrbitTicker(env);
  const oldEl = fakeRoot();
  const off = tk.register({ el: oldEl, n: 0, variant: 'orbit3', handoffKey: 'rm' });
  env.step();
  off();
  env.isReduced = true;
  const el = fakeRoot();
  tk.register({ el, n: 0, variant: 'orbit4', handoffKey: 'rm' });
  assert.equal(sw(el), null);
  assert.equal(el.children.length, 4);
  const snap = el.children.map((k) => k.style.transform);
  for (let i = 0; i < 5; i++) env.step();
  assert.deepEqual(el.children.map((k) => k.style.transform), snap);
});

await report.check('S8', 'loadingPrefs:换样式最短间隔 4000ms', 'red', () => {
  assert.equal(P.REROLL_MIN_GAP_MS, 4000);
});

process.exit(report.finish());
