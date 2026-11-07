// r154:三体 / 四体旋转指示器的摆位公式与共享动画循环(零 React)。
// r159:摆位改为按变体(orbitVariants.js 的 16 种)取公式;下面的 orbitAngles / orbitPlacement
// 是默认变体 nod(上下点头)的旧接口,保留给旧引用与单测。
// 公式照设计稿 v8 的 orbitPlace:圈水平放着,上下仰俯约 ±29°(过水平线时侧立成一条线);
// 点绕圈整 360°,每个仰俯周期(3.4 秒)转两圈并与仰俯锁相,所以最高 / 最低点总是钝角三角形;
// 过水平线时快、到最高 / 最低点时慢。
// 全页面只有一个 requestAnimationFrame 循环:有实例登记才跑,登记清空就停;页面隐藏时暂停;
// 系统要求减弱动画时只摆一次静止帧。

import { ORBIT_VARIANTS, variantOf, dotPx, DOT_BASE_PX } from './orbitVariants.js';

const TAU = Math.PI * 2;
const PERIOD_S = 3.4;
export const STILL_T = 0.9; // 减弱动画时的静止帧:仰俯角接近最大,三个点成钝角三角形
export const SPEED_FACTORS = Object.freeze({ slow: 0.7, normal: 1, fast: 1.4 });
const DEFAULT_FACTOR = SPEED_FACTORS.slow;
// 后台恢复或单帧卡顿时,不让相位一次跳太多
const MAX_FRAME_S = 0.1;
// 圆点底座 18px(见 orbitVariants.js 的 DOT_BASE_PX),transform 的 scale = dotPx(d) / 18,
// 直径在最远 1.6px 到最近 2.5px 之间变化。必须与 index.css 里 .orbit-mark i 的宽高 / margin 同步改。

function variantFor(id, n) {
  return variantOf(id) || ORBIT_VARIANTS[n === 4 ? 'orbit4' : 'orbit3'];
}

/** 时刻 t(秒)的各个相位角;单独导出便于单测验证单调性与圈数。 */
export function orbitAngles(t) {
  const tau = (TAU * t) / PERIOD_S;
  const th = tau + 0.3 * Math.sin(2 * tau); // 变速相位;dth/dtau = 1 + 0.6cos(2tau) ≥ 0.4,恒单调
  return {
    tau,
    th,
    elev: 0.5 * Math.sin(th), // 仰俯角 ±0.5 弧度
    spin: 2 * th - Math.PI / 2, // 每个仰俯周期整两圈
    roll: 0.12 * Math.sin(th + 0.9), // 轻微侧倾,形状不严格左右对称
  };
}

/** 变体 v 的 n 个点在时刻 t 的摆位:x、y 是归一化坐标(调用方乘半径),scale 是对 18px 底座的
 *  transform 缩放(= dotPx(d) / 18),opacity 与 z(叠放顺序)都随深度走。 */
function placeVariant(v, n, t) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const p = v.place(t, k, n);
    const d = Math.max(-1, Math.min(1, p.d || 0));
    const u = (d + 1) / 2;
    out.push({ x: p.x, y: p.y, d, scale: dotPx(d) / DOT_BASE_PX, opacity: 0.72 + 0.28 * u, z: Math.round(u * 20) });
  }
  return out;
}

/** 默认变体 nod(上下点头)的 n 个点在时刻 t 的摆位(旧接口,保留)。 */
export function orbitPlacement(n, t) {
  return placeVariant(ORBIT_VARIANTS.orbit3, n, t);
}

function stillTimeOf(v) {
  return v && Number.isFinite(v.stillT) ? v.stillT : STILL_T;
}

function speedFactor(el) {
  const v = el && el.dataset ? el.dataset.speed : undefined;
  return Object.prototype.hasOwnProperty.call(SPEED_FACTORS, v) ? SPEED_FACTORS[v] : DEFAULT_FACTOR;
}

