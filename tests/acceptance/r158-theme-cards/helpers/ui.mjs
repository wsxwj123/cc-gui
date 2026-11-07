// r158-theme-cards：打开夹具会话 / 展开工作组与工具卡 / 切主题 / 剪贴板记录。
// 只用接口文件列出的锚点（[data-work-group-head]、[data-tool-card*]、[data-term-*]、[data-diff-*]、pre[data-code-block] 等）和公开文案；
// 不读源码、不读 React state。找不到东西时不抛环境错，让断言带着现状说明失败。
import { expect } from '@playwright/test';
import { SESSIONS, END_ANCHOR } from './fixtures.mjs';
import { primeOverlays, openApp, openSessionByMarker, sendInOpenSession, resetCtl, writeScenario, touchCtl, releaseRound } from './runtime.mjs';

export const THEMES = [
  { key: 'default-light', family: 'default', mode: 'light' },
  { key: 'claude-warm', family: 'claude', mode: 'light', cgui: 'claude-warm' },
  { key: 'github-light', family: 'github', mode: 'light', cgui: 'github-light' },
  { key: 'default-dark', family: 'default', mode: 'dark' },
  { key: 'github-dark', family: 'github', mode: 'dark', cgui: 'github-dark' },
  { key: 'nord', family: 'nord', mode: 'dark', cgui: 'nord' },
  { key: 'claude-dark', family: 'claude', mode: 'dark', cgui: 'claude-dark' },
];
export const LIGHT = THEMES.filter((t) => t.mode === 'light');
export const DARK = THEMES.filter((t) => t.mode === 'dark');

export const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
export const textOf = async (loc) => norm(await loc.innerText());

/** 页面启动前替换 navigator.clipboard.writeText，把写入的文本按顺序记在 window.__copied（WebKit 读不到系统剪贴板）。 */
export async function stubClipboard(page) {
  await page.addInitScript(() => {
    window.__copied = [];
    const write = (t) => { window.__copied.push(String(t)); return Promise.resolve(); };
    try {
      if (navigator.clipboard) Object.defineProperty(navigator.clipboard, 'writeText', { value: write, configurable: true });
      else Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true });
    } catch { /* 忽略 */ }
  });
}
export const copied = (page) => page.evaluate(() => window.__copied || []);

/** 点开页面上所有 aria-expanded=false 的工作组头（历史回合里的工具卡都在组里）。 */
export async function expandAllGroups(page) {
  const heads = page.locator('[data-work-group-head]');
  await heads.first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
  const n = await heads.count();
  for (let i = 0; i < n; i += 1) {
    const h = heads.nth(i);
    if ((await h.getAttribute('aria-expanded')) === 'false') { await h.click({ timeout: 8_000 }); await page.waitForTimeout(150); }
  }
}

/** 展开所有工具卡：先读 aria-expanded，只点收起的（MCP 卡默认已展开）。没有 [data-tool-card-head] 时最多等 8 秒就放行。 */
export async function expandAllCards(page) {
  const heads = page.locator('[data-tool-card-head]');
  await heads.first().waitFor({ state: 'attached', timeout: 8_000 }).catch(() => {});
  const n = await heads.count();
  for (let i = 0; i < n; i += 1) {
    const h = heads.nth(i);
    if ((await h.getAttribute('aria-expanded')) === 'false') await h.click({ timeout: 8_000 });
  }
  await page.waitForTimeout(250);
}

/** 滚到回合末尾（正文开头那句 + 最后一个围栏代码块）。 */
export async function scrollToEnd(page, anchor = END_ANCHOR) {
  await page.getByText(anchor).first().scrollIntoViewIfNeeded({ timeout: 8_000 }).catch(() => {});
  const last = page.locator('pre[data-code-block]').last();
  if (await last.count()) await last.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(200);
}

/** 打开夹具会话并展开全部工作组（工具卡的展开交给调用方）。theme：THEMES 里的一项；clipboard：是否记录剪贴板写入。 */
export async function openFixture(page, key, { theme, clipboard = false } = {}) {
  if (clipboard) await stubClipboard(page);
  await primeOverlays(page, theme ? { 'cgui-theme-family': theme.family, 'cgui-theme': theme.mode } : {});
  await openApp(page);
  await openSessionByMarker(page, SESSIONS[key].marker);
  await expandAllGroups(page);
}

