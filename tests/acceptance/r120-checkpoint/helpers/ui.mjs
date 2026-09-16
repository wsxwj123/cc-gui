// r120 界面操作层:只按用户看得见的东西定位(面板坞的格子按钮、可见文案、按钮文字)。
// 依据只有 .devflow/INTERFACE-r120.md §B。界面落点合同没写死,所以"哪个面板/哪个页签"
// 一律靠逐个面板扫一遍找,不写死组件结构 —— 落点变了测试不用改。
import { expect } from '@playwright/test';

export const UI_BASE = process.env.R120_UI_BASE || 'http://127.0.0.1:6700';
export const API_BASE = process.env.R120_API_BASE || 'http://127.0.0.1:6701';

/** 对隔离实例直调接口(准备/核对用,不作为界面断言)。 */
export async function api(method, url, body) {
  const res = await fetch(API_BASE + url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, text, json };
}

/** 进应用并压掉旅游浮层/更新检查。 */
export async function boot(page) {
  await page.addInitScript(() => { try { localStorage.setItem('cgui-tour-seen', '1'); } catch { /* 忽略 */ } });
  for (const api of ['**/api/version-check', '**/api/claude-version-check']) {
    await page.route(api, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hasUpdate: false, localBuild: true }) }));
  }
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 40_000 });
  await dismissOverlays(page);
}

/** 反复点掉「稍后 / 以后再说 / 已知晓」这类一次性浮层。
 *  注意:不要用「跳过」当关键词 —— 它太容易命中产品自己的按钮。 */
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

/** 展开面板坞里的格子(「设置」那颗按钮)。**幂等**:坞已经开着就什么都不做 ——
 *  那颗按钮是开关,重复点会把坞关掉,导致"扫面板"其实只扫到一两个。 */
export async function openPanelDock(page) {
  const probe = page.locator('[data-cgui="panel-dock"] button').filter({ hasText: /^通用$/ }).first();
  if (await probe.isVisible().catch(() => false)) return true;
  const toggle = page.locator('[data-testid="panel-dock-toggle"]');
  if (await toggle.count()) await toggle.click({ force: true }).catch(() => {});
  await page.waitForTimeout(600);
  return await probe.isVisible().catch(() => false);
}

/** 面板坞里所有面板的名字(「终端」「用量」「通用」…)。 */
export async function panelLabels(page) {
  await openPanelDock(page);
  const raw = await page.locator('[data-cgui="panel-dock"] button').allInnerTexts();
  return [...new Set(raw.map((s) => s.trim()).filter(Boolean))];
}

function panelButton(page, label) {
  return page.locator('[data-cgui="panel-dock"] button').filter({ hasText: new RegExp(`^${label}$`) }).first();
}

/** 打开某个面板,返回该面板打开后的整页可见文本。 */
export async function openPanel(page, label) {
  await openPanelDock(page);
  const btn = panelButton(page, label);
  if (!(await btn.count())) return null;
  await btn.click({ force: true }).catch(() => {});
  await page.waitForTimeout(900);
  await dismissOverlays(page);
  return page.evaluate(() => document.body.innerText || '');
}

/** 逐个打开面板坞里的每个面板,把可见文本拼起来 —— 用户"到处找一遍"的等价物。
 *  返回 {text, panels, total}:panels 是**真的打开过并读到文本**的面板。 */
export async function scanAllPanels(page) {
  const labels = (await panelLabels(page)).filter((l) => l !== '设置');
  const chunks = [];
  const seenPanels = [];
  for (const label of labels) {
    const text = await openPanel(page, label);
    if (text === null) continue;
    seenPanels.push(label);
    chunks.push(`\n===== 面板【${label}】=====\n${text}`);
  }
  return { text: chunks.join('\n'), panels: seenPanels, total: labels.length };
}

/** 在所有面板里找第一个"名字匹配 re 且可见可点"的按钮;返回 {panel,locator,text} 或 null。
 *  只认真正的表单按钮/链接,不碰带 role="tab" 之类内部管控件的容器 —— 否则一个面板标签
 *  就能把"这个入口根本不存在"伪造成"找到了"。 */
export async function findButtonAcrossPanels(page, re) {
  const labels = (await panelLabels(page)).filter((l) => l !== '设置');
  for (const label of labels) {
    await openPanel(page, label);
    for (const role of ['button', 'link']) {
      const btn = page.getByRole(role).filter({ hasText: re }).first();
      if ((await btn.count()) && await btn.isVisible().catch(() => false)) {
        const text = (await btn.innerText().catch(() => '')) || '';
        return { panel: label, locator: btn, text: text.trim(), role };
      }
    }
  }
  return null;
}

/** 挂起所有发往 checkpoints 的 DELETE:请求发出去但服务端永不回 —— 用来判定"确认前有没有真删"。
 *  返回一个数组,元素是拦截到的请求(确认前必须是空的)。 */
export function blockDeleteRequests(page) {
  const seen = [];
  page.route('**/api/checkpoints**', async (route) => {
    const req = route.request();
    if (req.method().toUpperCase() === 'DELETE') {
      const body = req.postData();
      seen.push({ url: req.url().replace(UI_BASE, ''), body: body && body.length < 4096 ? body : null });
      return;                                        // 永不 fulfill:请求留在飞行中
    }
    await route.continue();
  });
  return seen;
}

/** 等界面上出现二次确认弹窗;找不到返回 null。 */
export async function waitConfirmDialog(page, timeout = 12_000) {
  const dialog = page.locator('[role="dialog"], [role="alertdialog"], dialog[open]').last();
  try { await dialog.waitFor({ state: 'visible', timeout }); } catch { return null; }
  return { locator: dialog, text: await dialog.innerText().catch(() => '') };
}

/** 弹窗里的某个按钮。 */
export const dialogButton = (dlg, re) => dlg.locator.getByRole('button', { name: re }).first();
