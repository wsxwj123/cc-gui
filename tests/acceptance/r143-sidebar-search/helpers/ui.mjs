// r143 界面操作层:侧栏搜索框 / 搜索结果行 / 侧栏会话行 / P3 的三个出口 / 重命名框 / 授权卡 ——
// 只用用户看得见的东西(或产品自己给的 data-cgui 句柄)定位。
// 回合相关的几个函数(composer / sendPrompt / waitTurnRunning / switchTo / releaseChunk2 /
// releaseTurnEnd / releaseAllRuns)逐字抄自 tests/acceptance/r118-switch-back/helpers/ui.mjs
// (S3/S4/S7 要在侧栏搜索的同时跑真回合 / 挂真授权卡)。
//
// 关键区分(本套件存在的理由,见 .devflow/PLAN-r143-sidebar-search.md §2.4 + REVIEW-PLAN-r143 §3.1):
//   · 搜索结果行 = 原生 `<button class="sidebar-item">`(App.jsx:1601-1609 的 GlobalSearchResults,
//     `<button>` 起于 :1602)—— **这个元素没有 role 属性**;
//   · 侧栏会话行 = `<div role="button" tabIndex={0} data-cgui="session-row" class="sidebar-item">`
//     (App.jsx:1752-1768;role 在 :1754,句柄在 :1756)。
//   ⇒ 两者的可访问名都含会话标记,所以 `getByRole('button', { name: /标记/ })` **两个都会命中**
//     (`.first()` 谁先出现在 DOM 里就落到谁身上);
//   ⇒ 而 `[role=button].sidebar-item` **只命中会话行** —— 命中行没有 role 属性,压根不在这个选择器的结果里。
//     (旧注释写"两者都匹配它"是错的;`sessionRow()` 之所以能工作,恰恰是因为它只匹配会话行。)
//   2026-09-16 的假红就是这么来的:一行 `getByRole('button', { name: /标记/ }).first()` 以为点的是结果行,
//   实际点到了会话行 ⇒ 走 handleSelect、搜索词不清 ⇒ 侧栏被这个搜索词永久过滤。
//   ⇒ 本文件把搜索结果行钉在 `<button>` 标签上(命中行是 button、会话行是 div),并**优先使用产品句柄
//     `data-cgui="search-hit"`**(REVIEW-PLAN-r143 §7-1 要求开发代理给命中行加的那个句柄);
//     句柄一旦落地,这个双选择器自动切过去,测试不用再改。
import { expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { live } from './fixtures.mjs';

/** 侧栏搜索框(受控输入,data-cgui="sidebar-search")。 */
export const searchInput = (page) => page.getByRole('complementary').getByRole('textbox', { name: /搜索项目/ });

/**
 * 搜索结果行 —— **不是**"名字里含标记的第一个按钮"。
 * 命中行是原生 `<button class="sidebar-item">`(无 role 属性),会话行是 `<div role=button>`:
 * 先认产品句柄 `data-cgui="search-hit"`,没有就退回"侧栏里的原生 button"(只可能命中命中行)。
 */
export const hitRow = (page, mark) =>
  page.locator('[data-cgui="sidebar"] [data-cgui="search-hit"], [data-cgui="sidebar"] button.sidebar-item')
    .filter({ hasText: mark }).first();

/** 侧栏会话行(div[role=button].sidebar-item;搜索期间会被搜索词按标题过滤掉)。 */
export const sessionRow = (page, mark) =>
  page.locator('[role=button].sidebar-item').filter({ hasText: mark }).first();

/** 进应用并压掉旅游浮层/更新检查。 */
export async function boot(page) {
  await page.addInitScript(() => { try { localStorage.setItem('cgui-tour-seen', '1'); } catch {} });
  for (const api of ['**/api/version-check', '**/api/claude-version-check']) {
    await page.route(api, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hasUpdate: false, localBuild: true }) }));
  }
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 40_000 });
}

