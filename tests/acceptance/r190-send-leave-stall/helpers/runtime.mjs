// r190-send-leave-stall 验收套件的运行时守卫、导航与页面观测。
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
  if (!baseURL) throw new EnvironmentBlocked('set BASE_URL to the isolated test instance (use run.sh)');
  const url = new URL(baseURL);
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) throw new EnvironmentBlocked('BASE_URL must be loopback');
  const port = Number(url.port || 80);
  if ([6677, 6689, 6710, 8788, 8789, 8798, 8799].includes(port)) throw new EnvironmentBlocked(`port ${port} is reserved`);
  if (port < 6700 || port > 6999) throw new EnvironmentBlocked(`port ${port} is outside the reserved test range (6700-6999)`);
  return { baseURL: url.toString().replace(/\/$/, ''), port };
}

export function fixtureManifest() {
  const file = manifestPath();
  if (!fs.existsSync(file)) throw new EnvironmentBlocked(`missing ${file}; run.sh creates it`);
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

export const ROWS = '[data-cgui="session-row"]';
const projectRow = (page, ctx) => page.locator('[data-cgui="project-row"]').filter({ hasText: ctx.workspaceName });
export const sessionRows = (page) => page.locator(ROWS);

/** 展开本用例工作区在侧栏里的分组(已展开就不动)。 */
export async function openWorkspaceGroup(page, ctx) {
  const pr = projectRow(page, ctx).first();
  await expect(pr, `侧栏里应有本用例的工作区 ${ctx.workspaceName}`).toBeVisible({ timeout: 30_000 });
  if ((await pr.getAttribute('aria-expanded')) !== 'true') await pr.click();
  await expect(sessionRows(page).first(), '展开工作区后应出现会话行').toBeVisible({ timeout: 15_000 });
}

/** 点侧栏里种子会话那一行(带本用例种子标记的行)。 */
export async function clickSeedRow(page, ctx, { timeout = 20_000 } = {}) {
  const row = sessionRows(page).filter({ hasText: ctx.seed.marker }).first();
  await expect(row, '侧栏里应有种子会话行').toBeVisible({ timeout });
  await row.click({ timeout: 5_000 });
}

export function composerBox(page) {
  return page.getByPlaceholder(/输入消息|开始一个新会话|发消息|问点什么/).or(page.locator('textarea'));
}

/** 页面已打开且展开了本工作区时:点开种子会话 → 点「新建会话」,返回时停在一个全新空会话上(输入框可用)。 */
export async function enterNewSessionFromLoaded(page, ctx) {
  await openWorkspaceGroup(page, ctx);
  await clickSeedRow(page, ctx);
  await expect(page.locator('[data-cgui="message-list"]'), '种子会话的历史回复应显示').toContainText('R190 历史回复', { timeout: 20_000 });
  const btn = page.getByRole('button', { name: '新建会话' }).first();
  await expect(btn, '应有「新建会话」按钮').toBeVisible({ timeout: 15_000 });
  await btn.click();
  await expect(composerBox(page).last(), '点「新建会话」后应出现输入框').toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-cgui="message-list"]').filter({ hasText: 'R190 历史回复' }), '新会话里不应还留着种子会话的历史回复').toHaveCount(0, { timeout: 10_000 });
}

/** 打开应用 → 进入本工作区的全新空会话。 */
export async function openNewSession(page, ctx) {
  await openApp(page);
  await enterNewSessionFromLoaded(page, ctx);
}

export async function sendText(page, text) {
  const box = composerBox(page).last();
  await expect(box).toBeVisible({ timeout: 15_000 });
  await box.fill(text);
  await box.press('Enter');
}

// ───────────────────────── 页面观测 ─────────────────────────
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 内容恰好等于 text 的用户气泡个数(首尾空白忽略)。 */
export const userBubbleCount = (page, text) =>
  page.locator('.chat-user-bubble').filter({ hasText: new RegExp(`^\\s*${esc(text)}\\s*$`) }).count();
/** 含这段文字的助手文字块个数。 */
export const assistantBlockCount = (page, text) => page.locator('.markdown-content').filter({ hasText: text }).count();

/** 等夹具状态文件里「已处理完」的用户消息条数 ≥ n;超时返回读到的最后值。 */
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

export function uniqueTag(prefix = '') { return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`; }
