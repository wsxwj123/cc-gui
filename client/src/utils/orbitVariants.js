// r159:16 种旋转加载动画的摆位公式(纯函数,不碰 DOM)。
// 公式逐字移植自图鉴页 .devflow/r159-orbit-random/ref/gallery.template.html 的 <script>
// (nod / v5 / v6 / tumble / breath / fig8 / diag / adj3 / adj4 / counter / binary),系数不改。
// 每个 place(t, k, n) 返回 { x, y, d }:x、y 是以轨道半径为 1 的归一化坐标(调用方乘半径 R),
// d ∈ [-1, 1] 是深度(1 = 离观察者最近)。圆点直径由 dotPx(d) 给出:最远 1.6px、最近 2.5px。

const TAU = Math.PI * 2;
const PI = Math.PI;

export const FRONT_PX = 2.5; // 最前方圆点直径
export const BACK_PX = 1.6; // 最远圆点直径
// 圆点底座:macOS WebKit 会把很小的盒子按设备像素取整再画圆角,两三像素的点会被压扁;
// 底座取 18px,再用 transform 的 scale(dotPx / 18)缩到目标直径。须与 index.css 的 .orbit-mark i 同步。
export const DOT_BASE_PX = 18;

function frac(v) { return v - Math.floor(v); }
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function lerp(a, b, u) { return a + (b - a) * u; }
function eio(u) { u = clamp(u, 0, 1); return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; }

/** 深度 d → 圆点直径(px)。 */
export function dotPx(d) {
  return lerp(BACK_PX, FRONT_PX, (clamp(d, -1, 1) + 1) / 2);
}

// ---- 轨道类 ----
function nodAng(t) {
  const tau = (TAU * t) / 3.4;
  const th = tau + 0.3 * Math.sin(2 * tau);
  return { elev: 0.5 * Math.sin(th), spin: 2 * th - PI / 2, roll: 0.12 * Math.sin(th + 0.9) };
}
function nod(t, k, n) {
  const g = nodAng(t);
  const se = Math.sin(g.elev), ce = Math.cos(g.elev), sr = Math.sin(g.roll), cr = Math.cos(g.roll);
  const a = g.spin + (TAU * k) / n, x0 = Math.cos(a), z0 = Math.sin(a), ys = z0 * se;
  return { x: x0 * cr - ys * sr, y: x0 * sr + ys * cr, d: z0 * ce };
}
function v5(t, k, n) {
  const g = 1.30 + 0.27 * Math.sin((TAU * t) / 6.4), yaw = 0.42 * Math.sin((TAU * t) / 9.1);
  const cg = Math.cos(g), sg = Math.sin(g), cy = Math.cos(yaw), sy = Math.sin(yaw);
  const a = (TAU * t) / 2.2 + (TAU * k) / n, x0 = Math.cos(a), y0 = Math.sin(a) * cg, z0 = Math.sin(a) * sg;
  return { x: x0 * cy + z0 * sy, y: y0, d: -x0 * sy + z0 * cy };
}
function varAngle(t, period, depth, mod, p0) {
  const w0 = TAU / period, W = TAU / mod;
  return w0 * t - w0 * (depth / W) * (Math.cos(W * t + p0) - Math.cos(p0));
}
function v6(t, k, n) {
  const spin = varAngle(t, 1.7, 0.6, 2.6, 0), tau = (TAU * t) / 3.2 + 1.2, flip = tau + 0.4 * Math.sin(2 * tau);
  const yaw = varAngle(t, 8.5, 0.5, 5.9, 2.0);
  const cf = Math.cos(flip), sf = Math.sin(flip), cy = Math.cos(yaw), sy = Math.sin(yaw);
  const a = spin + (TAU * k) / n, x0 = Math.cos(a), y0 = Math.sin(a), y1 = y0 * cf, z1 = y0 * sf;
  return { x: x0 * cy + z1 * sy, y: y1 * 0.9, d: -x0 * sy + z1 * cy };
}
function tumble(t, k, n) {
  const a = (TAU * t) / 1.9 + (TAU * k) / n, b = (TAU * t) / 4.3, g = (TAU * t) / 6.1;
  const x0 = Math.cos(a), y0 = Math.sin(a), y1 = y0 * Math.cos(b), z1 = y0 * Math.sin(b);
  return { x: x0 * Math.cos(g) + z1 * Math.sin(g), y: y1, d: -x0 * Math.sin(g) + z1 * Math.cos(g) };
}
function breath(t, k, n) {
  const a = (TAU * t) / 2 + (TAU * k) / n, r = 0.62 + 0.38 * (0.5 + 0.5 * Math.sin((TAU * t) / 2.6)), tl = 0.8;
  return { x: r * Math.cos(a), y: r * Math.sin(a) * Math.cos(tl), d: Math.sin(a) * (0.45 + 0.55 * r) };
}

