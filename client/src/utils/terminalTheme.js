// R38：内置终端配色跟随 GUI 主题。
//
// 这里只做一件事：把「当前主题」合成成 xterm 的 ITheme 对象，并提供一个
// 「主题可能变了」的订阅信号。抽成独立模块的理由是 TerminalPanel.jsx（JSX）
// 进不了 node，抽出来纯函数才可单测。
//
// 契约：.devflow/INTERFACE-20260912-theme-usage.md §A（色值表、6 槽覆盖规则、
// 色值文法、对比度兜底），值逐字对齐，不得自由发挥。
//
// 两条实测出来的硬约束（不是风格偏好）：
// ① 非法色值绝不能透传给 xterm —— 最小实验 S3：xterm 对非法值不抛异常、静默
//    回落成白色前景，浅色底上等于隐形。故逐槽「文法白名单 + 回落常量」是必需机制。
// ② xterm 的 term.options.theme 按引用比较 —— 原地改再赋回不生效（S5），赋新对象
//    才生效（S6）。故本模块每次调用都返回新对象（不变量，见 resolveTerminalTheme）。
//
// 顶层不得触碰 document/window（纯函数要能在 node 下 import）。
import { resolveSkinMode, subscribeSkin } from './skins.js';

/** §A.5：与 --font-mono（index.css @theme）逐字一致。 */
export const TERMINAL_FONT_FAMILY = "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace";
/** §A.5：与 CodeBlock.jsx 的 text-[13px] 一致。字距 -0.01em 无法用 xterm 的整数 px 表达，本批不设。 */
export const TERMINAL_FONT_SIZE = 13;

/** §A.1 常量基座：22 键，浅/深两套不同调色板（ANSI 16 槽的唯一来源）。 */
export const TERMINAL_THEME_BASE = Object.freeze({
  light: Object.freeze({
    background: '#FFFFFF', foreground: '#1A1A1A', cursor: '#1A1A1A', cursorAccent: '#FFFFFF',
    selectionBackground: 'rgba(0,0,0,0.16)', selectionInactiveBackground: 'rgba(0,0,0,0.12)',
    black: '#24292F', red: '#C0392B', green: '#1A7F37', yellow: '#8A6100', blue: '#0B5FBF',
    magenta: '#7B2FBF', cyan: '#0E6E75', white: '#6E7781',
    brightBlack: '#57606A', brightRed: '#A40E26', brightGreen: '#116329', brightYellow: '#7A5200',
    brightBlue: '#0550AE', brightMagenta: '#6639BA', brightCyan: '#0A5F6B', brightWhite: '#24292F',
  }),
  dark: Object.freeze({
    background: '#1A1A1B', foreground: '#F5F5F6', cursor: '#F5F5F6', cursorAccent: '#1A1A1B',
    selectionBackground: 'rgba(255,255,255,0.20)', selectionInactiveBackground: 'rgba(255,255,255,0.14)',
    black: '#808A96', red: '#FF7B72', green: '#3FB950', yellow: '#D29922', blue: '#58A6FF',
    magenta: '#BC8CFF', cyan: '#39C5CF', white: '#B1BAC4',
    brightBlack: '#909AA6', brightRed: '#FFA198', brightGreen: '#56D364', brightYellow: '#E3B341',
    brightBlue: '#79C0FF', brightMagenta: '#D2A8FF', brightCyan: '#56D4DD', brightWhite: '#F0F6FC',
  }),
});

/** §A.7 阈值表（全局唯一，不得再出现第二组数字）。 */
const CURSOR_MIN_CONTRAST = 3.0;
const SELECTION_ALPHA_MIN = 0.10;
const SELECTION_ALPHA_MAX = 0.60;

// ── §A.6 色值文法白名单 ──────────────────────────────────────────────
// 命名色/var()/color-mix()/currentColor/含 ; } @ /* url( 的值一律拒绝（回落常量）。
const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB_RE = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i;
const RGBA_RE = /^rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(0|1|0?\.\d+|1\.0*)\s*\)$/i;
const HSL_RE = /^hsl\(\s*(\d{1,3})\s*,\s*(\d{1,3})%\s*,\s*(\d{1,3})%\s*\)$/i;
const HSLA_RE = /^hsla\(\s*(\d{1,3})\s*,\s*(\d{1,3})%\s*,\s*(\d{1,3})%\s*,\s*(0|1|0?\.\d+|1\.0*)\s*\)$/i;
const inRange = (n, lo, hi) => Number.isFinite(n) && n >= lo && n <= hi;

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const t = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(hp) % 6];
  const m = l - c / 2;
  return { r: Math.round((t[0] + m) * 255), g: Math.round((t[1] + m) * 255), b: Math.round((t[2] + m) * 255) };
}

