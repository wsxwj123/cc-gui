// Codex 式回合标记波形：指针中心 18px，48px 外恢复 6px。
export function turnWaveWidth(distance) {
  return 6 + 12 * Math.max(0, 1 - distance / 48) ** 2;
}

// ── r11-④(鱼眼版):等距紧凑布局 + 指针鱼眼变形 + 单容器解算 ──────────
// 根因(实证):157 回合时按文档比例分布的刻度间距≈4px < 每刻度 12px 热区,压盖致悬停
// 命中错邻居。重做(对齐 dsh 效果):
//  · 布局:全部回合等距紧凑、整簇垂直居中、永不溢出(超高时整体压缩间距),恒全量渲染;
//  · 鱼眼:pointermove 时指针附近间距局部拉开(中心×factor,高斯衰减 ±3 根内明显),
//    再全簇重归一化 —— 总高/簇边界不变;
//  · 命中:tooltip/点击/键盘步进全部在变形后坐标上二分解最近回合(所见即所得)。

/** 等距紧凑布局:count 个回合在 height 内等距分布,整簇垂直居中;
 *  count×preferredGap 超高时压缩间距,保证首尾恒在 [0, height] 内。返回 px 数组。 */
export function layoutCompactPositions(count, height, preferredGap = 8) {
  if (!Number.isFinite(height) || height <= 0 || count <= 0) return [];
  if (count === 1) return [height / 2];
  const gap = Math.min(preferredGap, height / (count - 1));
  const clusterH = gap * (count - 1);
  const start = (height - clusterH) / 2;
  return Array.from({ length: count }, (_, i) => start + i * gap);
}

/**
 * 鱼眼变形(纯函数):指针附近的间距 ×factor(高斯权重,sigma 缺省=3×平均间距,
 * ≈±3 根内明显),随后按总高重归一化(远处按比例压缩补偿)。
 * 不变量:总高/簇边界不变(首尾坐标钉死)、序号单调性守恒、pointerY 为空时原样返回。
 */
export function distortPositions(base, pointerY, { factor = 3, sigma } = {}) {
  const n = base?.length || 0;
  if (n < 2 || pointerY == null) return base || [];
  const total = base[n - 1] - base[0];
  if (!(total > 0)) return base;
  const s = sigma || (total / (n - 1)) * 3;
  const s2 = 2 * s * s;
  const gaps = new Array(n - 1);
  let sum = 0;
  for (let i = 0; i < n - 1; i++) {
    const mid = (base[i] + base[i + 1]) / 2;
    const d = mid - pointerY;
    const w = 1 + (factor - 1) * Math.exp(-(d * d) / s2);
    gaps[i] = (base[i + 1] - base[i]) * w;
    sum += gaps[i];
  }
  const scale = total / sum; // 重归一化:总高守恒,远处间距按比例压缩补偿
  const out = new Array(n);
  out[0] = base[0];
  for (let i = 0; i < n - 1; i++) out[i + 1] = out[i] + gaps[i] * scale;
  out[n - 1] = base[n - 1]; // 数值兜底:簇端逐字钉死
  return out;
}

/**
 * r11-⑬→p5-1:指针纵坐标归一化到【布局像素】坐标系——无量纲比例法。
 * 0.2.293 真机(WKWebView 大字体档)回归证明 ⑬ 的比值法
 * `(clientY-rect.top)*(clientHeight/rect.height)` 依赖「clientHeight 与 rect.height
 * 的缩放语义关系」这一跨 API 引擎假设(WebKit 与 Chromium 对 zoom 下两 API 的
 * 缩放口径不一致)→ 归一化出界:命中错位+鱼眼中心跑出条外(全线条距离>衰减半径,
 * 视觉=鱼眼消失)。
 * 修法:fraction = (clientY - rect.top) / rect.height —— 分子分母取自【同一次
 * getBoundingClientRect 的同一坐标系】(CSSOM 规定 client 坐标与 rect 同空间),
 * 任何内核任何 zoom 下恒等于指针在条内的真实相对位置(0~1 夹紧);
 * localY = fraction × targetHeight(调用方传自家布局态 box.height,不再查任何
 * 每事件 DOM API)。引擎无关性由数学保证,不再依赖任何跨 API 缩放假设。
 * rect.height<=0(未布局)兜底不除,退回视觉差值夹紧。
 */
export function normalizePointerY(clientY, rect, targetHeight) {
  const th = (Number.isFinite(targetHeight) && targetHeight > 0) ? targetHeight : 0;
  const rh = rect?.height;
  if (!(Number.isFinite(rh) && rh > 0)) {
    const raw = clientY - (rect?.top || 0); // 未布局兜底:不除
    return Math.max(0, Math.min(th, raw));
  }
  const fraction = Math.max(0, Math.min(1, (clientY - (rect.top || 0)) / rh));
  return fraction * th;
}

/** positions(px,升序,可含 null 洞)→ 可二分的紧凑索引 {fracs, idxs}。 */
export function buildTurnIndex(positions) {
  const fracs = [];
  const idxs = [];
  (positions || []).forEach((p, i) => {
    if (typeof p === 'number' && Number.isFinite(p)) { fracs.push(p); idxs.push(i); }
  });
  return { fracs, idxs };
}

/** 二分解最近回合:y(与 positions 同单位)→ 原数组索引;空集返回 -1;平票取更早回合。 */
export function nearestTurnIndex(index, frac) {
  const fracs = index?.fracs || [];
  const idxs = index?.idxs || [];
  if (!fracs.length) return -1;
  let lo = 0;
  let hi = fracs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (fracs[mid] < frac) lo = mid + 1; else hi = mid;
  }
  if (lo > 0 && Math.abs(fracs[lo - 1] - frac) <= Math.abs(fracs[lo] - frac)) lo -= 1;
  return idxs[lo];
}
