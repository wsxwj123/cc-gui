// r151a 界面操作层(进应用、打开历史会话、权限档选择器、设置页「权限」分区、发消息、记录请求)。
// 入口写法参照 r148 / r149 / r150 的 helpers/ui.mjs(都是界面上的既有入口,不是产品实现)。
import { expect, test } from '@playwright/test';
import { seedSession } from './fixtures.mjs';

/** 进应用并压掉引导浮层 / 更新检查。localInit 里的键会在页面脚本跑之前写进 localStorage。 */
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

/** 打开一条历史会话(第一次必须走侧栏搜索,见 r148 helpers 的说明)。 */
export async function openSessionBySearch(page, mark) {
  const search = page.getByRole('complementary').getByRole('textbox', { name: /搜索项目/ });
  await expect(async () => {
    await search.click();
    await search.fill(mark);
    await expect(search).toHaveValue(mark, { timeout: 2_000 });
    await expect(hitRow(page, mark)).toBeVisible({ timeout: 8_000 });
  }).toPass({ timeout: 60_000 });
  await hitRow(page, mark).click();
  try { await expect(search).toHaveValue('', { timeout: 5_000 }); } catch { await search.fill(''); }
  await expect(page.getByText(`${mark} 这是已有的旧回复。`).first(), '历史会话应已打开').toBeVisible({ timeout: 20_000 });
}

let seq = 0;
/** 落一条新的历史会话并在界面上打开它(每个用例一条,回合跑完标题会变,不复用)。返回 { sid, cwd, mark }。 */
export async function openFreshSession(page, tag) {
  seq += 1;
  const n = (Date.now() % 1e8).toString(16).padStart(8, '0');
  const sid = `${n}-${String(seq).padStart(4, '0')}-4000-8000-${Date.now().toString(16).slice(-12).padStart(12, '0')}`;
  const mark = `R151U${tag.replace(/[^A-Za-z0-9]/g, '')}M${seq}X${n.slice(-4)}`;
  const s = seedSession(`ui-${tag}-${seq}-${n}`, sid, mark);
  await openSessionBySearch(page, mark);
  return s;
}

// ---------------- 权限档选择器 ----------------
export const selector = (page) => page.locator('[data-testid="permission-mode-selector"]').last();
export async function openSelector(page) {
  const listbox = page.locator('[role="listbox"]').filter({ has: page.locator('[role="option"]') }).last();
  if (!(await listbox.isVisible().catch(() => false))) {
    await expect(selector(page), '应有权限档选择器').toBeVisible({ timeout: 15_000 });
    await selector(page).click();
  }
  await expect(listbox, '选择器弹层应展开').toBeVisible({ timeout: 5_000 });
  return listbox;
}
export async function closeSelector(page) { await page.keyboard.press('Escape').catch(() => {}); await page.waitForTimeout(200); }
/** 弹层里每个选项:{ mode: data-mode 属性(没有为 null), title: 第一行文字, text: 全文 }。 */
export async function readOptions(page) {
  const listbox = await openSelector(page);
  return listbox.locator('[role="option"]').evaluateAll((els) => els.map((e) => ({
    mode: e.getAttribute('data-mode'),
    title: (e.innerText || '').trim().split(/\s+/)[0],
    text: (e.innerText || '').replace(/\s+/g, ' ').trim(),
  })));
}
export const autoOption = (page) => page.locator('[role="listbox"] [role="option"][data-mode="auto"]');
/** 在选择器里选某个档(按 data-mode)。 */
export async function chooseMode(page, mode) {
  await openSelector(page);
  const opt = page.locator(`[role="listbox"] [role="option"][data-mode="${mode}"]`);
  await expect(opt, `选择器里应有 data-mode="${mode}" 的选项`).toBeVisible({ timeout: 5_000 });
  await opt.click();
  await page.waitForTimeout(300);
}
/** 按标题选(不依赖 data-mode;用于改动前就存在的选项)。标题要整词相等:「规划」的说明里也含"自动"二字。 */
export async function chooseModeByTitle(page, title) {
  const listbox = await openSelector(page);
  const titles = await listbox.locator('[role="option"]').evaluateAll((els) => els.map((e) => (e.innerText || '').trim().split(/\s+/)[0]));
  const i = titles.indexOf(title);
  expect(i, `选择器里应有标题为「${title}」的选项(实际:${titles.join(' / ')})`).toBeGreaterThanOrEqual(0);
  await listbox.locator('[role="option"]').nth(i).click();
  await page.waitForTimeout(300);
}

// ---------------- 发消息 / 记请求 ----------------
export const composer = (page) => page.getByPlaceholder(/输入消息|开始一个新会话/).last();
export async function sendPrompt(page, text) {
  const box = composer(page);
  await expect(box).toBeVisible({ timeout: 15_000 });
  await box.fill(text);
  await box.press('Enter');
}
/** 记录每一次 POST /api/chat 的请求体。 */
export function recordChatPosts(page) {
  const list = [];
  page.on('request', (req) => {
    try {
      if (req.method() !== 'POST' || !/\/api\/chat$/.test(new URL(req.url()).pathname)) return;
      list.push(JSON.parse(req.postData() || '{}'));
    } catch { /* 非 JSON */ }
  });
  return list;
}
/** 记录某路径的请求(方法 + 请求体)。 */
export function recordRequests(page, pathname) {
  const list = [];
  page.on('request', (req) => {
    try {
      if (new URL(req.url()).pathname !== pathname) return;
      let body = null; try { body = JSON.parse(req.postData() || 'null'); } catch { body = req.postData(); }
      list.push({ method: req.method(), body });
    } catch { /* */ }
  });
  return list;
}
export const readLocal = (page, key) => page.evaluate((k) => localStorage.getItem(k), key);

// ---------------- 设置页「权限」分区 ----------------
export async function openPermissionSettings(page) {
  const section = page.locator('#set-permissions');
  if (await section.isVisible().catch(() => false)) return;
  const toggle = page.locator('[data-testid="panel-dock-toggle"]');
  const gen = page.locator('[data-cgui="panel-dock"] button[title="通用"]').first();
  if (!(await gen.isVisible().catch(() => false))) await toggle.click();
  await gen.click();
  await page.getByRole('button', { name: '权限', exact: true }).first().click();
  await expect(section, '设置 → 权限 分区应打开').toBeVisible({ timeout: 10_000 });
}
export const tpSection = (page) => page.getByTestId('third-party-auto-section');

export function note(text) { test.info().annotations.push({ type: 'note', description: text }); }
