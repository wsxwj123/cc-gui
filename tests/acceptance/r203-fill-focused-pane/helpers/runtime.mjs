// r203-fill-focused-pane 验收套件的运行时守卫、导航与页面观测。
// 铁规:只连 127.0.0.1 上本套件自己的隔离实例;只通过页面(文案 / role / data-* 锚点)观测,不读源码、不读应用内部状态。
import fs from 'node:fs';
import { expect } from '@playwright/test';
import { manifestPath } from './fixtures.mjs';

export class EnvironmentBlocked extends Error {
  constructor(message) {
    super(`ENVIRONMENT_BLOCKED: ${message}`);
    this.name = 'EnvironmentBlocked';
  }
}

export function getRuntime() {
  const baseURL = process.env.BASE_URL;
  if (!baseURL) throw new EnvironmentBlocked('set BASE_URL to the isolated test instance (use run.sh)');
  const url = new URL(baseURL);
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) throw new EnvironmentBlocked('BASE_URL must be loopback');
  const port = Number(url.port || 80);
  if ([6677, 6689, 6710, 8788, 8789, 8798, 8799].includes(port)) throw new EnvironmentBlocked(`port ${port} is reserved`);
  if (port < 6700 || port > 6999) throw new EnvironmentBlocked(`port ${port} is outside the reserved test range (6700-6999)`);
  return { baseURL: url.toString().replace(/\/$/, ''), port };
}

export function fixtureManifest() {
  const file = manifestPath();
  if (!fs.existsSync(file)) throw new EnvironmentBlocked(`missing ${file}; run.sh creates it`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ───────────────────────── 导航 ─────────────────────────
const OVERLAY_DISMISS = ['关闭指引', '跳过', '稍后', '知道了'];

export async function dismissOverlays(page) {
  for (const name of OVERLAY_DISMISS) {
    const b = page.getByRole('button', { name, exact: true });
    if ((await b.count()) && (await b.first().isVisible().catch(() => false))) {
      await b.first().click().catch(() => {});
      await page.waitForTimeout(150);
    }
  }
}


// 桌面外壳替身(接口文件给定):页面登记 cgui:screenshot-hotkey 监听,测试用 window.__fireShot() 触发。
const SHELL_STUB = () => {
  const cbs = new Map(); let n = 0; const listeners = {};
  window.__TAURI_INTERNALS__ = {
    transformCallback(cb) { n += 1; cbs.set(n, cb); return n; },
    unregisterCallback(id) { cbs.delete(id); },
    async invoke(cmd, args) {
      if (cmd === 'plugin:event|listen') { (listeners[args.event] ||= []).push(args.handler); return listeners[args.event].length; }
      return null;
    },
    convertFileSrc: (p) => p,
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
  };
  window.__fireShot = () => { for (const id of listeners['cgui:screenshot-hotkey'] || []) { const cb = cbs.get(id); if (cb) cb({ event: 'cgui:screenshot-hotkey', id: 1, payload: null }); } };
};

/** 打开页面。split=true:只在第一次加载时往 localStorage 写两格分屏(刷新时不再写;用 sessionStorage 标记「已写过」)。 */
export async function openApp(page, { split = false } = {}) {
  await page.addInitScript((wantSplit) => {
    try {
      localStorage.setItem('cgui-tour-seen', '1');
      if (wantSplit && !sessionStorage.getItem('r203-split-written')) {
        localStorage.setItem('cgui-pane-count', '2');
        localStorage.setItem('cgui-active-tab-index', '0');
        sessionStorage.setItem('r203-split-written', '1');
      }
    } catch { /* 忽略 */ }
  }, split);
  await page.addInitScript(SHELL_STUB);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await dismissOverlays(page);
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 60_000 });
}

export async function reloadApp(page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await dismissOverlays(page);
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 60_000 });
}

export const ROWS = '[data-cgui="session-row"]';
export const sessionRows = (page) => page.locator(ROWS);
export const panes = (page) => page.locator('[data-testid="pane"]');
const projectRow = (page, ctx) => page.locator('[data-cgui="project-row"]').filter({ hasText: ctx.workspaceName });

