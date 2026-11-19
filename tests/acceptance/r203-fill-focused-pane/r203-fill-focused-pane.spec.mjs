// r203-fill-focused-pane 黑盒验收:往输入框里塞内容的入口(截图快捷键、文件浏览器「添加到上下文」)只作用于当前聚焦的窗格。
// 只依据接口文件的行为清单 C1–C4;只通过页面(窗格、输入框、附件卡片文件名、侧栏、文件浏览器)观测。
// 截图快捷键由外壳替身触发(helpers/runtime.mjs 的 SHELL_STUB),后端用 PATH 最前面的假 screencapture(helpers/fixtures.mjs 写入)。
// 记号:S = 夹具里一条有一轮历史的会话。
import { test, expect } from '@playwright/test';
import { seedWorkspace, NOTE_FILE } from './helpers/fixtures.mjs';
import {
  openSplitWithS, openSingleHome, focusPane, panes, homeBoxIn, uniqueTag,
  fireShot, shotCardsIn, inputIn, addFileToContext,
} from './helpers/runtime.mjs';

test('C1 【复现】分屏左格 S、右格空首页聚焦:触发截图快捷键,右格首页出现截图附件卡片,左格 S 里没有', async ({ page }) => {
  const ctx = seedWorkspace(uniqueTag('t'));
  await openSplitWithS(page, ctx);
  await focusPane(page, 1);
  await expect(homeBoxIn(page, 1), 'C1:右格聚焦后应显示新会话首页输入框').toBeVisible({ timeout: 15_000 });
  await fireShot(page);
  await expect(shotCardsIn(page, 1), 'C1:右格首页应出现 1 张截图附件卡片(文件名 <uuid>.png)').toHaveCount(1, { timeout: 20_000 });
  await page.waitForTimeout(800);
  await expect(shotCardsIn(page, 0), 'C1:左格 S 里不应出现截图附件卡片').toHaveCount(0);
});

test('C2 【复现】单栏:打开 S 后点「新建会话」进首页,触发截图快捷键,首页出现截图附件卡片', async ({ page }) => {
  const ctx = seedWorkspace(uniqueTag('t'));
  await openSingleHome(page, ctx);
  await fireShot(page);
  await expect(shotCardsIn(page, null), 'C2:首页应出现 1 张截图附件卡片(文件名 <uuid>.png)').toHaveCount(1, { timeout: 20_000 });
});

test('C3 【复现】分屏左格 S、右格首页聚焦:文件浏览器里对文件点「添加到上下文」,右格首页输入框以 @文件名 结尾,左格 S 输入框为空', async ({ page }) => {
  const ctx = seedWorkspace(uniqueTag('t'));
  await openSplitWithS(page, ctx);
  await focusPane(page, 1);
  await expect(homeBoxIn(page, 1), 'C3:右格聚焦后应显示新会话首页输入框').toBeVisible({ timeout: 15_000 });
  await addFileToContext(page, NOTE_FILE);
  await expect(homeBoxIn(page, 1), `C3:右格首页输入框应以 "@${NOTE_FILE} " 结尾`).toHaveValue(new RegExp(`@${NOTE_FILE.replace('.', '\\.')} $`), { timeout: 15_000 });
  await expect(inputIn(page, 0), 'C3:左格 S 的输入框内容应为空').toHaveValue('');
});

test('C4 【相邻回归】分屏左格 S 聚焦:触发截图快捷键,左格 S 里出现截图附件卡片,右格里没有', async ({ page }) => {
  const ctx = seedWorkspace(uniqueTag('t'));
  await openSplitWithS(page, ctx);
  await focusPane(page, 0);
  await expect(panes(page).nth(0), 'C4:左格应仍显示 S').toContainText('R203 历史回复');
  await fireShot(page);
  await expect(shotCardsIn(page, 0), 'C4:左格 S 里应出现 1 张截图附件卡片(文件名 <uuid>.png)').toHaveCount(1, { timeout: 20_000 });
  await page.waitForTimeout(800);
  await expect(shotCardsIn(page, 1), 'C4:右格里不应出现截图附件卡片').toHaveCount(0);
});
