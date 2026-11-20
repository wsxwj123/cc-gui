// r205-rollback-trim-reason 验收套件的运行时守卫、导航与页面观测。
// 铁规:只连 127.0.0.1 上本套件自己的隔离实例;只通过页面(文案 / role / title / data-* 锚点)和后端输出文件观测,不读源码、不读应用内部状态。
import fs from 'node:fs';
import { expect } from '@playwright/test';
import { manifestPath, serverStderrPath, serverStdoutPath } from './fixtures.mjs';

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

// ───────────────────────── 后端输出 ─────────────────────────
function sizeOf(file) { try { return fs.statSync(file).size; } catch { return 0; } }
function readFrom(file, offset) {
  try {
    const buf = fs.readFileSync(file);
    return buf.subarray(Math.min(offset, buf.length)).toString('utf8');
  } catch { return ''; }
}
/** 记下此刻后端 stdout / stderr 文件的长度;之后只看「这一刻之后」新写的内容。 */
export function markServerOutput() {
  return { err: sizeOf(serverStderrPath()), out: sizeOf(serverStdoutPath()) };
}
export function stderrSince(mark) { return readFrom(serverStderrPath(), mark.err); }
export function stdoutSince(mark) { return readFrom(serverStdoutPath(), mark.out); }
/** 这一刻之后,stdout 与 stderr 里所有含 [history-op] 的行。 */
export function historyOpLinesSince(mark) {
  return `${stderrSince(mark)}\n${stdoutSince(mark)}`.split('\n').filter((l) => l.includes('[history-op]'));
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

export const ROWS = '[data-cgui="session-row"]';
export const sessionRows = (page) => page.locator(ROWS);
const projectRow = (page, ctx) => page.locator('[data-cgui="project-row"]').filter({ hasText: ctx.workspaceName });

/** 展开本用例工作区在侧栏里的分组(已展开就不动)。 */
export async function openWorkspaceGroup(page, ctx) {
  const pr = projectRow(page, ctx).first();
  await expect(pr, `侧栏里应有本用例的工作区 ${ctx.workspaceName}`).toBeVisible({ timeout: 30_000 });
  if ((await pr.getAttribute('aria-expanded')) !== 'true') await pr.click();
  await expect(sessionRows(page).first(), '展开工作区后应出现会话行').toBeVisible({ timeout: 15_000 });
}

/** 点侧栏里含 text 的会话行。 */
export async function clickRowWith(page, text, { timeout = 20_000 } = {}) {
  const row = sessionRows(page).filter({ hasText: text }).first();
  await expect(row, `侧栏里应有含「${text}」的会话行`).toBeVisible({ timeout });
  await row.click({ timeout: 5_000 });
}

/** 打开页面并进入用例的会话,等到「要回退的那条用户消息」显示出来。 */
export async function openCaseSession(page, c) {
  await openApp(page);
  await openWorkspaceGroup(page, c);
  await clickRowWith(page, c.marker);
  await expect(messageCard(page, c.targetText), `会话里应显示要回退的用户消息「${c.targetText}」`).toBeVisible({ timeout: 20_000 });
}

// ───────────────────────── 回退入口 ─────────────────────────
/** 页面上正文含 text 的那条消息卡片。 */
export const messageCard = (page, text) => page.locator('[data-message-id]').filter({ hasText: text }).first();

/** 悬停用户消息 → 点「回滚 / 重新编辑」→ 点菜单里的「仅回退消息」(只回退,不重发)。 */
export async function rollbackOnly(page, text) {
  const card = messageCard(page, text);
  await card.hover();
  await card.getByTitle('回滚 / 重新编辑').click();
  // 只认真正的 <button>:侧栏会话行是 div[role=button],它的名字(会话标题)可能恰好含菜单项的字。
  await page.getByRole('button', { name: /仅回退消息/ }).and(page.locator('button')).click();
}

export const TRIM_FAILED = '会话记录裁剪失败';
export const TRIM_FAILED_FULL = '会话记录裁剪失败，会话记录没有改动，原定的重发没有发出。';

/** 页面可见文字(整页 body)。 */
export const bodyText = (page) => page.locator('body').innerText();

/** 等页面出现「会话记录裁剪失败」黄字(最长 timeoutMs);返回此时整页文字。 */
export async function waitTrimFailedNotice(page, timeoutMs = 30_000) {
  await expect(page.locator('body'), `点回退后页面应出现黄字「${TRIM_FAILED}」`).toContainText(TRIM_FAILED, { timeout: timeoutMs });
  return bodyText(page);
}