/** 展开本用例工作区在侧栏里的分组(已展开就不动)。 */
export async function openWorkspaceGroup(page, ctx) {
  const pr = projectRow(page, ctx).first();
  await expect(pr, `侧栏里应有本用例的工作区 ${ctx.workspaceName}`).toBeVisible({ timeout: 30_000 });
  if ((await pr.getAttribute('aria-expanded')) !== 'true') await pr.click();
  await expect(sessionRows(page).first(), '展开工作区后应出现会话行').toBeVisible({ timeout: 15_000 });
}

/** 在第 i 格(从 0 数起)上按下鼠标并抬起,使它成为聚焦窗格。落点取窗格上部偏中,避开底部输入框。 */
export async function focusPane(page, i) {
  const pane = panes(page).nth(i);
  await expect(pane, `第 ${i + 1} 格应存在`).toBeVisible({ timeout: 15_000 });
  const box = await pane.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.35);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(300);
}

/** 点侧栏里含 text 的会话行。 */
export async function clickRowWith(page, text, { timeout = 20_000 } = {}) {
  const row = sessionRows(page).filter({ hasText: text }).first();
  await expect(row, `侧栏里应有含「${text}」的会话行`).toBeVisible({ timeout });
  await row.click({ timeout: 5_000 });
}

/**
 * 分屏起步:两格启动 → 聚焦左格 → 点侧栏会话 S 行,S 进左格。返回时左格聚焦、显示 S 的历史回复,右格是空的。
 * (单栏版本见 openSingleWithS。)
 */
export async function openSplitWithS(page, ctx) {
  await openApp(page, { split: true });
  await expect(panes(page), '应是两格分屏').toHaveCount(2, { timeout: 15_000 });
  await openWorkspaceGroup(page, ctx);
  await clickRowWith(page, ctx.seed.marker);
  await expect(panes(page).nth(0), '左格应显示 S 的历史回复').toContainText('R203 历史回复', { timeout: 20_000 });
}

/** 单栏起步:打开页面 → 点 S 行 → 点「新建会话」,停在新会话首页。 */
export async function openSingleHome(page, ctx) {
  await openApp(page);
  await openWorkspaceGroup(page, ctx);
  await clickRowWith(page, ctx.seed.marker);
  await expect(page.locator('[data-cgui="message-list"]'), 'S 的历史回复应显示').toContainText('R203 历史回复', { timeout: 20_000 });
  const btn = page.getByRole('button', { name: '新建会话' }).first();
  await expect(btn, '应有「新建会话」按钮').toBeVisible({ timeout: 15_000 });
  await btn.click();
  await expect(page.getByPlaceholder('输入消息，开始一个新会话…').last(), '点「新建会话」后应出现新会话首页输入框').toBeVisible({ timeout: 15_000 });
}

/** 在第 i 格(null = 整页最后一个)的输入框里输入 text 并回车。 */
export async function sendIn(page, i, text) {
  const scope = i === null ? page : panes(page).nth(i);
  const box = scope.getByPlaceholder(/^输入消息/).last();
  await expect(box, `${i === null ? '页面' : `第 ${i + 1} 格`}应有可用输入框`).toBeVisible({ timeout: 15_000 });
  await box.fill(text);
  await box.press('Enter');
}

export const HOME_PLACEHOLDER = '输入消息，开始一个新会话…';
export const homeBoxIn = (page, i) => panes(page).nth(i).getByPlaceholder(HOME_PLACEHOLDER);

// ───────────────────────── 顶栏观测与操作 ─────────────────────────
const modelBtn = (page) => page.locator('header[data-cgui="topbar"] [data-cgui="model-selector"] button[title^="模型:"]').first();
const effortBtn = (page) => page.locator('header[data-cgui="topbar"] [data-cgui="effort-selector"] button[title^="Effort:"]').first();

/** 顶栏当前显示的模型 id(title「模型: <id>」,截掉全角括号「（」及之后)。 */
export async function topModel(page) {
  const t = (await modelBtn(page).getAttribute('title')) || '';
  return t.replace(/^模型:\s*/, '').split('（')[0].trim();
}
/** 顶栏当前显示的思考强度中文名(title「Effort: <档位>」)。 */
export async function topEffort(page) {
  const t = (await effortBtn(page).getAttribute('title')) || '';
  return t.replace(/^Effort:\s*/, '').trim();
}

