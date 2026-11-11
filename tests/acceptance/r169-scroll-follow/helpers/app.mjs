// r169 界面操作层：只用用户看得见的东西 / 产品既有句柄（[data-cgui=…]、[data-testid=pane…]、[data-turn-uuid]、[data-history-load-older]、
// 名为「回到底部」的按钮）。切会话一律点侧栏会话行；滚动一律用鼠标滚轮。
// pane 参数：null = 单窗格（整页找消息列表）；0/1 = 分屏时第几个窗格（在 [data-testid="pane"] 里找）。
import fs from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import { SESSIONS, fakeCtlDir, refreshSessions } from './fixtures.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withDeadline = (p, ms, dflt) => Promise.race([p, sleep(ms).then(() => dflt)]);
export const VIEW = { width: 1500, height: 1000 };

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

// ───────────── 用例前后清理 ─────────────
export function resetCtl() {
  fs.mkdirSync(fakeCtlDir(), { recursive: true });
  for (const name of fs.readdirSync(fakeCtlDir())) { try { fs.unlinkSync(path.join(fakeCtlDir(), name)); } catch { /* 忽略 */ } }
}
/** 下一轮假回复持续多久（毫秒）；在发消息之前调。 */
export function setDuration(ms) {
  fs.mkdirSync(fakeCtlDir(), { recursive: true });
  fs.writeFileSync(path.join(fakeCtlDir(), 'scenario.json'), JSON.stringify({ durationMs: ms }));
}
/** 让所有还在跑的假回合收尾（用例 afterEach 里调）。 */
export async function finishRounds() {
  try { fs.writeFileSync(path.join(fakeCtlDir(), 'finish-all'), String(Date.now())); } catch { /* 忽略 */ }
  await sleep(1_500);
}
export function freshState() {
  resetCtl();
  refreshSessions(['A', 'B', 'C']);
}
export async function restoreViewport(page) {
  await page.setViewportSize(VIEW).catch(() => {});
}

// ───────────── 侧栏 ─────────────
export const sidebar = (page) => page.locator('[data-cgui="sidebar"]');
export const rowOf = (page, key) => sidebar(page).locator('[data-cgui="session-row"]').filter({ hasText: SESSIONS[key].beg }).first();

/** 让某会话的行出现在侧栏里（展开工作区一次；点工作区标题会打开最新会话，所以只在准备阶段用）。 */
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
export async function clickRow(page, key) {
  if (!(await rowOf(page, key).isVisible().catch(() => false))) await ensureRow(page, key);
  await rowOf(page, key).click({ timeout: 10_000 });
}

// ───────────── 页面上有没有某个标记 ─────────────
export function markerShown(page, marker) {
  return withDeadline(page.evaluate((m) => {
    const el = document.querySelector('[data-cgui="message-list"]') || document.querySelector('[data-testid="pane"]');
    return !!el && (el.textContent || '').includes(m);
  }, marker).catch(() => false), 2_000, false);
}
export function markerInPane(page, i, marker) {
  return withDeadline(page.evaluate(([idx, m]) => {
    const el = document.querySelectorAll('[data-testid="pane"]')[idx];
    return !!el && (el.textContent || '').includes(m);
  }, [i, marker]).catch(() => false), 2_000, false);
}
export async function waitMarker(page, marker, ms, probe = markerShown) {
  const t0 = Date.now();
  for (;;) {
    if (await probe(page, marker)) return Date.now() - t0;
    if (Date.now() - t0 > ms) return null;
    await sleep(200);
  }
}
/** 开会话 key 并等它的结束标记出现（准备阶段）。 */
export async function openAndWait(page, key, ms = 60_000) {
  await ensureRow(page, key);
  await clickRow(page, key);
  const t = await waitMarker(page, SESSIONS[key].end, ms);
  expect(t, `前置：会话 ${key} 应在 ${ms}ms 内加载出结束标记`).not.toBeNull();
}

