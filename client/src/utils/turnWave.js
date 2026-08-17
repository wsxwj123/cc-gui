// Codex 式回合标记波形：指针中心 18px，48px 外恢复 6px。
export function turnWaveWidth(distance) {
  return 6 + 12 * Math.max(0, 1 - distance / 48) ** 2;
}

// ── r11-④ 高密度刻度:单容器解算 ─────────────────────────────────
// 根因(实证):157 回合时刻度间距≈4px < 每刻度 12px 热区,热区互相压盖,悬停命中错邻居。
// 交互模型改为「容器一个 pointer 监听 + 按 pointerY 解最近回合索引」,tooltip/点击/波形
// 放大全用该索引;渲染可抽稀,解算永远用全量 positions(交互精确到真实回合)。

/** positions(0~1,可含 null=测不到的回合)→ 可二分的紧凑索引 {fracs, idxs}。 */
export function buildTurnIndex(positions) {
  const fracs = [];
  const idxs = [];
  (positions || []).forEach((p, i) => {
    if (typeof p === 'number' && Number.isFinite(p)) { fracs.push(p); idxs.push(i); }
  });
  return { fracs, idxs };
}

/**
 * 二分解最近回合:frac(0~1)→ 原 positions 数组中的回合索引;空索引返回 -1。
 * fracs 天然升序(positions 按 DOM offsetTop 生成)。
 */
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
  // lo = 首个 ≥ frac 的位置;最近者是 lo 或 lo-1(等距取更早的回合,行为稳定)。
  if (lo > 0 && Math.abs(fracs[lo - 1] - frac) <= Math.abs(fracs[lo] - frac)) lo -= 1;
  return idxs[lo];
}

/**
 * 抽稀步长:回合数 > 容器高/minGapPx 时每 step 条画一条(交互不抽稀)。
 * 高度未知(0/NaN)时不抽稀(step=1),首帧安全。
 */
export function decimationStep(count, heightPx, minGapPx = 3) {
  const slots = Math.floor((heightPx || 0) / minGapPx);
  if (!Number.isFinite(slots) || slots <= 0) return 1;
  if (count <= slots) return 1;
  return Math.ceil(count / slots);
}

/** 抽稀下第 i 条是否渲染:首尾恒画,其余按步长取模。 */
export function shouldRenderTick(i, count, step) {
  if (step <= 1) return true;
  return i === 0 || i === count - 1 || i % step === 0;
}
