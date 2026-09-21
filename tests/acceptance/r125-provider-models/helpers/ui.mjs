// r125 界面操作层:只按用户看得见的东西 + INTERFACE-r125 公布的锚点定位。
// 依据只有 .devflow/BRIEF-r125.md 与 .devflow/INTERFACE-r125.md;没看实现代码。既有入口(探路实测)在文件末尾注明。
import { expect } from '@playwright/test';

export const UI_BASE = process.env.R125_UI_BASE || '';

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

/** 刷新页面并等应用重新挂好。 */
export async function reloadApp(page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 40_000 });
  await dismissOverlays(page);
}

// ---------------------------------------------------------------------------
// 请求拦截(INTERFACE C1 / D1 允许的测试手段):只匹配路径,忽略 query。
// handler 返回 null = 放行给真实实例;返回 { __status, __body } 可指定状态码;其余当 200 JSON 正文。
// ---------------------------------------------------------------------------
export async function routeJson(page, pathname, handler, { method } = {}) {
  await page.route((url) => url.pathname === pathname, async (route) => {
    if (method && route.request().method() !== method) { await route.fallback(); return; }
    const value = typeof handler === 'function' ? await handler(route) : handler;
    if (value === null) { await route.fallback(); return; }
    if (value && typeof value === 'object' && '__status' in value) {
      await route.fulfill({ status: value.__status, contentType: 'application/json; charset=utf-8', body: typeof value.__body === 'string' ? value.__body : JSON.stringify(value.__body ?? {}) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(value) });
  });
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

// ---------------------------------------------------------------------------
// 生图面板(既有入口,照 r123 套件):面板坞「生图」→ 面板头「生图（自定义生图 provider）」→「新增生图 provider」表单
// ---------------------------------------------------------------------------
export const panelHeader = (page) => page.getByText('生图（自定义生图 provider）').first();
export const imagePanel = (page) => page.locator('[data-cgui-panel]').filter({ has: page.getByText('生图（自定义生图 provider）') }).first();
export async function openImagePanel(page) {
  if (!(await panelHeader(page).isVisible().catch(() => false))) await openDockPanel(page, '生图');
  await expect(panelHeader(page), '应打开生图面板').toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(300);
}
export const imageBaseInput = (page) => imagePanel(page).getByPlaceholder('https://api.example.com/v1').first();
export async function openNewImageProviderForm(page) {
  await imagePanel(page).locator('button[title="新增生图 provider"]').first().click({ timeout: 8_000 });
  await expect(imageBaseInput(page), '应出现生图提供方表单(接口地址输入框)').toBeVisible({ timeout: 10_000 });
}

// ---------------------------------------------------------------------------
// Provider 管理弹窗(既有入口,照 pricing-accuracy 套件:全局事件 cgui:open-provider-manager;testid provider-manager)
// ---------------------------------------------------------------------------
export async function openProviderManager(page) {
  const manager = page.locator('[data-testid="provider-manager"]');
  if (!(await manager.count())) await page.evaluate(() => window.dispatchEvent(new CustomEvent('cgui:open-provider-manager')));
  await expect(manager, '全局事件 cgui:open-provider-manager 应打开 Provider 管理弹窗').toBeVisible({ timeout: 8_000 });
  return manager;
}

// ---------------------------------------------------------------------------
// INTERFACE §B 勾选弹窗锚点(新增契约;当前代码还没有 → 用例红在"锚点不存在"属预期)
// ---------------------------------------------------------------------------
export const pickModal = (page) => page.locator('[data-testid="model-pick-modal"]');
export const pickRows = (page) => pickModal(page).locator('[data-testid="model-pick-row"]');
export const pickRow = (page, id) => pickModal(page).locator(`[data-testid="model-pick-row"][data-model-id="${id}"]`);
export const pickBox = (page, id) => pickRow(page, id).locator('input[type=checkbox]');
export const pickConfirm = (page) => page.locator('[data-testid="model-pick-confirm"]');
export const pickSearch = (page) => page.locator('[data-testid="model-pick-search"]');

// ---------------------------------------------------------------------------
// INTERFACE §D Provider 列表锚点(新增契约)
// ---------------------------------------------------------------------------
export const switchList = (page) => page.locator('[data-testid="provider-switch-list"]');
export const switchRows = (page) => switchList(page).locator('[data-provider-id]');
export const listError = (page) => page.locator('[data-testid="provider-list-error"]');

export const textOf = (loc) => loc.evaluate((el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim());

// ---------------------------------------------------------------------------
// 顶栏两个按钮(探路实测的 title 前缀)与模型页
// ---------------------------------------------------------------------------
export const providerButton = (page) => page.locator('button[title^="Provider:"]').first();
export const modelButton = (page) => page.locator('button[title^="模型:"]').first();
export const fetchLatestButton = (page) => page.getByRole('button', { name: '拉取最新', exact: true }).first();
/** 模型页浮层根(INTERFACE 没给锚点)= 同时罩住「拉取最新」按钮(在头部工具行)与「1M 上下文」区块的最深容器(探路 P11 实测结构)。 */
export const modelPage = (page) => page.locator('div')
  .filter({ has: page.getByRole('button', { name: '拉取最新', exact: true }) })
  .filter({ hasText: '1M 上下文' }).last();
export async function openModelPage(page) {
  if (!(await fetchLatestButton(page).isVisible().catch(() => false))) await modelButton(page).click({ force: true });
  await expect(fetchLatestButton(page), '模型页应打开(能看到「拉取最新」)').toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(250);
}
/** 模型页列表里"文字逐字等于 id"的元素(有 = 该模型在下拉列表里显示;一行里 id 与名字两个节点同文本,取第一个)。 */
export const modelRowShown = (page, id) => modelPage(page).getByText(id, { exact: true }).first();

// ---------------------------------------------------------------------------
// 勾选弹窗:INTERFACE §B 锚点优先;当前代码没有这些锚点 → 兜底为探路实测的既有形态
// (弹窗根 = 罩住「全不选」按钮与 ≥1 个 checkbox 的最深容器;行 = 紧邻 checkbox 的、去掉「已添加」后文字逐字等于 id 的祖先)。
// 用了哪条路径由 anchorPath() 报告,写进测试计划。
// ---------------------------------------------------------------------------
export const legacyPickModal = (page) => page.locator('div')
  .filter({ has: page.getByRole('button', { name: '全不选', exact: true }) })
  .filter({ has: page.locator('input[type=checkbox]') }).last();
export const pickModalAny = (page) => pickModal(page).or(legacyPickModal(page));
export const pickConfirmAny = (page) => pickConfirm(page).or(pickModalAny(page).getByRole('button', { name: '确认', exact: true }));
export const pickCancelAny = (page) => pickModalAny(page).getByRole('button', { name: '取消', exact: true }).first();
export const pickSelectAll = (page) => pickModalAny(page).getByRole('button', { name: '全选', exact: true }).first();
export const pickSelectNone = (page) => pickModalAny(page).getByRole('button', { name: '全不选', exact: true }).first();
export const pickSearchAny = (page) => pickSearch(page)
  .or(pickModalAny(page).locator('input:not([type=checkbox])').first())
  .or(page.locator('input[placeholder="搜索模型…"]:visible').last());
export async function anchorPath(page) {
  return (await pickModal(page).count()) ? 'INTERFACE data-testid' : '既有形态兜底(无 data-testid)';
}
/** 弹窗里模型 id 对应的 checkbox。 */
export async function boxOf(page, id) {
  const byId = pickBox(page, id);
  if (await byId.count()) return byId;
  const modal = legacyPickModal(page);
  const idx = await modal.locator('input[type=checkbox]').evaluateAll((els, id) => els.findIndex((c) => {
    let el = c;
    for (let i = 0; i < 5 && el; i += 1) {
      const t = (el.innerText || el.textContent || '').replace(/已添加/g, '').replace(/\s+/g, ' ').trim();
      if (t === id) return true;
      if (t.length > id.length + 20) return false;
      el = el.parentElement;
    }
    return false;
  }), id);
  if (idx < 0) throw new Error(`勾选弹窗里没有模型 ${id} 这一行(既有形态兜底也没找到)`);
  return modal.locator('input[type=checkbox]').nth(idx);
}
/** 弹窗里全部行的 {id, checked, disabled} 快照(去掉「已添加」标签后的行文字当 id)。 */
export async function pickSnapshot(page) {
  const rows = pickRows(page);
  if (await rows.count()) {
    return rows.evaluateAll((els) => els.map((r) => { const c = r.querySelector('input[type=checkbox]'); return { id: r.getAttribute('data-model-id'), checked: !!c?.checked, disabled: !!c?.disabled }; }));
  }
  return legacyPickModal(page).locator('input[type=checkbox]').evaluateAll((els) => els.map((c) => {
    let el = c; let text = '';
    for (let i = 0; i < 5 && el; i += 1) { text = (el.innerText || el.textContent || '').replace(/已添加/g, '').replace(/\s+/g, ' ').trim(); if (text) break; el = el.parentElement; }
    return { id: text, checked: c.checked, disabled: c.disabled };
  }));
}
export const checkedIds = async (page) => (await pickSnapshot(page)).filter((r) => r.checked).map((r) => r.id).sort();

// ---------------------------------------------------------------------------
// 生图 provider:选中某条 → 「编辑」→ 表单里的「拉取模型」/「保存」
// ---------------------------------------------------------------------------
export const imageProviderSelect = (page, id) => imagePanel(page).locator('select').filter({ has: page.locator(`option[value="${id}"]`) }).first();
export async function openImageProviderEdit(page, id) {
  await openImagePanel(page);
  const sel = imageProviderSelect(page, id);
  await expect(sel, `生图页的提供方下拉里应有 ${id}`).toBeVisible({ timeout: 10_000 });
  await sel.selectOption(id);
  await imagePanel(page).locator('button[title="编辑"]').first().click({ force: true });
  await expect(imageFetchModelsButton(page), '应进入编辑表单(有「拉取模型」)').toBeVisible({ timeout: 10_000 });
}
export const imageFetchModelsButton = (page) => imagePanel(page).getByRole('button', { name: /拉取模型/ }).first();
export const imageSaveButton = (page) => imagePanel(page).getByRole('button', { name: '保存', exact: true }).first();
export const imageModelInput = (page) => imagePanel(page).getByPlaceholder('gpt-image-2').first();

// ---------------------------------------------------------------------------
// Provider 切换浮层:INTERFACE §D 锚点优先;兜底 = 探路实测形态(含「PROVIDER · 当前」头与「管理 Provider」按钮的最深容器,
// 行 = 其中带头像 div[title] 的 button)。
// ---------------------------------------------------------------------------
export const legacySwitchList = (page) => page.locator('div')
  .filter({ has: page.getByRole('button', { name: /管理 Provider/ }) })
  .filter({ hasText: /provider\s*[·•・]\s*当前/i }).last();   // 头部文字屏显为大写 PROVIDER(CSS),DOM 里大小写不定 → 忽略大小写
export const switchListAny = (page) => switchList(page).or(legacySwitchList(page));
export const switchRowsAny = (page) => switchRows(page).or(legacySwitchList(page).locator('button:has(div[title])'));
export async function openProviderList(page) {
  if (!(await switchListAny(page).isVisible().catch(() => false))) await providerButton(page).click({ force: true });
  await expect(switchListAny(page), 'provider 切换浮层应打开').toBeVisible({ timeout: 10_000 });
}
export async function closeProviderList(page) {
  await page.keyboard.press('Escape');
  await expect(switchListAny(page)).toHaveCount(0, { timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(200);
}