/** 夹具第 n 项的卡（n = 接口文件夹具表的序号 1…11）。页面上的 DOM 顺序是 1–8、10、11（历史回合），第 9 项（直播回合）排最后；h 会话里没有第 9 项。 */
const DOM_INDEX = [0, 1, 2, 3, 4, 5, 6, 7, 10, 8, 9];
export const cardAt = (page, n) => page.locator('[data-tool-card]').nth(DOM_INDEX[n - 1]);
/** 只展开第 n 张卡（先读 aria-expanded），返回它的 [data-tool-card-body]。 */
export async function openCard(page, n) {
  await expect(cardAt(page, n), `页面上没有第 ${n} 张 [data-tool-card]（接口文件点名的钩子还不存在）`).toHaveCount(1, { timeout: 8_000 });
  const head = cardAt(page, n).locator('[data-tool-card-head]');
  if ((await head.getAttribute('aria-expanded', { timeout: 8_000 })) === 'false') await head.click({ timeout: 8_000 });
  await expect(head, `第 ${n} 张卡点开后 aria-expanded 应为 true`).toHaveAttribute('aria-expanded', 'true', { timeout: 5_000 });
  return cardAt(page, n).locator('[data-tool-card-body]');
}

/**
 * 在页面里跑（Playwright 会把函数体序列化过去，所以必须自包含）：只采原始事实，颜色一律原样文本，算术放在 Node 侧。
 * 颜色统一成 rgb()/rgba()/color(srgb …) 文本；别的写法（oklch / lab 等）交给画布换算成 sRGB。
 */
