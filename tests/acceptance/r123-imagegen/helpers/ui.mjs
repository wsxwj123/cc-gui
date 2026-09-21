// r123 界面操作层:只按用户看得见的东西 + INTERFACE-r123 公布的 data-testid 定位。
// 入口(探路实测):顶栏面板坞「生图」→ 面板头「生图（自定义生图 provider）」;
//   「新增生图 provider」按钮(title)打开提供方表单:名称 / 协议 select(openai|gemini|chat|mj|mj-proxy)/
//   接口地址 input(placeholder https://api.example.com/v1)/ 密钥 / 模型 input(placeholder gpt-image-2)…;
//   面板里另有「任务列表」页签(历史条目在这里)。
import { expect } from '@playwright/test';

export const UI_BASE = process.env.R123_UI_BASE || '';

export async function prime(page) {
  await page.addInitScript(() => { try { localStorage.setItem('cgui-tour-seen', '1'); } catch { /* 忽略 */ } });
  for (const url of ['**/api/version-check', '**/api/claude-version-check']) {
    await page.route(url, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hasUpdate: false, localBuild: true }) }));
  }
}

/** 进应用并压掉一次性浮层。 */
export async function boot(page) {
  await prime(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 40_000 });
  await dismissOverlays(page);
}

/** 反复点掉「稍后 / 以后再说 / 已知晓」这类一次性浮层。 */
export async function dismissOverlays(page, passes = 6) {
  for (let i = 0; i < passes; i += 1) {
    let hit = false;
    for (const label of ['稍后', '以后再说', '已知晓']) {
      const btn = page.locator('button').filter({ hasText: label }).last();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click({ force: true }).catch(() => {});
        await page.waitForTimeout(120);
        hit = true;
      }
    }
    if (!hit) return;
  }
}

/** 顶栏面板坞里点某个面板(收起时先点开坞)。 */
export async function openDockPanel(page, name) {
  const btn = page.locator('[data-cgui="panel-dock"]').getByRole('button', { name, exact: true }).first();
  if (!(await btn.isVisible().catch(() => false))) {
    await page.locator('[data-testid="panel-dock-toggle"]').first().click({ timeout: 8_000 });
    await page.waitForTimeout(400);
  }
  await expect(btn, `顶栏面板坞里应当有「${name}」`).toBeVisible({ timeout: 10_000 });
  await btn.click({ timeout: 8_000 });
}

export const panelHeader = (page) => page.getByText('生图（自定义生图 provider）').first();

export async function openImagePanel(page) {
  await openDockPanel(page, '生图');
  await expect(panelHeader(page), '应打开生图面板').toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(300);
}

/** 生图面板容器 = 罩住面板头的最近的 [data-cgui-panel] 元素。 */
export const imagePanel = (page) => page.locator('[data-cgui-panel]').filter({ has: page.getByText('生图（自定义生图 provider）') }).first();

export async function openNewProviderForm(page) {
  await imagePanel(page).locator('button[title="新增生图 provider"]').first().click({ timeout: 8_000 });
  await expect(baseInput(page), '应出现提供方表单(接口地址输入框)').toBeVisible({ timeout: 10_000 });
}

export const baseInput = (page) => imagePanel(page).getByPlaceholder('https://api.example.com/v1').first();
export const modelInput = (page) => imagePanel(page).getByPlaceholder('gpt-image-2').first();
export const keyInput = (page) => imagePanel(page).getByPlaceholder('sk-…').first();
export const nameInput = (page) => imagePanel(page).getByPlaceholder('我的 gpt-image').first();
/** 协议下拉 = 含 mj-proxy 选项的那个 select。 */
export const protocolSelect = (page) => imagePanel(page).locator('select').filter({ has: page.locator('option[value="mj-proxy"]') }).first();
export const finalUrl = (page) => page.locator('[data-testid="image-final-url"]');
export const addV1Button = (page) => page.locator('[data-testid="image-add-v1"]');

/** 面板里的「任务列表」页签。 */
export async function openTaskList(page) {
  await imagePanel(page).getByRole('button', { name: '任务列表', exact: true }).first().click({ timeout: 8_000 });
  await page.waitForTimeout(300);
}

export const textOf = (loc) => loc.evaluate((el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim());
