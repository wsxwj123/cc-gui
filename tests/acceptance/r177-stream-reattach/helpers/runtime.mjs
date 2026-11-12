// r177-stream-reattach 验收套件的运行时守卫、导航与页面观测。
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

/** 点侧栏会话行。who = 'jia' | 'yi' | 'fresh'(本用例工作区里既不是甲也不是乙的那一行,即刚新建的会话)。
 *  甲的标题发过消息后可能被改写:找不到带甲标记的行时,退而取「不是乙」的第一行。 */
export async function clickSession(page, who, ctx, { timeout = 20_000 } = {}) {
  const rows = sessionRows(page);
  const deadline = Date.now() + timeout;
  let texts = [];
  for (;;) {
    texts = await rows.allInnerTexts();
    let idx = -1;
    if (who === 'yi') idx = texts.findIndex((t) => t.includes(ctx.yi.marker));
    else if (who === 'jia') {
      idx = texts.findIndex((t) => t.includes(ctx.jia.marker));
      if (idx < 0) idx = texts.findIndex((t) => !t.includes(ctx.yi.marker));
    } else idx = texts.findIndex((t) => !t.includes(ctx.yi.marker) && !t.includes(ctx.jia.marker));
    if (idx >= 0) {
      await rows.nth(idx).click({ timeout: 5_000 });
      return;
    }
    if (Date.now() > deadline) throw new Error(`侧栏里 ${timeout}ms 内找不到「${who}」会话行;当前各行 = ${JSON.stringify(texts)}`);
    await page.waitForTimeout(150);
  }
}

/** 打开应用、展开本用例工作区、点开甲,并等到甲的历史回复显示出来。 */
export async function openJia(page, ctx) {
  await openApp(page);
  await openWorkspaceGroup(page, ctx);
  await clickSession(page, 'jia', ctx);
  await expect(page.locator('[data-cgui="message-list"]'), '甲的历史回复应显示').toContainText('R177 历史回复', { timeout: 20_000 });
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
/** 读一次页面:正文片段数(消息区文字里 `片段\d{4}` 的出现个数)、停止键在不在、以及几组字样是否出现。 */
async function readPage(page) {
  return await page.evaluate(() => {
    const ml = document.querySelector('[data-cgui="message-list"]');
    const listText = ml ? ml.innerText : '';
    const m = listText.match(/片段\d{4}/g);
    const body = document.body.innerText;
    return {
      n: m ? m.length : 0,
      hasList: Boolean(ml),
      stop: Boolean(document.querySelector('[data-cgui="stop-btn"]')),
      takeover: /接管|连接中断/.test(body),
      interrupted: /Request interrupted|已中断/.test(body),
      startFail: /启动失败|fake start failure/.test(body),
      outputting: /正在输出/.test(body),
      listOutputting: /正在输出/.test(listText),
    };
  });
}

/** 一次观测:页面读数 + 读页面前后各读一次夹具状态文件(fxBefore / fxAfter,已输出片段数)。 */
export async function snap(page, ctx) {
  const b = readStatus(ctx.workspaceName);
  const t = Date.now();
  const p = await readPage(page);
  const a = readStatus(ctx.workspaceName);
  const fxBefore = b ? b.chunksEmitted : null;
  const fxAfter = a ? a.chunksEmitted : fxBefore;
  return { t, ...p, fxBefore, fxAfter: fxAfter ?? fxBefore, openedAt: a ? a.openedAt : null, ended: a ? Boolean(a.ended) : false, exitedAt: a ? a.exitedAt : null,interruptedAtChunks: a ? a.interruptedAtChunks : null };
}

/** 一路记录所有观测,供事后检查「观察期间每一次都没出现 X / 都有 Y」。 */
export class Watch {
  constructor(page, ctx, stepMs = 150) { this.page = page; this.ctx = ctx; this.stepMs = stepMs; this.samples = []; }
  async snap() { const s = await snap(this.page, this.ctx); this.samples.push(s); return s; }
  /** 反复观测直到 pred 成立或超时。返回 { ok, s(最后一次观测) }。 */
  async until(pred, timeoutMs) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const s = await this.snap();
      if (pred(s)) return { ok: true, s };
      if (Date.now() >= end) return { ok: false, s };
      await this.page.waitForTimeout(this.stepMs);
    }
  }
  /** 持续观测 ms 毫秒,返回最后一次观测。 */
  async hold(ms) {
    const end = Date.now() + ms;
    for (;;) {
      await this.page.waitForTimeout(Math.min(this.stepMs, Math.max(0, end - Date.now())));
      const s = await this.snap();
      if (Date.now() >= end) return s;
    }
  }
  /** 连续 count 个窗口,每个 windowMs 毫秒;返回每个窗口的 { start, end, grow }。 */
  async windows(count, windowMs) {
    const out = [];
    let start = await this.snap();
    for (let k = 0; k < count; k += 1) {
      const end = await this.holdUntil(start.t + windowMs);
      out.push({ start, end, grow: end.n - start.n });
      start = end;
    }
    return out;
  }
  async holdUntil(tMs) { return await this.hold(Math.max(0, tMs - Date.now())); }
  /** 等夹具开口(状态文件里 openedAt 有值),返回 T0;超时返回 null。 */
  async waitOpened(timeoutMs) {
    const r = await this.until((s) => s.openedAt != null, timeoutMs);
    return r.ok ? r.s.openedAt : null;
  }
  count(pred) { return this.samples.filter(pred).length; }
}

/** 断言每个窗口片段数至少增长 minGrow。 */
export function expectGrowth(wins, minGrow, what) {
  const grows = wins.map((w) => w.grow);
  const detail = wins.map((w) => `${w.start.n}→${w.end.n}`).join(' | ');
  expect(Math.min(...grows), `${what}:每个 3 秒窗口应至少多 ${minGrow} 片段;实际各窗口(起→止)= ${detail}`).toBeGreaterThanOrEqual(minGrow);
}

export function uniqueTag(prefix = '') { return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`; }
