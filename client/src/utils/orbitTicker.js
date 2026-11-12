// r154:三体 / 四体旋转指示器的摆位公式与共享动画循环(零 React)。
// r159:摆位改为按变体(orbitVariants.js 的 16 种)取公式;下面的 orbitAngles / orbitPlacement
// 是默认变体 nod(上下点头)的旧接口,保留给旧引用与单测。
// 公式照设计稿 v8 的 orbitPlace:圈水平放着,上下仰俯约 ±29°(过水平线时侧立成一条线);
// 点绕圈整 360°,每个仰俯周期(3.4 秒)转两圈并与仰俯锁相,所以最高 / 最低点总是钝角三角形;
// r161 起变速改为「展开(最高 / 最低点)时快、过水平线排成一条线时慢」(旧版相反),公式只在 orbitVariants.js 的 nodAng 一处。
// 全页面只有一个 requestAnimationFrame 循环:有实例登记才跑,登记清空就停;页面隐藏时暂停;
// 系统要求减弱动画时只摆一次静止帧。

import { ORBIT_VARIANTS, variantOf, dotPx, nodAng, DOT_BASE_PX, ORBIT_REF_PX, ORBIT_REF_R } from './orbitVariants.js';
import { DEFAULT_LOADING_SPEED } from './loadingPrefs.js';

export const STILL_T = 0.85; // 减弱动画时的静止帧:= 3.4 / 4 秒,仰俯角恰为最大,三个点对称地成钝角三角形(须与 orbitVariants.js 里 orbit3 / orbit4 的 stillT 相同)
export const SPEED_FACTORS = Object.freeze({ slow: 0.7, normal: 1, fast: 1.4 });
// r165:指示器没带 data-speed、或值不合法时按默认转速那一档转(默认转速由慢改成标准;取 loadingPrefs.js 的常量,不在这里写死)
const DEFAULT_FACTOR = SPEED_FACTORS[DEFAULT_LOADING_SPEED];
// 后台恢复或单帧卡顿时,不让相位一次跳太多
const MAX_FRAME_S = 0.1;
// 圆点底座 18px(见 orbitVariants.js 的 DOT_BASE_PX),transform 的 scale = dotPx(d) · k / 18,
// 14px 基准指示器上直径在最远 1.8px 到最近 2.3px 之间变化。必须与 index.css 里 .orbit-mark i 的宽高 / margin 同步改。
// r161 整体放大:k = 指示器宽 / 14,轨道半径 = 4.8 · k,圆点直径 · k,指示器越大整个动画等比越大。

function variantFor(id, n) {
  return variantOf(id) || ORBIT_VARIANTS[n === 4 ? 'orbit4' : 'orbit3'];
}

/** 时刻 t(秒)的各个相位角{ tau, th, elev, spin, roll };单独导出便于单测验证单调性与圈数。
 *  公式在 orbitVariants.js 的 nodAng(变速相位 th = tau − 0.3·sin(2·tau),恒单调;仰俯角 ±0.5 弧度;spin 每个仰俯周期整两圈;roll 是轻微侧倾)。 */
export function orbitAngles(t) {
  return nodAng(t);
}

/** 变体 v 的 n 个点在时刻 t 的摆位:x、y 是归一化坐标(调用方乘半径),scale 是对 18px 底座的
 *  transform 缩放(= dotPx(d) · mag / 18,mag 是整体放大倍数 k,缺省 1),opacity 与 z(叠放顺序)都随深度走。 */
function placeVariant(v, n, t, mag = 1) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const p = v.place(t, k, n);
    const d = Math.max(-1, Math.min(1, p.d || 0));
    const u = (d + 1) / 2;
    out.push({ x: p.x, y: p.y, d, scale: (dotPx(d) * mag) / DOT_BASE_PX, opacity: 0.72 + 0.28 * u, z: Math.round(u * 20) });
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

// r172:换样式的过渡(墙钟毫秒,不随转速档位变):先聚拢 1 秒(旧样式照转,圆点收向中心),到中心那一刻换成新样式
// (点数也在这一刻变),再展开 1 秒。spread ∈ [0, 1] 是摆位时乘在轨道半径上的比例;聚拢期间远近大小差一并收掉。
export const SWITCH_IN_MS = 1000;
export const SWITCH_OUT_MS = 1000;
// 聚拢到中心时所有圆点统一的不透明度(大小取深度 0 那一档)
const MID_OPACITY = 0.86;

