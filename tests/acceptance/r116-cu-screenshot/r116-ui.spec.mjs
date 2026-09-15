// r116 界面层(3 条):通用工具卡片里的电脑操控截图 —— 读历史显示与放大、回复进行中放大、大截图不出编码。
// 依据只有 .devflow/BRIEF-r116.md(R1、R2、R5、R6)与 .devflow/INTERFACE-r116.md §B;没看实现。
// 只由 run.sh 调起:tests/acceptance/r116-cu-screenshot/run.sh
//
// "放大层"按黑盒认:点击后页面上多出一张天然尺寸与被点那张相同的图,且它挂在 position:fixed 的浮层里;
// 关闭后这张图消失。夹具里每张图尺寸都不同,天然尺寸 = 身份。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { MARK, IMG, TEXT } from './helpers/fixtures.mjs';

async function boot(page) {
  await page.addInitScript(() => { try { localStorage.setItem('cgui-tour-seen', '1'); } catch {} });
  for (const api of ['**/api/version-check', '**/api/claude-version-check']) {   // 不出网查更新
    await page.route(api, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hasUpdate: false, localBuild: true }) }));
  }
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 40_000 });
}

async function openHistory(page, marker) {
  // 夹具项目位于 git worktree 里,侧栏常规列表不列它(实测显示"没有找到项目",/api/projects 却有),
  // 所以走侧栏搜索进会话。实测首载时输入框焦点会被抢走,填完核对值,不对就重来。
  const search = page.getByRole('complementary').getByRole('textbox', { name: /搜索项目/ });
  const hit = page.getByRole('button', { name: new RegExp(marker) }).first();
  await expect(async () => {
    await search.click();
    await search.fill(marker);
    await expect(search).toHaveValue(marker, { timeout: 2_000 });
    await expect(hit).toBeVisible({ timeout: 8_000 });
  }).toPass({ timeout: 60_000 });
  await hit.click();
  await page.keyboard.press('Escape');   // 收起搜索浮层
  await expect(page.locator('[data-turn-uuid]').first()).toBeVisible({ timeout: 30_000 });
}

/** 展开"思考与工具调用"条 → 工具组 → 第 i 张截图卡片,返回卡片元素。 */
async function openShotCard(page, i) {
  const head = page.locator('[data-strip="head"]').first();
  await expect(head).toBeVisible({ timeout: 15_000 });
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
  const header = page.locator('[data-strip-item="group"] button').filter({ hasText: 'screenshot' }).nth(i);
  if (!(await header.isVisible())) await page.getByRole('button', { name: /次工具调用/ }).first().click();
  await expect(header).toBeVisible({ timeout: 10_000 });
  const body = header.locator('xpath=following-sibling::*[1]');
  if (!(await body.isVisible())) await header.click();
  await expect(body).toBeVisible({ timeout: 10_000 });
  return header.locator('xpath=..');
}

const naturalSize = (loc) => loc.evaluate((el) => `${el.naturalWidth}x${el.naturalHeight}`);
/** 浮层里(position:fixed 祖先)可见的、天然尺寸为 w×h 的图有几张。 */
const zoomedCount = (page, { w, h }) => page.evaluate(([w, h]) => [...document.querySelectorAll('img')].filter((im) => {
  if (im.naturalWidth !== w || im.naturalHeight !== h) return false;
  const r = im.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  for (let el = im; el; el = el.parentElement) if (getComputedStyle(el).position === 'fixed') return true;
  return false;
}).length, [w, h]);

async function expectZoomOpensAndEscCloses(page, cardImg, shot) {
  expect(await zoomedCount(page, shot), '点击前不该已有放大层').toBe(0);
  await cardImg.click();
  await expect.poll(() => zoomedCount(page, shot), { timeout: 5_000, message: '点击卡片截图后应出现显示同一张图的放大层' }).toBe(1);
  await page.keyboard.press('Escape');
  await expect.poll(() => zoomedCount(page, shot), { timeout: 5_000, message: '按 Esc 后放大层应消失' }).toBe(0);
}

test('UI-1 [R1/R2/R5 读历史] 两张截图卡片都显示图片,点第一张打开放大层,Esc 关闭', async ({ page }) => {
  await boot(page);
  await openHistory(page, MARK.hist);
  const anthImg = (await openShotCard(page, 0)).locator('img[alt*="结果"]').first();
  await expect(anthImg, 'Anthropic 形态的截图应显示为图片').toBeVisible({ timeout: 10_000 });
  await expect.poll(() => naturalSize(anthImg)).toBe(`${IMG.histAnth.w}x${IMG.histAnth.h}`);
  const mcpImg = (await openShotCard(page, 1)).locator('img[alt*="结果"]').first();
  await expect(mcpImg, 'MCP 直传形态的截图应显示为图片').toBeVisible({ timeout: 10_000 });
  await expect.poll(() => naturalSize(mcpImg)).toBe(`${IMG.histMcp.w}x${IMG.histMcp.h}`);
  await expectZoomOpensAndEscCloses(page, anthImg, IMG.histAnth);
});

test('UI-2 [R5 回复进行中] 卡片里的截图点击打开放大层,Esc 关闭', async ({ page }) => {
  const release = path.join(process.env.R116_CTL, 'release');
  try { fs.unlinkSync(release); } catch { /* 本来就没有 */ }
  try {
    await boot(page);
    await page.getByText(/fixture-workspace/).first().click();
    const box = page.getByPlaceholder(/输入消息|开始一个新会话/).last();
    await expect(box).toBeVisible({ timeout: 15_000 });
    await box.fill('R116LIVE 请截屏');
    await box.press('Enter');
    const liveImg = page.locator('img[alt*="结果"]').first();
    await expect(liveImg, '回复进行中卡片里应显示截图').toBeVisible({ timeout: 30_000 });
    await expect.poll(() => naturalSize(liveImg)).toBe(`${IMG.live.w}x${IMG.live.h}`);
    await expect(page.getByRole('button', { name: /停止|中断/ }), '此刻回复应仍在进行中').not.toHaveCount(0);
    await expectZoomOpensAndEscCloses(page, liveImg, IMG.live);
  } finally {
    fs.writeFileSync(release, String(Date.now()));   // 放行假 CLI,别把回合挂在那
  }
});

test('UI-3 [R6] 大截图(约 42 万字符编码)会话:卡片文字照常显示,页面上不出现编码文字', async ({ page }) => {
  await boot(page);
  await openHistory(page, MARK.big);
  const card = await openShotCard(page, 0);
  await expect(card.getByText(TEXT.big), '卡片文字区应照常显示可读文字').toBeVisible();
  const leak = await page.evaluate((head) => {
    const t = document.body.innerText;
    const run = t.match(/[A-Za-z0-9+/=]{200,}/);
    return { head: t.includes(head), run: run ? `${run[0].slice(0, 40)}…(${run[0].length} 字符)` : null };
  }, IMG.big.data.slice(0, 48));
  expect(leak, '页面文字里不该出现截图编码(开头片段或 ≥200 字符的 base64 连串)').toEqual({ head: false, run: null });
});
