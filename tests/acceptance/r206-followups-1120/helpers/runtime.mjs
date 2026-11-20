// r206-followups-1120 验收套件的运行时守卫、导航与页面观测。
// 铁规:只连 127.0.0.1 上本套件自己的隔离实例;只通过页面(文案 / role / data-* 锚点 / title)观测,不读源码、不读应用内部状态。
import fs from 'node:fs';
import { expect } from '@playwright/test';
import { manifestPath } from './fixtures.mjs';
import { OPEN_VIEW_TITLE } from './transcripts.mjs';

export const BACKEND_PORT = 6933;
export const PAGE_PORT = 6934;
const RESERVED = [6677, 6689, 6710, 8788, 8789, 8798, 8799];

export class EnvironmentBlocked extends Error {
  constructor(message) { super(`ENVIRONMENT_BLOCKED: ${message}`); this.name = 'EnvironmentBlocked'; }
}

export function getRuntime() {
  const baseURL = process.env.BASE_URL;
  if (!baseURL) throw new EnvironmentBlocked('set BASE_URL to the isolated test instance (use run-isolated.sh)');
  const url = new URL(baseURL);
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) throw new EnvironmentBlocked('BASE_URL must be loopback');
  const port = Number(url.port || 80);
  if (RESERVED.includes(port)) throw new EnvironmentBlocked(`port ${port} is reserved`);
  if (port !== PAGE_PORT) throw new EnvironmentBlocked(`port ${port} is not this suite's page port ${PAGE_PORT}`);
  return { baseURL: url.toString().replace(/\/$/, ''), port, backend: `http://127.0.0.1:${BACKEND_PORT}` };
}

export function fixtureManifest() {
  const file = manifestPath();
  if (!fs.existsSync(file)) throw new EnvironmentBlocked(`missing ${file}; run-isolated.sh creates it`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function uniqueTag(prefix = '') { return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`; }
export const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

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
export const messageList = (page) => page.locator('[data-cgui="message-list"]');
const projectRow = (page, ctx) => page.locator('[data-cgui="project-row"]').filter({ hasText: ctx.workspaceName });
const sessionRows = (page) => page.locator('[data-cgui="session-row"]');

export async function openWorkspaceGroup(page, ctx) {
  const pr = projectRow(page, ctx).first();
  await expect(pr, `侧栏里应有本用例的工作区 ${ctx.workspaceName}`).toBeVisible({ timeout: 30_000 });
  if ((await pr.getAttribute('aria-expanded')) !== 'true') await pr.click();
  await expect(sessionRows(page).first(), '展开工作区后应出现会话行').toBeVisible({ timeout: 15_000 });
}

/** who = 'seed'(含种子标记的那一行)| 'fresh'(本工作区里不含种子标记的那一行,即用例新建的会话)。 */
export async function clickSession(page, who, ctx, { timeout = 20_000 } = {}) {
  const rows = sessionRows(page);
  const deadline = Date.now() + timeout;
  let texts = [];
  for (;;) {
    texts = await rows.allInnerTexts();
    const idx = who === 'seed' ? texts.findIndex((t) => t.includes(ctx.seed.marker)) : texts.findIndex((t) => !t.includes(ctx.seed.marker));
    if (idx >= 0) { await rows.nth(idx).click({ timeout: 5_000 }); return; }
    if (Date.now() > deadline) throw new Error(`侧栏里 ${timeout}ms 内找不到「${who}」会话行;当前各行 = ${JSON.stringify(texts)}`);
    await page.waitForTimeout(150);
  }
}

export function composerBox(page) {
  return page.getByPlaceholder(/输入消息|开始一个新会话|发消息|问点什么/).or(page.locator('textarea'));
}

/** 打开应用 → 展开本用例工作区 → 点开种子会话 → 点「新建会话」,停在一个全新空会话上。 */
export async function openNewSession(page, ctx) {
  await openApp(page);
  await openWorkspaceGroup(page, ctx);
  await clickSession(page, 'seed', ctx);
  await expect(messageList(page), '种子会话的历史回复应显示').toContainText('R206 历史回复', { timeout: 20_000 });
  const btn = page.getByRole('button', { name: '新建会话' }).first();
  await expect(btn, '应有「新建会话」按钮').toBeVisible({ timeout: 15_000 });
  await btn.click();
  await expect(composerBox(page).last(), '点「新建会话」后应出现输入框').toBeVisible({ timeout: 15_000 });
  await expect(messageList(page).filter({ hasText: 'R206 历史回复' }), '新会话里不应还留着种子会话的历史回复').toHaveCount(0, { timeout: 10_000 });
}

export async function sendText(page, text) {
  const box = composerBox(page).last();
  await expect(box).toBeVisible({ timeout: 15_000 });
  await box.fill(text);
  await box.press('Enter');
}

/** 回合结束 = 停止键先出现、再消失。 */
export async function waitTurnEnded(page) {
  await expect(stopBtn(page), '发出消息后应先看到停止键(回合已开始)').toBeVisible({ timeout: 20_000 });
  await expect(stopBtn(page), '回合应当结束(停止键消失)').toHaveCount(0, { timeout: 60_000 });
}

/** 打开应用后刷新、展开工作区、点开历史会话(由夹具铺好文件)。 */
export async function openStaticSession(page, ctx) {
  await openApp(page);
  await reloadApp(page);
  await openWorkspaceGroup(page, ctx);
  await clickSession(page, 'seed', ctx);
  await expect(messageList(page), '历史会话的末尾回复应显示').toContainText(ctx.doneText, { timeout: 30_000 });
}

// ───────────────────────── 子代理:卡片 / 子代理页 / 监控面板 ─────────────────────────
/** 子代理卡片 = 一轮里含「在子代理会话窗口打开」按钮的那个条目。 */
export const cardEntry = (page) => page.locator('[data-entry-state]').filter({ has: page.locator(`[title="${OPEN_VIEW_TITLE}"]`) });

/** 工具调用收在折叠组里:点组头展开,直到子代理卡片可见。 */
export async function expandGroup(page) {
  const head = page.locator('[data-work-group-head]').first();
  await expect(head, '应有折叠组的组头').toBeVisible({ timeout: 20_000 });
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
  await expect(cardEntry(page).first(), '展开折叠组后应看到子代理卡片').toBeVisible({ timeout: 15_000 });
}

/** 展开卡片(已展开就不动);返回卡片范围。 */
export async function expandCard(page) {
  const card = cardEntry(page).first();
  const titleRow = card.locator('button[aria-expanded]').first();
  if ((await titleRow.getAttribute('aria-expanded')) !== 'true') await titleRow.click();
  return card;
}

export async function openSubagentView(page) {
  const card = cardEntry(page).first();
  await card.hover();
  await card.locator(`[title="${OPEN_VIEW_TITLE}"]`).first().click({ timeout: 10_000 });
  const view = page.locator('[data-cgui="subagent-view"]');
  await expect(view.first(), '点「在子代理会话窗口打开」后应出现子代理页').toBeVisible({ timeout: 15_000 });
  return view.first();
}
