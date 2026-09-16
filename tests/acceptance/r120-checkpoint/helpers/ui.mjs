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

/** 在所有面板里找第一个"可见可点、且名字(可见文字 **或** title/aria-label)匹配 re"的按钮;
 *  返回 {panel,locator,text,role,by} 或 null。
 *  为什么要带 title/aria-label:这个产品里大量入口是**纯图标按钮**,名字只落在 title 属性上
 *  (例如「删除这一条回滚点」),只按可见文字找会漏掉、把"入口不存在"误判出来。
 *  只认真正的表单按钮/链接,不碰带 role="tab" 之类内部管控件的容器 —— 否则一个面板标签
 *  就能把"这个入口根本不存在"伪造成"找到了"。 */
export async function findButtonAcrossPanels(page, re) {
  const labels = (await panelLabels(page)).filter((l) => l !== '设置');
  for (const label of labels) {
    await openPanel(page, label);
    // 一次拿全:每个候选的可见性 + 三种"名字"(可见文字 / title / aria-label),再在 JS 侧匹配。
    // 这样纯图标按钮(title 里有名字、可见文字为空)也能被找到,不必为它单开一条查找路径。
    const hits = await page.evaluate((src) => {
      const out = [];
      const els = [...document.querySelectorAll('button, a[href], [role="button"], [role="link"]')];
      for (let i = 0; i < els.length; i += 1) {
        const el = els[i];
        if (!el.getClientRects().length) continue;
        const name = `${el.innerText || ''} ${el.getAttribute('title') || ''} ${el.getAttribute('aria-label') || ''}`.trim();
        if (new RegExp(src).test(name)) out.push({ i, name: name.slice(0, 80), hasText: !!(el.innerText || '').trim() });
      }
      return out;
    }, re.source + (re.flags.includes('i') ? '' : '')).catch(() => []);
    if (hits.length) {
      const h = hits[0];
      const locator = page.locator('button, a[href], [role="button"], [role="link"]').nth(h.i);
      return { panel: label, locator, text: h.name, role: 'button', by: h.hasText ? 'text' : 'title' };
    }
  }
  return null;
}

/** 侧栏里打开带 mark 的夹具会话(项目第一次必须走搜索,打开一次之后才作为侧栏行出现)。 */
export async function openSessionBySearch(page, mark) {
  const search = page.getByRole('complementary').getByRole('textbox', { name: /搜索项目/ });
  await expect(async () => {
    await search.click();
    await search.fill(mark);
    await expect(search).toHaveValue(mark, { timeout: 2_000 });
    await expect(page.getByRole('button', { name: new RegExp(mark) }).first()).toBeVisible({ timeout: 8_000 });
  }).toPass({ timeout: 90_000 });
  await page.getByRole('button', { name: new RegExp(mark) }).first().click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);
}

/** 当前会话头部「更多会话操作」→「检查点」:打开 Checkpoint 时间线(单条明细在这里)。
 *  返回 true 表示时间线已打开(里面能看到会话头部那颗「清理全部」)。 */
export async function openCheckpointTimeline(page) {
  const more = page.getByTitle(/更多会话操作/).first();
  await more.waitFor({ state: 'visible', timeout: 30_000 });
  await more.click({ force: true });
  const item = page.getByRole('button', { name: /^检查点$/ }).first();
  try { await item.waitFor({ state: 'visible', timeout: 8_000 }); } catch { return false; }
  await item.click({ force: true });
  await page.waitForTimeout(1_200);
  // 时间线开着的标志:里面能看到「删本会话全部回滚点」那颗(标题是"删除本会话的全部回滚点")。
  return (await page.getByTitle(/删除.*回滚点/).count()) > 0;
}

/** 检查点时间线是否已打开(判据同 openCheckpointTimeline 的返回值)。 */
export const timelineOpen = async (page) => (await page.getByTitle(/删除.*回滚点/).count()) > 0;

/** 时间线里每条回滚点右侧的删除图标(名字只在 title 上,没有可见文字)。
 *  只认"删一条"的那类;删整个会话的「清理全部」是另一颗,别混。 */
export const singleSnapshotDeleteButtons = (page) => page.getByTitle(/删除(这一条|该条|单条)/);

/** 某一行(含给定按钮的那一行)显示的快照短 sha;读不到返回 null。 */
export async function rowShortSha(btn) {
  const row = btn.locator('xpath=ancestor::div[1]');
  const txt = await row.innerText().catch(() => '');
  const m = txt.match(/\b([0-9a-f]{7,40})\b/);
  return m ? m[1] : null;
}

/** 超大目录弹窗(首次遇到超阈值时出现的那个「要不要保存快照」询问)。
 *  按"能看出是问要不要为大目录保存快照"来认,不写死组件结构。 */
export const snapshotPrompt = (page) => page.locator('[role="dialog"],[role="alertdialog"]')
  .filter({ hasText: /是否为这个会话保存快照|保存快照/ }).last();

/** 解开对 checkpoints DELETE 的挂起,放真请求过去(用完 blockDeleteRequests 之后要调)。 */
export async function unblockDeleteRequests(page) {
  await page.unroute('**/api/checkpoints**');
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
