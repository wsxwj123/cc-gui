// TU-* 套件 helper 层（R38 终端配色 / R39 终端归属行 / R40 刷新逐家结果折叠 / R41 订阅卡条件显示）。
//
// 黑盒原则：只用契约公布的入口 —— HTTP 路由、契约点名的模块与导出、公开文案/role/data-*、
// xterm 自己的渲染面。不 import 其他 acceptance 套件的 helpers（自包含）。
//
// 契约来源：`.devflow/BRIEF-20260912-theme-usage.md`（需求唯一真相源）+
// `.devflow/INTERFACE-20260912-theme-usage.md`（§A/§B/§C/D，接口约定）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect } from '@playwright/test';
import { ensureFixtureManifest, suitePath, dataRoot } from './tu-fixtures.mjs';

export { ensureFixtureManifest, suitePath, dataRoot };

const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** worktree 根：tests/acceptance/<suite>/ → 上三级。 */
export const WORKTREE = path.resolve(suiteDir, '..', '..', '..');

export class EnvironmentBlocked extends Error {
  constructor(message) {
    super(`ENVIRONMENT_BLOCKED: ${message}`);
    this.name = 'EnvironmentBlocked';
  }
}

function rejectSecretFields(value, prefix = '') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const at = prefix ? `${prefix}.${key}` : key;
    if (/(secret|password|cookie|authorization|api.?key|resume.?token)/i.test(key)) {
      throw new EnvironmentBlocked(`fixture manifest must not contain credential field ${at}`);
    }
    rejectSecretFields(child, at);
  }
}

/** 环境守卫：只允许回环、拒绝 6677/6689 用户实例、夹具数据根必须在本套件 .artifacts 下。 */
export function getRuntime() {
  const raw = process.env.BASE_URL;
  if (!raw) throw new EnvironmentBlocked('set BASE_URL to the isolated test instance');
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new EnvironmentBlocked('BASE_URL must use http or https');
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new EnvironmentBlocked('BASE_URL must be loopback; remote and user instances are refused');
  }
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if ([6677, 6689].includes(port)) throw new EnvironmentBlocked('ports 6677 and 6689 are protected user instances');

  const manifest = ensureFixtureManifest();
  rejectSecretFields(manifest);
  const root = path.resolve(manifest.dataRoot || '');
  const allowed = suitePath('.artifacts');
  if (!manifest.dataRoot || (root !== allowed && !root.startsWith(`${allowed}${path.sep}`))) {
    throw new EnvironmentBlocked('fixture dataRoot must be inside theme-usage-20260912/.artifacts');
  }
  return { baseURL: url.toString().replace(/\/$/, ''), manifest };
}