export function snapshotInPage() {
  const g2d = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const nc = (s) => {
    if (/^(rgba?\(|color\(\s*srgb)/i.test(s)) return s;
    g2d.clearRect(0, 0, 1, 1); g2d.fillStyle = '#000'; g2d.fillStyle = s; g2d.fillRect(0, 0, 1, 1);
    const d = g2d.getImageData(0, 0, 1, 1).data;
    return `rgba(${d[0]}, ${d[1]}, ${d[2]}, ${(d[3] / 255).toFixed(4)})`;
  };
  const cs = (e) => getComputedStyle(e);
  const rendered = (e) => e.getClientRects().length > 0 && cs(e).visibility !== 'hidden';
  const desc = (e) => `${e.tagName.toLowerCase()}${[...e.attributes].filter((a) => a.name.startsWith('data-')).slice(0, 2)
    .map((a) => `[${a.name}${a.value ? `=${a.value.slice(0, 14)}` : ''}]`).join('')}${typeof e.className === 'string' && e.className ? `.${e.className.split(/\s+/)[0].slice(0, 18)}` : ''}`;
  const bgOf = (e) => nc(cs(e).backgroundColor);
  const chain = (e) => { const out = []; for (let p = e; p; p = p.parentElement) out.push(bgOf(p)); return out; };
  const subtree = (root) => [root, ...root.querySelectorAll('*')].filter(rendered).map((e) => ({ d: desc(e), bg: bgOf(e) }));
  const texts = (root, skip) => {
    const set = new Set();
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const pe = n.parentElement;
      if (!pe || !n.nodeValue.trim() || !rendered(pe) || (skip && skip(pe, n))) continue;
      set.add(pe);
    }
    return [...set];
  };
  const sample = (cat, el) => ({ cat, d: desc(el), t: el.textContent.trim().slice(0, 28), fg: nc(cs(el).color), chain: chain(el) });
  const all = (sel) => [...document.querySelectorAll(sel)].filter(rendered);
  const html = document.documentElement;
  const out = {
    theme: html.getAttribute('data-theme'), cgui: html.getAttribute('data-cgui-theme'),
    canvasChain: chain(document.querySelector('[data-turn-uuid]') || document.body), samples: [], cards: [], pres: [], md: {},
  };
  for (const c of all('[data-tool-card]')) out.cards.push({ name: c.getAttribute('data-tool-name'), status: c.getAttribute('data-status'), sub: subtree(c) });
  for (const p of all('pre[data-code-block]')) out.pres.push({ tone: p.getAttribute('data-code-tone'), sub: subtree(p) });
  for (const e of all('[data-tool-card-title]')) out.samples.push(sample('title', e));
  for (const r of all('[data-term-cmd]')) for (const e of texts(r, (pe, n) => !!pe.closest('button') || n.nodeValue.trim() === '$')) out.samples.push(sample('cmd', e));
  for (const r of all('[data-term-out]')) for (const e of texts(r)) out.samples.push(sample('out', e));
  for (const r of all('pre[data-code-block]')) for (const e of texts(r, (pe) => !!pe.closest('button, [data-code-lang]'))) out.samples.push(sample('code', e));
  for (const r of all('[data-diff-line]')) for (const e of texts(r, (pe) => !!pe.closest('[data-diff-sign]'))) out.samples.push(sample('diff', e));
  const inl = all('code').find((c) => !c.closest('pre') && c.textContent.trim() === 'foo()');
  const bq = all('blockquote')[0];
  const tb = all('table')[0];
  if (inl) {
    const p = inl.closest('p, li') || inl.parentElement;
    out.md.inline = { sub: subtree(inl), bg: bgOf(inl), fg: nc(cs(inl).color), parentFg: nc(cs(p).color) };
    out.samples.push(sample('inline', inl));
  }
  if (bq) {
    out.md.bq = { sub: subtree(bq), fontStyle: cs(bq).fontStyle, bw: cs(bq).borderLeftWidth, bs: cs(bq).borderLeftStyle };
    for (const e of texts(bq)) out.samples.push(sample('bq', e));
  }
  if (tb) {
    out.md.table = {
      sub: subtree(tb), r: cs(tb).borderTopLeftRadius, rp: tb.parentElement ? cs(tb.parentElement).borderTopLeftRadius : '0px',
      rows: [...tb.querySelectorAll('tbody tr')].map((tr) => ({ tr: bgOf(tr), td: tr.cells[0] ? bgOf(tr.cells[0]) : null })),
    };
    for (const e of texts(tb)) out.samples.push(sample('table', e));
  }
  return out;
}

// ───────────────────────── 颜色算术（Node 侧）─────────────────────────
const splitTok = (x) => x.split(/[\s,/]+/).filter(Boolean);
const alphaOf = (t) => (t === undefined ? 1 : t.endsWith('%') ? parseFloat(t) / 100 : parseFloat(t));
/** 认 rgb() / rgba() / color(srgb r g b / a) 三种写法（color() 的分量是 0–1），返回 {r,g,b:0–255, a:0–1}。 */
export function parseColor(str) {
  const s = String(str).trim();
  let m = s.match(/^rgba?\(([^)]*)\)$/i);
  if (m) {
    const p = splitTok(m[1]);
    const ch = (t) => (t.endsWith('%') ? (parseFloat(t) * 255) / 100 : parseFloat(t));
    return { r: ch(p[0]), g: ch(p[1]), b: ch(p[2]), a: alphaOf(p[3]) };
  }
  m = s.match(/^color\(\s*srgb\s+([^)]*)\)$/i);
  if (m) {
    const p = splitTok(m[1]);
    const ch = (t) => (t.endsWith('%') ? (parseFloat(t) * 255) / 100 : parseFloat(t) * 255);
    return { r: ch(p[0]), g: ch(p[1]), b: ch(p[2]), a: alphaOf(p[3]) };
  }
  throw new Error(`无法解析颜色「${s}」`);
}
const lin = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
export const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
export const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
export const contrast = (x, y) => { const a = lum(x); const b = lum(y); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
export const canvasOf = (snap) => {
  for (const b of snap.canvasChain) { const c = parseColor(b); if (c.a >= 0.99) return c; }
  return { r: 255, g: 255, b: 255, a: 1 };
};

/** 主题有没有真切过去（防止把「主题没切成」误判成「颜色不对」）。 */
export function themeProblems(snap, theme) {
  const out = [];
  const cl = lum(canvasOf(snap));
  if (theme.cgui && snap.cgui !== theme.cgui) out.push(`${theme.key}：<html data-cgui-theme> 应为 ${theme.cgui}，实为 ${snap.cgui}`);
  if (theme.mode === 'light' ? cl < 0.5 : cl > 0.5) out.push(`${theme.key}：画布亮度 ${cl.toFixed(2)} 与 ${theme.mode} 不符（data-theme=${snap.theme}）`);
  return out;
}
/** 亮度检查（B1 / B2 / B12）：roots = [{label, sub}]，sub[0] 是根元素；light → 根亮度 ≥ 0.70，dark → ≤ 0.30；子树里不透明背景与画布亮度差 ≤ 0.35。 */
export function lumProblems(snap, theme, roots) {
  const canvas = canvasOf(snap);
  const cl = lum(canvas);
  const out = [];
  for (const { label, sub } of roots) {
    const rl = lum(over(parseColor(sub[0].bg), canvas));
    if (theme.mode === 'light' ? rl < 0.7 : rl > 0.3) out.push(`${theme.key} ${label} 背景亮度 ${rl.toFixed(2)}（应${theme.mode === 'light' ? ' ≥ 0.70' : ' ≤ 0.30'}）`);
    const far = sub.filter((e) => { const c = parseColor(e.bg); return c.a >= 0.99 && Math.abs(lum(c) - cl) > 0.35; });
    for (const e of far.slice(0, 3)) out.push(`${theme.key} ${label} 子元素 ${e.d} 亮度 ${lum(parseColor(e.bg)).toFixed(2)} 与画布 ${cl.toFixed(2)} 差 ${Math.abs(lum(parseColor(e.bg)) - cl).toFixed(2)}（应 ≤ 0.35）`);
    if (far.length > 3) out.push(`${theme.key} ${label} 另有 ${far.length - 3} 个子元素同样越界`);
  }
  return out;
}
/** 对比度检查（B3 / B12）：cats 里每一类至少采到一个样本，且每个样本对比度 ≥ 4.5。背景 = 往上第一个 alpha ≥ 0.02 的祖先，半透明叠到画布上。 */
export function contrastProblems(snap, theme, cats) {
  const canvas = canvasOf(snap);
  const out = [];
  const seen = {};
  for (const s of snap.samples) {
    if (!cats.includes(s.cat)) continue;
    seen[s.cat] = (seen[s.cat] || 0) + 1;
    let bg = canvas;
    for (const b of s.chain) { const c = parseColor(b); if (c.a >= 0.02) { bg = over(c, canvas); break; } }
    const r = contrast(over(parseColor(s.fg), bg), bg);
    if (r < 4.5) out.push(`${theme.key} ${s.cat}「${s.t}」(${s.d}) 对比度 ${r.toFixed(2)}（应 ≥ 4.5）`);
  }
  for (const c of cats) if (!seen[c]) out.push(`${theme.key}：页面上没采到「${c}」类文字样本（对应元素不存在或不可见）`);
  return out;
}

const cache = new Map();
/** 每个主题只开一次页面、采一次快照（B1 / B2 / B3 / B12 共用同一份只读结果；单跑某一条时按需现采，所以互不依赖）。 */
export async function themeSnapshot(browser, theme) {
  if (cache.has(theme.key)) return cache.get(theme.key);
  const ctx = await browser.newContext({ baseURL: process.env.BASE_URL, viewport: { width: 1280, height: 900 } });
  try {
    ctx.setDefaultTimeout(15_000);
    const page = await ctx.newPage();
    await openFull(page, `ft${THEMES.indexOf(theme)}`, { theme });
    await expandAllCards(page);
    await scrollToEnd(page);
    const snap = await page.evaluate(snapshotInPage);
    cache.set(theme.key, snap);
    return snap;
  } finally { releaseAll(); await ctx.close(); }
}
export const cardRoots = (snap) => [
  ...snap.cards.map((c, i) => ({ label: `卡#${i + 1}(${c.name}/${c.status})`, sub: c.sub })),
  ...snap.pres.map((p, i) => ({ label: `代码块#${i + 1}(tone=${p.tone})`, sub: p.sub })),
];
export const mdRoots = (snap) => [['inline', '行内代码'], ['bq', '引用块'], ['table', '表格']].filter(([k]) => snap.md[k]).map(([k, label]) => ({ label, sub: snap.md[k].sub }));

// ───────────────────────── 直播回合：造第 9 项（运行中）─────────────────────────
export const RUNNING_EVENT = { kind: 'tool', name: 'Bash', input: { command: 'sleep 999' }, pending: 'd1' };
/** 放开所有闸门并放行回合，让停在半路的假命令行自己收尾（用例收尾 / 换主题前调用）。 */
export function releaseAll() {
  try { for (let i = 1; i <= 8; i += 1) { touchCtl(`g${i}`); touchCtl(`d${i}`); } releaseRound(); } catch { /* 忽略 */ }
}
/**
 * 「完整夹具」：打开 f* / e2 会话（历史回合同 h）→ 发一条消息 → 假 claude 发出一个不返回的工具调用（默认 Bash sleep 999，即第 9 项）并停住
 * → 展开全部工作组（历史组 + 直播组）。events 可换成别的事件（E2 用来造「参数还在传输」）。
 */
export async function openFull(page, key, { theme, clipboard = false, events = [RUNNING_EVENT] } = {}) {
  resetCtl();
  writeScenario({ stepDelayMs: 120, holdBeforeResult: true, events });
  await openFixture(page, key, { theme, clipboard });
  await sendInOpenSession(page, '请开始这一轮');
  await expect.poll(async () => await page.locator('[data-work-group-head]').count(), { timeout: 25_000, message: '发出消息后应出现直播回合的工作组头' })
    .toBeGreaterThanOrEqual(key === 'e2' ? 0 : 2);
  await expandAllGroups(page);
}
