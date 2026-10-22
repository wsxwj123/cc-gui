// H. 分屏(行为 22,相邻):两个窗格时消息操作按钮只显示图标且按钮有 title;单个窗格时显示文字。真实 App。
import { test, expect } from '@playwright/test';
import { seedSession, uniq } from '../r151b-xsession-p1/helpers/fixtures.mjs';
import { boot, openSessionBySearch } from '../r151b-xsession-p1/helpers/ui.mjs';

test.describe.configure({ timeout: 150_000 });

/** 真实 DOM 上的分屏状态:窗格数、「重做/分叉」按钮(是否可见、title)、按钮里文字标签的计算样式 display。 */
const paneFacts = (page) => page.evaluate(() => {
  const norm = (s) => (s || '').replace(/\s+/g, '');
  const shown = (el) => { const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
  const split = document.querySelector('[data-testid="pane-split"]');
  if (!split) return { found: false, paneCount: 0, buttons: [], labels: [] };
  const buttons = []; const labels = [];
  for (const btn of split.querySelectorAll('button')) {
    const text = norm(btn.textContent);
    if (!/^(重做|分叉)$/.test(text)) continue;
    buttons.push({ text, visible: shown(btn), title: btn.getAttribute('title') || btn.getAttribute('aria-label') || '' });
    for (const el of btn.querySelectorAll('span')) if (/^(重做|分叉)$/.test(norm(el.textContent))) labels.push({ text: norm(el.textContent), display: getComputedStyle(el).display });
  }
  return { found: true, paneCount: split.querySelectorAll('[data-testid="pane"]').length, buttons, labels };
});
const summary = (f) => ({
  panes: f.paneCount, buttons: f.buttons.length > 0, buttonsVisible: f.buttons.length > 0 && f.buttons.every((b) => b.visible),
  labelsHidden: f.labels.length > 0 && f.labels.every((l) => l.display === 'none'), labelsShown: f.labels.length > 0 && f.labels.every((l) => l.display !== 'none'),
  allButtonsHaveTitle: f.buttons.length > 0 && f.buttons.every((b) => b.title.trim().length > 0),
});

test('Q22 (相邻) 两个窗格时消息操作按钮只显示图标、按钮有 title;单个窗格时显示文字', async ({ page }) => {
  const S = seedSession(`q22-${uniq('')}`);
  await boot(page);
  await openSessionBySearch(page, S.title, S.reply);
  await expect.poll(async () => { const f = await paneFacts(page); return f.found && f.paneCount === 1 && f.buttons.length > 0 && f.labels.length > 0; }, { timeout: 25_000, message: '前置:单屏应有 1 个窗格和「重做/分叉」按钮' }).toBe(true);
  const single = summary(await paneFacts(page));
  await page.locator('[data-testid="panel-dock-toggle"]').click();
  await expect(page.locator('[data-testid="pane-count"]'), '展开面板坞后应出现分屏数量入口').toBeVisible({ timeout: 10_000 });
  await page.locator('[data-testid="pane-count"]').click();
  await page.locator('[data-testid="pane-count-2"]').click();
  await expect.poll(async () => (await paneFacts(page)).paneCount, { timeout: 20_000, message: '切到 2 窗格后应有 2 个真实窗格' }).toBe(2);
  await expect.poll(async () => { const f = await paneFacts(page); return f.buttons.length > 0 && f.labels.length > 0; }, { timeout: 20_000, message: '2 窗格时消息操作按钮应仍在' }).toBe(true);
  const split = summary(await paneFacts(page));
  expect.soft(single, '单个窗格:按钮可见、文字标签显示').toMatchObject({ panes: 1, buttonsVisible: true, labelsShown: true, labelsHidden: false });
  expect.soft(split, '两个窗格:按钮可见、文字标签隐藏、每个按钮有 title').toMatchObject({ panes: 2, buttonsVisible: true, labelsHidden: true, allButtonsHaveTitle: true });
});
