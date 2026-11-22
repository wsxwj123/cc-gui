// 页面操作:打开应用、进会话、回退、打开设置、确认框。只用文案 / role / title / data-* 锚点,不读源码。
import { expect } from '@playwright/test';

const OVERLAY_DISMISS = ['关闭指引', '跳过', '稍后', '知道了'];
export async function dismissOverlays(page) {
  for (const name of OVERLAY_DISMISS) {
    const b = page.getByRole('button', { name, exact: true });
    if ((await b.count()) && (await b.first().isVisible().catch(() => false))) { await b.first().click().catch(() => {}); await page.waitForTimeout(150); }
  }
}
export async function openApp(page) {
  await page.addInitScript(() => { try { localStorage.setItem('cgui-tour-seen', '1'); } catch { /* 忽略 */ } });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await dismissOverlays(page);
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 60_000 });
}
export const sessionRows = (page) => page.locator('[data-cgui="session-row"]');
export async function openWorkspaceGroup(page, c) {
  const pr = page.locator('[data-cgui="project-row"]').filter({ hasText: c.workspaceName }).first();
  await expect(pr, `侧栏里应有工作区 ${c.workspaceName}`).toBeVisible({ timeout: 30_000 });
  if ((await pr.getAttribute('aria-expanded')) !== 'true') await pr.click();
  await expect(sessionRows(page).first(), '展开工作区后应出现会话行').toBeVisible({ timeout: 15_000 });
}
export async function clickRowWith(page, text) {
  const row = sessionRows(page).filter({ hasText: text }).first();
  await expect(row, `侧栏里应有含「${text}」的会话行`).toBeVisible({ timeout: 20_000 });
  await row.click({ timeout: 5_000 });
}
export const messageCard = (page, text) => page.locator('[data-message-id]').filter({ hasText: text }).first();
export async function openSession(page, c) {
  await openApp(page);
  await openWorkspaceGroup(page, c);
  await clickRowWith(page, c.marker);
  await expect(messageCard(page, c.targetText), `会话里应显示「${c.targetText}」`).toBeVisible({ timeout: 20_000 });
}
/** 悬停用户消息 →「回滚 / 重新编辑」→「仅回退消息」(只回退,不重发)。 */
export async function rollbackOnly(page, text) {
  const card = messageCard(page, text);
  await card.hover();
  await card.getByTitle('回滚 / 重新编辑').click();
  await page.getByRole('button', { name: /仅回退消息/ }).and(page.locator('button')).click();
}
export const TRIM_FAILED = '会话记录裁剪失败';

// ── 设置 ──
export const settingsSearch = (page) => page.getByPlaceholder(/搜索设置/).first();
export async function openSettings(page) {
  const box = settingsSearch(page);
  const combo = process.platform === 'darwin' ? 'Meta+0' : 'Control+0';
  let attempt = 0;
  await expect(async () => {
    if (await box.isVisible().catch(() => false)) return;
    attempt += 1;
    if (attempt % 2 === 1) await page.keyboard.press(combo);
    else await page.locator('[data-cgui="settings-btn"]').first().click({ timeout: 3_000 }).catch(() => {});
    await expect(box).toBeVisible({ timeout: 4_000 });
  }, '设置面板应当打开(能看到「搜索设置」输入框)').toPass({ timeout: 40_000 });
}
/** 打开设置 → 高级 → 找到「存储清理」小节(#set-storage)。 */
export async function openStorageSection(page) {
  await openSettings(page);
  const tab = page.locator('button').filter({ hasText: /^高级$/ }).first();
  if (await tab.isVisible().catch(() => false)) await tab.click({ timeout: 3_000 }).catch(() => {});
  const sec = page.locator('#set-storage');
  await expect(sec, '设置 → 高级 里应有 id=set-storage 的小节').toBeVisible({ timeout: 20_000 });
  return sec;
}
export const tid = (page, id) => page.getByTestId(id);
/** 确认框宿主(confirmDialog 挂在 body 上,带 data-cgui-confirm)。 */
export const confirmHost = (page) => page.locator('[data-cgui-confirm]');
export const confirmButtons = (page) => ({
  cancel: confirmHost(page).getByRole('button', { name: /取消/ }).first(),
  confirm: confirmHost(page).getByRole('button').filter({ hasNotText: /取消/ }).last(),
});
