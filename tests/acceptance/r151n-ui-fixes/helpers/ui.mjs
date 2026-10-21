// r151n 界面操作层(从 r151l-history-pagination/helpers/ui.mjs 裁剪):
// 进应用、压掉引导浮层/更新检查、用侧栏搜索打开种子会话、取消息区。
// 定位口径都是界面上既有/接口文件约定的可观察身份,不 import 产品代码。
import { expect } from '@playwright/test';

/** 进应用并压掉引导浮层 / 更新检查。 */
export async function boot(page, localInit = {}) {
  await page.addInitScript((init) => {
    try {
      localStorage.setItem('cgui-tour-seen', '1');
      for (const [k, v] of Object.entries(init)) localStorage.setItem(k, v);
    } catch { /* 隐私模式 */ }
  }, localInit);
  for (const api of ['**/api/version-check', '**/api/claude-version-check']) {
    await page.route(api, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hasUpdate: false, localBuild: true }) }));
  }
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 40_000 });
}

const hitRow = (page, mark) =>
  page.locator('[data-cgui="sidebar"] [data-cgui="search-hit"], [data-cgui="sidebar"] button.sidebar-item').filter({ hasText: mark }).first();

/** 打开一条历史会话(走侧栏搜索)。mark = 消息正文里的唯一标记;replyText = 打开后应能看到的一段文字。 */
export async function openSessionBySearch(page, mark, replyText) {
  const search = page.getByRole('complementary').getByRole('textbox', { name: /搜索项目/ });
  await expect(async () => {
    await search.click();
    await search.fill(mark);
    await expect(search).toHaveValue(mark, { timeout: 2_000 });
    await expect(hitRow(page, mark)).toBeVisible({ timeout: 8_000 });
  }).toPass({ timeout: 60_000 });
  await hitRow(page, mark).click();
  try { await expect(search).toHaveValue('', { timeout: 5_000 }); } catch { await search.fill(''); }
  if (replyText) await expect(page.getByText(replyText).first(), '历史会话应已打开').toBeVisible({ timeout: 20_000 });
}

/** 消息区滚动容器。 */
export const messageList = (page) => page.locator('[data-cgui="message-list"]');
/** 消息区里已挂载的消息行(每条已定稿消息一个 [data-turn-uuid] 包装)。 */
export const messageRows = (page) => messageList(page).locator('[data-turn-uuid]');
