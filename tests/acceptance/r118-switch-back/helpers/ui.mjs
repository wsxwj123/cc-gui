// r118 界面操作层:只按用户看得见的东西定位(侧栏会话行、输入框、发送/停止按钮、页面文字)。
// 依据只有 .devflow/INTERFACE-r118.md §A:会话切换 = 点会话列表里的另一条再点回来。
import { expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { live } from './fixtures.mjs';

// INTERFACE §A 的逐字文案
export const TAKEOVER = '↪ 此运行已在另一处查看';
export const BANNER = '这个会话仍在后台工作中 · 新内容会随生成自动追加';
export const BANNER_LOOSE = '这个会话仍在后台工作中';   // 只认主干(横幅尾部措辞若改,断言仍指向同一条横幅)

export const takeoverCount = (page) => page.getByText(TAKEOVER.replace('↪ ', ''), { exact: false }).count();
export const bannerCount = (page) => page.getByText(BANNER_LOOSE, { exact: false }).count();

/** 进应用并压掉旅游浮层/更新检查。 */
export async function boot(page) {
  await page.addInitScript(() => { try { localStorage.setItem('cgui-tour-seen', '1'); } catch {} });
  for (const api of ['**/api/version-check', '**/api/claude-version-check']) {
    await page.route(api, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hasUpdate: false, localBuild: true }) }));
  }
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 40_000 });
}

/**
 * 打开某条夹具会话。实测:夹具项目不进侧栏常规列表(显示"没有找到项目"),第一次必须走搜索;
 * 打开一次之后它的会话才作为侧栏行出现(见 sessionRow)。
 */
export async function openSessionBySearch(page, mark) {
  const search = page.getByRole('complementary').getByRole('textbox', { name: /搜索项目/ });
  await expect(async () => {
    await search.click();
    await search.fill(mark);
    await expect(search).toHaveValue(mark, { timeout: 2_000 });
    await expect(page.getByRole('button', { name: new RegExp(mark) }).first()).toBeVisible({ timeout: 8_000 });
  }).toPass({ timeout: 60_000 });
  await page.getByRole('button', { name: new RegExp(mark) }).first().click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);
}

/** 侧栏里那条会话(实测 = div[role=button].sidebar-item,名字是会话标题)。 */
export const sessionRow = (page, mark) => page.locator('[role=button].sidebar-item').filter({ hasText: mark }).first();

/** 用户切会话:点另一条会话的行(INTERFACE §A 的切换方式)。 */
export async function switchTo(page, mark) {
  const row = sessionRow(page, mark);
  await expect(row, `侧栏里应能看到会话 ${mark}`).toBeVisible({ timeout: 15_000 });
  await row.click();
  await page.waitForTimeout(500);   // 让窗格把会话换过来再开始观察(换的过程中界面还是旧会话)
}

export const composer = (page) => page.getByPlaceholder(/输入消息|开始一个新会话/).last();

/** 在一个会话里发一条消息(打字 + Enter)。 */
export async function sendPrompt(page, text) {
  const box = composer(page);
  await expect(box).toBeVisible({ timeout: 15_000 });
  await box.fill(text);
  await box.press('Enter');
}

/** 等这一轮"正在生成":假 CLI 吐出第一块文字 + 停止按钮可用。 */
export async function waitTurnRunning(page, sid, prompt) {
  await expect(page.getByText(live.chunk1(sid, prompt), { exact: false }).first(), '回合应吐出第一块文字')
    .toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: /^停止/ }), '回合进行中应有可用的停止按钮').toBeEnabled({ timeout: 10_000 });
}

/** 一条消息的文字是否出现在正文的消息卡里(排除侧栏标题那一处)。 */
export async function messageVisible(page, text) {
  const inCards = page.locator('[data-message-id], .chat-user-bubble, .markdown-content').filter({ hasText: text });
  if (await inCards.count()) return await inCards.first().isVisible();
  return (await page.locator('body').innerText()).includes(text);
}

/** 界面此刻的几项可判断状态(全部取用户看得见的东西)。 */
export async function readState(page) {
  const body = await page.locator('body').innerText();
  const stop = page.getByRole('button', { name: /^停止/ });
  return {
    takeover: body.includes('此运行已在另一处查看'),
    banner: body.includes(BANNER_LOOSE),
    stops: await stop.count(),
    stopEnabled: (await stop.count()) ? await stop.first().isEnabled() : false,
    body,
  };
}

/**
 * 在一段时间窗里反复采样(竞态类用例靠它,不用固定 sleep 赌时序):
 * 每 `every` 毫秒取一次状态,返回全部采样。窗口内任一采样不满足断言即失败。
 */
export async function sampleWindow(page, { ms = 6_000, every = 500 } = {}) {
  const samples = [];
  const deadline = Date.now() + ms;
  for (;;) {
    samples.push(await readState(page));
    if (Date.now() >= deadline) return samples;
    await page.waitForTimeout(every);
  }
}

export const rel = (ctl, sid, suffix) => path.join(ctl, `${sid}${suffix}`);

/**
 * 放行这个实例里**所有**停住的回合(按假 CLI 自己落的 <sid>.started 找)。
 * 用于收尾:运行时新建的会话 id 是应用生成的,测试手上没有,只能这样兜底。
 */
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
export const releaseChunk2 = (ctl, sid) => fs.writeFileSync(rel(ctl, sid, '.chunk'), String(Date.now()));
export const releaseTurnEnd = (ctl, sid) => fs.writeFileSync(rel(ctl, sid, '.done'), String(Date.now()));
