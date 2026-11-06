// r154 / ui-live-line-v2:三体 / 四体旋转指示器的摆位公式与共享动画循环(零 React)。
// ui-live-line-v2 起去掉仰俯(elev)与侧倾(roll)两项倾斜 —— 旧投影把圆压成了扁椭圆;
// 现在点严格落在正圆上(半径恒为 1),只保留变速:过两个"水平"位置时快、到两侧时慢。
// 全页面只有一个 requestAnimationFrame 循环:有实例登记才跑,登记清空就停;页面隐藏时暂停;
// 系统要求减弱动画时只摆一次静止帧。

const TAU = Math.PI * 2;
const PERIOD_S = 3.4;
export const STILL_T = 0.9; // 减弱动画时的静止帧:三点停在圆上一个非对称相位(不是水平 / 正中)
export const SPEED_FACTORS = Object.freeze({ slow: 0.7, normal: 1, fast: 1.4 });
const DEFAULT_FACTOR = SPEED_FACTORS.slow;
// 后台恢复或单帧卡顿时,不让相位一次跳太多
const MAX_FRAME_S = 0.1;

/** 时刻 t(秒)的各个相位角;单独导出便于单测验证单调性与圈数。 */
export function orbitAngles(t) {
  const tau = (TAU * t) / PERIOD_S;
  const th = tau + 0.3 * Math.sin(2 * tau); // 变速相位;dth/dtau = 1 + 0.6cos(2tau) ≥ 0.4,恒单调
  return {
    tau,
    th,
    spin: 2 * th - Math.PI / 2, // 每个变速周期(3.4 秒)整两圈
  };
}

/** n 个点在时刻 t 的摆位;x、y 是正圆上的归一化坐标(调用方乘半径),z 是叠放顺序。 */
export function orbitPlacement(n, t) {
  const { spin } = orbitAngles(t);
  const out = [];
  for (let k = 0; k < n; k++) {
    const a = spin + (TAU * k) / n;
    const x = Math.cos(a);
    const y = Math.sin(a); // z 朝向观察者 → 屏幕上就是 y
    const d = Math.sin(a); // 深度(只影响点的大小 / 不透明度 / 叠放,不影响位置)
    out.push({
      x,
      y,
      scale: 1 + 0.42 * d,
      opacity: 0.72 + (0.28 * (d + 1)) / 2,
      z: Math.round((d + 1) * 10),
    });
  }
  return out;
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
  const pts = orbitPlacement(entry.n, t);
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
 * register({ el, kids, n }) 返回注销函数。每个实例各自累积相位,转速每帧从 el.dataset.speed 读,
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
    for (const e of entries) if (e.el.isConnected !== false) place(e, STILL_T);
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
    const rec = { el: entry.el, kids, n: entry.n || kids.length, t: STILL_T, R: 0 };
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