/** 过文法则返回 {r,g,b,a}，否则 null。文法即白名单，顺带给出 alpha（selection 的 α 约束要用）。 */
function parseColorValue(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v) return null;
  if (HEX_RE.test(v)) {
    let h = v.slice(1);
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    return {
      r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    };
  }
  let m = v.match(RGB_RE);
  if (m) {
    const [r, g, b] = [+m[1], +m[2], +m[3]];
    return inRange(r, 0, 255) && inRange(g, 0, 255) && inRange(b, 0, 255) ? { r, g, b, a: 1 } : null;
  }
  m = v.match(RGBA_RE);
  if (m) {
    const [r, g, b, a] = [+m[1], +m[2], +m[3], +m[4]];
    return inRange(r, 0, 255) && inRange(g, 0, 255) && inRange(b, 0, 255) && inRange(a, 0, 1)
      ? { r, g, b, a } : null;
  }
  m = v.match(HSL_RE);
  if (m) {
    const [h, s, l] = [+m[1], +m[2] / 100, +m[3] / 100];
    return inRange(h, 0, 360) && inRange(+m[2], 0, 100) && inRange(+m[3], 0, 100)
      ? { ...hslToRgb(h, s, l), a: 1 } : null;
  }
  m = v.match(HSLA_RE);
  if (m) {
    const [h, s, l, a] = [+m[1], +m[2] / 100, +m[3] / 100, +m[4]];
    return inRange(h, 0, 360) && inRange(+m[2], 0, 100) && inRange(+m[3], 0, 100) && inRange(a, 0, 1)
      ? { ...hslToRgb(h, s, l), a } : null;
  }
  return null;
}

// ── §A.7 对比度（WCAG 2.x；带 alpha 的先 source-over 合成） ──────────────
const compositeOver = (fg, bg) => ({
  r: fg.r * fg.a + bg.r * (1 - fg.a),
  g: fg.g * fg.a + bg.g * (1 - fg.a),
  b: fg.b * fg.a + bg.b * (1 - fg.a),
  a: 1,
});

