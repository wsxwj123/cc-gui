// r168 界面操作层：只用用户看得见的东西 / 产品既有句柄（[data-cgui=…]、[data-testid=pane…]、[data-turn-uuid]、[data-history-load-older]）。
// 切会话一律点侧栏会话行（先展开夹具所在工作区），不用侧栏搜索框来切换。
import fs from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import { SESSIONS, fakeCtlDir } from './fixtures.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const backendURL = () => process.env.BACKEND_URL;

export async function boot(page) {
  await page.addInitScript(() => { try { localStorage.setItem('cgui-tour-seen', '1'); } catch { /* 忽略 */ } });
  for (const api of ['**/api/version-check', '**/api/claude-version-check']) {
    await page.route(api, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hasUpdate: false, localBuild: true }) }));
  }
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 60_000 });
  for (const label of ['稍后', '以后再说', '已知晓']) {
    const b = page.locator('button').filter({ hasText: label }).last();
    if (await b.isVisible().catch(() => false)) await b.click({ force: true }).catch(() => {});
  }
}

// ───────────── 侧栏 ─────────────
export const sidebar = (page) => page.locator('[data-cgui="sidebar"]');
export const rowOf = (page, key) => sidebar(page).locator('[data-cgui="session-row"]').filter({ hasText: SESSIONS[key].beg }).first();

/** 让某会话的行出现在侧栏里（展开它所在工作区；工作区没列出来时用搜索把它打开一次——只在准备阶段用）。 */
export async function ensureRow(page, key) {
  const row = rowOf(page, key);
  const head = sidebar(page).getByText(SESSIONS[key].wsName).first();
  try {
    await expect(async () => {
      if (await row.isVisible().catch(() => false)) return;
      if (await head.isVisible().catch(() => false)) await head.click();
      await expect(row).toBeVisible({ timeout: 4_000 });
    }).toPass({ timeout: 25_000 });
  } catch {
    const search = page.getByRole('complementary').getByRole('textbox', { name: /搜索工作区/ });
    await search.click();
    await search.fill(SESSIONS[key].beg);
    const hit = sidebar(page).locator('[data-cgui="search-hit"], button.sidebar-item').filter({ hasText: SESSIONS[key].beg }).first();
    await expect(hit, `侧栏搜不到夹具会话 ${key}`).toBeVisible({ timeout: 20_000 });
    await hit.click();
    await search.fill('');
    await expect(async () => {
      if (!(await row.isVisible().catch(() => false)) && (await head.isVisible().catch(() => false))) await head.click();
      await expect(row).toBeVisible({ timeout: 4_000 });
    }).toPass({ timeout: 25_000 });
  }
}

/** 点侧栏里的会话行（不等加载完）。 */
export async function clickRow(page, key) {
  // 展开另一个工作区会把前一个收起，所以跨工作区点之前行可能不在——先展开（同工作区内连点时行一直在，不走这一步）。
  if (!(await rowOf(page, key).isVisible().catch(() => false))) await ensureRow(page, key);
  await rowOf(page, key).click({ timeout: 10_000 });
}

// ───────────── 页面上有没有某个标记 ─────────────
const withDeadline = (p, ms, dflt) => Promise.race([p, sleep(ms).then(() => dflt)]);

/** 消息区（或窗格）里出现了 marker？ */
export function markerShown(page, marker) {
  return withDeadline(page.evaluate((m) => {
    const el = document.querySelector('[data-cgui="message-list"]') || document.querySelector('[data-testid="pane"]');
    return !!el && (el.textContent || '').includes(m);
  }, marker).catch(() => false), 2_000, false);
}
/** 整页（含侧栏）里出现了 marker？（反向断言用，更严） */
export function markerInPage(page, marker) {
  return withDeadline(page.evaluate((m) => (document.body.textContent || '').includes(m), marker).catch(() => false), 2_000, false);
}
/** 第 i 个窗格里出现了 marker？ */
export function markerInPane(page, i, marker) {
  return withDeadline(page.evaluate(([idx, m]) => {
    const el = document.querySelectorAll('[data-testid="pane"]')[idx];
    return !!el && (el.textContent || '').includes(m);
  }, [i, marker]).catch(() => false), 2_000, false);
}

/** 等 marker 出现；返回耗时毫秒，超时返回 null。 */
export async function waitMarker(page, marker, ms, probe = markerShown) {
  const t0 = Date.now();
  for (;;) {
    if (await probe(page, marker)) return Date.now() - t0;
    if (Date.now() - t0 > ms) return null;
    await sleep(200);
  }
}

/**
 * 经侧栏在 keys 之间轮流点击 n 次（每次切完等 pause 毫秒），返回每次的结果：
 * { i, key, ms }；ms = 点击到结束标记出现的耗时，null = limit 内没出现；clickError = 点击本身失败。
 */