function place(entry, t) {
  const { el, kids } = entry;
  const w = el.clientWidth;
  if (w > 0) entry.R = Math.max(3.5, w / 2 - 2.2);
  const R = entry.R || 3.5;
  const pts = placeVariant(entry.variant, entry.n, t);
  for (let k = 0; k < pts.length; k++) {
    const kid = kids[k];
    if (!kid) continue;
    const p = pts[k];
    kid.style.setProperty('transform', `translate(${(p.x * R).toFixed(2)}px,${(p.y * R).toFixed(2)}px) scale(${p.scale.toFixed(3)})`);
    kid.style.setProperty('opacity', p.opacity.toFixed(3));
    kid.style.zIndex = String(p.z);
  }
}

/**
 * 环境可注入(单测用假 raf):
 *   raf(cb) / caf(id):帧调度;hidden():页面是否隐藏;reduced():是否减弱动画;
 *   onVisibility(cb):订阅可见性变化,返回取消订阅函数。
 * register({ el, kids, n, variant }) 返回注销函数;variant 是 orbitVariants 的 id,缺省按 n 取 orbit3 / orbit4。每个实例各自累积相位,转速每帧从 el.dataset.speed 读,
 * 改转速不重建 DOM、不跳相位。
 */
export function createOrbitTicker({ raf, caf, hidden = () => false, reduced = () => false, onVisibility = null } = {}) {
  const entries = new Set();
  let rafId = null;
  let lastNow = null;
  let unsubscribeVisibility = null;

  function stopLoop() {
    if (rafId != null && caf) caf(rafId);
    rafId = null;
    lastNow = null;
  }

  function placeStill() {
    for (const e of entries) if (e.el.isConnected !== false) place(e, stillTimeOf(e.variant));
  }

  function frame(now) {
    rafId = null;
    if (!entries.size || hidden()) { lastNow = null; return; }
    if (reduced()) { placeStill(); lastNow = null; return; }
    const dt = lastNow == null ? 0 : Math.min(MAX_FRAME_S, Math.max(0, (now - lastNow) / 1000));
    lastNow = now;
    for (const e of entries) {
      if (e.el.isConnected === false) continue;
      e.t += dt * speedFactor(e.el);
      place(e, e.t);
    }
    rafId = raf(frame);
  }

  function ensureRunning() {
    if (!entries.size) return;
    if (reduced()) { placeStill(); return; }
    if (hidden() || rafId != null) return;
    rafId = raf(frame);
  }

  function handleVisibility() {
    if (hidden()) stopLoop();
    else ensureRunning();
  }

  function register(entry) {
    if (!entry || !entry.el) return () => {};
    const kids = Array.from(entry.kids || []);
    const n = entry.n || kids.length;
    const variant = variantFor(entry.variant, n);
    // 相位从静止帧时刻起算:首帧、减弱动画与正常播放的起点一致
    const rec = { el: entry.el, kids, n, variant, t: stillTimeOf(variant), R: 0 };
    entries.add(rec);
    // 先摆一帧,首帧前不出现叠在中心的一坨点
    place(rec, rec.t);
    if (!unsubscribeVisibility && onVisibility) unsubscribeVisibility = onVisibility(handleVisibility) || null;
    ensureRunning();
    return () => {
      if (!entries.delete(rec)) return;
      if (!entries.size) {
        stopLoop();
        if (unsubscribeVisibility) { unsubscribeVisibility(); unsubscribeVisibility = null; }
      }
    };
  }

  return {
    register,
    get size() { return entries.size; },
    get running() { return rafId != null; },
  };
}

function browserEnv() {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    // 非浏览器环境(node 单测导入本模块):不跑循环
    return { raf: () => null, caf: () => {}, hidden: () => true, reduced: () => false };
  }
  const mq = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  return {
    raf: (cb) => window.requestAnimationFrame(cb),
    caf: (id) => window.cancelAnimationFrame(id),
    hidden: () => document.hidden === true,
    reduced: () => !!(mq && mq.matches),
    onVisibility: (cb) => {
      document.addEventListener('visibilitychange', cb);
      return () => document.removeEventListener('visibilitychange', cb);
    },
  };
}

// 全局唯一的 ticker 实例
export const orbitTicker = createOrbitTicker(browserEnv());
