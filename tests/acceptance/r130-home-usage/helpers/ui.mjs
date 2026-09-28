// r130 界面操作层:只按 INTERFACE-r130 §C 公布的 testid / data-cgui 锚点与用户看得见的东西定位。
// 依据只有 BRIEF/INTERFACE-r130;没看实现代码。页面来自 run.sh 起的 dev server(/api、/ws 代理到隔离实例)。
import { expect } from '@playwright/test';
import fs from 'node:fs';
import { dayAgo, today, mondayIndex, localDayOf } from './fixtures.mjs';
import { uiExpectedPath } from './ui-fixtures.mjs';

export const UI_BASE = process.env.R130_UI_BASE || '';
export const API_BASE = process.env.R130_API_BASE || '';
export const readUiExpected = () => JSON.parse(fs.readFileSync(uiExpectedPath(), 'utf8'));
export const CARD_KEYS = ['sessions', 'messages', 'tokens', 'active-days', 'current-streak', 'longest-streak', 'peak-hour', 'favorite-model'];
export const TEXT = { empty: '还没有用量记录', error: '无法加载用量数据', retry: '重试', stale: '统计中，数据可能略旧', slow: '正在统计全部会话…', noRecord: '无记录' };

/** INTERFACE §C 的 tokens 缩写四档。 */
export const fmtTokens = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n));
export const fmtInt = (n) => Number(n).toLocaleString('en-US');
/** INTERFACE §C 分级:vals = 窗口内 tokens>0 的天升序;q_k = vals[min(n-1, floor(n*k/4))]。 */
export function levelFn(tokensList) {
  const vals = tokensList.filter((v) => v > 0).sort((a, b) => a - b); const n = vals.length;
  if (!n) return () => 0;
  const q = (k) => vals[Math.min(n - 1, Math.floor((n * k) / 4))];
  const [q1, q2, q3] = [q(1), q(2), q(3)];
  return (t) => (t === 0 ? 0 : t <= q1 ? 1 : t <= q2 ? 2 : t <= q3 ? 3 : 4);
}

/** /api/usage 打桩载荷(完整形状);overview: null → 不带 overview 键(模拟旧缓存回放)。 */
export function payload({ total = {}, byDay = [], overview = {}, meta = {}, byModel } = {}) {
  const t = { input: 1000, output: 200, cacheRead: 5000, cacheWrite: 100, sessionCount: 12, ...total };
  const body = {
    total: t,
    byModel: byModel ?? [{ model: 'claude-opus-4-1-20250805', input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite, calls: 3, byPeriod: {} }],
    byProject: [],
    byDay,
    meta: { scannedAt: 1_760_000_000_000, stale: false, ...meta },
  };
  if (overview !== null) {
    const hc = Array(24).fill(0); hc[8] = 5; hc[14] = 2;
    body.overview = { messages: 1234, activeDays: 7, firstDay: dayAgo(30), lastActiveDay: today(), currentStreak: 3, longestStreak: 5, hourCounts: hc, peakHour: 8, favoriteModel: 'claude-opus-4-1-20250805', ...overview };
  }
  return body;
}
/** byDay 一行:tokens 全放 input;messages/sessions 给默认值。 */
export const dayEntry = (day, tokens, extra = {}) => ({ day, input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, calls: 1, sessions: 1, messages: 2, ...extra });
export const sum4 = (r) => (r.input || 0) + (r.output || 0) + (r.cacheRead || 0) + (r.cacheWrite || 0);

/**
 * 打桩 /api/usage(只匹配路径,忽略 query)。responder 可为:载荷对象 / 返回 {status, body, delayMs} 的函数。
 * 返回 state:{ hits:[相对注册时刻的 ms], set(responder) }。必须在 goto 之前调用。
 */
export async function stubUsage(page, responder) {
  const state = { hits: [], t0: Date.now(), responder };
  state.set = (r) => { state.responder = r; };
  await page.route((url) => url.pathname === '/api/usage', async (route) => {
    state.hits.push(Date.now() - state.t0);
    const r = typeof state.responder === 'function' ? await state.responder(route, state.hits.length) : { status: 200, body: state.responder };
    if (r === null) { await route.fallback(); return; }
    if (r.delayMs) await new Promise((res) => setTimeout(res, r.delayMs));
    await route.fulfill({ status: r.status ?? 200, contentType: 'application/json; charset=utf-8', body: typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {}) });
  });
  return state;
}

/** 每次导航前的预置(照 r122 helpers/ui.mjs 的 prime):压掉导引、钉住版本检查。 */
export async function prime(page) {
  await page.addInitScript(() => { try { localStorage.setItem('cgui-tour-seen', '1'); } catch { /* 忽略 */ } });
  for (const url of ['**/api/version-check', '**/api/claude-version-check']) {
    await page.route(url, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hasUpdate: false, localBuild: true }) }));
  }
}
export async function dismissOverlays(page, passes = 6) {
  for (let i = 0; i < passes; i += 1) {
    let hit = false;
    for (const label of ['稍后', '以后再说', '已知晓']) {
      const btn = page.locator('button').filter({ hasText: label }).last();
      if (await btn.isVisible().catch(() => false)) { await btn.click({ force: true }).catch(() => {}); await page.waitForTimeout(120); hit = true; }
    }
    if (!hit) return;
  }
}
/** 进应用并落到单屏首页(能看到 home-input)。已经在会话里时点侧栏「新建会话」回首页。 */
export async function gotoHome(page) {
  await prime(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-cgui="panel-dock"], [data-testid="home-input"]').first(), '应用应挂载(面板坞或首页输入框可见)').toBeVisible({ timeout: 40_000 });
  await dismissOverlays(page);
  const input = page.getByTestId('home-input');
  if (!(await input.isVisible({ timeout: 8000 }).catch(() => false))) {
    const btn = page.locator('[data-cgui=new-session-btn]').first();
    if (await btn.count()) await btn.click({ force: true }).catch(() => {});
  }
  await expect(input, '应落在首页(home-input 可见)').toBeVisible({ timeout: 15_000 });
}

