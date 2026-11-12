// r170 界面操作层:只用界面上看得见的东西 / 产品既有句柄([data-cgui="message-list"]、[data-turn-uuid]、
// [data-turn-placeholder]、[data-history-load-older]、名为「回到底部」的按钮、--ui-zoom)。
// 滚动一律用鼠标滚轮;切会话走侧栏搜索;刷新 = 与 r151l B4 相同的 cgui:sessions-changed 事件。不 import 产品代码。
import { expect } from '@playwright/test';
import { seedHistory, appendMessages } from './fixtures.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const list = (page) => page.locator('[data-cgui="message-list"]');
export const rows = (page) => list(page).locator('[data-turn-uuid]');
export const entry = (page) => list(page).getByText(/更早/).filter({ hasNotText: '尚未加载' });
export const backBtn = (page) => page.getByRole('button', { name: '回到底部', exact: true });
export const rowCount = (page) => rows(page).count();

/** 进应用:压掉引导 / 更新检查,界面缩放预置 1.0(默认 1.2 会把像素读数放大),并自证生效。 */
export async function boot(page) {
  await page.addInitScript(() => {
    try { localStorage.setItem('cgui-tour-seen', '1'); localStorage.setItem('cgui-ui-font-scale', '1'); } catch { /* 忽略 */ }
  });
  for (const api of ['**/api/version-check', '**/api/claude-version-check']) {
    await page.route(api, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hasUpdate: false, localBuild: true }) }));
  }
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 60_000 });
  const zoom = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom').trim());
  expect(zoom, '前置自证:界面缩放应为 1(应用默认 1.2 会把像素读数放大 1.2 倍)').toBe('1');
}

async function openSessionBySearch(page, mark, replyText) {
  const search = page.getByRole('complementary').getByRole('textbox', { name: /搜索工作区/ });
  const hit = page.locator('[data-cgui="sidebar"] [data-cgui="search-hit"], [data-cgui="sidebar"] button.sidebar-item').filter({ hasText: mark }).first();
  await expect(async () => {
    await search.click();
    await search.fill(mark);
    await expect(search).toHaveValue(mark, { timeout: 2_000 });
    await expect(hit).toBeVisible({ timeout: 8_000 });
  }).toPass({ timeout: 60_000 });
  await hit.click();
  try { await expect(search).toHaveValue('', { timeout: 5_000 }); } catch { await search.fill(''); }
  await expect(page.getByText(replyText).first(), '历史会话应已打开').toBeVisible({ timeout: 30_000 });
}

/** 造一份 count 条会话、开页面、打开它。返回 { S, errors };errors 收集未捕获的页面错误。 */
export async function openFixture(page, name, count = 600) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const S = seedHistory(name, { count });
  await boot(page);
  await openSessionBySearch(page, S.texts[0], S.texts[count - 1]);
  await expect.poll(() => rowCount(page), { message: '前置:首屏应已挂载消息行', timeout: 30_000 }).toBeGreaterThanOrEqual(100);
  await expect(entry(page).first(), '前置:600 条会话首屏应有「加载更早」入口').toBeVisible({ timeout: 20_000 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await sleep(500);
  return { S, errors };
}

// ───────────── 消息区读数 ─────────────
/** { top, sh, ch, dist }:dist = scrollHeight − scrollTop − clientHeight。 */
export async function metrics(page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-cgui="message-list"]');
    if (!el) return null;
    return { top: el.scrollTop, sh: el.scrollHeight, ch: el.clientHeight, dist: el.scrollHeight - el.scrollTop - el.clientHeight };
  });
}
export async function metricsOrFail(page) {
  const m = await metrics(page);
  expect(m, '读不到消息区([data-cgui="message-list"])').not.toBeNull();
  return m;
}

/** 视口里第一条完整可见的消息行:{ uuid, text, dist },dist = 行上边到消息区上边(CSS px)。 */
export async function firstVisibleRow(page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-cgui="message-list"]');
    if (!el) return null;
    const box = el.getBoundingClientRect();
    for (const r of el.querySelectorAll('[data-turn-uuid]')) {
      const b = r.getBoundingClientRect();
      if (b.height > 0 && b.top >= box.top - 0.5 && b.top < box.top + el.clientHeight) {
        return { uuid: r.getAttribute('data-turn-uuid'), text: (r.textContent || '').trim().slice(0, 40), dist: b.top - box.top };
      }
    }
    return null;
  });
}
/** 指定消息行(按 data-turn-uuid)到消息区上边的距离;不在页面上返回 null。 */
export async function rowDist(page, uuid) {
  return page.evaluate((u) => {
    const el = document.querySelector('[data-cgui="message-list"]');
    if (!el) return null;
    const r = Array.from(el.querySelectorAll('[data-turn-uuid]')).find((x) => x.getAttribute('data-turn-uuid') === u);
    return r ? r.getBoundingClientRect().top - el.getBoundingClientRect().top : null;
  }, uuid);
}
/** 含该正文的消息行是否有一部分在视口内。 */
export async function textInView(page, text) {
  return page.evaluate((t) => {
    const el = document.querySelector('[data-cgui="message-list"]');
    if (!el) return false;
    const box = el.getBoundingClientRect();
    return Array.from(el.querySelectorAll('[data-turn-uuid]')).some((r) => {
      if (!(r.textContent || '').includes(t)) return false;
      const b = r.getBoundingClientRect();
      return b.height > 0 && b.bottom > box.top && b.top < box.bottom;
    });
  }, text);
}
/** 一次取全页面上「提示行」的证据:[data-turn-placeholder] 个数 + 含「尚未加载」的文字个数 + 文字。 */
export async function placeholderFacts(page) {
  const marked = page.locator('[data-turn-placeholder]');
  const byText = list(page).getByText(/尚未加载/);
  const n = await marked.count();
  return { marked: n, byText: await byText.count(), text: n ? (await marked.first().innerText()).trim() : null };
}

