// r122 界面操作层:只按用户看得见的东西 + INTERFACE-r122 公布的锚点定位。
// 依据只有 .devflow/BRIEF-r122.md 与 .devflow/INTERFACE-r122.md;没看实现代码。
import { expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

export const UI_BASE = process.env.R122_UI_BASE || '';
export const API_BASE = process.env.R122_API_BASE || '';
/** INTERFACE A1:开关的存储约定(公开契约)。 */
export const FOLD_KEY = 'cgui-auto-fold-process';

/** 对隔离实例直调接口(准备/核对用)。 */
export async function api(method, url, body) {
  if (!API_BASE) throw new Error('R122_API_BASE 未设置(run.sh 负责)');
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

/**
 * 每次导航前(含刷新)要做的预置。
 *   fold: '1' | '0' | null(= 删掉这个键,即"从没设置过")| undefined(= 完全不碰这个键,留给界面自己写)
 * 用 addInitScript:页面脚本跑之前就生效,所以产品启动时读到的就是这个值。
 * ⚠️ 传了 fold 的用例里不要再指望"界面写入的值能活过刷新"—— 每次导航都会被重置成 fold。
 *    要验"记住选择"(A8)的用例必须传 undefined。
 */
export async function prime(page, { fold } = {}) {
  await page.addInitScript(([key, value]) => {
    try {
      localStorage.setItem('cgui-tour-seen', '1');
      if (value === null) localStorage.removeItem(key);
      else if (value !== undefined && value !== '__untouched__') localStorage.setItem(key, value);
    } catch { /* 忽略 */ }
  }, [FOLD_KEY, fold === undefined ? '__untouched__' : fold]);
  for (const url of ['**/api/version-check', '**/api/claude-version-check']) {
    await page.route(url, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hasUpdate: false, localBuild: true }) }));
  }
}

/** 进应用并压掉一次性浮层。 */
export async function boot(page, opts = {}) {
  await prime(page, opts);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 40_000 });
  await dismissOverlays(page);
}

/** 反复点掉「稍后 / 以后再说 / 已知晓」这类一次性浮层(别用「跳过」当关键词,会误命中产品自己的按钮)。 */
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

/** 侧栏里打开带 mark 的夹具会话(夹具项目第一次必须走搜索)。打开的判据:消息流里出现了轮行。 */
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
  await expect(page.locator('[data-turn-uuid]').first(), `会话 ${mark} 打开后消息流里应出现轮行`).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(400);
}

export const readFoldKey = (page) => page.evaluate((k) => localStorage.getItem(k), FOLD_KEY);

// ---------------------------------------------------------------------------
// 回合条带(INTERFACE A3 的既有锚点)
// ---------------------------------------------------------------------------

/** 已落盘的助手轮行(流式气泡没有 data-turn-uuid)。 */
export const turnRows = (page) => page.locator('[data-turn-uuid][data-turn-role="turn"]');
/** 一轮的条带根(按"这一轮里那段唯一的文字"定位;直播期与收官后都适用)。 */
export const stripRootOf = (page, text) => page.locator('[data-strip-root]').filter({ hasText: text }).first();

/** 条带根的当前显示状态快照(全部是公开锚点)。 */
export async function stripSnapshot(root) {
  if (!(await root.count())) return { present: false };
  return await root.first().evaluate((el) => {
    const head = el.querySelector('[data-strip="head"]');
    const groups = [...el.querySelectorAll('[data-strip-item="group"]')];
    const texts = [...el.querySelectorAll('[data-strip-item="text"]')];
    return {
      present: true,
      state: el.getAttribute('data-strip-state'),
      headCount: el.querySelectorAll('[data-strip="head"]').length,
      headAria: head ? head.getAttribute('aria-expanded') : null,
      kinds: [...el.querySelectorAll('[data-strip-item]')].map((x) => x.getAttribute('data-strip-item')),
      groupCount: groups.length,
      groupHidden: groups.map((g) => g.hasAttribute('hidden')),
      groupHeights: groups.map((g) => Math.round(g.getBoundingClientRect().height)),
      textHidden: texts.map((t) => t.hasAttribute('hidden')),
    };
  });
}

/** 页面上所有条带根的状态,按出现顺序。 */
export const allStripStates = (page) => page.locator('[data-strip-root]')
  .evaluateAll((els) => els.map((el) => el.getAttribute('data-strip-state')));

// ---------------------------------------------------------------------------
// 桩控制(INTERFACE A9:"正在生成"必须由测试可控)
// ---------------------------------------------------------------------------

export function ctlPath(name) {
  const ctl = process.env.R122_CTL;
  if (!ctl) throw new Error('R122_CTL 未设置(run.sh 负责)');
  return path.join(ctl, name);
}
export function writeScenario(scenario) {
  fs.mkdirSync(process.env.R122_CTL, { recursive: true });
  fs.writeFileSync(ctlPath('scenario.json'), `${JSON.stringify(scenario, null, 2)}\n`);
}
/** 放行"停在 result 之前"的回合。 */
export function releaseRound() { fs.writeFileSync(ctlPath('release'), String(Date.now())); }
/** 清掉上一条用例留下的场景与放行文件(不清的话下一轮的 hold 会立刻被放行)。 */
export function resetCtl() {
  for (const name of ['scenario.json', 'release']) { try { fs.unlinkSync(ctlPath(name)); } catch { /* 本来就没有 */ } }
}
export function ctlPhase(sid) { try { return fs.readFileSync(ctlPath(`${sid}.phase`), 'utf8').trim(); } catch { return null; } }

