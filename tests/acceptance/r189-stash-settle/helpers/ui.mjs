// r189 界面操作层:只按用户看得见的东西定位(侧栏会话行、输入框、发送/停止按钮、对话列表里的气泡)。
// 从 r118-switch-back/helpers/ui.mjs 派生。
import { expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

export async function boot(page) {
  await page.addInitScript(() => { try { localStorage.setItem('cgui-tour-seen', '1'); } catch {} });
  for (const api of ['**/api/version-check', '**/api/claude-version-check']) {
    await page.route(api, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hasUpdate: false, localBuild: true }) }));
  }
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 40_000 });
}

const hitRow = (page, mark) =>
  page.locator('[data-cgui="sidebar"] [data-cgui="search-hit"], [data-cgui="sidebar"] button.sidebar-item')
    .filter({ hasText: mark }).first();

/** 夹具项目第一次必须走搜索才进侧栏;打开一次之后它的会话才作为侧栏行出现。 */
export async function openSessionBySearch(page, mark) {
  const search = page.getByRole('complementary').getByRole('textbox', { name: /搜索工作区/ });
  await expect(async () => {
    await search.click();
    await search.fill(mark);
    await expect(search).toHaveValue(mark, { timeout: 2_000 });
    await expect(hitRow(page, mark)).toBeVisible({ timeout: 8_000 });
  }).toPass({ timeout: 60_000 });
  await hitRow(page, mark).click();
  try { await expect(search).toHaveValue('', { timeout: 5_000 }); } catch { await search.fill(''); }
  await page.waitForTimeout(800);
}

export const sessionRow = (page, mark) => page.locator('[role=button].sidebar-item').filter({ hasText: mark }).first();

export async function switchTo(page, mark) {
  const row = sessionRow(page, mark);
  await expect(row, `侧栏里应能看到会话 ${mark}`).toBeVisible({ timeout: 15_000 });
  await row.click();
  await page.waitForTimeout(500);
}

export const composer = (page) => page.getByPlaceholder(/输入消息|开始一个新会话/).last();

export async function sendPrompt(page, text) {
  const box = composer(page);
  await expect(box).toBeVisible({ timeout: 15_000 });
  await box.fill(text);
  await box.press('Enter');
}
/** 点发送按钮发(斜杠命令用,避开斜杠菜单抢回车)。 */
export async function sendByButton(page, text) {
  const box = composer(page);
  await expect(box).toBeVisible({ timeout: 15_000 });
  await box.fill(text);
  await page.getByRole('button', { name: '发送' }).first().click();
}

export const stopButton = (page) => page.getByRole('button', { name: /^停止/ });

/** 等这一轮"正在生成":第一块文字出现 + 停止按钮可用。 */
export async function waitTurnRunning(page, chunk1Text) {
  await expect(page.getByText(chunk1Text, { exact: false }).first(), '回合应吐出第一块文字').toBeVisible({ timeout: 30_000 });
  await expect(stopButton(page), '回合进行中应有可用的停止按钮').toBeEnabled({ timeout: 10_000 });
}

// ───── 对话列表观察 ─────
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 内容等于 text 的用户气泡个数(精确相等,首尾空白忽略)。 */
export const userBubbleCount = (page, text) =>
  page.locator('.chat-user-bubble').filter({ hasText: new RegExp(`^\\s*${esc(text)}\\s*$`) }).count();
/** 含这段文字的助手文字块个数。 */
export const assistantBlockCount = (page, text) => page.locator('.markdown-content').filter({ hasText: text }).count();
export const messageList = (page) => page.locator('[data-cgui="message-list"]');
export const messageRows = (page) => messageList(page).locator('[data-turn-uuid]');
export const listText = (page) => messageList(page).innerText().catch(() => '');
export const scrubberScope = (page) => page.locator('[data-cgui="scrubber-scope"]');

/** 假命令行的控制文件。 */
const ctlFile = (ctl, sid, suffix) => path.join(ctl, `${sid}${suffix}`);
export const releaseChunk2 = (ctl, sid) => fs.writeFileSync(ctlFile(ctl, sid, '.chunk'), String(Date.now()));
export const releaseTurnEnd = (ctl, sid) => fs.writeFileSync(ctlFile(ctl, sid, '.done'), String(Date.now()));
export const resetPhase = (ctl, sid) => { try { fs.unlinkSync(ctlFile(ctl, sid, '.phase')); } catch { /* 本来就没有 */ } };
export const setDeferUser = (ctl) => fs.writeFileSync(path.join(ctl, 'defer-user'), '1');
export const clearDeferUser = (ctl) => { try { fs.unlinkSync(path.join(ctl, 'defer-user')); } catch { /* 本来就没有 */ } };
export function releaseAllRuns(ctl) {
  let names = [];
  try { names = fs.readdirSync(ctl); } catch { return; }
  for (const name of names) {
    const m = /^(.+)\.started$/.exec(name);
    if (!m) continue;
    fs.writeFileSync(path.join(ctl, `${m[1]}.chunk`), 'x');
    fs.writeFileSync(path.join(ctl, `${m[1]}.done`), 'x');
  }
}
/** 等假命令行把回合走到某个阶段(读它落的 phase 文件)。 */
export async function waitPhase(page, ctl, sid, want, ms = 30_000) {
  const deadline = Date.now() + ms;
  let got = '';
  for (;;) {
    try { got = fs.readFileSync(ctlFile(ctl, sid, '.phase'), 'utf8').trim(); } catch { got = ''; }
    if (got === want) return;
    if (Date.now() > deadline) throw new Error(`夹具没准备好:假命令行 ${ms}ms 内没走到阶段 ${want}(现在是「${got}」)`);
    await page.waitForTimeout(150);
  }
}
