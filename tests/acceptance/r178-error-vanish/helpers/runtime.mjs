// r178-error-vanish 验收套件的运行时守卫、导航与页面观测。
// 铁规:只连 127.0.0.1 上本套件自己的隔离实例;只通过页面(文案 / role / data-* 锚点)观测,不读源码、不读应用内部状态。
import fs from 'node:fs';
import { expect } from '@playwright/test';
import { manifestPath, readStatus } from './fixtures.mjs';

export class EnvironmentBlocked extends Error {
  constructor(message) {
    super(`ENVIRONMENT_BLOCKED: ${message}`);
    this.name = 'EnvironmentBlocked';
  }
}

export function getRuntime() {
  const baseURL = process.env.BASE_URL;
  if (!baseURL) throw new EnvironmentBlocked('set BASE_URL to the isolated test instance (use run-isolated.sh)');
  const url = new URL(baseURL);
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) throw new EnvironmentBlocked('BASE_URL must be loopback');
  const port = Number(url.port || 80);
  if ([6677, 6689, 6710, 8798, 8799].includes(port)) throw new EnvironmentBlocked(`port ${port} is reserved`);
  if (port < 6700 || port > 6799) throw new EnvironmentBlocked(`port ${port} is outside the reserved test range (6700-6799)`);
  return { baseURL: url.toString().replace(/\/$/, ''), port };
}

export function fixtureManifest() {
  const file = manifestPath();
  if (!fs.existsSync(file)) throw new EnvironmentBlocked(`missing ${file}; run-isolated.sh creates it`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ───────────────────────── 导航 ─────────────────────────
const OVERLAY_DISMISS = ['关闭指引', '跳过', '稍后', '知道了'];

export async function dismissOverlays(page) {
  for (const name of OVERLAY_DISMISS) {
    const b = page.getByRole('button', { name, exact: true });
    if ((await b.count()) && (await b.first().isVisible().catch(() => false))) {
      await b.first().click().catch(() => {});
      await page.waitForTimeout(150);
    }
  }
}

export async function openApp(page) {
  await page.addInitScript(() => { try { localStorage.setItem('cgui-tour-seen', '1'); } catch { /* 忽略 */ } });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await dismissOverlays(page);
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 60_000 });
}

export async function reloadApp(page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await dismissOverlays(page);
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 60_000 });
}

export const stopBtn = (page) => page.locator('[data-cgui="stop-btn"]');
const projectRow = (page, ctx) => page.locator('[data-cgui="project-row"]').filter({ hasText: ctx.workspaceName });
const sessionRows = (page) => page.locator('[data-cgui="session-row"]');

/** 展开本用例工作区在侧栏里的分组(已展开就不动)。 */
export async function openWorkspaceGroup(page, ctx) {
  const pr = projectRow(page, ctx).first();
  await expect(pr, `侧栏里应有本用例的工作区 ${ctx.workspaceName}`).toBeVisible({ timeout: 30_000 });
  if ((await pr.getAttribute('aria-expanded')) !== 'true') await pr.click();
  await expect(sessionRows(page).first(), '展开工作区后应出现会话行').toBeVisible({ timeout: 15_000 });
}

/** 点侧栏会话行。who = 'seed'(本用例工作区里带种子标记的那一行)| 'fresh'(本工作区里不是种子的那一行,即用例新建的会话)。 */
export async function clickSession(page, who, ctx, { timeout = 20_000 } = {}) {
  const rows = sessionRows(page);
  const deadline = Date.now() + timeout;
  let texts = [];
  for (;;) {
    texts = await rows.allInnerTexts();
    const idx = who === 'seed'
      ? texts.findIndex((t) => t.includes(ctx.seed.marker))
      : texts.findIndex((t) => !t.includes(ctx.seed.marker));
    if (idx >= 0) {
      await rows.nth(idx).click({ timeout: 5_000 });
      return;
    }
    if (Date.now() > deadline) throw new Error(`侧栏里 ${timeout}ms 内找不到「${who}」会话行;当前各行 = ${JSON.stringify(texts)}`);
    await page.waitForTimeout(150);
  }
}

/** 打开应用 → 展开本用例工作区 → 点开种子会话 → 点「新建会话」,返回时停在这个工作区里的一个全新空会话上(输入框可用)。 */
export async function openNewSession(page, ctx) {
  await openApp(page);
  await openWorkspaceGroup(page, ctx);
  await clickSession(page, 'seed', ctx);
  await expect(page.locator('[data-cgui="message-list"]'), '种子会话的历史回复应显示').toContainText('R178 历史回复', { timeout: 20_000 });
  const btn = page.getByRole('button', { name: '新建会话' }).first();
  await expect(btn, '应有「新建会话」按钮').toBeVisible({ timeout: 15_000 });
  await btn.click();
  await expect(composerBox(page).last(), '点「新建会话」后应出现输入框').toBeVisible({ timeout: 15_000 });
  // 空会话里消息区可能根本没挂上,所以用「带历史回复的消息区个数 = 0」判断,不用 not.toContainText(元素不存在会报错)。
  await expect(page.locator('[data-cgui="message-list"]').filter({ hasText: 'R178 历史回复' }), '新会话里不应还留着种子会话的历史回复').toHaveCount(0, { timeout: 10_000 });
}

