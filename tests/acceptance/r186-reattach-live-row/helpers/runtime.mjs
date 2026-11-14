// r186-reattach-live-row 验收套件的运行时守卫与导航。
// 铁规:只连 127.0.0.1 上本套件自己的隔离实例;只通过页面(文案 / role / data-* 锚点)观测,不读源码、不读应用内部状态。
import fs from 'node:fs';
import { expect } from '@playwright/test';
import { manifestPath, readStage } from './fixtures.mjs';

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
  if ([6677, 6689, 6710, 8788, 8789, 8798, 8799].includes(port)) throw new EnvironmentBlocked(`port ${port} is reserved`);
  if (port < 6700 || port > 6999) throw new EnvironmentBlocked(`port ${port} is outside the reserved test range (6700-6999)`);
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

/** 每个页面的未捕获错误清单(用例的 page 夹具登记)。 */
export const pageErrorLists = new WeakMap();

export async function reloadApp(page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  // 刷新瞬间,旧文档里被取消的在途请求(WebKit 报「Fetch API cannot load … due to access control checks」)是页面卸载的副作用,
  // 不是刷新后新页面的未捕获错误:刷新完成时把旧文档遗留的错误清掉,之后新页面上出现的才算数。
  const list = pageErrorLists.get(page);
  if (list) list.length = 0;
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

/** 点侧栏会话行。who = 'seed'(带种子标记的那一行)| 'fresh'(本工作区里不是种子的那一行,即用例新建的会话)。 */
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

export function composerBox(page) {
  return page.getByPlaceholder(/输入消息|开始一个新会话|发消息|问点什么/).or(page.locator('textarea'));
}

export async function sendText(page, text) {
  const box = composerBox(page).last();
  await expect(box).toBeVisible({ timeout: 15_000 });
  await box.fill(text);
  await box.press('Enter');
}

/** 打开应用 → 展开本用例工作区 → 点开种子会话(确认历史回合已显示)。 */
export async function openSeedSession(page, ctx) {
  await openApp(page);
  await openWorkspaceGroup(page, ctx);
  await clickSession(page, 'seed', ctx);
  await expect(page.locator('[data-cgui="message-list"]'), '种子会话的历史回复应显示').toContainText('R186SEED-历史回合收尾', { timeout: 20_000 });
}

/** 打开种子会话后点「新建会话」,停在这个工作区里的一个全新空会话上(输入框可用)。 */
export async function openNewSession(page, ctx) {
  await openSeedSession(page, ctx);
  const btn = page.getByRole('button', { name: '新建会话' }).first();
  await expect(btn, '应有「新建会话」按钮').toBeVisible({ timeout: 15_000 });
  await btn.click();
  await expect(composerBox(page).last(), '点「新建会话」后应出现输入框').toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-cgui="message-list"]').filter({ hasText: 'R186SEED-历史回合收尾' }), '新会话里不应还留着种子会话的历史回复').toHaveCount(0, { timeout: 10_000 });
}

/** 等假命令行进入某阶段(读夹具阶段文件);超时抛错并写明读到的最后值。 */
export async function waitStage(page, ctx, stage, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = readStage(ctx.workspaceName);
    if (last === stage) return;
    if (Date.now() >= end) throw new Error(`假命令行 ${timeoutMs}ms 内没进入阶段 ${stage};最后阶段 = ${last}`);
    await page.waitForTimeout(100);
  }
}

/** 停止键不在(回合已结束);最多等 timeoutMs,返回最终是否不在。 */
export async function waitStopGone(page, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if ((await stopBtn(page).count()) === 0) return true;
    if (Date.now() >= end) return false;
    await page.waitForTimeout(100);
  }
}

export function uniqueTag(prefix = '') { return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`; }