// 八字轨道:三个等质量天体的真实周期解(Chenciner–Montgomery),RK4 积分一个周期制表后回放。
// 积分表第一次用到时才算(1500 步),之后缓存。
let fig8Cache = null;
export function fig8Table() {
  if (fig8Cache) return fig8Cache;
  const Tp = 6.32591398, N = 1500, dt = Tp / N;
  let r = [[-0.97000436, 0.24308753], [0.97000436, -0.24308753], [0, 0]];
  const v3 = [-0.93240737, -0.86473146];
  let v = [[-v3[0] / 2, -v3[1] / 2], [-v3[0] / 2, -v3[1] / 2], [v3[0], v3[1]]];
  function acc(q) {
    const a = [[0, 0], [0, 0], [0, 0]];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      if (i === j) continue;
      const dx = q[j][0] - q[i][0], dy = q[j][1] - q[i][1], dd = Math.sqrt(dx * dx + dy * dy), f = 1 / (dd * dd * dd);
      a[i][0] += dx * f; a[i][1] += dy * f;
    }
    return a;
  }
  function add(q, w, h) { return q.map((p, i) => [p[0] + w[i][0] * h, p[1] + w[i][1] * h]); }
  const X = [[], [], []], Y = [[], [], []];
  for (let s = 0; s < N; s++) {
    for (let i = 0; i < 3; i++) { X[i].push(r[i][0]); Y[i].push(r[i][1]); }
    const k1v = acc(r), k1r = v, k2r = add(v, k1v, dt / 2), k2v = acc(add(r, k1r, dt / 2));
    const k3r = add(v, k2v, dt / 2), k3v = acc(add(r, k2r, dt / 2)), k4r = add(v, k3v, dt), k4v = acc(add(r, k3r, dt));
    r = r.map((p, i2) => [
      p[0] + (dt / 6) * (k1r[i2][0] + 2 * k2r[i2][0] + 2 * k3r[i2][0] + k4r[i2][0]),
      p[1] + (dt / 6) * (k1r[i2][1] + 2 * k2r[i2][1] + 2 * k3r[i2][1] + k4r[i2][1]),
    ]);
    v = v.map((p, i2) => [
      p[0] + (dt / 6) * (k1v[i2][0] + 2 * k2v[i2][0] + 2 * k3v[i2][0] + k4v[i2][0]),
      p[1] + (dt / 6) * (k1v[i2][1] + 2 * k2v[i2][1] + 2 * k3v[i2][1] + k4v[i2][1]),
    ]);
  }
  // end = 积分一整个周期后的位置,单测用它核对首尾闭合
  fig8Cache = { N, X, Y, end: r, sx: 0.92 / 1.081, sy: (0.92 / 1.081) * 2.1 };
  return fig8Cache;
}
function fig8(t, k) {
  const F = fig8Table();
  const u = frac(t / 4.8) * F.N, i0 = Math.floor(u) % F.N, f = u - Math.floor(u), i1 = (i0 + 1) % F.N;
  const bx = lerp(F.X[k][i0], F.X[k][i1], f) * F.sx, by = lerp(F.Y[k][i0], F.Y[k][i1], f) * F.sy;
  const psi = 0.9 * Math.sin((TAU * t) / 7.2), phi = 0.3, x1 = bx * Math.cos(psi), z1 = bx * Math.sin(psi);
  return { x: x1, y: by * Math.cos(phi) - z1 * Math.sin(phi), d: clamp((by * Math.sin(phi) + z1 * Math.cos(phi)) * 1.35, -1, 1) };
}