export function composerBox(page) {
  return page.getByPlaceholder(/输入消息|开始一个新会话|发消息|问点什么/).or(page.locator('textarea'));
}

export async function sendText(page, text) {
  const box = composerBox(page).last();
  await expect(box).toBeVisible({ timeout: 15_000 });
  await box.fill(text);
  await box.press('Enter');
}

// ───────────────────────── 页面观测 ─────────────────────────
/** 读一次消息区([data-cgui="message-list"])的可见文字;消息区还没挂上返回空串。 */
export async function readList(page) {
  return await page.evaluate(() => {
    const ml = document.querySelector('[data-cgui="message-list"]');
    return ml ? ml.innerText : '';
  });
}

/** 子串在文字里出现的次数(不重叠)。 */
export function countOf(text, sub) {
  let n = 0;
  for (let i = text.indexOf(sub); i >= 0; i = text.indexOf(sub, i + sub.length)) n += 1;
  return n;
}

/**
 * 在页面里装一个高频观察器:每 25 毫秒 + 每次 DOM 变动都读一次消息区文字,记下每个子串此刻在不在,
 * 以及「第一次看到」的页面时刻。修复前报错块只存在 25~200 毫秒,外部几百毫秒一次的轮询来不及看到,所以必须在页面内轮询。
 */
export async function startMonitor(page, needles) {
  await page.evaluate((list) => {
    if (window.__r178mon) { clearInterval(window.__r178mon.timer); window.__r178mon.observer.disconnect(); }
    const mon = { samples: [], first: {}, needles: list, timer: 0, observer: null };
    const tick = () => {
      const ml = document.querySelector('[data-cgui="message-list"]');
      const text = ml ? ml.innerText : '';
      const t = performance.now();
      const has = list.map((n) => text.includes(n));
      list.forEach((n, i) => { if (has[i] && mon.first[n] === undefined) mon.first[n] = t; });
      mon.samples.push({ t, has });
    };
    mon.timer = setInterval(tick, 25);
    mon.observer = new MutationObserver(tick);
    mon.observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    window.__r178mon = mon;
  }, needles);
}

/** 等某个子串第一次出现在消息区(观察器记录),返回出现时刻(页面时间,毫秒);超时返回 null。 */
export async function waitFirstSeen(page, needle, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const t = await page.evaluate((n) => window.__r178mon.first[n] ?? null, needle);
    if (t != null) return t;
    if (Date.now() >= end) return null;
    await page.waitForTimeout(50);
  }
}

/** 等页面时钟走到 tPage(毫秒)。 */
async function waitPageTime(page, tPage) {
  await page.waitForFunction((t) => performance.now() >= t, tPage, { polling: 100, timeout: 60_000 });
}

/**
 * 从 t0 起连续 ms 毫秒,观察器的每一次采样里 needle 都在。
 * 返回 { ok, samples, maxGapMs, firstMissingAtMs }:firstMissingAtMs 是第一次不在时距 t0 多少毫秒(没缺过为 null);
 * maxGapMs 是窗口内相邻两次采样的最大间隔(要求 ≤ 500,否则「一直在」没有证明力)。
 */
export async function checkPresentFor(page, needle, t0, ms) {
  await waitPageTime(page, t0 + ms);
  return await page.evaluate(({ n, from, span }) => {
    const mon = window.__r178mon;
    const idx = mon.needles.indexOf(n);
    const win = mon.samples.filter((s) => s.t >= from && s.t <= from + span);
    let maxGap = 0;
    for (let i = 1; i < win.length; i += 1) maxGap = Math.max(maxGap, win[i].t - win[i - 1].t);
    if (win.length) maxGap = Math.max(maxGap, win[0].t - from, from + span - win[win.length - 1].t);
    else maxGap = span;
    const miss = win.find((s) => !s.has[idx]);
    return { ok: !miss && maxGap <= 500, samples: win.length, maxGapMs: Math.round(maxGap), firstMissingAtMs: miss ? Math.round(miss.t - from) : null };
  }, { n: needle, from: t0, span: ms });
}

/** 页面时间 t0 之后再过 ms 毫秒(用于「出现后 5 秒时」读一次现状)。 */
export async function waitAfter(page, t0, ms) { await waitPageTime(page, t0 + ms); }

/** 等夹具状态文件里「已处理完」的用户消息条数 ≥ n(回合结束事件已输出);超时返回读到的最后值。 */
export async function waitProcessed(page, ctx, n, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  let last = 0;
  for (;;) {
    const st = readStatus(ctx.workspaceName);
    last = st ? st.processed : last;
    if (last >= n) return last;
    if (Date.now() >= end) return last;
    await page.waitForTimeout(100);
  }
}

/** 停止键不在(回合已结束);最多等 15 秒,返回最终是否不在。 */
export async function waitStopGone(page, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if ((await stopBtn(page).count()) === 0) return true;
    if (Date.now() >= end) return false;
    await page.waitForTimeout(100);
  }
}

export function uniqueTag(prefix = '') { return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`; }

