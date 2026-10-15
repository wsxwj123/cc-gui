// r151b 界面操作层(进应用、侧栏搜索打开会话、发消息、记请求、设置页「会话」分区)。
// 入口写法照搬 r151a 的 helpers/ui.mjs(都是界面上的既有入口,不是产品实现)。
import { expect, test } from '@playwright/test';

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

export const sidebar = (page) => page.locator('[data-cgui="sidebar"]');
const hitRow = (page, mark) =>
  page.locator('[data-cgui="sidebar"] [data-cgui="search-hit"], [data-cgui="sidebar"] button.sidebar-item').filter({ hasText: mark }).first();

/** 打开一条历史会话(走侧栏搜索)。mark = 标题里的唯一标记;replyText = 打开后应能看到的一段文字(确认已打开)。 */
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

export const composer = (page) => page.getByPlaceholder(/输入消息|开始一个新会话/).last();
export async function sendPrompt(page, text) {
  const box = composer(page);
  await expect(box).toBeVisible({ timeout: 15_000 });
  await box.fill(text);
  await box.press('Enter');
}

/** 记录某路径(精确匹配 pathname 或正则)的请求:{ method, body, at }。 */
export function recordRequests(page, pathname) {
  const list = [];
  page.on('request', (req) => {
    try {
      const p = new URL(req.url()).pathname;
      if (pathname instanceof RegExp ? !pathname.test(p) : p !== pathname) return;
      let body = null; try { body = JSON.parse(req.postData() || 'null'); } catch { body = req.postData(); }
      list.push({ method: req.method(), path: p, body, at: Date.now() });
    } catch { /* */ }
  });
  return list;
}

/** 打开设置页「会话」分区(入口:面板坞 → 通用 → 「会话」)。 */
export async function openSessionSettings(page) {
  const toggle = page.locator('[data-testid="panel-dock-toggle"]');
  const gen = page.locator('[data-cgui="panel-dock"] button[title="通用"]').first();
  if (!(await gen.isVisible().catch(() => false))) await toggle.click();
  await gen.click();
  await page.getByRole('button', { name: '会话', exact: true }).first().click();
}

export function note(text) { test.info().annotations.push({ type: 'note', description: text }); }
