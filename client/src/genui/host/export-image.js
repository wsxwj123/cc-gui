/**
 * r69 图表导出 —— PNG 层。
 *
 * 三条通道,按节点实际画在什么上面分:
 *  ① `echart` → ECharts 实例自己的 `getDataURL({pixelRatio:2})`(引擎重绘一遍,2 倍图);
 *  ② 页面里已有 `<svg>` 的(chart 的折线/环形、plot、mermaid、diagram)→ 克隆那棵 SVG,
 *     光栅化;
 *  ③ `chart` 的柱状图 → 页面上它是**一堆 div**(GenuiBlock.module.css 的 .barFill 用
 *     背景色+百分比高度画),没有 SVG 可克隆,所以按 `node.data` 现画一张 SVG 再光栅化。
 *
 * ② 的命门是**颜色**:SVG 一旦被序列化成 data URL 塞进 `<img>`,它就是**另一个文档**,
 * 页面的 CSS 规则和 `var(--color-*)` 自定义属性一个都跟不过去 —— 直接序列化出来的图会
 * 掉色/透明。所以序列化前把每个元素的 computed style 内联进 `style` 属性(computed
 * 值已经是求值后的具体颜色,不含 var())。mermaid 自己会往 SVG 里插一段 `<style>`,
 * 那段随克隆一起走,不受影响。
 *
 * 导出路径**零外发**:不 import 任何 action/send 面,不发任何网络请求。
 * base64 手工解码,连"用 fetch 读 data URL"这条捷径都不走 —— 一是没必要,
 * 二是外发探针盯的就是 fetch 调用面,别让本地解码看起来像在发请求。
 *
 * @module genui/host/export-image
 */

/** 内联哪些属性。SVG 上色 + 文字 + foreignObject 里 HTML 标签需要的最小盒模型。
 * 不抄 width/height:让目标文档按同样的字体重新排版比抄死尺寸稳。 */
const INLINE_PROPS = [
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin',
  'marker-start', 'marker-mid', 'marker-end', 'opacity', 'visibility', 'display',
  'color', 'font-family', 'font-size', 'font-weight', 'font-style',
  'text-anchor', 'dominant-baseline', 'text-align', 'line-height', 'letter-spacing',
  'white-space', 'text-decoration', 'background-color', 'border-radius', 'padding',
  'justify-content', 'align-items', 'box-sizing',
];

/** 导出图周围留白(px,1 倍图坐标)。 */
const PAD = 12;

/**
 * 往上找第一层不透明的背景色 —— PNG 的底色。
 * 直接用主题 token 会在"图表被放进带底色的卡片里"时对不上;顺着 DOM 往上问最准,
 * 而且明暗主题自动跟随,不需要在这里写第二份主题判断。
 */
export function surfaceBackground(el) {
  for (let n = el; n instanceof Element; n = n.parentElement) {
    const c = getComputedStyle(n).backgroundColor;
    if (c && c !== 'transparent' && !/,\s*0\s*\)$/.test(c)) return c;
  }
  return '#ffffff';
}

/** 求值一个颜色声明串(可能是 `var(--x)`)。探针必须挂在 body 上:WebKit 对游离元素的
 * getComputedStyle 返回空(EChartNode.tsx 的 usedColor 同一条理由,那份没导出,不动上游)。 */
function usedColor(decl, fallback) {
  const probe = document.createElement('span');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = 'position:fixed;left:-100000px;top:0;pointer-events:none';
  probe.style.color = decl;
  document.body.appendChild(probe);
  const used = getComputedStyle(probe).color.trim();
  probe.remove();
  return used === '' ? fallback : used;
}

/** base64 → Blob,不经 fetch。 */
function base64ToBlob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

/** 把 live 树上每个元素的 computed style 内联到 clone 树的同位元素上。
 * cloneNode(true) 保序,所以两棵树的 querySelectorAll('*') 一一对应。 */
function inlineComputedStyles(live, clone) {
  const a = [live, ...live.querySelectorAll('*')];
  const b = [clone, ...clone.querySelectorAll('*')];
  for (let i = 0; i < a.length && i < b.length; i++) {
    if (b[i].tagName === 'STYLE' || b[i].tagName === 'style') continue;
    const cs = getComputedStyle(a[i]);
    let decl = '';
    for (const p of INLINE_PROPS) {
      const v = cs.getPropertyValue(p);
      if (v === '') continue;
      // display / visibility 只抄"藏起来"那一端。整个抄过去会把 computed 的
      // `display:block` 盖到 SVG 图元上,反而改变渲染;而 `fill:none`(折线不填充)
      // 这类"none 才是正确值"的属性必须原样抄 —— 漏了折线会被填成一坨实心色块。
      if ((p === 'display' && v !== 'none') || (p === 'visibility' && v !== 'hidden')) continue;
      decl += `${p}:${v};`;
    }
    b[i].setAttribute('style', decl + (b[i].getAttribute('style') ?? ''));
  }
}

