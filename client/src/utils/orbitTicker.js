// r154:三体 / 四体旋转指示器的摆位公式与共享动画循环(零 React)。
// 公式照设计稿 v8 的 orbitPlace:圈水平放着,上下仰俯约 ±29°(过水平线时侧立成一条线);
// 点绕圈整 360°,每个仰俯周期(3.4 秒)转两圈并与仰俯锁相,所以最高 / 最低点总是钝角三角形;
// 过水平线时快、到最高 / 最低点时慢。
// 全页面只有一个 requestAnimationFrame 循环:有实例登记才跑,登记清空就停;页面隐藏时暂停;
// 系统要求减弱动画时只摆一次静止帧。

const TAU = Math.PI * 2;
const PERIOD_S = 3.4;
export const STILL_T = 0.9; // 减弱动画时的静止帧:仰俯角接近最大,三个点成钝角三角形
export const SPEED_FACTORS = Object.freeze({ slow: 0.7, normal: 1, fast: 1.4 });
const DEFAULT_FACTOR = SPEED_FACTORS.slow;
// 后台恢复或单帧卡顿时,不让相位一次跳太多
const MAX_FRAME_S = 0.1;
// 圆点底座:macOS WebKit 会把很小的盒子的宽、高分别取整到设备像素再画圆角,3.6px 的点会被压成横向椭圆;
// 底座取 18px 后取整误差占比很小,再用 transform 的 scale 缩回同样的视觉大小(scale = 1 时约 3.6px)。
// 必须与 index.css 里 .orbit-mark i 的宽高 / margin 同步改。
const DOT_VISUAL_PX = 3.6;
const DOT_BASE_PX = 18;
const DOT_K = DOT_VISUAL_PX / DOT_BASE_PX;

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

/** n 个点在时刻 t 的摆位;x、y 是单位圆内的归一化坐标(调用方乘半径),z 是叠放顺序。 */
export function orbitPlacement(n, t) {
  const { elev, spin, roll } = orbitAngles(t);
  const se = Math.sin(elev);
  const ce = Math.cos(elev);
  const sr = Math.sin(roll);
  const cr = Math.cos(roll);
  const out = [];
  for (let k = 0; k < n; k++) {
    const a = spin + (TAU * k) / n;
    const x0 = Math.cos(a);
    const z0 = Math.sin(a); // z 朝向观察者
    const xs = x0;
    const ys = z0 * se; // 俯视时近处的点落在下方
    const d = z0 * ce; // 深度
    out.push({
      x: xs * cr - ys * sr,
      y: xs * sr + ys * cr,
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
    kid.style.setProperty('transform', `translate(${(p.x * R).toFixed(2)}px,${(p.y * R).toFixed(2)}px) scale(${(p.scale * DOT_K).toFixed(3)})`);
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