// ── 锚点 ──
export const home = (page) => page.locator('[data-cgui="home"]');
export const greeting = (page) => page.locator('h2[data-cgui="home-greeting"]');
export const homeInput = (page) => page.getByTestId('home-input');
export const usage = (page) => page.getByTestId('home-usage');
export const cards = (page) => page.getByTestId('home-usage-cards');
export const card = (page, key) => page.getByTestId(`home-usage-card-${key}`);
export const heatmap = (page) => page.getByTestId('home-usage-heatmap');
export const cells = (page) => page.getByTestId('home-usage-cell');
export const futureCells = (page) => page.getByTestId('home-usage-cell-future');
export const cellOf = (page, day) => page.locator(`[data-testid="home-usage-cell"][data-day="${day}"]`);
export const tip = (page) => page.getByTestId('home-usage-tip');
export const state = (page, s) => page.getByTestId(`home-usage-${s}`);

/** 卡片的显示文本(值元素 = 卡内带 title 的那个元素;取不到就退回整卡文本)。 */
export async function cardValue(page, key) {
  const c = card(page, key);
  await expect(c, `应有卡片 ${key}`).toBeVisible();
  return c.evaluate((el) => {
    const v = el.querySelector('[title]');
    return { dataValue: el.getAttribute('data-value'), text: (v ? v.textContent : el.textContent || '').trim(), title: v ? v.getAttribute('title') : null, truncate: v ? v.classList.contains('truncate') : null, whole: (el.textContent || '').replace(/\s+/g, ' ').trim() };
  });
}

/** 热力图全部格子的几何与数据:行号/列号按 boundingBox 归组(不依赖 DOM 层级)。 */
export async function cellGeometry(page) {
  return heatmap(page).evaluate((root) => {
    const els = [...root.querySelectorAll('[data-testid="home-usage-cell"],[data-testid="home-usage-cell-future"]')];
    const items = els.map((el) => { const b = el.getBoundingClientRect(); return { future: el.getAttribute('data-testid') === 'home-usage-cell-future', day: el.getAttribute('data-day'), tokens: el.getAttribute('data-tokens'), level: el.getAttribute('data-level'), today: el.getAttribute('data-today'), title: el.getAttribute('title'), x: Math.round(b.x * 2) / 2, y: Math.round(b.y * 2) / 2, w: b.width, h: b.height }; });
    const xs = [...new Set(items.map((i) => i.x))].sort((a, b) => a - b);
    const ys = [...new Set(items.map((i) => i.y))].sort((a, b) => a - b);
    return { weeks: root.getAttribute('data-weeks'), cols: xs.length, rows: ys.length, items: items.map((i) => ({ ...i, col: xs.indexOf(i.x), row: ys.indexOf(i.y) })) };
  });
}
export { mondayIndex, today, dayAgo };

/** 分屏数设成 n(INTERFACE §C:面板坞里的 pane-count → pane-count-n)。 */
export async function setPaneCount(page, n) {
  const ctl = page.getByTestId('pane-count').first();
  if (!(await ctl.isVisible().catch(() => false))) {
    await page.locator('[data-testid="panel-dock-toggle"]').first().click({ force: true }).catch(() => {});
    await page.waitForTimeout(400);
  }
  await expect(ctl, '面板坞里应有「分屏」入口 pane-count').toBeVisible({ timeout: 10_000 });
  const opt = page.getByTestId(`pane-count-${n}`).first();
  if (!(await opt.isVisible().catch(() => false))) { await ctl.click({ force: true }); await page.waitForTimeout(300); }
  await expect(opt, `应能看到 pane-count-${n}`).toBeVisible({ timeout: 5000 });
  await opt.click({ force: true });
  await page.keyboard.press('Escape').catch(() => {});
}
/** 打开顶栏「用量」面板(照 r122 openUsagePanel)。 */
export async function openUsagePanel(page) {
  const btn = page.getByRole('button', { name: '用量', exact: true }).first();
  if (!(await btn.isVisible().catch(() => false))) { await page.locator('[data-testid="panel-dock-toggle"]').first().click({ timeout: 8000 }); await page.waitForTimeout(400); }
  await expect(btn, '顶栏面板坞里应当有「用量」').toBeVisible({ timeout: 10_000 });
  await btn.click({ timeout: 8000 });
  await expect(page.getByText('价格与来源').first(), '用量面板里应有「价格与来源」版块').toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: '导出 CSV' }).first(), '用量面板的慢段应已挂载').toBeVisible({ timeout: 30_000 });
}
/** 本地日期加减 n 天。 */
export const dayShift = (day, n) => { const d = new Date(`${day}T12:00:00+08:00`); d.setDate(d.getDate() + n); return localDayOf(d); };