/** SVG 元素 → PNG Blob(2 倍图,带底色与留白)。 */
async function svgToPng(svg, bg, scale) {
  const rect = svg.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width || svg.clientWidth || 480));
  const h = Math.max(1, Math.round(rect.height || svg.clientHeight || 240));
  const clone = svg.cloneNode(true);
  inlineComputedStyles(svg, clone);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  clone.setAttribute('width', String(w));
  clone.setAttribute('height', String(h));
  if (clone.getAttribute('viewBox') === null) clone.setAttribute('viewBox', `0 0 ${w} ${h}`);
  const xml = new XMLSerializer().serializeToString(clone);
  return rasterize(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`, w, h, bg, scale);
}

/** data URL → 画布 → PNG Blob。 */
function rasterize(url, w, h, bg, scale) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round((w + PAD * 2) * scale);
      canvas.height = Math.round((h + PAD * 2) * scale);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, PAD * scale, PAD * scale, w * scale, h * scale);
      canvas.toBlob((blob) => (blob === null ? reject(new Error('画布导出失败')) : resolve(blob)), 'image/png');
    };
    img.onerror = () => reject(new Error('图形光栅化失败'));
    img.src = url;
  });
}

const BARS_W = 520;
const BARS_PLOT_H = 150;
const BARS_LABEL_H = 22;

/** XML 文本转义(标签/数值都是模型输出,直接拼进 SVG 会破坏结构)。 */
const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

/**
 * 柱状 chart → SVG 文本。页面上的柱子是 div,没得克隆,只能按数据现画。
 * 取色与取值口径**照 charts.tsx**:显式 color 优先,否则按下标取固定色板;
 * 负值压到 0 高(和屏幕上一样),数值标注照打。
 */
function barsSvg(node, palette, ink) {
  const groups = Array.isArray(node.series) && node.series.length > 0 && Array.isArray(node.series[0]?.data)
    ? node.series
    : null;
  const labels = groups !== null
    ? groups[0].data.map((d) => d?.label ?? '')
    : (node.data ?? []).map((d) => d?.label ?? '');
  const cols = groups !== null
    ? labels.map((_, i) => groups.map((s, si) => ({ v: Number(s?.data?.[i]?.value) || 0, color: s?.color ?? palette[si % palette.length] })))
    : (node.data ?? []).map((d, i) => [{ v: Number(d?.value) || 0, color: d?.color ?? palette[i % palette.length] }]);
  const max = Math.max(...cols.flat().map((b) => b.v), 1);
  const n = Math.max(cols.length, 1);
  const slot = (BARS_W - 16) / n;
  const parts = [];
  for (const p of [0, 25, 50, 75, 100]) {
    const y = BARS_PLOT_H - (p / 100) * (BARS_PLOT_H - 18);
    parts.push(`<line x1="8" x2="${BARS_W - 8}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${xml(ink.grid)}" stroke-width="1"/>`);
  }
  cols.forEach((bars, i) => {
    const bw = Math.max(3, (slot - 10) / bars.length);
    bars.forEach((b, k) => {
      const h = Math.min((Math.max(0, b.v) / max) * (BARS_PLOT_H - 18), BARS_PLOT_H - 18);
      const x = 8 + i * slot + 5 + k * bw;
      parts.push(`<rect x="${x.toFixed(1)}" y="${(BARS_PLOT_H - h).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="${xml(b.color)}"/>`);
      parts.push(`<text x="${(x + (bw - 2) / 2).toFixed(1)}" y="${(BARS_PLOT_H - h - 4).toFixed(1)}" text-anchor="middle" font-size="10" fill="${xml(ink.value)}">${xml(b.v)}</text>`);
    });
    parts.push(`<text x="${(8 + i * slot + slot / 2).toFixed(1)}" y="${BARS_PLOT_H + 14}" text-anchor="middle" font-size="11" fill="${xml(ink.label)}">${xml(labels[i] ?? '')}</text>`);
  });
  const h = BARS_PLOT_H + BARS_LABEL_H;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${BARS_W}" height="${h}" viewBox="0 0 ${BARS_W} ${h}" font-family="system-ui,-apple-system,'PingFang SC',sans-serif">${parts.join('')}</svg>`;
}

/** charts.tsx 的固定色板(逐字对齐 CHART_COLORS —— 那边是 .tsx,裸 import 进不来)。 */
const PALETTE_TOKENS = [
  '--dsw-static-deepseek-400', '--dsw-static-green-400', '--dsw-static-amber-400', '--dsw-static-red-400',
  '--dsw-static-blue-450', '--dsw-static-deepseek-450', '--dsw-static-neutral-bluish-400', '--dsw-static-deepseek-300',
];

/**
 * 节点 → PNG Blob。`container` 是该节点在页面上的容器元素。
 * 拿不到可导出的图形时抛错,由调用方给出可读提示。
 */
export async function nodePngBlob(container, node, { scale = 2 } = {}) {
  const bg = surfaceBackground(container);
  if (node?.type === 'echart') {
    const { getInstanceByDom } = await import('echarts');
    for (const el of container.querySelectorAll('div')) {
      const inst = getInstanceByDom(el);
      if (inst) {
        const url = inst.getDataURL({ type: 'png', pixelRatio: scale, backgroundColor: bg });
        return base64ToBlob(url.slice(url.indexOf(',') + 1), 'image/png');
      }
    }
    throw new Error('图表尚未渲染完成');
  }
  const svg = container.querySelector('svg');
  if (svg !== null) return svgToPng(svg, bg, scale);
  if (node?.type === 'chart') {
    const palette = PALETTE_TOKENS.map((t) => usedColor(`var(${t})`, '#4f8ef7'));
    const ink = {
      grid: usedColor('var(--dsw-alias-border-l1)', 'rgba(128,128,128,0.25)'),
      label: usedColor('var(--dsw-alias-label-tertiary)', '#888'),
      value: usedColor('var(--dsw-alias-label-secondary)', '#666'),
    };
    const text = barsSvg(node, palette, ink);
    return rasterize(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`, BARS_W, BARS_PLOT_H + BARS_LABEL_H, bg, scale);
  }
  throw new Error('该图形暂不支持导出图片');
}