function luminance({ r, g, b }) {
  const f = (value) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** CR(c1, c2)；任一侧不可解析（理论上进不来）返回 0，调用方自然走回落分支。 */
function contrastRatio(c1, c2) {
  const a = parseColorValue(c1);
  const b = parseColorValue(c2);
  if (!a || !b) return 0;
  const x = a.a < 1 ? compositeOver(a, b) : a;
  const y = b.a < 1 ? compositeOver(b, a) : b;
  const lx = luminance(x);
  const ly = luminance(y);
  return (Math.max(lx, ly) + 0.05) / (Math.min(lx, ly) + 0.05);
}

/** §A.2 的 6 个可被 token 覆盖的槽 → CSS 自定义属性名（唯一真相）。 */
const SLOT_TO_TOKEN = {
  background: '--color-canvas',
  foreground: '--color-ink',
  cursorAccent: '--color-canvas',
  selectionBackground: '--color-accent-muted',
  selectionInactiveBackground: '--color-accent-subtle',
  cursor: '--color-accent',
};

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * §A.2 纯函数：常量基座 + 6 槽 token 覆盖（16 个 ANSI 槽恒取常量）。
 * 任何输入都不抛；非法/缺失/空值逐槽回落。**每次调用返回新对象**（xterm 按引用比较）。
 */
export function resolveTerminalTheme(input) {
  const mode = isPlainObject(input) && input.mode === 'dark' ? 'dark' : 'light';
  const base = TERMINAL_THEME_BASE[mode];
  const tokens = isPlainObject(input) && isPlainObject(input.tokens) ? input.tokens : {};

  // 取 token 值：非字符串/空/不过文法 → 回落基座（非法值绝不透传给 xterm，见文件头 ①）
  const pick = (name, fallback) => {
    const value = tokens[name];
    return parseColorValue(value) ? value.trim() : fallback;
  };
  // selection 专用：α 越界（仓内真实触发点：:root 默认浅色 --color-accent-subtle α=0.06）同样回落
  const pickSelection = (name, fallback) => {
    const value = tokens[name];
    const parsed = parseColorValue(value);
    if (!parsed || parsed.a < SELECTION_ALPHA_MIN || parsed.a > SELECTION_ALPHA_MAX) return fallback;
    return value.trim();
  };

  const background = pick(SLOT_TO_TOKEN.background, base.background);
  const foreground = pick(SLOT_TO_TOKEN.foreground, base.foreground);
  // §A.2 cursor 兜底：accent 对背景的对比度不够（默认深色 2.25 / claude-warm 2.92 / wechat-light 2.04
  // / skyline-light 2.56 四套）时回落 foreground —— 块状光标看不见等于没有光标。
  const accent = pick(SLOT_TO_TOKEN.cursor, base.cursor);
  const cursor = contrastRatio(accent, background) >= CURSOR_MIN_CONTRAST ? accent : foreground;

  return {
    background,
    foreground,
    cursor,
    cursorAccent: background,
    selectionBackground: pickSelection(SLOT_TO_TOKEN.selectionBackground, base.selectionBackground),
    selectionInactiveBackground: pickSelection(SLOT_TO_TOKEN.selectionInactiveBackground, base.selectionInactiveBackground),
    black: base.black, red: base.red, green: base.green, yellow: base.yellow,
    blue: base.blue, magenta: base.magenta, cyan: base.cyan, white: base.white,
    brightBlack: base.brightBlack, brightRed: base.brightRed, brightGreen: base.brightGreen,
    brightYellow: base.brightYellow, brightBlue: base.brightBlue, brightMagenta: base.brightMagenta,
    brightCyan: base.brightCyan, brightWhite: base.brightWhite,
  };
}

/**
 * §A.3 DOM 读取（薄封装）：深浅档口径 = skins.js 的 resolveSkinMode（data-theme → data-theme-system；
 * 非法/缺失一律按「缺席」看 data-theme-system）。**不用画布亮度反推、不查 matchMedia**。
 * root 缺失 / 非浏览器环境 / 读不到值 → 返回 mode 对应的基座（不抛）。
 */
export function readTerminalTheme(root) {
  try {
    const el = root || (typeof document !== 'undefined' ? document.documentElement : null);
    if (!el || typeof el.getAttribute !== 'function') return resolveTerminalTheme();
    const mode = resolveSkinMode(el);
    let tokens = null;
    const view = (el.ownerDocument && el.ownerDocument.defaultView) || (typeof window !== 'undefined' ? window : null);
    if (view && typeof view.getComputedStyle === 'function') {
      const cs = view.getComputedStyle(el);
      tokens = {};
      for (const name of Object.values(SLOT_TO_TOKEN)) tokens[name] = cs.getPropertyValue(name).trim();
    }
    return resolveTerminalTheme({ mode, tokens });
  } catch {
    return resolveTerminalTheme();
  }
}

/**
 * §A.4 订阅「终端配色可能已变」：主题三属性（MutationObserver）+ 皮肤激活/停用（subscribeSkin）。
 *
 * 为什么不观察 <html> 的 style：--ui-zoom / --surface-alpha 也写在那个内联样式上，
 * 观察 style 会在拖滑杆时逐帧重算并推给所有终端（genui/host-theme.ts 记录过同一个坑）。
 * 皮肤只改内联变量、不动属性，MutationObserver 看不到 → 必须另接 subscribeSkin。
 *
 * 契约：onChange 非函数/缺失也不抛，且永远返回可调用的 unsubscribe；unsubscribe 幂等；
 * 同一批变更允许调多次 → 调用方必须幂等。
 */
export function subscribeTerminalTheme(onChange) {
  const cb = typeof onChange === 'function' ? onChange : null;
  let stopped = false;
  const fire = () => {
    if (stopped || !cb) return;
    try { cb(); } catch { /* 订阅方自己的异常不外溢 */ }
  };

  let observer = null;
  try {
    const el = typeof document !== 'undefined' ? document.documentElement : null;
    const MO = typeof MutationObserver !== 'undefined' ? MutationObserver : null;
    if (el && MO) {
      observer = new MO(fire);
      observer.observe(el, {
        attributes: true,
        attributeFilter: ['data-theme', 'data-theme-system', 'data-cgui-theme'],
      });
    }
  } catch { observer = null; }

  let unsubSkin = null;
  try { unsubSkin = subscribeSkin(fire); } catch { unsubSkin = null; }

  let done = false;
  return function unsubscribe() {
    if (done) return;   // 幂等：重复调用不抛
    done = true;
    stopped = true;
    try { if (observer) observer.disconnect(); } catch {}
    try { if (typeof unsubSkin === 'function') unsubSkin(); } catch {}
  };
}