function easeInOut(u) {
  const x = u < 0 ? 0 : (u > 1 ? 1 : u);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

function place(entry, t) {
  const { el, kids } = entry;
  const w = el.clientWidth;
  if (w > 0) entry.mag = w / ORBIT_REF_PX; // 整体放大倍数 k:指示器越宽,轨道与圆点等比越大(下面循环里的 k 是点序号,别混)
  const mag = entry.mag || 1;
  const R = ORBIT_REF_R * mag;
  const s = entry.spread == null ? 1 : entry.spread;
  const midScale = (dotPx(0) * mag) / DOT_BASE_PX;
  const pts = placeVariant(entry.variant, entry.n, t, mag);
  for (let k = 0; k < pts.length; k++) {
    const kid = kids[k];
    if (!kid) continue;
    const p = pts[k];
    // spread = 1(不在过渡中)时与旧版逐字相同
    const x = s >= 1 ? p.x * R : p.x * R * s;
    const y = s >= 1 ? p.y * R : p.y * R * s;
    const scale = s >= 1 ? p.scale : midScale + (p.scale - midScale) * s;
    const opacity = s >= 1 ? p.opacity : MID_OPACITY + (p.opacity - MID_OPACITY) * s;
    kid.style.setProperty('transform', `translate(${x.toFixed(2)}px,${y.toFixed(2)}px) scale(${scale.toFixed(3)})`);
    kid.style.setProperty('opacity', opacity.toFixed(3));
    kid.style.zIndex = String(p.z);
  }
}

// 过渡标记写在指示器根元素上:聚拢 in、展开 out、其余时候没有这个属性(React 不渲染它,不会被覆盖)
function setSwitchAttr(el, value) {
  if (!el) return;
  if (typeof el.setAttribute === 'function' && typeof el.removeAttribute === 'function') {
    if (value) el.setAttribute('data-switch', value);
    else el.removeAttribute('data-switch');
  } else if (el.dataset) {
    if (value) el.dataset.switch = value;
    else delete el.dataset.switch;
  }
}

// <i> 的个数跟着当前样式的点数走:多了从末尾摘掉,少了在末尾补(补的点默认透明,同一帧里马上摆位)
function syncKids(rec) {
  const { el, kids } = rec;
  const doc = el.ownerDocument;
  while (kids.length < rec.n) {
    if (!doc || typeof doc.createElement !== 'function' || typeof el.appendChild !== 'function') break;
    const kid = doc.createElement('i');
    el.appendChild(kid);
    kids.push(kid);
  }
  while (kids.length > rec.n) {
    const kid = kids.pop();
    if (kid && kid.parentNode === el && typeof el.removeChild === 'function') el.removeChild(kid);
  }
}

// 换成变体 v:点数在这一刻变,相位从新变体的静止帧时刻起算(此时圆点都在中心,看不出跳)
function swapVariant(rec, v) {
  if (!v || v === rec.variant) return;
  rec.variant = v;
  rec.n = v.n;
  syncKids(rec);
  rec.t = stillTimeOf(v);
}

// 按墙钟推进过渡;页面隐藏后回来、或卡了很久,一次推进到底,不会停在中间
function advanceSwitch(rec, nowMs) {
  for (;;) {
    if (rec.sw === 'in') {
      const p = (nowMs - rec.swStart) / SWITCH_IN_MS;
      if (p < 1) { rec.spread = rec.fromSpread * (1 - easeInOut(p)); return; }
      swapVariant(rec, rec.pending);
      rec.pending = null;
      rec.sw = 'out';
      rec.swStart += SWITCH_IN_MS;
      setSwitchAttr(rec.el, 'out');
      continue;
    }
    if (rec.sw === 'out') {
      const p = (nowMs - rec.swStart) / SWITCH_OUT_MS;
      if (p < 1) { rec.spread = easeInOut(p); return; }
      rec.sw = null;
      setSwitchAttr(rec.el, null);
    }
    rec.spread = 1;
    return;
  }
}

// 立即结束过渡(减弱动画):还在聚拢的直接换成目标样式,标记去掉
function finishSwitch(rec) {
  if (rec.sw === 'in' && rec.pending) swapVariant(rec, rec.pending);
  const had = rec.sw != null;
  rec.sw = null;
  rec.pending = null;
  rec.spread = 1;
  if (had) setSwitchAttr(rec.el, null);
}

function defaultClock() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

/**
 * 环境可注入(单测用假 raf):
 *   raf(cb) / caf(id):帧调度;hidden():页面是否隐藏;reduced():是否减弱动画;
 *   onVisibility(cb):订阅可见性变化,返回取消订阅函数;clock():墙钟毫秒(换样式过渡用,缺省 performance.now)。
 * register({ el, kids, n, variant, enter }) 返回注销函数(kids 缺省取 el 现有的 <i>,不够的由 ticker 补;enter = 从中心展开出现);
 * retarget(el, variant) 原位换样式(带聚拢 / 展开过渡);variant 是 orbitVariants 的 id,缺省按 n 取 orbit3 / orbit4。每个实例各自累积相位,转速每帧从 el.dataset.speed 读,
 * 改转速不重建 DOM、不跳相位。
 */
export function createOrbitTicker({ raf, caf, hidden = () => false, reduced = () => false, onVisibility = null, clock = defaultClock } = {}) {
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
    for (const e of entries) {
      finishSwitch(e);
      if (e.el.isConnected !== false) place(e, stillTimeOf(e.variant));
    }
  }

  function frame(now) {
    rafId = null;
    if (!entries.size || hidden()) { lastNow = null; return; }
    if (reduced()) { placeStill(); lastNow = null; return; }
    const dt = lastNow == null ? 0 : Math.min(MAX_FRAME_S, Math.max(0, (now - lastNow) / 1000));
    lastNow = now;
    const wall = clock();
    for (const e of entries) {
      if (e.el.isConnected === false) continue;
      e.t += dt * speedFactor(e.el);
      // 先推进过渡(可能在这一刻换样式、t 重置为新样式的起点),再摆位
      if (e.sw) advanceSwitch(e, wall);
      place(e, e.t);
    }
    rafId = raf(frame);
  }

  /** r172:原位换样式。旧样式照转并收向中心(data-switch=in),到中心换成 variantId 再展开(out)。
   *  还在聚拢 → 只换目标;已经在展开 → 从当前位置重新聚拢再展开成最新的;减弱动画 → 直接换成新样式的静止帧。
   *  el 没登记过 → 什么都不做,返回 false。 */
  function retarget(el, variantId) {
    let rec = null;
    for (const e of entries) if (e.el === el) { rec = e; break; }
    if (!rec) return false;
    const v = variantFor(variantId, rec.n);
    if (reduced()) {
      finishSwitch(rec);
      swapVariant(rec, v);
      place(rec, stillTimeOf(rec.variant));
      return true;
    }
    const nowMs = clock();
    if (rec.sw) advanceSwitch(rec, nowMs);
    if (rec.sw === 'in') { rec.pending = v; return true; }
    if (v === rec.variant) return true; // 不在过渡中 / 正在展开成的就是它:不用换
    rec.fromSpread = rec.sw === 'out' ? rec.spread : 1;
    rec.sw = 'in';
    rec.swStart = nowMs;
    rec.pending = v;
    setSwitchAttr(rec.el, 'in');
    ensureRunning();
    return true;
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
    // 没给 kids 时取根元素现有的 <i>(StrictMode 下第二次登记会沿用第一次补出来的点),个数不够由 syncKids 补齐
    const kids = entry.kids
      ? Array.from(entry.kids)
      : Array.from(entry.el.children || []).filter((c) => !c.tagName || c.tagName === 'I');
    const n = entry.n || kids.length;
    const variant = variantFor(entry.variant, n);
    // 相位从静止帧时刻起算:首帧、减弱动画与正常播放的起点一致
    const rec = { el: entry.el, kids, n, variant, t: stillTimeOf(variant), mag: 0, sw: null, swStart: 0, fromSpread: 1, pending: null, spread: 1 };
    syncKids(rec);
    // r172:enter = 这个实例是伴随换样式出现的(状态行换位置的同时换了样式):从中心展开,只做后半段。减弱动画时不做。
    if (entry.enter && !reduced()) {
      rec.sw = 'out';
      rec.swStart = clock();
      rec.spread = 0;
    }
    setSwitchAttr(rec.el, rec.sw);
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
    retarget,
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