/**
 * 把夹具项目打开进侧栏(夹具项目不在侧栏常规列表里,第一次必须走搜索)。
 * 点的是**搜索结果行**(hitRow),不是会话行 —— 这是与 r118 老助手的关键差别。
 */
export async function openFixtureProject(page, mark) {
  const search = searchInput(page);
  await search.click();
  await search.fill(mark);
  await expect(search).toHaveValue(mark, { timeout: 5_000 });
  await hitRow(page, mark).click();
  await expect(search, '点搜索结果行后搜索词应立即清空').toHaveValue('', { timeout: 5_000 });
  return search;
}

// ── 回合(抄自 r118;S3/S4 靠这几个把"回合正在跑"造出来)──────────────────────

export const composer = (page) => page.getByPlaceholder(/输入消息|开始一个新会话/).last();

/**
 * 「停止」按钮的产品句柄。working 为假时这个按钮**根本不存在**(ChatInput.jsx:1154 的二态分支),
 * 所以"它在不在"就是"界面认为这一轮还在不在跑"的判据 —— 比按名字 `/^停止/` 更准
 * (那个正则还会命中「停止后台 N」)。
 */
export const stopBtn = (page) => page.locator('[data-cgui="stop-btn"]');

// ── P3 的三个出口(S5/S5b;三个句柄各用各的,不许互相替代)──────────────────────
/** 搜索框里的 × 清空钮(只在有词时出现)。 */
export const clearSearchBtn = (page) => page.locator('[data-cgui="sidebar-search-clear"]');
/** 过滤态说明行(有词时出现;文案「已按搜索词过滤 · 匹配 N 条会话」)。 */
export const filterHint = (page) => page.locator('[data-cgui="sidebar-search-filter-hint"]');
/** 说明行里的「清空」—— 与 × 是**两个不同出口**。 */
export const clearSearchHintBtn = (page) => page.locator('[data-cgui="sidebar-search-clear-hint"]');

// ── S6/S7/S9 用到的界面元素 ─────────────────────────────────────────────────
/** 会话重命名输入框(⋯ → 重命名 之后出现,autoFocus)。 */
export const renameInput = (page) => page.getByPlaceholder(/自定义标题/);
/** 权限卡的「拒绝」按钮(title="Esc")—— 卡挂着 = 它在;卡被裁决掉 = 它消失。 */
export const denyBtn = (page) => page.getByRole('button', { name: '拒绝', exact: true });
/**
 * 确认框的宿主节点(confirmDialog 自挂到 document.body,**带 data-cgui-confirm="1"**)。
 * 宿主本身没有尺寸(fixed 子节点撑不出它的盒子)⇒ 只判 `toHaveCount`,不要判可见性。
 */
export const confirmHost = (page) => page.locator('[data-cgui-confirm]');
/** 侧栏此刻**渲染出来**的会话行(搜索词生效时,不匹配的行根本不渲染)。 */
export const sessionRows = (page) => page.locator('[data-cgui="session-row"]');

/** 在一个会话里发一条消息(打字 + Enter)。 */
export async function sendPrompt(page, text) {
  const box = composer(page);
  await expect(box).toBeVisible({ timeout: 15_000 });
  await box.fill(text);
  await box.press('Enter');
}

/** 等这一轮"正在生成":假 CLI 吐出第一块文字 + 停止按钮在。 */
export async function waitTurnRunning(page, sid, prompt) {
  await expect(page.getByText(live.chunk1(sid, prompt), { exact: false }).first(), '回合应吐出第一块文字')
    .toBeVisible({ timeout: 30_000 });
  await expect(stopBtn(page), '回合进行中应有可用的停止按钮').toHaveCount(1, { timeout: 10_000 });
}