// ---- 换位类 ----
const CORN = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
// 左上↔右下、右上↔左下两对轮流交换,走椭圆弧:一个绕前面(大)、一个绕后面(小),另一对让开
function diag(t, k) {
  const Pd = 2.4, ci = Math.floor(t / Pd), ph = frac(t / Pd), A = eio(ph / 0.42), B = eio((ph - 0.5) / 0.42);
  const pair = k % 2, prog = pair ? B : A, other = pair ? A : B, w = ci + prog, a = 0.78;
  const cx = CORN[k][0] * a, cy = CORN[k][1] * a, L = Math.sqrt(cx * cx + cy * cy), nx = -cy / L, ny = cx / L;
  const sw = Math.sin(PI * w), co = Math.cos(PI * w), bulge = 0.62;
  let x = cx * co + nx * bulge * sw, y = cy * co + ny * bulge * sw;
  if (!(prog > 0 && prog < 1)) { const out = 1 + 0.16 * Math.sin(PI * clamp(other, 0, 1)); x *= out; y *= out; }
  return { x, y, d: 0.9 * sw * (k < 2 ? 1 : -1) };
}
function makeSwapper(slots, beats, len, bulge) {
  const occ = slots.map((_, i) => i), list = [occ.slice()];
  for (let i = 0; i < 96; i++) {
    const b = beats[i % beats.length], tmp = occ[b[0]];
    occ[b[0]] = occ[b[1]]; occ[b[1]] = tmp;
    if ((i + 1) % beats.length === 0 && occ.every((v, j) => v === j)) break;
    list.push(occ.slice());
  }
  return function swap(t, k) {
    const bi = Math.floor(t / len), ph = frac(t / len), e = eio(ph / 0.78), oc = list[bi % list.length];
    const bt = beats[bi % beats.length], slot = oc.indexOf(k), sp = Math.sin(PI * e);
    if (slot === bt[0] || slot === bt[1]) {
      const other = slot === bt[0] ? bt[1] : bt[0];
      const fx = slots[slot][0], fy = slots[slot][1], tx = slots[other][0], ty = slots[other][1];
      let ux = tx - fx, uy = ty - fy;
      const ul = Math.sqrt(ux * ux + uy * uy) || 1;
      ux /= ul; uy /= ul;
      return { x: lerp(fx, tx, e) + (-uy) * bulge * sp, y: lerp(fy, ty, e) + ux * bulge * sp, d: 0.8 * sp * (slot === bt[0] ? 1 : -1) };
    }
    const o = 1 + 0.12 * sp;
    return { x: slots[slot][0] * o, y: slots[slot][1] * o, d: 0 };
  };
}
const SLOT4 = CORN.map((c) => [c[0] * 0.78, c[1] * 0.78]);
const SLOT3 = [0, 1, 2].map((i) => { const a = -PI / 2 + (TAU * i) / 3; return [0.95 * Math.cos(a), 0.95 * Math.sin(a)]; });
const adj4 = makeSwapper(SLOT4, [[0, 1], [3, 2], [0, 3], [1, 2]], 0.8, 0.5);
const adj3 = makeSwapper(SLOT3, [[0, 1], [1, 2], [2, 0]], 0.9, 0.45);
function binary(t, k) {
  const sys = k < 2 ? 0 : 1, j = k % 2;
  const cx = (sys ? 0.6 : -0.6) + 0.08 * Math.cos((TAU * t) / 3.1 + sys * PI), cy = 0.1 * Math.sin((TAU * t) / 2.3 + sys * PI);
  const ph = ((sys ? -1 : 1) * TAU * t) / 1.1 + j * PI;
  return { x: cx + 0.32 * Math.cos(ph), y: cy + 0.32 * Math.sin(ph), d: Math.sin(ph) * (sys ? -1 : 1) };
}
function counter(t, k) {
  if (k < 2) {
    const a = (TAU * t) / 1.4 + k * PI, tl = 0.8;
    return { x: 0.42 * Math.cos(a), y: 0.42 * Math.sin(a) * Math.cos(tl), d: 0.25 + 0.75 * Math.sin(a) * Math.sin(tl) };
  }
  const b = (-TAU * t) / 2.2 + (k - 2) * PI + PI / 2, tl2 = -0.8;
  return { x: Math.cos(b), y: Math.sin(b) * Math.cos(tl2), d: -0.2 + 0.8 * Math.sin(b) * Math.sin(tl2) };
}

