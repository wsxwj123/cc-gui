// 输入框里光标在第几个显示行(r192)。上下键翻输入历史按「光标在第一 / 最后一个显示行」判断,
// 显示行既包括手动换行的行,也包括自动折出来的行。
//
// 量法:一个看不见的镜像元素,复制输入框里影响折行的样式,宽度取输入框的内容宽度;
// 镜像里放「光标前的文字 + 一个装着光标后文字的 span」,span 的 offsetTop 就是光标所在行的顶。
// 位置都从镜像里量(offsetTop),不拿计算样式里的行高去除:行高可能是 normal,界面又有整体缩放,
// 混用两种量法会差一个倍数。界面缩放加在 html 上,镜像挂在 body 下,和输入框处在同一个缩放环境;
// 不插进输入框的父元素(那是 React 管的节点)。镜像只建一个,反复用,每次用完清空。
//
// 已知边界:光标正好在自动折行的断点上时,量出来算下一行(偶尔多按一次上键)。

const MIRRORED_STYLE_PROPS = [
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'fontStretch',
  'letterSpacing', 'wordSpacing', 'lineHeight', 'textTransform', 'textIndent',
  'tabSize', 'wordBreak', 'overflowWrap',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
];

// 两个位置的 offsetTop 相差不到这个值就算同一行(亚像素取整的余量;一行至少十几像素)。
const SAME_LINE_TOLERANCE = 2;

let mirrorEl = null;

function ensureMirror() {
  const parent = document.body;
  if (!parent) return null;
  if (!mirrorEl) {
    mirrorEl = document.createElement('div');
    mirrorEl.setAttribute('aria-hidden', 'true');
    const s = mirrorEl.style;
    s.position = 'absolute';
    s.visibility = 'hidden';
    s.pointerEvents = 'none';
    s.left = '-10000px';
    s.top = '0';
    s.height = 'auto';
    s.overflow = 'hidden';
    s.boxSizing = 'border-box';
    s.border = '0';
    s.margin = '0';
    s.whiteSpace = 'pre-wrap';
  }
  if (mirrorEl.parentNode !== parent) parent.appendChild(mirrorEl);
  return mirrorEl;
}

// 量 textarea 当前选区:起点是否在第一显示行、终点是否在最后显示行。
// 量不出来(不在页面里、宽度为 0、没有排版结果)返回 null,调用方退回最保守的判据。
export function measureCaretLines(textarea) {
  if (!textarea || typeof document === 'undefined' || !textarea.isConnected) return null;
  const width = textarea.clientWidth;
  if (!(width > 0)) return null;
  const mirror = ensureMirror();
  if (!mirror) return null;
  try {
    const cs = getComputedStyle(textarea);
    for (const prop of MIRRORED_STYLE_PROPS) mirror.style[prop] = cs[prop];
    mirror.style.width = `${width}px`;
    const value = textarea.value;
    const topAt = (pos) => {
      mirror.textContent = '';
      mirror.appendChild(document.createTextNode(value.slice(0, pos)));
      const marker = document.createElement('span');
      // 光标后没有字(含文本以换行结尾)时放一个普通句点,才量得到最后那一行。
      marker.textContent = value.slice(pos) || '.';
      mirror.appendChild(marker);
      return marker.offsetTop;
    };
    const startTop = topAt(textarea.selectionStart);
    const endTop = topAt(textarea.selectionEnd);
    const firstTop = topAt(0);
    const lastTop = topAt(value.length);
    if (![startTop, endTop, firstTop, lastTop].every(Number.isFinite)) return null;
    if (mirror.offsetHeight <= 0) return null;
    return {
      onFirstLine: Math.abs(startTop - firstTop) < SAME_LINE_TOLERANCE,
      onLastLine: Math.abs(endTop - lastTop) < SAME_LINE_TOLERANCE,
    };
  } catch {
    return null;
  } finally {
    mirror.textContent = '';
  }
}

// 纯函数(不碰页面):按光标所在显示行判断这次上 / 下键能不能交给输入历史。
// lines 为 measureCaretLines 的结果;为 null 时退回最保守的判据:
// 上键要选区起点在最开头,下键要选区终点在最末尾。
// 文本为空或只有一个显示行时,两个条件天然都成立。
export function caretLineAllowsHistory({ key, lines, selectionStart, selectionEnd, textLength }) {
  if (key === 'ArrowUp') {
    if (lines) return !!lines.onFirstLine;
    return selectionStart === 0;
  }
  if (key === 'ArrowDown') {
    if (lines) return !!lines.onLastLine;
    return selectionEnd === textLength;
  }
  return false;
}