/** 用户切会话:点另一条会话的行(会话行内容在回合跑完后可能被改标题,别跨回合复用同一条)。 */
export async function switchTo(page, mark) {
  const row = sessionRow(page, mark);
  await expect(row, `侧栏里应能看到会话 ${mark}`).toBeVisible({ timeout: 15_000 });
  await row.click();
  await page.waitForTimeout(500);   // 让窗格把会话换过来再开始观察(换的过程中界面还是旧会话)
}

export const rel = (ctl, sid, suffix) => path.join(ctl, `${sid}${suffix}`);
/** 放行假 CLI 的第二块(它停在"等 <sid>.chunk"上)。 */
export const releaseChunk2 = (ctl, sid) => fs.writeFileSync(rel(ctl, sid, '.chunk'), String(Date.now()));
/** 放行假 CLI 收尾(它停在"等 <sid>.done"上)。 */
export const releaseTurnEnd = (ctl, sid) => fs.writeFileSync(rel(ctl, sid, '.done'), String(Date.now()));

/** 放行本实例里**所有**还停着的回合(按假 CLI 自己落的 <sid>.started 找);收尾用。 */
export function releaseAllRuns(ctl) {
  if (!ctl) return;
  let names = [];
  try { names = fs.readdirSync(ctl); } catch { return; }
  for (const name of names) {
    const m = /^(.+)\.started$/.exec(name);
    if (!m) continue;
    fs.writeFileSync(path.join(ctl, `${m[1]}.chunk`), 'x');
    fs.writeFileSync(path.join(ctl, `${m[1]}.done`), 'x');
  }
}

// ── S6/S7/S9 的几个"进入点" ─────────────────────────────────────────────────
/**
 * 打开某条会话行的 ⋯ 菜单,等菜单项出现,返回那一行。
 * 操作钮是会话行的**兄弟**节点(同一个 wrapper 里),所以从行往上取一层再找;
 * md 断点下它默认 opacity-0、hover 才显形,先 hover 一下。
 */
export async function openSessionMenu(page, mark) {
  const row = sessionRow(page, mark);
  await expect(row, `侧栏里应能看到会话 ${mark}`).toBeVisible({ timeout: 15_000 });
  await row.hover();
  await row.locator('xpath=..').getByTestId('session-actions-btn').click();
  await expect(page.getByTestId('session-actions-rename'), '会话 ⋯ 菜单应展开').toBeVisible({ timeout: 5_000 });
  return row;
}

/** ⋯ → 重命名:把某条会话行切进重命名态,返回那个输入框(autoFocus 已经在里面)。 */
export async function startRenameSession(page, mark) {
  await openSessionMenu(page, mark);
  await page.getByTestId('session-actions-rename').click();
  const input = renameInput(page);
  await expect(input, '点「重命名」后应出现输入框').toBeVisible({ timeout: 5_000 });
  return input;
}

/**
 * ⋯ → 删除会话:走 `confirmDialog`(S9 的入口)。**只负责把确认框叫出来**,
 * 后面按 Esc 取消(S9 断言的就是"取消"),所以不会真删。
 */
export async function openDeleteConfirm(page, mark) {
  await openSessionMenu(page, mark);
  await page.getByTestId('session-actions-delete').click();
  await expect(confirmHost(page), '点「删除会话」后应出现确认框').toHaveCount(1, { timeout: 5_000 });
  await expect(page.getByText('删除该会话的本地历史记录'), '确认框文案').toBeVisible({ timeout: 5_000 });
}

/**
 * 让这条会话的**下一个回合**挂一张授权卡(S7):假 CLI 吐完第一块后会发 can_use_tool 并等应答。
 * 必须在发消息之前调用(回合一开始就会读这个开关)。
 */
export const armPermissionCard = (ctl, sid) => fs.writeFileSync(rel(ctl, sid, '.permission'), '1');
export const disarmPermissionCard = (ctl, sid) => { try { fs.unlinkSync(rel(ctl, sid, '.permission')); } catch { /* 本来就没有 */ } };
