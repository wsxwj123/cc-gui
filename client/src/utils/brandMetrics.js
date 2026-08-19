// r13-p2-15:字标光学对齐 —— 按【实际渲染字体】度量算图标补偿量。
// 背景:字标字体(Newsreader)走 Google Fonts 网络加载;加载成功与回落 Georgia 的
// 上/下伸部度量不同,任何固定 px 补偿都会在另一种情况下偏(且顶栏底缘裁切会把
// 向下位移的字底切掉)。所以:文字零位移(靠 line-height 留足余量),补偿全落在图标上,
// 数值由本模块在字体就绪后实测写入 CSS 变量 --brand-optical-dy。

/** 纯函数:由字体度量算「字形视觉中心相对 line box 中心」的偏移(px,正=偏下)。 */
export function opticalDy({ lineBoxH, fontAscent, fontDescent, actualAscent, actualDescent }) {
  if (!(lineBoxH > 0)) return 0;
  const baselineFromTop = (lineBoxH - (fontAscent + fontDescent)) / 2 + fontAscent;
  const glyphCenterFromTop = baselineFromTop - (actualAscent - actualDescent) / 2;
  const dy = glyphCenterFromTop - lineBoxH / 2;
  // 兜底:异常度量(缺字体/度量为 0)不产生离谱位移
  return Number.isFinite(dy) && Math.abs(dy) <= 6 ? dy : 0;
}

/** 量当前 DOM 里的字标并写入 --brand-optical-dy(图标据此上/下移与字形对齐)。 */
export function applyBrandOptical(doc = document) {
  const el = doc.querySelector('.cgui-brand-name');
  if (!el || typeof doc.createElement !== 'function') return null;
  try {
    const cs = getComputedStyle(el);
    const ctx = doc.createElement('canvas').getContext('2d');
    if (!ctx) return null;
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const m = ctx.measureText(el.textContent || 'CC-GUI');
    const dy = opticalDy({
      lineBoxH: parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.35,
      fontAscent: m.fontBoundingBoxAscent,
      fontDescent: m.fontBoundingBoxDescent,
      actualAscent: m.actualBoundingBoxAscent,
      actualDescent: m.actualBoundingBoxDescent,
    });
    doc.documentElement.style.setProperty('--brand-optical-dy', `${dy.toFixed(2)}px`);
    return dy;
  } catch { return null; }
}

/** 挂载:字体就绪后量一次,字体再变(fonts.ready 二次 resolve/窗口 resize)重量。 */
export function watchBrandOptical() {
  const run = () => applyBrandOptical();
  run();
  try { document.fonts?.ready?.then(run); } catch {}
  window.addEventListener('resize', run);
  return () => window.removeEventListener('resize', run);
}
