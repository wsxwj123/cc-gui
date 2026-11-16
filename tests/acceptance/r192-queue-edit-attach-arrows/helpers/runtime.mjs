// r192-queue-edit-attach-arrows 验收套件的运行时守卫与导航。
// 铁规:只连 127.0.0.1 上本套件自己的隔离实例;只通过页面(文案 / role / data-* 锚点)观测,不读源码、不读应用内部状态。
import fs from 'node:fs';
import { expect } from '@playwright/test';
import { manifestPath } from './fixtures.mjs';

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
  if (port !== 6942) throw new EnvironmentBlocked(`port ${port} is not this suite's page port (6942)`);
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

/** 点侧栏会话行。who = 'jia' | 'yi'。甲的标题发过消息后可能被改写:找不到带甲标记的行时,退而取「不是乙」的第一行。 */
export async function clickSession(page, who, ctx, { timeout = 20_000 } = {}) {
  const rows = sessionRows(page);
  const deadline = Date.now() + timeout;
  let texts = [];
  for (;;) {
    texts = await rows.allInnerTexts();
    let idx = -1;
    if (who === 'yi') idx = texts.findIndex((t) => t.includes(ctx.yi.marker));
    else {
      idx = texts.findIndex((t) => t.includes(ctx.jia.marker));
      if (idx < 0) idx = texts.findIndex((t) => !t.includes(ctx.yi.marker));
    }
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
  await expect(page.locator('[data-cgui="message-list"]'), '甲的历史回复应显示').toContainText('R192 历史回复', { timeout: 20_000 });
}

export const composerBox = (page) => page.locator('textarea[data-cgui="composer-input"]');

/** 在当前会话发一条消息(会真的触发一轮);等到页面真的向后端发出「发起对话」的请求(等不到也不报错,后面的读数会说明问题)。 */
export async function sendMessage(page, text) {
  const isChatStart = (r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/chat';
  const posted = page.waitForRequest(isChatStart, { timeout: 15_000 }).catch(() => null);
  const box = composerBox(page);
  await expect(box).toBeVisible({ timeout: 15_000 });
  await box.fill(text);
  await box.press('Enter');
  await posted;
}

export function uniqueTag(prefix = '') { return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`; }

/** 对某条用户消息卡打开「回滚 / 重新编辑」菜单并点指定菜单项(itemName 为菜单项可见文字的正则)。取自 r182 套件的同名函数。 */
export async function pickRollbackItem(page, prompt, itemName, what) {
  const card = page.locator('[data-cgui="message-user"]').filter({ hasText: prompt }).first();
  await expect(card, `${what}:这条用户消息卡应带 data-message-id(最多等 5 秒)`).toHaveAttribute('data-message-id', /.+/, { timeout: 5_000 });
  // 回合刚结束的头一两秒,消息列表会重排、用户消息卡可能被重新挂载,刚打开的菜单会跟着消失。
  // 所以「悬停 → 点菜单键 → 点菜单项」整组重来:每步短超时,点不到就从悬停重新开始;菜单项一点成功立刻返回(不会点两次)。
  const STEP_MS = 1_200;
  const TOTAL_MS = 8_000;
  const start = Date.now();
  let attempt = 0;
  let lastStep = '悬停用户消息卡';
  let lastErr = '';
  while (Date.now() - start < TOTAL_MS) {
    attempt += 1;
    try {
      lastStep = '悬停用户消息卡';
      await card.hover({ timeout: STEP_MS });
      lastStep = '点「回滚 / 重新编辑」';
      await card.getByTitle('回滚 / 重新编辑').click({ timeout: STEP_MS });
      lastStep = `点菜单项 ${itemName}`;
      await page.getByRole('button', { name: itemName }).click({ timeout: STEP_MS });
      return;
    } catch (e) {
      lastErr = String(e && e.message ? e.message : e).split('\n')[0];
      await page.waitForTimeout(150);
    }
  }
  throw new Error(`${what}:${TOTAL_MS} 毫秒内共尝试 ${attempt} 次仍没点到菜单项 ${itemName};最后一次(第 ${attempt} 次)卡在「${lastStep}」:${lastErr}`);
}