// ───────────── 消息列表：离底距离 / scrollTop / 停止键 ─────────────
export const paneLoc = (page, pane) => (pane === null ? page.locator('body') : page.locator('[data-testid="pane"]').nth(pane));
export const listLoc = (page, pane) => paneLoc(page, pane).locator('[data-cgui="message-list"]').first();
export const stopBtn = (page, pane = null) => paneLoc(page, pane).locator('[data-cgui="stop-btn"]').first();
/** 名为「回到底部」的按钮（按无障碍名称找，不看样式类名）。 */
export const backBtn = (page, pane = null) => paneLoc(page, pane).getByRole('button', { name: '回到底部', exact: true });

/** 一次读出 { list, stop, dist, top, sh, ch }；dist = scrollHeight − scrollTop − clientHeight。 */
export function metrics(page, pane = null) {
  return withDeadline(page.evaluate((idx) => {
    const root = idx === null ? document : document.querySelectorAll('[data-testid="pane"]')[idx];
    if (!root) return null;
    const el = root.querySelector('[data-cgui="message-list"]');
    const s = root.querySelector('[data-cgui="stop-btn"]');
    const stop = !!s && s.getClientRects().length > 0;
    if (!el) return { list: false, stop };
    return { list: true, stop, dist: el.scrollHeight - el.scrollTop - el.clientHeight, top: el.scrollTop, sh: el.scrollHeight, ch: el.clientHeight };
  }, pane).catch(() => null), 3_000, null);
}
export async function metricsOrFail(page, pane = null) {
  const m = await metrics(page, pane);
  expect(m && m.list, `读不到${pane === null ? '' : `第 ${pane} 个窗格的`}消息列表（[data-cgui="message-list"]）`).toBe(true);
  return m;
}