// ───────────── 滚轮 ─────────────
async function hover(page) {
  const box = await list(page).boundingBox();
  expect(box, '消息区没有可见区域,没法滚轮').not.toBeNull();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}
/** 滚轮往上翻到最顶(scrollTop ≤ 1),并等布局稳住后再确认一次。 */
export async function toTop(page, maxMs = 30_000) {
  await hover(page);
  const t0 = Date.now();
  for (;;) {
    const m = await metricsOrFail(page);
    if (m.top <= 1) {
      await sleep(400);
      const m2 = await metricsOrFail(page);
      if (m2.top <= 1) return m2;
    }
    if (Date.now() - t0 > maxMs) return m;
    await page.mouse.wheel(0, -2500);
    await sleep(150);
  }
}
/** 滚轮往下翻,直到 scrollTop ≥ target(每步 300px)。 */
export async function wheelDownTo(page, target, maxMs = 30_000) {
  await hover(page);
  const t0 = Date.now();
  for (;;) {
    const m = await metricsOrFail(page);
    if (m.top >= target || Date.now() - t0 > maxMs) return m;
    await page.mouse.wheel(0, 300);
    await sleep(80);
  }
}
/** 只往上滚直到滚不动:scrollTop ≤ 1 且消息行数、总高度连续 5 次采样(每次 250ms)都不变。最多 maxMs。 */
export async function wheelUpUntilStuck(page, maxMs = 90_000) {
  await hover(page);
  const t0 = Date.now();
  let last = null;
  let same = 0;
  for (;;) {
    await page.mouse.wheel(0, -2500);
    await sleep(250);
    const m = await metricsOrFail(page);
    const sig = `${m.top <= 1}|${await rowCount(page)}|${m.sh}`;
    same = m.top <= 1 && sig === last ? same + 1 : 0;
    last = sig;
    if (same >= 5 || Date.now() - t0 > maxMs) return { ...m, rows: await rowCount(page), timedOut: same < 5 };
  }
}

// ───────────── 加载更早 / 追加刷新 ─────────────
/** 先翻到顶,再点一次「加载更早」入口,等这次请求 200 落地、入口恢复、布局稳住。 */
export async function clickLoadOlderAtTop(page, { settleMs = 800 } = {}) {
  await toTop(page);
  const responseP = page.waitForResponse((res) => {
    try { const u = new URL(res.url()); return /\/api\/sessions\/[^/]+\/messages$/.test(u.pathname) && u.searchParams.has('before'); } catch { return false; }
  }, { timeout: 60_000 });
  const e = entry(page).first();
  await expect(e, '点之前「加载更早」入口应可见').toBeVisible({ timeout: 20_000 });
  await e.dispatchEvent('click');
  const res = await responseP;
  expect(res.status(), '「加载更早」请求应 200').toBe(200);
  const btn = page.locator('[data-history-load-older] button');
  if (await btn.count()) await expect(btn).toBeEnabled({ timeout: 20_000 });
  await sleep(settleMs);
}
/** 翻到顶后记下第一条消息行,点一次入口,返回 { before, afterDist }(afterDist = null 表示那条消息行已不在页面上)。 */
export async function clickAndTrackFirstRow(page) {
  await toTop(page);
  const before = await firstVisibleRow(page);
  expect(before, '前置:翻到顶后视口里应有消息行').not.toBeNull();
  await clickLoadOlderAtTop(page);
  return { before, afterDist: await rowDist(page, before.uuid) };
}

/** 往会话文件追加 n 条并让页面刷新(同 r151l B4:派发 cgui:sessions-changed),等刷新应答落地并稳住。返回新消息正文数组。 */
export async function appendAndRefresh(page, S, n) {
  const texts = appendMessages(S, n);
  const responseP = page.waitForResponse((res) => {
    try { const u = new URL(res.url()); return u.pathname === `/api/sessions/${encodeURIComponent(S.sid)}/messages` && !u.searchParams.has('before'); } catch { return false; }
  }, { timeout: 30_000 });
  await page.evaluate((sid) => {
    window.dispatchEvent(new CustomEvent('cgui:sessions-changed', { detail: { path: `/${sid}.jsonl` } }));
  }, S.sid);
  await responseP;
  await sleep(1_500);
  return texts;
}
