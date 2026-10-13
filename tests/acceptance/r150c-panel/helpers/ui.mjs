// r150c 界面辅助(由 r150-plugins 的 helpers/ui.mjs 复制而来,**那个目录只读**;末尾追加"挂住强制读取")。
// 进应用、打开「工具(MCP 服务器 · 插件)」面板、切页签、找插件卡片。
import { expect } from '@playwright/test';

export const TOOLS_PANEL = '工具（MCP 服务器 · 插件）';
export const SYNCED_GROUP_TITLE = '账号同步的插件';

/** 进应用并压掉引导浮层 / 更新检查。 */
export async function boot(page) {
  await page.addInitScript(() => { try { localStorage.setItem('cgui-tour-seen', '1'); } catch { /* 隐私模式 */ } });
  for (const api of ['**/api/version-check', '**/api/claude-version-check']) {
    await page.route(api, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hasUpdate: false, localBuild: true }) }));
  }
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 40_000 });
}

/** 展开面板坞(幂等)。 */
export async function openDock(page) {
  const probe = page.locator('[data-testid="pane-count"]').first();
  if (await probe.isVisible().catch(() => false)) return;
  await page.locator('[data-testid="panel-dock-toggle"]').click();
  await expect(probe, '面板坞应展开').toBeVisible({ timeout: 5_000 });
}

/** 打开「工具」面板并切到指定页签('MCP 服务器' / '插件')。 */
export async function openToolsTab(page, tabName) {
  const tab = page.getByRole('tab', { name: tabName, exact: true });
  if (!(await tab.isVisible().catch(() => false))) {
    await openDock(page);
    await page.locator(`[data-cgui="panel-dock"] button[title="${TOOLS_PANEL}"]`).first().click();
  }
  await expect(tab, `「工具」面板里应有「${tabName}」页签`).toBeVisible({ timeout: 15_000 });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

export const syncedGroup = (page) => page.getByTestId('plugins-synced-group');
export const installedGroup = (page) => page.getByTestId('plugins-installed-group');
export const pluginCard = (page, name) => page.locator(`[data-testid="plugin-card"][data-plugin-name="${name}"]`);
export const cardNames = (group) => group.locator('[data-testid="plugin-card"]').evaluateAll((els) => els.map((el) => el.getAttribute('data-plugin-name')));
/** 面板顶部的「刷新」按钮(强制重读)。 */
export const refreshButton = (page) => page.getByRole('button', { name: '刷新', exact: true });
/** MCP 页签里名字等于 name 的服务器行数。 */
export const mcpRowCount = (page, name) => page.getByText(name, { exact: true }).count();

/**
 * 挂住列表读取(GET /api/mcp):请求停在浏览器这一侧不发出去,release() 之后原样放行。
 * 用来造"慢的读取还在路上"这个时序 —— 延迟由测试决定,不靠任何进程的快慢。
 *   which = 'fresh':只挂强制读取(?fresh=1),读缓存的读取照常;
 *   which = 'all'  :两种都挂。
 * count() = 已挂住的条数;release() 放行并撤掉拦截。
 */
async function holdReads(page, which) {
  const held = [];
  const match = (url) => url.pathname === '/api/mcp' && (which === 'all' || url.searchParams.get('fresh') === '1');
  const handler = (route) => { if (route.request().method() === 'GET') held.push(route); else route.continue(); };
  await page.route(match, handler);
  return {
    count: () => held.length,
    release: async () => {
      await page.unroute(match, handler);
      for (const route of held.splice(0)) await route.continue();
    },
  };
}
export const holdFreshReads = (page) => holdReads(page, 'fresh');
export const holdAllReads = (page) => holdReads(page, 'all');