export async function switchLoop(page, keys, n, { limit = 10_000, pause = 2_500 } = {}) {
  const results = [];
  for (let i = 0; i < n; i += 1) {
    const key = keys[i % keys.length];
    const r = { i: i + 1, key, ms: null };
    const t0 = Date.now();
    try { await clickRow(page, key); } catch (e) { r.clickError = String(e.message).split('\n')[0]; }
    const found = await waitMarker(page, SESSIONS[key].end, limit - (Date.now() - t0));
    r.ms = found === null ? null : Date.now() - t0; // 总耗时（含点击本身）
    results.push(r);
    await sleep(pause);
  }
  return results;
}
export const describeSwitches = (rs) => rs.map((r) => `#${r.i}${r.key}=${r.ms === null ? `>限时未出现${r.clickError ? `(点击失败:${r.clickError})` : ''}` : `${r.ms}ms`}`).join(' ');

// ───────────── 回合 / 输入框 ─────────────
export const stopBtn = (page) => page.locator('[data-cgui="stop-btn"]');
export const composer = (page) => page.getByPlaceholder(/输入消息|开始一个新会话|发消息|问点什么/).or(page.locator('textarea')).last();

export function resetCtl() {
  fs.mkdirSync(fakeCtlDir(), { recursive: true });
  for (const name of fs.readdirSync(fakeCtlDir())) { try { fs.unlinkSync(path.join(fakeCtlDir(), name)); } catch { /* 忽略 */ } }
}
/** 让所有还在跑的假回合收尾（用例 finally 里调）。 */
export async function finishRounds() {
  try { fs.writeFileSync(path.join(fakeCtlDir(), 'finish-all'), String(Date.now())); } catch { /* 忽略 */ }
  await sleep(1_500);
}

/** 在当前打开的会话里发一条消息，并等"停止"键出现。消息以该会话的开头标记起头（保证侧栏标题仍含标记）。 */
export async function sendAndWaitRunning(page, key, userText) {
  const box = composer(page);
  await expect(box).toBeVisible({ timeout: 15_000 });
  await box.fill(userText);
  await box.press('Enter');
  await expect(stopBtn(page), '发消息后应出现"停止"键（回合进行中）').toBeVisible({ timeout: 30_000 });
}

/** 开会话 key 并等它的结束标记出现（准备阶段）。 */
export async function openAndWait(page, key, ms = 60_000) {
  await ensureRow(page, key);
  await clickRow(page, key);
  const t = await waitMarker(page, SESSIONS[key].end, ms);
  expect(t, `前置：会话 ${key} 应在 ${ms}ms 内加载出结束标记`).not.toBeNull();
}

export const countMatches = (page, re) => page.evaluate(([src]) => {
  const el = document.querySelector('[data-cgui="message-list"]');
  return el ? ((el.textContent || '').match(new RegExp(src, 'g')) || []).length : 0;
}, [re.source]);

export const messageRows = (page) => page.locator('[data-cgui="message-list"] [data-turn-uuid]');
export const loadOlder = (page) => page.locator('[data-cgui="message-list"]').getByText(/更早/).filter({ hasNotText: '尚未加载' });

// ───────────── 分屏 ─────────────
export async function setPaneCount(page, n) {
  const probe = page.locator('[data-cgui="panel-dock"] button').filter({ hasText: /^通用$/ }).first();
  if (!(await probe.isVisible().catch(() => false))) {
    await page.locator('[data-testid="panel-dock-toggle"]').click({ force: true });
    await sleep(600);
  }
  await page.getByTestId('pane-count').first().click({ force: true });
  await sleep(400);
  await page.getByTestId(`pane-count-${n}`).first().click({ force: true });
  await page.keyboard.press('Escape').catch(() => {});
  await expect.poll(() => page.locator('[data-testid="pane"]').count(), { message: `应有 ${n} 个窗格`, timeout: 10_000 }).toBe(n);
}
/** 把第 i 个窗格设为"当前"（点它的输入框；空窗格点提示文字）。 */
export async function focusPane(page, i) {
  const pane = page.locator('[data-testid="pane"]').nth(i);
  const hint = pane.getByText(/点左侧任一会话填入本分屏/).first();
  if (await hint.isVisible().catch(() => false)) await hint.click({ force: true });
  else await pane.locator('textarea').first().click({ force: true });
  await sleep(300);
}

/** 记下发往 /api/sessions/<sid>/messages 的请求。 */
export function watchHistory(page) {
  const list = [];
  page.on('request', (req) => {
    try {
      const u = new URL(req.url());
      const m = /^\/api\/sessions\/([^/]+)\/messages$/.exec(u.pathname);
      if (m) list.push({ sid: decodeURIComponent(m[1]), url: req.url(), at: Date.now() });
    } catch { /* 非 http */ }
  });
  return list;
}