export const composer = (page) => page.getByRole('textbox', { name: /打开命令/ }).or(page.getByPlaceholder(/输入消息|开始一个新会话/)).first();
export const stopButton = (page) => page.getByRole('button', { name: /^停止/ });

export async function sendPrompt(page, text) {
  const box = composer(page);
  await expect(box).toBeVisible({ timeout: 15_000 });
  await box.click({ force: true }).catch(() => {});
  await box.fill(text);
  await box.press('Enter');
}

/** 等回合结束("停止"键消失即回合收尾)。 */
export async function waitRoundIdle(page, timeout = 60_000) {
  await expect.poll(async () => await stopButton(page).count(), { timeout, message: '回合没有结束("停止"键一直在)' }).toBe(0);
}

// ---------------------------------------------------------------------------
// 请求拦截(INTERFACE B7 / C5 允许的测试手段):只匹配路径,忽略 query。一律 HTTP 200。
// ---------------------------------------------------------------------------

export async function routeJson(page, pathname, handler, { method } = {}) {
  await page.route((url) => url.pathname === pathname, async (route) => {
    if (method && route.request().method() !== method) { await route.fallback(); return; }
    const value = typeof handler === 'function' ? await handler(route) : handler;
    if (value === null) { await route.fallback(); return; }
    await route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(value) });
  });
}

// ---------------------------------------------------------------------------
// 设置面板(INTERFACE A2)
// ---------------------------------------------------------------------------

export const FOLD_BLOCK_ID = 'set-auto-fold';
/** 既有的一个开关区块(「生成式界面渲染」),只用来**自证**下面这套开关读写手法对真实设置面板有效。 */
export const EXISTING_SWITCH_BLOCK_ID = 'set-genui';

export const settingsSearch = (page) => page.getByPlaceholder(/搜索设置/).first();
export const settingBlock = (page, id) => page.locator(`#${id}`);
/** 区块里的开关控件:role=switch 或 checkbox(INTERFACE A2 两种都允许)。 */
export const blockSwitch = (page, id) => settingBlock(page, id).locator('[role="switch"], input[type="checkbox"]').first();
export const foldBlock = (page) => settingBlock(page, FOLD_BLOCK_ID);
export const foldSwitch = (page) => blockSwitch(page, FOLD_BLOCK_ID);

/** 打开设置面板(Cmd/Ctrl+0,顶栏「设置」按钮的提示里写明的直达键);落在默认页,不点任何页签。 */
export async function openSettings(page) {
  const box = settingsSearch(page);
  const combo = process.platform === 'darwin' ? 'Meta+0' : 'Control+0';
  await expect(async () => {
    if (await box.isVisible().catch(() => false)) return;
    await page.keyboard.press(combo);           // 应用还没挂好时这一下会丢 → 外层重试
    await expect(box).toBeVisible({ timeout: 4_000 });
  }, '设置面板应当打开(能看到「搜索设置」输入框)').toPass({ timeout: 40_000 });
}

export async function closeSettings(page) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}

/** 刷新页面并等应用重新挂好(不等的话紧跟着的快捷键会丢)。 */
export async function reloadApp(page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 40_000 });
  await dismissOverlays(page);
}

/** 开关当前是不是"开":aria-checked='true' 或原生 checked。控件不存在时返回 null。 */
export async function blockSwitchChecked(page, id) {
  const sw = blockSwitch(page, id);
  if (!(await sw.count())) return null;
  return await sw.evaluate((el) => {
    const aria = el.getAttribute('aria-checked');
    if (aria === 'true') return true;
    if (aria === 'false') return false;
    return typeof el.checked === 'boolean' ? el.checked : null;
  });
}
export const foldSwitchChecked = (page) => blockSwitchChecked(page, FOLD_BLOCK_ID);

/** 像用户那样拨一下开关(控件本身不可见时点它的 label —— 自绘样式的 checkbox 常见)。 */
export async function toggleBlockSwitch(page, id) {
  const block = settingBlock(page, id);
  await expect(block, `设置面板默认页里应当有 #${id} 区块`).toBeVisible({ timeout: 10_000 });
  const sw = blockSwitch(page, id);
  await expect(sw, `#${id} 里应当有一个开关控件(role=switch 或 checkbox)`).toHaveCount(1);
  await block.scrollIntoViewIfNeeded().catch(() => {});
  if (await sw.isVisible().catch(() => false)) await sw.click({ timeout: 5_000 });
  else await block.locator('label').first().click({ timeout: 5_000 });
  await page.waitForTimeout(250);
}
export const toggleFoldSwitch = (page) => toggleBlockSwitch(page, FOLD_BLOCK_ID);

/**
 * 设置搜索的结果条目:探路实测现有形态是搜索框下面的一排按钮(每条 = 标签 + 所在页名)。
 * 不写死它的 DOM 层级,只认"目标区块自身之外、可见、文字含关键词的按钮"。
 */
export const settingsSearchHits = (page, keyword, blockId) => page
  .locator(`button:not(#${blockId} *):visible`).filter({ hasText: keyword });

// ---------------------------------------------------------------------------
// 聊天模式(入口:顶栏「主题」→「界面」页 →「聊天模式」,探路实测)
// ---------------------------------------------------------------------------

export async function enableChatMode(page) {
  await page.locator('button[title="主题与外观"]').first().click({ timeout: 8_000 });
  await page.locator('.glass-popover button').filter({ hasText: /^界面$/ }).first().click({ timeout: 8_000 });
  await page.locator('.glass-popover button').filter({ hasText: '聊天模式' }).first().click({ timeout: 8_000 });
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}
