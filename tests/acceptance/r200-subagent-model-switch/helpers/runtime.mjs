// r200-subagent-model-switch 验收套件的运行时守卫、导航与页面观测。
// 铁规:只连 127.0.0.1 上本套件自己的隔离实例;只通过页面(文案 / role / data-* 锚点 / title)观测,不读源码、不读应用内部状态。
import fs from 'node:fs';
import { expect } from '@playwright/test';
import { manifestPath } from './fixtures.mjs';
import { OPEN_VIEW_TITLE } from './transcripts.mjs';

export const BACKEND_PORT = 6975;
export const PAGE_PORT = 6976;
const RESERVED = [6677, 6689, 6710, 8788, 8789, 8798, 8799];

export class EnvironmentBlocked extends Error {
  constructor(message) { super(`ENVIRONMENT_BLOCKED: ${message}`); this.name = 'EnvironmentBlocked'; }
}

export function getRuntime() {
  const baseURL = process.env.BASE_URL;
  if (!baseURL) throw new EnvironmentBlocked('set BASE_URL to the isolated test instance (use run-isolated.sh)');
  const url = new URL(baseURL);
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) throw new EnvironmentBlocked('BASE_URL must be loopback');
  const port = Number(url.port || 80);
  if (RESERVED.includes(port)) throw new EnvironmentBlocked(`port ${port} is reserved`);
  if (port !== PAGE_PORT) throw new EnvironmentBlocked(`port ${port} is not this suite's page port ${PAGE_PORT}`);
  return { baseURL: url.toString().replace(/\/$/, ''), port, backend: `http://127.0.0.1:${BACKEND_PORT}` };
}

