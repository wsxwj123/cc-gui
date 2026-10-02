// r119 界面操作层:只按用户看得见的东西定位(侧栏会话行、输入框、停止按钮、页面文字)。
// 依据只有 .devflow/INTERFACE-r119.md §A。
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/** 进应用并压掉旅游浮层/更新检查。 */
export async function boot(page) {
  await page.addInitScript(() => { try { localStorage.setItem('cgui-tour-seen', '1'); } catch { /* 忽略 */ } });
  for (const api of ['**/api/version-check', '**/api/claude-version-check']) {
    await page.route(api, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hasUpdate: false, localBuild: true }) }));
  }
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 40_000 });
}

/**
 * **搜索结果行** —— 拾取只能点它,不能点"名字里含标记的第一个按钮"。
 *   命中行 = 原生 `<button class="sidebar-item">`(产品句柄 `data-cgui="search-hit"`,App.jsx:1602,**没有 role 属性**);
 *   会话行 = `<div role="button" data-cgui="session-row">`(App.jsx:1754)。
 *   `getByRole('button', { name: /标记/ })` **两个都会命中**:全局搜索有 220ms 防抖,而会话行是同步渲染的
 *   ⇒ 项目已展开时 `.first()` 会落到会话行 = 2026-09-16 那次假红的根因(`PROJECT.md:1902/1924` 点名过本套件)。
 * 先认产品句柄,没有就退回"侧栏里的原生 button"(会话行是 div,天然排除)。
 */
const hitRow = (page, mark) =>
  page.locator('[data-cgui="sidebar"] [data-cgui="search-hit"], [data-cgui="sidebar"] button.sidebar-item')
    .filter({ hasText: mark }).first();

/**
 * 打开某条夹具会话(夹具项目第一次必须走搜索,打开一次之后会话才作为侧栏行出现)。
 *
 * r143 加固(2026-10-02;四条契约见 .devflow/TEST-PLAN-r143.md §7):
 *   ① 拾取定位器换成 `hitRow`(产品句柄优先);② 删掉拾取后的 `keyboard.press('Escape')`
 *   (拾取后焦点落回 body,那一击会冒泡到会话级 Esc、可能停掉正在跑的回合);
 *   ③ 收尾先硬断言搜索词被清空,失败才兜底 `fill('')` + annotation。**硬契约归 r143 的 S2 独占**。
 */
export async function openSessionBySearch(page, mark) {
  const search = page.getByRole('complementary').getByRole('textbox', { name: /搜索项目/ });
  await expect(async () => {
    await search.click();
    await search.fill(mark);
    await expect(search).toHaveValue(mark, { timeout: 2_000 });
    await expect(hitRow(page, mark)).toBeVisible({ timeout: 8_000 });
  }).toPass({ timeout: 90_000 });
  await hitRow(page, mark).click();
  try {
    await expect(search, '点搜索结果行后搜索词应被清空(硬契约见 r143 的 S2)').toHaveValue('', { timeout: 5_000 });
  } catch {
    await search.fill('');
    test.info().annotations.push({ type: '⚠️ 搜索词未自动清空(已兜底)', description: 'r119-stop-response openSessionBySearch' });
    console.warn('[r119-stop-response] 搜索词未自动清空,已兜底 fill("") —— 硬契约见 r143 的 S2');
  }
  await page.waitForTimeout(800);
}

export const sessionRow = (page, mark) => page.locator('[role=button].sidebar-item').filter({ hasText: mark }).first();

export async function switchTo(page, mark) {
  const row = sessionRow(page, mark);
  await expect(row, `侧栏里应能看到会话 ${mark}`).toBeVisible({ timeout: 30_000 });
  await row.click();
  await page.waitForTimeout(500);
}

export const composer = (page) => page.getByPlaceholder(/输入消息|开始一个新会话/).last();
export const stopButton = (page) => page.getByRole('button', { name: /^停止/ });

export async function sendPrompt(page, text) {
  const box = composer(page);
  await expect(box).toBeVisible({ timeout: 15_000 });
  await box.fill(text);
  await box.press('Enter');
}

/** 等这一轮确实在跑:桩吐出的流式内容已在正文里,并且「停止」按钮可用。 */
export async function waitStreaming(page, sid, timeout = 90_000) {
  await expect(page.getByText(`R119STREAM ${sid.slice(0, 8)}`, { exact: false }).first(),
    '桩应已吐出流式内容').toBeVisible({ timeout });
  await expect(stopButton(page).first(), '回合进行中应有可用的「停止」按钮').toBeEnabled({ timeout: 15_000 });
}

/** 让流式内容再往前走几块(界面稳定处于"正在生成"),再开始量。 */
export async function settleStreaming(page, sid) {
  const before = await (await import('./measure.mjs')).streamIndex(page);
  await page.waitForTimeout(1_500);
  const after = await (await import('./measure.mjs')).streamIndex(page);
  if (after <= before) {
    await page.waitForTimeout(1_500);   // 再给一次机会(慢启动那类情况下第一块刚到)
  }
}

/** 界面此刻与"停止"有关的可判断状态(用户看得见的东西)。 */
export async function stopState(page) {
  const btn = stopButton(page);
  const n = await btn.count();
  return {
    stopCount: n,
    stopEnabled: n ? await btn.first().isEnabled() : false,
    stopVisible: n ? await btn.first().isVisible() : false,
    stopText: n ? (await btn.first().innerText()).trim() : '',
    body: await page.evaluate(() => (document.body.textContent || '').slice(-4_000)),
  };
}

/** 收尾:把本实例里所有还停着的桩进程放行/杀掉(按桩自己落的 pid 文件,不按进程名)。 */
export function killStubs(ctl) {
  let names = [];
  try { names = fs.readdirSync(ctl); } catch { return []; }
  const killed = [];
  for (const name of names) {
    if (!/\.pid$/.test(name)) continue;
    const pid = Number(fs.readFileSync(path.join(ctl, name), 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try { process.kill(pid, 'SIGKILL'); killed.push(pid); } catch { /* 已经退了 */ }
  }
  return killed;
}