const ALIAS_LABEL = { sonnet: 'Sonnet (alias)', opus: 'Opus (alias)', haiku: 'Haiku (alias)', fable: 'Fable (alias)' };

/** 在顶栏模型选择器里选别名行 alias(sonnet / opus / haiku / fable);选完等顶栏显示该 id。 */
export async function selectModel(page, alias) {
  await modelBtn(page).click();
  const row = page.getByRole('button').filter({ hasText: ALIAS_LABEL[alias] }).first();
  await expect(row, `模型列表里应有「${ALIAS_LABEL[alias]}」行`).toBeVisible({ timeout: 10_000 });
  await row.click();
  await expect.poll(() => topModel(page), { message: `选了 ${alias} 之后顶栏应显示 ${alias}`, timeout: 10_000 }).toBe(alias);
}

/** 在顶栏思考强度选择器里选档位 name(默认/低/中/高/极高/极限,按开头匹配);选完等顶栏显示该档。 */
export async function selectEffort(page, name) {
  await effortBtn(page).click();
  const scoped = page.locator('[data-cgui="effort-selector"] button:not([title^="Effort:"])').filter({ hasText: new RegExp(`^\\s*${name}`) });
  const wide = page.locator('button:not([title^="Effort:"])').filter({ hasText: new RegExp(`^\\s*${name}(?!高)`) });
  const row = (await scoped.count()) ? scoped.first() : wide.first();
  await expect(row, `强度列表里应有「${name}」档`).toBeVisible({ timeout: 10_000 });
  await row.click();
  await expect.poll(() => topEffort(page), { message: `选了 ${name} 之后顶栏应显示 ${name}`, timeout: 10_000 }).toBe(name);
}

// ───────────────────────── 假命令行侧观测 ─────────────────────────
/** 等假命令行收到含 marker 的用户消息;返回收到的那些条({model, effort, …});最晚等 timeoutMs。 */
export async function waitReceived(page, receivedMsgs, marker, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const got = receivedMsgs(marker);
    if (got.length) return got;
    if (Date.now() >= end) return got;
    await page.waitForTimeout(100);
  }
}
export async function waitDone(page, doneMsgs, marker, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const got = doneMsgs(marker);
    if (got.length) return got.length;
    if (Date.now() >= end) return 0;
    await page.waitForTimeout(100);
  }
}

export function uniqueTag(prefix = '') { return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`; }

// ───────────────────────── 截图 / 添加到上下文 ─────────────────────────
/** 触发截图快捷键(经外壳替身)。 */
export async function fireShot(page) {
  await page.evaluate(() => window.__fireShot());
}

const SHOT_NAME = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png/;
/** 第 i 格(null = 整页)里截图附件卡片(文件名形如 <uuid>.png)。 */
export const shotCardsIn = (page, i) => (i === null ? page : panes(page).nth(i)).getByText(SHOT_NAME);

/** 当前窗格输入框(第 i 格里最后一个「输入消息…」框)。 */
export const inputIn = (page, i) => panes(page).nth(i).getByPlaceholder(/^输入消息/).last();

/** 展开工具坞 → 文件浏览器 → 对名为 fileName 的文件行右键 → 点「添加到上下文」。 */
export async function addFileToContext(page, fileName) {
  await page.locator('[data-testid="panel-dock-toggle"]').click();
  const fb = page.locator('button[title="文件浏览器"]').first();
  await expect(fb, '工具坞里应有「文件浏览器」按钮').toBeVisible({ timeout: 15_000 });
  await fb.click();
  const row = page.getByText(fileName, { exact: true }).first();
  await expect(row, `文件浏览器里应有文件 ${fileName}`).toBeVisible({ timeout: 20_000 });
  await row.click({ button: 'right' });
  const item = page.getByRole('button', { name: '添加到上下文', exact: true }).first();
  await expect(item, '右键菜单里应有「添加到上下文」').toBeVisible({ timeout: 10_000 });
  await item.click();
}