export function uniqueId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`.slice(0, 64);
}

// ---------------------------------------------------------------------------
// 契约点名的模块（R38：client/src/utils/terminalTheme.js）
// ---------------------------------------------------------------------------

/**
 * Node 侧载入契约点名的模块并校验导出。
 * 模块/导出缺失 = 产品未实现（普通报错，不是环境问题），消息里点名缺什么。
 */
export async function requireTerminalThemeModule() {
  const rel = 'client/src/utils/terminalTheme.js';
  const abs = path.resolve(WORKTREE, rel);
  if (!fs.existsSync(abs)) {
    throw new Error(`契约模块 ${rel} 不存在 —— R38（终端配色跟随主题）尚未按 §A 实现该模块`);
  }
  let mod;
  try {
    mod = await import(pathToFileURL(abs).href);
  } catch (error) {
    throw new Error(`契约模块不可用（${rel}）：${error.message}`);
  }
  const required = [
    'TERMINAL_THEME_BASE', 'resolveTerminalTheme', 'readTerminalTheme', 'subscribeTerminalTheme',
    'TERMINAL_FONT_FAMILY', 'TERMINAL_FONT_SIZE',
  ];
  const missing = required.filter(name => mod[name] === undefined);
  if (missing.length) throw new Error(`契约模块 ${rel} 缺少导出：${missing.join(', ')}`);
  return mod;
}

// ---------------------------------------------------------------------------
// §A.5 字体常量（合同逐字值）
// ---------------------------------------------------------------------------

export const TERMINAL_FONT_FAMILY = "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace";
export const TERMINAL_FONT_SIZE = 13;

/** §A.1 ThemeObject 的 22 个键（顺序即合同表顺序）。 */
export const THEME_KEYS = [
  'background', 'foreground', 'cursor', 'cursorAccent',
  'selectionBackground', 'selectionInactiveBackground',
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
  'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
];
export const ANSI_KEYS = THEME_KEYS.slice(6);
export const TOKEN_SLOT_KEYS = THEME_KEYS.slice(0, 6);

/** §A.1 定稿值（合同表，测试以此为对比度基准；与合同表逐字）。 */
export const CONTRACT_BASE = {
  light: {
    background: '#FFFFFF', foreground: '#1A1A1A', cursor: '#1A1A1A', cursorAccent: '#FFFFFF',
    selectionBackground: 'rgba(0,0,0,0.16)', selectionInactiveBackground: 'rgba(0,0,0,0.12)',
    black: '#24292F', red: '#C0392B', green: '#1A7F37', yellow: '#8A6100', blue: '#0B5FBF',
    magenta: '#7B2FBF', cyan: '#0E6E75', white: '#6E7781',
    brightBlack: '#57606A', brightRed: '#A40E26', brightGreen: '#116329', brightYellow: '#7A5200',
    brightBlue: '#0550AE', brightMagenta: '#6639BA', brightCyan: '#0A5F6B', brightWhite: '#24292F',
  },
  dark: {
    background: '#1A1A1B', foreground: '#F5F5F6', cursor: '#F5F5F6', cursorAccent: '#1A1A1B',
    selectionBackground: 'rgba(255,255,255,0.20)', selectionInactiveBackground: 'rgba(255,255,255,0.14)',
    black: '#808A96', red: '#FF7B72', green: '#3FB950', yellow: '#D29922', blue: '#58A6FF',
    magenta: '#BC8CFF', cyan: '#39C5CF', white: '#B1BAC4',
    brightBlack: '#909AA6', brightRed: '#FFA198', brightGreen: '#56D364', brightYellow: '#E3B341',
    brightBlue: '#79C0FF', brightMagenta: '#D2A8FF', brightCyan: '#56D4DD', brightWhite: '#F0F6FC',
  },
};

/** §A.7 阈值表（全局唯一，不得再出现第二组数字）。 */
export const THRESHOLD = {
  foregroundBackground: 4.5,   // 判据 1
  ansi: 3.0,                   // 判据 2
  cursorBackground: 3.0,       // 判据 3
  cursorAccentCursor: 3.0,     // 判据 4
  selectionContrast: 1.20,     // 判据 5（**只判激活态**）
  selectionText: 3.0,          // 判据 6（激活态与失焦态都判）
  selectionAlphaMin: 0.10,     // 判据 7
  selectionAlphaMax: 0.60,     // 判据 7
};

/** §A.7 常量槽的两套参考底色。 */
export const REFERENCE_BACKGROUNDS = {
  light: ['#FFFFFF', '#FAF7F2'],
  dark: ['#1A1A1B', '#29251F'],
};

/** §A.7 验证口径点名的三套预设（canvas / ink / accent）。 */
export const TOKEN_PRESETS = [
  { name: 'claude-warm', mode: 'light', tokens: { '--color-canvas': '#FAF7F2', '--color-ink': '#1A1A1A', '--color-accent': '#D97757', '--color-accent-muted': 'rgba(217,119,87,0.28)', '--color-accent-subtle': 'rgba(217,119,87,0.12)' } },
  { name: 'github-light', mode: 'light', tokens: { '--color-canvas': '#FFFFFF', '--color-ink': '#24292F', '--color-accent': '#0969DA', '--color-accent-muted': 'rgba(9,105,218,0.20)', '--color-accent-subtle': 'rgba(9,105,218,0.10)' } },
  { name: 'github-dark', mode: 'dark', tokens: { '--color-canvas': '#0D1117', '--color-ink': '#E6EDF3', '--color-accent': '#58A6FF', '--color-accent-muted': 'rgba(88,166,255,0.24)', '--color-accent-subtle': 'rgba(88,166,255,0.12)' } },
];

// ---------------------------------------------------------------------------
// §A.6 色值文法（测试侧独立实现；只断言合同明列的"接受/拒绝"清单）
// ---------------------------------------------------------------------------

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB_RE = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i;
const RGBA_RE = /^rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(0|1|0?\.\d+|1\.0*)\s*\)$/i;
const HSL_RE = /^hsl\(\s*(\d{1,3})\s*,\s*(\d{1,3})%\s*,\s*(\d{1,3})%\s*\)$/i;
const HSLA_RE = /^hsla\(\s*(\d{1,3})\s*,\s*(\d{1,3})%\s*,\s*(\d{1,3})%\s*,\s*(0|1|0?\.\d+|1\.0*)\s*\)$/i;
const inRange = (n, lo, hi) => Number.isFinite(n) && n >= lo && n <= hi;

/** §A.6：值是否通过色值文法（非字符串一律 false）。 */
export function isValidColorValue(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (!v) return false;
  if (HEX_RE.test(v)) return true;
  let m = v.match(RGB_RE);
  if (m) return inRange(+m[1], 0, 255) && inRange(+m[2], 0, 255) && inRange(+m[3], 0, 255);
  m = v.match(RGBA_RE);
  if (m) {
    return inRange(+m[1], 0, 255) && inRange(+m[2], 0, 255) && inRange(+m[3], 0, 255)
      && inRange(+m[4], 0, 1);
  }
  m = v.match(HSL_RE);
  if (m) return inRange(+m[1], 0, 360) && inRange(+m[2], 0, 100) && inRange(+m[3], 0, 100);
  m = v.match(HSLA_RE);
  if (m) {
    return inRange(+m[1], 0, 360) && inRange(+m[2], 0, 100) && inRange(+m[3], 0, 100)
      && inRange(+m[4], 0, 1);
  }
  return false;
}

/** §A.6 明列的"必须回落"输入（逐个断言用）。 */
export const INVALID_COLOR_VALUES = [
  '#FAF7F2;', 'red', 'white', 'transparent', 'var(--x)', 'color-mix(in srgb, red, blue)',
  'currentColor', 'url(#x)', '@media x', '/*x*/', 'rgb(1,2)', 'rgb(300,0,0)', 'hsl(400,50%,50%)',
  'rgba(0,0,0,2)', '', '   ', '##zzz',
];

// ---------------------------------------------------------------------------
// §A.7 颜色与对比度（WCAG 2.x；alpha 先按 source-over 合成到背景）
// ---------------------------------------------------------------------------

/**
 * 解析色值 → `{r,g,b,a}`。
 * 也接受**已经解析过的颜色对象**（`compositeOver` / `selectionOnTop` 的返回值）原样返回 ——
 * 这样"算出来的期望色"可以直接喂给 `sameColor` / `contrastRatio`，不必来回转字符串。
 * 注：这不是放宽判据 —— 比较与阈值仍按同一组数字算。
 */
export function parseColor(value) {
  if (value && typeof value === 'object' && Number.isFinite(value.r) && Number.isFinite(value.g)
    && Number.isFinite(value.b)) {
    return { r: value.r, g: value.g, b: value.b, a: Number.isFinite(value.a) ? value.a : 1 };
  }
  if (typeof value !== 'string') throw new Error(`not a color string: ${JSON.stringify(value)}`);
  const v = value.trim();
  let m = v.match(/^#([0-9a-f]{3,8})$/i);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map(c => c + c).join('');
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return { r, g, b, a };
  }
  m = v.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  m = v.match(/^hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  if (m) {
    const { r, g, b } = hslToRgb(+m[1], +m[2] / 100, +m[3] / 100);
    return { r, g, b, a: m[4] === undefined ? 1 : +m[4] };
  }
  throw new Error(`unparsable color: ${value}`);
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const t = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(hp) % 6];
  const m = l - c / 2;
  return { r: Math.round((t[0] + m) * 255), g: Math.round((t[1] + m) * 255), b: Math.round((t[2] + m) * 255) };
}

/** source-over：把带 alpha 的 fg 合成到不透明 bg 上，得到不透明色。 */
export function compositeOver(fg, bg) {
  const f = parseColor(fg);
  const b = parseColor(bg);
  const mix = (x, y) => x * f.a + y * (1 - f.a);
  return { r: mix(f.r, b.r), g: mix(f.g, b.g), b: mix(f.b, b.b), a: 1 };
}

function luminance({ r, g, b }) {
  const f = (value) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** §A.7 的 CR(c1, c2)：两个入参都必须是不透明色（带 alpha 的先 compositeOver）。 */
export function contrastRatio(c1, c2) {
  const a = typeof c1 === 'string' ? parseColor(c1) : c1;
  const b = typeof c2 === 'string' ? parseColor(c2) : c2;
  expect(a.a, `CR 只接受不透明色：${JSON.stringify(c1)}`).toBe(1);
  expect(b.a, `CR 只接受不透明色：${JSON.stringify(c2)}`).toBe(1);
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** 显示用：把对比度截到 3 位，报错信息里好读。 */
export function cr(c1, c2) {
  return Number(contrastRatio(c1, c2).toFixed(3));
}

/** §A.7：把 rgba 选中色按 source-over 合到背景上，得到判据 5/6 用的 selBg。 */
export function selectionOnTop(selectionColor, background) {
  return compositeOver(selectionColor, background);
}

export function sameColor(a, b) {
  const x = parseColor(a);
  const y = parseColor(b);
  return Math.abs(x.r - y.r) <= 1 && Math.abs(x.g - y.g) <= 1 && Math.abs(x.b - y.b) <= 1
    && Math.abs(x.a - y.a) <= 0.01;
}

// ---------------------------------------------------------------------------
// xterm 渲染面探针（R38 的"实际长什么样"取证）
// ---------------------------------------------------------------------------

/**
 * 读终端**渲染层**的实际配色。取证手段（三条，均为 xterm 自己的公开/稳定产物）：
 *   ① 背景：`.xterm-scrollable-element` 的**行内** style.backgroundColor ——
 *      契约 §F#5 点名该节点（xterm 自己把主题底色写在这里，见 RESEARCH-spike S7）；
 *      `xterm.css` 也把它作为公开选择器写死。
 *   ② 前景/字体：`.xterm-rows` 的计算样式 —— xterm 把自己的注入样式表作用在这一行容器上
 *      （{ color, font-family, font-size }）。
 *   ③ ANSI 16 / 光标 / 选中：解析 xterm 注入的 `<style>` 规则体 —— 那是 xterm 把
 *      app 交给它的 theme 对象**投影后的结果**，等于"渲染时真的会用这些色"。
 *      （选中色读到的是 xterm 自己合成的 opaque 值 = 契约 §A.7 的 selBg。）
 *
 * 边界（如实在 TEST-PLAN / 报告里写明）：这是 xterm DOM 渲染器的产物，不是产品契约锚点；
 * 若 xterm 换渲染器（canvas/webgl）或改类名，本探针失效 —— 失效时抛 EnvironmentBlocked，
 * 不伪装成产品红。
 */
export async function probeTerminalPalette(page) {
  const result = await page.evaluate(() => {
    // 页面上可能有不止一个渲染器元素：主题变化/面板重建时被卸载的那个会留下僵尸节点（它的
    // <style> 已被 dispose 掉，DomRenderer.dispose → _themeStyleElement.remove()）。
    // 所以逐个自证"这台渲染器的注入样式里确实有完整配色规则"，取第一台能自证的；同分时优先可见的那台。
    const candidates = [...document.querySelectorAll('[class*="xterm-dom-renderer-owner-"]')]
      .filter(el => el.isConnected);
    const picked = [];
    for (const el of candidates) {
      const cls = [...el.classList].find(c => c.startsWith('xterm-dom-renderer-owner-'));
      if (!cls) continue;
      const rows = el.querySelector('.xterm-rows');
      if (!rows) continue;
      // 渲染器里有不止一个 <style>（尺寸样式 + 配色样式），必须挑出含配色规则的那一个
      const themeStyle = [...el.querySelectorAll('style')]
        .find(s => (s.textContent || '').includes(`.${cls} .xterm-fg-15`));
      if (!themeStyle) continue;                              // 自证：这份样式里真有全部配色规则
      const box = el.closest('.xterm')?.getBoundingClientRect();
      picked.push({ el, cls, css: themeStyle.textContent, rows, visible: Boolean(box && box.width > 0 && box.height > 0) });
    }
    if (!picked.length) {
      return { missing: `没有一台自带完整配色的 xterm 渲染器（页面上有 ${candidates.length} 个候选）—— 不是 DOM 渲染器？或都已被卸载？` };
    }
    const { cls: ownerClass, css, rows } = picked.find(x => x.visible) || picked[picked.length - 1];
    const prefix = `.${ownerClass}`;
    const owner = picked.find(x => x.cls === ownerClass).el;
    const rules = [];
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(css))) rules.push({ sel: m[1].trim(), body: m[2] });
    const ruleBody = (selector) => {
      const hit = rules.find(r => r.sel === selector);
      return hit ? hit.body : null;
    };
    const prop = (body, name) => {
      if (!body) return null;
      const hit = body.match(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, 'i'));
      return hit ? hit[1].trim() : null;
    };

    const rowsBody = ruleBody(`${prefix} .xterm-rows`);
    const ansi = [];
    for (let i = 0; i < 16; i += 1) ansi.push(prop(ruleBody(`${prefix} .xterm-fg-${i}`), 'color'));
    const cursorBody = ruleBody(`${prefix} .xterm-rows .xterm-cursor.xterm-cursor-block`);
    const selectionRules = rules.filter(r => r.sel.includes('.xterm-selection') && r.sel.endsWith('div'));
    const scope = owner.closest('.xterm') || document;
    const scrollable = scope.querySelector('.xterm-scrollable-element')
      || document.querySelector('.xterm-scrollable-element');

    if (ansi.some(v => !v)) return { missing: `注入样式里读不到全部 16 条 ANSI 规则（读到 ${ansi.filter(Boolean).length}/16）` };
    if (!prop(cursorBody, 'background-color') || !prop(cursorBody, 'color')) {
      return { missing: '注入样式里读不到块状光标规则（background-color/color）' };
    }
    if (selectionRules.length < 2) {
      return { missing: `注入样式里只找到 ${selectionRules.length} 条选中色规则（应有激活/失焦两条）` };
    }
    if (!scrollable) return { missing: '找不到 .xterm-scrollable-element（主题底色写在这里）' };

    return {
      missing: null,
      ownerClass: prefix,
      backgroundInline: scrollable ? (scrollable.style.backgroundColor || '') : '',
      backgroundComputed: scrollable ? getComputedStyle(scrollable).backgroundColor : '',
      foreground: getComputedStyle(rows).color,
      fontFamily: getComputedStyle(rows).fontFamily,
      fontSizePx: getComputedStyle(rows).fontSize,
      rowsRuleColor: prop(rowsBody, 'color'),
      rowsRuleFontFamily: prop(rowsBody, 'font-family'),
      ansi,
      cursor: prop(cursorBody, 'background-color'),
      cursorAccent: prop(cursorBody, 'color'),
      selectionActive: selectionRules[0] ? prop(selectionRules[0].body, 'background-color') : null,
      selectionInactive: selectionRules[1] ? prop(selectionRules[1].body, 'background-color') : null,
      selectionRuleCount: selectionRules.length,
    };
  });
  if (result.missing) {
    throw new EnvironmentBlocked(`读不到终端渲染面的配色（${result.missing}）—— 本探针依赖 xterm DOM 渲染器`);
  }
  return result;
}

/**
 * 轮询等终端渲染面满足条件（不用固定等待）。
 * **谓词契约（唯一）**：`predicate(palette)` 达标时返回 `true`，不达标时返回**失败原因字符串**
 * （会出现在超时报错里）。因此断言是 `.toBe(true)` —— 返回字符串/其它值一律算没达标，判据不放宽。
 * 读不到渲染面**不立刻判死**：主题切换时终端会被卸载重建，中间可能一瞬间没有活着的渲染器，
 * 这种情况重试即可；一直读不到则超时报错，错误里带上 ENV 原因（不会伪装成产品红）。
 */
export async function pollPalette(page, predicate, message, timeout = 15_000) {
  await expect.poll(async () => {
    try {
      const verdict = predicate(await probeTerminalPalette(page));
      return verdict === true ? true : String(verdict);
    } catch (error) {
      return error instanceof EnvironmentBlocked ? `ENV: ${error.message}` : `读不到：${error.message}`;
    }
  }, { timeout, message }).toBe(true);
}

/** 终端渲染面的摘要（写进断言消息里，失败时一眼看出实际是哪几个色不对）。 */
export function describePalette(palette) {
  return JSON.stringify({
    bg: palette.backgroundInline || palette.backgroundComputed,
    fg: palette.foreground,
    cursor: palette.cursor,
    cursorAccent: palette.cursorAccent,
    selActive: palette.selectionActive,
    selInactive: palette.selectionInactive,
    ansi: palette.ansi,
  });
}

// ---------------------------------------------------------------------------
// 公开 UI 导航（只认 role/text/data-*，与真实用户路径一致）
// ---------------------------------------------------------------------------

const OVERLAY_DISMISS_BUTTONS = ['关闭指引', '跳过', '稍后'];

export async function dismissTransientOverlays(page) {
  for (const name of OVERLAY_DISMISS_BUTTONS) {
    const button = page.getByRole('button', { name, exact: true });
    if ((await button.count()) && (await button.first().isVisible().catch(() => false))) {
      await button.first().click().catch(() => {});
      await page.waitForTimeout(300);
    }
  }
}

export async function clickThroughOverlays(page, target, { attempts = 4, timeout = 4_000 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await dismissTransientOverlays(page);
    try {
      await target.click({ timeout });
      return;
    } catch (error) {
      if (attempt === attempts - 1) throw error;
      await page.waitForTimeout(300);
    }
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 用侧栏搜索打开夹具会话（= 把「用量」「终端」面板坞展开到会话视图）。 */
export async function openFixtureSession(page, { baseURL } = {}) {
  const { manifest } = getRuntime();
  const { searchMarker, projectName } = manifest.session;
  if (baseURL && page.url() === 'about:blank') {
    await page.goto(baseURL);
    await page.waitForLoadState('domcontentloaded');
  }
  await dismissTransientOverlays(page);
  const search = page.getByRole('textbox', { name: /搜索项目/ }).first();
  await search.fill(searchMarker);
  const result = page.getByRole('button', { name: new RegExp(escapeRegExp(searchMarker)) }).first();
  await expect(result, '侧栏搜索必须能命中本套件夹具会话').toBeVisible();
  await clickThroughOverlays(page, result);
  await page.keyboard.press('Escape');
  await dismissTransientOverlays(page);
  if (projectName) {
    await expect(page.getByRole('banner')).toContainText(projectName, { timeout: 10_000 }).catch(() => {});
  }
}

async function openDockPanel(page, name) {
  const panelButton = page.getByRole('button', { name, exact: true }).first();
  if (!(await panelButton.count())) {
    await clickThroughOverlays(page, page.getByRole('button', { name: /^设置/ }).first());
  }
  await expect(panelButton, `顶栏面板坞必须提供「${name}」面板`).toBeVisible();
  await clickThroughOverlays(page, panelButton);
}

export async function openUsagePanel(page, opts = {}) {
  await openFixtureSession(page, opts);
  await openDockPanel(page, '用量');
  await expect(page.getByText('价格与来源').first(), '用量面板必须有「价格与来源」区').toBeVisible();
  // 面板是分段的：价目/刷新区先渲染，订阅卡与额度卡要等 /api/usage（要扫全部会话，慢）回来才挂载。
  // 不等这一步，"订阅卡必须不渲染"这类负向断言会在卡片还来得及挂载之前就通过（恒真）。
  await expect(page.getByRole('button', { name: '导出 CSV' }).first(),
    '用量面板的慢段（订阅卡/额度卡所在的那一段）必须已经挂载').toBeVisible({ timeout: 20_000 });
}

/** 顶栏「终端」开关：打开面板并等 shell 提示符（终端就绪的证据）。 */
const SHELL_PROMPT = /@[^\s@]+\s.*[%$#]\s*$/;

export async function openTerminalPanel(page) {
  const toggle = page.getByRole('button', { name: '终端', exact: true }).first();
  await expect(toggle, '顶栏必须提供「终端」面板开关').toBeVisible();
  await clickThroughOverlays(page, toggle);
  await expect(page.getByText(SHELL_PROMPT).first(), '终端面板打开后必须出现 shell 提示符').toBeVisible({ timeout: 20_000 });
}

/** 结束本页面自己开的 shell（合同入口：标签上的「关闭此标签」）。尽力而为、永不抛出。 */
export async function closePanelTerminals(page) {
  const closeTab = page.getByRole('button', { name: /关闭此标签/ });
  const toggle = page.getByRole('button', { name: '终端', exact: true }).first();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!(await closeTab.count())) return;
    if (!(await closeTab.first().isVisible().catch(() => false))) {
      await toggle.click({ timeout: 4_000 }).catch(() => null);
      await page.waitForTimeout(400);
      continue;
    }
    await closeTab.first().click({ timeout: 4_000 }).catch(() => null);
    await page.waitForTimeout(400);
  }
}

// ---------------------------------------------------------------------------
// 主题切换（公开 UI：顶栏「主题」按钮 → 明暗档 + 配色家族）
// ---------------------------------------------------------------------------

const THEME_BUTTON = '[data-cgui="theme-btn"]';

/** 打开主题弹层（role=tab 的「配色」页在展开后可见）。 */
export async function openThemePopover(page) {
  const button = page.locator(THEME_BUTTON).first();
  await expect(button, '顶栏必须有「主题」按钮（data-cgui="theme-btn"）').toBeVisible();
  await button.click();
  await expect(page.getByRole('tablist', { name: '外观设置分类' }), '主题弹层必须出现外观设置选项卡').toBeVisible();
}

export async function closeThemePopover(page) {
  await page.keyboard.press('Escape').catch(() => null);
}

/** 选明暗档：浅色 / 深色 / 跟随系统。 */
export async function pickTone(page, label) {
  await page.getByRole('button', { name: label, exact: true }).first().click();
}

/** 选配色家族（先切到「配色」页）。 */
export async function pickThemeFamily(page, name) {
  await page.getByRole('tab', { name: '配色' }).click();
  const item = page.getByRole('button', { name, exact: true }).first();
  await expect(item, `配色页必须有家族「${name}」`).toBeVisible();
  await item.click();
}

/** 读 `<html>` 上的主题属性（合同的三个触发属性）。 */
export async function readThemeAttributes(page) {
  return await page.evaluate(() => {
    const root = document.documentElement;
    return {
      theme: root.getAttribute('data-theme'),
      family: root.getAttribute('data-cgui-theme'),
      system: root.getAttribute('data-theme-system'),
    };
  });
}

/** 读 `<html>` 上解析后的 CSS token 值（终端配色应有的来源）。 */
export async function readRootTokens(page, names) {
  return await page.evaluate((list) => {
    const cs = getComputedStyle(document.documentElement);
    const out = {};
    for (const name of list) out[name] = cs.getPropertyValue(name).trim();
    return out;
  }, names);
}

export const TERMINAL_TOKEN_NAMES = [
  '--color-canvas', '--color-ink', '--color-accent', '--color-accent-muted', '--color-accent-subtle',
  '--ui-zoom', '--surface-alpha',
];

// ---------------------------------------------------------------------------
// 网络打桩（R40 / R41）：只拦契约 §D 点名的三个既有接口
// ---------------------------------------------------------------------------

export function jsonFulfil(body, status = 200) {
  return { status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) };
}

/**
 * 只匹配路径，忽略 query（`/api/pricing?refreshId=…` 也走同一份桩）。
 * 一律 200：契约 §D 说这三个接口**恒 200**，且响应体自己就有 `status` 字段（订阅额度的
 * `status:'available'|'stale'|…`）—— 绝不能把响应体的 status 当成 HTTP 状态码。
 */
export async function routeJson(page, pathname, handler) {
  await page.route((url) => url.pathname === pathname, async (route) => {
    const value = typeof handler === 'function' ? handler(route) : handler;
    if (value === null) { await route.fallback(); return; }
    await route.fulfill(jsonFulfil(value, 200));
  });
}

/** §D `GET /api/provider` 的成功形状。 */
export function providerPayload({ providerHint = 'anthropic', hasAuthKey = false, model = null, baseUrl = '', protocol = 'anthropic' } = {}) {
  const body = { baseUrl, providerHint, model, protocol };
  if (hasAuthKey !== undefined) body.hasAuthKey = hasAuthKey;
  return body;
}

/** §D `GET /api/subscription-usage` 的成功形状（只给用例关心的字段）。 */
export function subscriptionPayload({ status = 'unavailable', code, segments = false } = {}) {
  const body = { official: true, status, source: 'cli', fetchedAt: '2026-09-12T02:00:00.000Z', accountScope: 'tu', session: null, weekAll: null, weekScoped: null };
  if (segments) {
    body.session = { percent: 12, resetText: '3 小时后重置' };
    body.weekAll = { percent: 34, resetText: '周一重置' };
    body.weekScoped = { percent: 56, resetText: '周一重置', label: 'Opus' };
  }
  if (code) body.code = code;
  return body;
}

/** §D `GET /api/provider-quota` 的三种形状。 */
export function quotaPayloadOfficial() {
  return { official: true };
}

export function quotaPayloadOk({ providerName = 'TU Provider', items = [{ label: '余额', value: 12.34 }] } = {}) {
  return {
    official: false, ok: true, providerId: 'tu-provider', providerName, kind: 'balance',
    currency: 'CNY', items, low: false, fetchedAt: '2026-09-12T02:00:00.000Z',
  };
}

export function quotaPayloadFailed({ reason = 'no-endpoint', note = '该 provider 未登记额度接口，请去官网查看' } = {}) {
  return { official: false, ok: false, reason, note };
}

// ---------------------------------------------------------------------------
// 实例身份预检
// ---------------------------------------------------------------------------

/**
 * 确认 BASE_URL 指的是**本套件自己的**隔离实例：只有本套件数据根里的夹具会话才带
 * 我们的独有 marker。指错实例时一句话报错，别等一堆用例报成产品缺陷。
 */
export async function assertSuiteInstance(baseURL) {
  const { manifest } = getRuntime();
  const marker = manifest.session.searchMarker;
  const body = await fetch(`${baseURL}/api/search?q=${encodeURIComponent(marker)}`)
    .then(r => r.json()).catch(() => null);
  const hit = Array.isArray(body?.hits) ? body.hits.some(h => JSON.stringify(h).includes(marker)) : false;
  if (!hit) {
    const health = await fetch(`${baseURL}/api/health`).then(r => r.json()).catch(() => null);
    throw new EnvironmentBlocked(
      `BASE_URL 指的实例不是本套件的隔离实例：搜不到本套件数据根里的夹具会话 ${manifest.session.sessionId}`
      + `（marker=${marker}）。\n  实例 ${baseURL}：version=${health?.version ?? '?'}\n`
      + `  本套件数据根：${manifest.dataRoot}\n  多半是复用了别套件/别轮次留下的实例，或 HOME/数据根不对。`
      + `按 README「How to run」用 ./run-isolated.sh 重起一个。`,
    );
  }
  const health = await fetch(`${baseURL}/api/health`).then(r => r.json()).catch(() => null);
  return { baseURL, version: health?.version ?? null };
}