// ---- 变体表 ----
// stillT:系统要求减弱动画时摆的静止帧时刻,在 0.1–10 秒里搜出的「两点最小中心距最大」的时刻;
// 14px 指示器(R = 4.8)里两两中心距都 ≥ 3.5px,唯独双星互绕的同一对点被公式固定在 0.64R ≈ 3.07px。
// 单测 tests/unit/check-r159-orbit-variants.mjs 按 ≥ 3px 核对。orbit3 / orbit4 沿用旧值 0.9。
function V(id, n, label, place, stillT) {
  return Object.freeze({ id, n, label, place, stillT });
}
export const ORBIT_VARIANTS = Object.freeze({
  orbit3: V('orbit3', 3, '三体旋转', nod, 0.9),
  orbit4: V('orbit4', 4, '四体旋转', nod, 0.9),
  'o3-v5': V('o3-v5', 3, '三体·摆动偏转', v5, 4.58),
  'o4-v5': V('o4-v5', 4, '四体·摆动偏转', v5, 4.9),
  'o3-v6': V('o3-v6', 3, '三体·忽停忽翻', v6, 9),
  'o4-v6': V('o4-v6', 4, '四体·忽停忽翻', v6, 8.91),
  'o3-tumble': V('o3-tumble', 3, '三体·三维翻滚', tumble, 0.1),
  'o4-tumble': V('o4-tumble', 4, '四体·三维翻滚', tumble, 0.1),
  'o3-breath': V('o3-breath', 3, '三体·呼吸环绕', breath, 8.5),
  'o4-breath': V('o4-breath', 4, '四体·呼吸环绕', breath, 8.5),
  'o3-fig8': V('o3-fig8', 3, '三体·八字轨道', fig8, 7.63),
  'o3-adj': V('o3-adj', 3, '三体·邻位交换', adj3, 0.73),
  'o4-adj': V('o4-adj', 4, '四体·邻位交换', adj4, 0.65),
  'o4-diag': V('o4-diag', 4, '四体·对角换位', diag, 1.03),
  'o4-counter': V('o4-counter', 4, '四体·内外对转', counter, 3.4),
  'o4-binary': V('o4-binary', 4, '四体·双星互绕', binary, 0.18),
});

// 随机池:顺序固定(与任务文件的表一致)
export const RANDOM_POOL = Object.freeze([
  'orbit3', 'orbit4', 'o3-v5', 'o4-v5', 'o3-v6', 'o4-v6', 'o3-tumble', 'o4-tumble',
  'o3-breath', 'o4-breath', 'o3-fig8', 'o3-adj', 'o4-adj', 'o4-diag', 'o4-counter', 'o4-binary',
]);

/** 按 id 取变体;不是 16 种之一返回 null。 */
export function variantOf(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(ORBIT_VARIANTS, id) ? ORBIT_VARIANTS[id] : null;
}