export function fixtureManifest() {
  const file = manifestPath();
  if (!fs.existsSync(file)) throw new EnvironmentBlocked(`missing ${file}; run-isolated.sh creates it`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function uniqueTag(prefix = '') { return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`; }
export const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

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

export async function openApp(page) {
  await page.addInitScript(() => { try { localStorage.setItem('cgui-tour-seen', '1'); } catch { /* 忽略 */ } });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await dismissOverlays(page);
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 60_000 });
}

export async function reloadApp(page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await dismissOverlays(page);
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 60_000 });
}

export const stopBtn = (page) => page.locator('[data-cgui="stop-btn"]');
export const messageList = (page) => page.locator('[data-cgui="message-list"]');
const projectRow = (page, ctx) => page.locator('[data-cgui="project-row"]').filter({ hasText: ctx.workspaceName });
const sessionRows = (page) => page.locator('[data-cgui="session-row"]');

export async function openWorkspaceGroup(page, ctx) {
  const pr = projectRow(page, ctx).first();
  await expect(pr, `侧栏里应有本用例的工作区 ${ctx.workspaceName}`).toBeVisible({ timeout: 30_000 });
  if ((await pr.getAttribute('aria-expanded')) !== 'true') await pr.click();
  await expect(sessionRows(page).first(), '展开工作区后应出现会话行').toBeVisible({ timeout: 15_000 });
}

/** who = 'seed'(含种子标记的那一行)| 'fresh'(本工作区里不含种子标记的那一行,即用例新建的会话)。 */
export async function clickSession(page, who, ctx, { timeout = 20_000 } = {}) {
  const rows = sessionRows(page);
  const deadline = Date.now() + timeout;
  let texts = [];
  for (;;) {
    texts = await rows.allInnerTexts();
    const idx = who === 'seed' ? texts.findIndex((t) => t.includes(ctx.seed.marker)) : texts.findIndex((t) => !t.includes(ctx.seed.marker));
    if (idx >= 0) { await rows.nth(idx).click({ timeout: 5_000 }); return; }
    if (Date.now() > deadline) throw new Error(`侧栏里 ${timeout}ms 内找不到「${who}」会话行;当前各行 = ${JSON.stringify(texts)}`);
    await page.waitForTimeout(150);
  }
}

export function composerBox(page) {
  return page.getByPlaceholder(/输入消息|开始一个新会话|发消息|问点什么/).or(page.locator('textarea'));
}

/** 打开应用 → 展开本用例工作区 → 点开种子会话 → 点「新建会话」,停在一个全新空会话上。 */
export async function openNewSession(page, ctx) {
  await openApp(page);
  await openWorkspaceGroup(page, ctx);
  await clickSession(page, 'seed', ctx);
  await expect(messageList(page), '种子会话的历史回复应显示').toContainText('R200 历史回复', { timeout: 20_000 });
  const btn = page.getByRole('button', { name: '新建会话' }).first();
  await expect(btn, '应有「新建会话」按钮').toBeVisible({ timeout: 15_000 });
  await btn.click();
  await expect(composerBox(page).last(), '点「新建会话」后应出现输入框').toBeVisible({ timeout: 15_000 });
  await expect(messageList(page).filter({ hasText: 'R200 历史回复' }), '新会话里不应还留着种子会话的历史回复').toHaveCount(0, { timeout: 10_000 });
}

export async function sendText(page, text) {
  const box = composerBox(page).last();
  await expect(box).toBeVisible({ timeout: 15_000 });
  await box.fill(text);
  await box.press('Enter');
}

/** 回合结束 = 停止键先出现、再消失。 */
export async function waitTurnEnded(page) {
  await expect(stopBtn(page), '发出消息后应先看到停止键(回合已开始)').toBeVisible({ timeout: 20_000 });
  await expect(stopBtn(page), '回合应当结束(停止键消失)').toHaveCount(0, { timeout: 60_000 });
}

/** 打开应用后刷新、展开工作区、点开历史会话(由夹具铺好文件)。 */
export async function openStaticSession(page, ctx) {
  await openApp(page);
  await reloadApp(page);
  await openWorkspaceGroup(page, ctx);
  await clickSession(page, 'seed', ctx);
  await expect(messageList(page), '历史会话的末尾回复应显示').toContainText(ctx.doneText, { timeout: 30_000 });
}

// ───────────────────────── 子代理:卡片 / 子代理页 / 监控面板 ─────────────────────────
/** 子代理卡片 = 一轮里含「在子代理会话窗口打开」按钮的那个条目。 */
export const cardEntry = (page) => page.locator('[data-entry-state]').filter({ has: page.locator(`[title="${OPEN_VIEW_TITLE}"]`) });

/** 工具调用收在折叠组里:点组头展开,直到子代理卡片可见。 */
export async function expandGroup(page) {
  const head = page.locator('[data-work-group-head]').first();
  await expect(head, '应有折叠组的组头').toBeVisible({ timeout: 20_000 });
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
  await expect(cardEntry(page).first(), '展开折叠组后应看到子代理卡片').toBeVisible({ timeout: 15_000 });
}

/** 展开卡片(已展开就不动);返回卡片范围。 */
export async function expandCard(page) {
  const card = cardEntry(page).first();
  const titleRow = card.locator('button[aria-expanded]').first();
  if ((await titleRow.getAttribute('aria-expanded')) !== 'true') await titleRow.click();
  return card;
}

export async function openSubagentView(page) {
  const card = cardEntry(page).first();
  await card.hover();
  await card.locator(`[title="${OPEN_VIEW_TITLE}"]`).first().click({ timeout: 10_000 });
  const view = page.locator('[data-cgui="subagent-view"]');
  await expect(view.first(), '点「在子代理会话窗口打开」后应出现子代理页').toBeVisible({ timeout: 15_000 });
  return view.first();
}

/** 顶栏 →「监控」。 */
export async function openMonitor(page) {
  await dismissOverlays(page);
  if (!(await page.getByRole('button', { name: '监控', exact: true }).first().count())) {
    await page.locator('[data-testid="panel-dock-toggle"]').first().click().catch(() => {});
    await page.waitForTimeout(500);
    await dismissOverlays(page);
  }
  const monitor = page.getByRole('button', { name: '监控', exact: true }).first();
  await expect(monitor, '顶栏必须有「监控」入口').toBeVisible({ timeout: 10_000 });
  await monitor.click();
  await expect(page.getByText('子代理 (', { exact: false }).first(), '监控面板必须渲染出「子代理 (N)」区').toBeVisible({ timeout: 10_000 });
}

const MODEL_RE = '/claude-[a-z0-9.-]+/';
const MONEY_RE_SRC = '^[¥$]\\s?[\\d,]+(?:\\.\\d+)?$|^未能计价$|^另有 \\d+ 个未能计价$';

/**
 * 监控面板(对话流窗格之外)里这条子代理那一行:以描述文字或 toolUseId 为锚点(取叶子节点),
 * 往上走到第一个「看得见 want 的内容」的祖先,返回它的可见文字(空白归一)与里面的金额叶节点。
 * want = 'model'(含 claude-… 模型名)| 'money'(含金额 / 未能计价小标)。找不到返回 { found:false }。
 */
export async function monitorRow(page, ctx, want) {
  return await page.evaluate(({ anchors, want, modelSrc, moneySrc }) => {
    const pane = document.querySelector('[data-testid="pane"]');
    const money = new RegExp(moneySrc);
    const model = new RegExp(modelSrc.slice(1, -1));
    const leaves = [...document.querySelectorAll('*')].filter((el) => el.querySelector('*') === null && !(pane && pane.contains(el))
      && anchors.some((a) => (el.textContent || '').includes(a)));
    const hasWant = (el) => (want === 'model'
      ? model.test(el.innerText || '')
      : [...el.querySelectorAll('*')].some((x) => x.querySelector('*') === null && money.test((x.textContent || '').trim())));
    for (const leaf of leaves) {
      let cur = leaf;
      for (let i = 0; cur && cur !== document.body && i < 12; i += 1, cur = cur.parentElement) {
        if (hasWant(cur)) {
          return {
            found: true,
            text: (cur.innerText || '').replace(/\s+/g, ' ').trim(),
            money: [...cur.querySelectorAll('*')].filter((x) => x.querySelector('*') === null && money.test((x.textContent || '').trim())).map((x) => x.textContent.trim()),
          };
        }
      }
    }
    return { found: false, text: '', money: [] };
  }, { anchors: [ctx.toolUseId, ctx.description], want, modelSrc: MODEL_RE, moneySrc: MONEY_RE_SRC });
}

/** 某个范围元素(卡片)里的金额 / 未能计价叶节点。 */
export async function moneyIn(locator) {
  return await locator.first().evaluate((root, moneySrc) => {
    const money = new RegExp(moneySrc);
    return [...root.querySelectorAll('*')].filter((x) => x.querySelector('*') === null && money.test((x.textContent || '').trim())).map((x) => x.textContent.trim());
  }, MONEY_RE_SRC);
}

/** 金额文字 → 美元数(¥ 按 7.2 折回;读不出返回 null)。 */
export function usdOf(text) {
  const m = String(text).trim().match(/^([¥$])\s?([\d,]+(?:\.\d+)?)$/);
  if (!m) return null;
  const v = Number(m[2].replace(/,/g, ''));
  return m[1] === '¥' ? v / 7.2 : v;
}

// ───────────────────────── 计价环境(只给费用用例用) ─────────────────────────
const quote = (modelId, input, output) => ({
  quoteId: `r200-${modelId}`, provider: 'r200-synthetic', presetIds: ['r200-synthetic'], modelId, displayName: modelId,
  protocol: null, market: 'global', currency: 'USD', unit: 'per 1M tokens',
  prices: { input, output, cacheRead: null, cacheWrite5m: null, cacheWrite1h: null },
  conditions: null, validFrom: null, validTo: null, sourceUrl: 'https://example.test/pricing', sourceKind: 'official',
  fetchedAt: '2026-09-11T08:15:56.307Z', parserVersion: 'r200-test', status: 'fresh',
});
export const OFFICIAL_QUOTES = [quote('claude-opus-5', 5, 25), quote('claude-fable-5-1', 10, 50)];

/** 页面的价目入口(GET /api/pricing)注入一份合成报价(与 pricing-accuracy-20260911 套件同一手法)。 */
export async function routeCatalog(page, quotes) {
  const payload = { source: 'official-sources', fetchedAt: '2026-09-11T08:15:56.307Z', prices: {}, schemaVersion: 2, providers: [], quotes, refresh: null };
  await page.route('**/api/pricing**', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  });
}

/** 建并切到一个非套餐档的自定义 provider(否则 claude-* 模型按套餐计费不显示金额);走公开 HTTP 入口。 */
export async function ensureNonPlanProvider(request) {
  const { backend } = getRuntime();
  const P = { name: 'R200 计价', type: 'openai', baseURL: 'https://r200.invalid/v1', apiKey: 'r200-placeholder', models: ['claude-opus-5', 'claude-fable-5-1'] };
  const listed = await request.get(`${backend}/api/custom-providers`, { failOnStatusCode: false });
  const parsed = await listed.json().catch(() => []);
  const rows = Array.isArray(parsed) ? parsed : (parsed?.providers ?? []);
  let id = rows.find((r) => r?.name === P.name)?.id;
  if (!id) {
    const created = await request.post(`${backend}/api/custom-providers`, { data: P, failOnStatusCode: false });
    const body = await created.json().catch(() => null);
    if (created.status() !== 200 || !body?.id) throw new EnvironmentBlocked(`建不出计价用的 provider:HTTP ${created.status()}`);
    id = body.id;
  }
  const sw = await request.post(`${backend}/api/provider/switch`, { data: { id }, failOnStatusCode: false });
  if (sw.status() !== 200) throw new EnvironmentBlocked(`切不到计价用的 provider(HTTP ${sw.status()})`);
}