async function hoverList(page, pane) {
  const box = await listLoc(page, pane).boundingBox();
  expect(box, '消息列表没有可见区域，没法滚轮').not.toBeNull();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

/** 滚轮往上翻，直到 scrollTop 至少减少 minPx。返回 { start, end, moved }。 */
export async function wheelUp(page, pane, minPx, { step = 100 } = {}) {
  await hoverList(page, pane);
  const start = (await metricsOrFail(page, pane)).top;
  let cur = start;
  for (let i = 0; i < 80 && start - cur < minPx; i += 1) {
    await page.mouse.wheel(0, -step);
    await sleep(70);
    cur = (await metricsOrFail(page, pane)).top;
  }
  await sleep(250);
  const end = (await metricsOrFail(page, pane)).top;
  return { start, end, moved: start - end };
}
/** 滚轮一直往上翻到最顶部（scrollTop ≤ 1），最多 maxMs。 */
export async function wheelToTop(page, pane, maxMs = 20_000) {
  await hoverList(page, pane);
  const t0 = Date.now();
  for (;;) {
    const m = await metricsOrFail(page, pane);
    if (m.top <= 1 || Date.now() - t0 > maxMs) return m;
    await page.mouse.wheel(0, -2500);
    await sleep(150);
  }
}
/** 滚轮往下翻到底（离底 ≤ 4px），最多 maxMs。 */
export async function wheelToBottom(page, pane, maxMs = 8_000) {
  await hoverList(page, pane);
  const t0 = Date.now();
  for (;;) {
    const m = await metricsOrFail(page, pane);
    if (m.dist <= 4) return m;
    if (Date.now() - t0 > maxMs) return m;
    await page.mouse.wheel(0, 800);
    await sleep(120);
  }
}

/** 从现在起每 interval 毫秒采样一次，直到停止键消失（或超时）。返回样本数组 { t, stop, dist, top, btn }。 */
export async function watchUntilStopGone(page, pane, { interval = 200, maxMs = 90_000, withButton = false } = {}) {
  const samples = [];
  const t0 = Date.now();
  for (;;) {
    const m = await metrics(page, pane);
    const s = { t: Date.now() - t0, stop: !!(m && m.stop), dist: m && m.dist, top: m && m.top };
    if (withButton) {
      const loc = backBtn(page, pane);
      const n = await withDeadline(loc.count().catch(() => 0), 2_000, 0);
      s.btnCount = n;
      s.btn = n > 0 && (await withDeadline(loc.first().isVisible().catch(() => false), 2_000, false));
    }
    samples.push(s);
    if (!s.stop) return samples;
    if (Date.now() - t0 > maxMs) { s.timedOut = true; return samples; }
    await sleep(interval);
  }
}
export const median = (a) => { const b = [...a].sort((x, y) => x - y); const n = b.length; return n === 0 ? NaN : (n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2); };

/** "跟随中"的判据：回复进行中的样本，离底距离中位数 ≤4px，且至少 90% 的采样 ≤120px（允许个别采样落在"内容已追加、还没吸底"的瞬间）。 */
export function expectFollowing(samples, what) {
  const run = samples.filter((s) => s.stop && typeof s.dist === 'number');
  const ds = run.map((s) => s.dist);
  const max = Math.max(...ds);
  const med = median(ds);
  const okCount = ds.filter((d) => d <= 120).length;
  const ratio = ds.length ? okCount / ds.length : NaN;
  const info = `${what}：回复进行中共 ${ds.length} 个采样，离底距离最大 ${Number.isFinite(max) ? max.toFixed(0) : 'n/a'}px、中位数 ${Number.isFinite(med) ? med.toFixed(0) : 'n/a'}px、≤120px 的占比 ${Number.isFinite(ratio) ? (ratio * 100).toFixed(0) : 'n/a'}%（${okCount}/${ds.length}）`;
  expect(ds.length, `${info}（采样太少，判据无意义）`).toBeGreaterThanOrEqual(10);
  expect(med, `${info}；要求中位数 ≤4px`).toBeLessThanOrEqual(4);
  expect(ratio, `${info}；要求至少 90% 的采样 ≤120px`).toBeGreaterThanOrEqual(0.9);
  const last = samples[samples.length - 1];
  expect(last.timedOut, `${what}：等停止键消失超时`).toBeFalsy();
}

// ───────────── 输入框 / 发消息 ─────────────
export const composer = (page, pane = null) => (pane === null
  ? page.getByPlaceholder(/输入消息|开始一个新会话|发消息|问点什么/).or(page.locator('textarea')).last()
  : page.locator('[data-testid="pane"]').nth(pane).locator('textarea').first());

/** 在 pane 里发一条消息，并等该窗格的"停止"键出现。返回发送时刻。 */
export async function sendAndWaitRunning(page, pane, userText) {
  const box = composer(page, pane);
  await expect(box).toBeVisible({ timeout: 15_000 });
  await box.fill(userText);
  const tSend = Date.now();
  await box.press('Enter');
  await expect(stopBtn(page, pane), '发消息后应出现"停止"键（回合进行中）').toBeVisible({ timeout: 30_000 });
  return tSend;
}
/** 发完消息后保证"停在最底部"（前置条件，不是被测行为）：先看一眼，不在底部就用滚轮滚下去。 */
export async function ensureAtBottom(page, pane) {
  const m = await wheelToBottom(page, pane, 6_000);
  await sleep(500);
  const m2 = await metricsOrFail(page, pane);
  expect(m2.dist, `前置：发消息后应能停在最底部（离底 ${m.dist.toFixed(0)} → ${m2.dist.toFixed(0)}px）`).toBeLessThanOrEqual(4);
}

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
/** 分屏：左窗格 A，右窗格 C，两边都加载完。 */
export async function openSplitAC(page) {
  await boot(page);
  await ensureRow(page, 'A');
  await openAndWait(page, 'A');
  await setPaneCount(page, 2);
  await focusPane(page, 1);
  await clickRow(page, 'C');
  expect(await waitMarker(page, SESSIONS.C.end, 30_000, (p, m) => markerInPane(p, 1, m)), '前置：右窗格应加载出 C 的结束标记').not.toBeNull();
  expect(await markerInPane(page, 0, SESSIONS.A.end), '前置：左窗格应仍是 A').toBe(true);
  await sleep(1_000);
}

export const messageRows = (page) => page.locator('[data-cgui="message-list"] [data-turn-uuid]');
export const loadOlder = (page) => page.locator('[data-cgui="message-list"]').getByText(/更早/).filter({ hasNotText: '尚未加载' });
