// PA-514…PA-519：A 项（子代理花费）在**真浏览器里的呈现位置与数字** —— 契约 §10.1 / §10.3；
// 需求书口径（本文件逐条对应）：前台子代理 = 对话流 Task 卡片 + 监控面板都显示；
// 后台子代理 = 只在监控面板显示；workflow = 对话流那张卡片显示内部全部 agent 的合计、监控面板逐条显示；
// 归属不上的 = 在该 agent 位置显示小标「未能计价」、金额留空；轮末花费与三处命中率口径一字未变。
//
// 黑盒取法（不读实现代码）：
//   ① 期望金额**不在用例里写死**，一律按契约 §5.2/§5.3 用「该 agent 转写的 usage × 本用例注入的报价」现算
//      （报价经 §3.1 的 `GET /api/pricing` 注入 —— 那是客户端唯一的价目入口，与 E 项用例拦保存请求同一手法）；
//   ② 位置判据只用公开 DOM 身份：`[data-testid="pane"]` 是对话流窗格，监控面板在它之外；
//      卡片/行里的金额 = 该锚点最近一个「行/卡片」容器里的金额叶节点；轮末金额 = 父容器含「整轮命中率」的那一个。
//   ③ 契约**没有**公布 agent 行与金额的 `data-testid`，本文件用夹具自带的文字（agent 描述、toolUseId、
//      agent 短 id）当锚点 —— 这是已知脆点，需要的钩子清单见 README「A 项 UI 呈现」一节。
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import {
  getRuntime, requireUI, pricingPayload, quote, readMessages, EnvironmentBlocked,
} from './helpers/pa-runtime.mjs';
import { ensureFixtureManifest } from './helpers/pa-fixtures.mjs';

// ---------------------------------------------------------------------------
// 夹具与期望值
// ---------------------------------------------------------------------------

function subagentFixtures() {
  const manifest = ensureFixtureManifest();
  if (!manifest.subagents?.dir || !manifest.subagents.background?.sessionId) {
    throw new EnvironmentBlocked('夹具清单里没有 subagents 段（或没有 background 段）—— 跑 `node helpers/pa-fixtures.mjs` 重建');
  }
  return manifest.subagents;
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

/** 本用例注入的报价（USD / 1M tokens）。四维显式给出；`null` = 该维度未知（契约 §5.1）。 */
const QUOTES = [
  { modelId: 'claude-opus-5', prices: { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: null, cacheWrite1h: null } },
  { modelId: 'claude-sonnet-4-6', prices: { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: null, cacheWrite1h: null } },
];
const PRICES = Object.fromEntries(QUOTES.map(item => [item.modelId, item.prices]));

/** 契约 §2：美元来源的展示值 = 1 USD ≈ 7.2 CNY，展示保留 3 位小数。 */
const CNY_PER_USD = 7.2;
/** 3 位小数展示的舍入误差上限 = 5e-4，留一点余量。 */
const CNY_TOLERANCE = 0.001;

function catalogPayload() {
  return pricingPayload({
    quotes: QUOTES.map(item => quote({ quoteId: `pa-ui-${item.modelId}`, modelId: item.modelId, prices: item.prices })),
  });
}

/**
 * 展示金额期望值（CNY）= 该记录的用量 × 本用例注入的报价（契约 §5.2 第 1–3 条：本报价无时段/长档条件，
 * 也没有 cacheWrite 价 —— 写费维度进未知、不计入，加不加都是同一个数）。
 */
function expectedCny(record) {
  const price = PRICES[record.model];
  if (!price) throw new EnvironmentBlocked(`夹具记录的 model「${record.model}」不在本用例的报价里，期望值算不出来`);
  const u = record.usage || {};
  const usd = ((u.input_tokens || 0) * price.input
    + (u.output_tokens || 0) * price.output
    + (u.cache_read_input_tokens || 0) * price.cacheRead) / 1e6;
  return usd * CNY_PER_USD;
}

function formatCny(value) {
  return `¥${value.toFixed(3)}`;
}

function parseCny(text) {
  const match = String(text).trim().match(/^¥\s?([\d,]+(?:\.\d+)?)$/);
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

/** 孤儿 agent 的归属键只在它的 meta.json 里（父 jsonl 里没有）—— 也用它把面板里的行彼此分开。 */
function orphanToolUseId(fixture) {
  const metaFile = path.join(fixture.dir, fixture.task.sessionId, 'subagents', `${fixture.task.orphanId}.meta.json`);
  return JSON.parse(fs.readFileSync(metaFile, 'utf8')).toolUseId;
}

/** 监控面板「子代理」列表里全部行的锚点（划行边界用；探针会把锚点自己排除）。 */
function taskPanelAnchors(fixture) {
  return [fixture.task.callId, orphanToolUseId(fixture), fixture.background.callId];
}

/** 夹具自证：该 agent 的期望值必须没有第二种解释（model 有价、写量为 0、报价带 cacheRead 价）。 */
function assertAgentIsCleanlyPriced(agent) {
  expect(PRICES[agent.model], `夹具自证：agent ${agent.agentSessionId} 的 model 必须有价`).toBeTruthy();
  expect(agent.usage?.cache_creation_input_tokens || 0,
    `夹具自证：agent ${agent.agentSessionId} 的 cache_creation 必须是 0（否则写费维度会引入未知项）`).toBe(0);
  expect(PRICES[agent.model].cacheRead, '夹具自证：报价必须带 cacheRead 价，否则读费无法现算').not.toBeNull();
}

// ---------------------------------------------------------------------------
// 公共 DOM 探针（只认公开身份 + 夹具自带文字）
// ---------------------------------------------------------------------------

/** 页面里所有「金额 / 未能计价小标」叶节点。scope: 'pane' 对话流内 / 'outside' 窗格之外 / 'all'。 */
function findMoneyLeaves(page, scope = 'all') {
  return page.evaluate(({ scope }) => {
    const pane = document.querySelector('[data-testid="pane"]');
    const isMoney = text => /^[¥$]\s?[\d,]+(?:\.\d+)?$/.test(text) || /^未能计价$|^另有 \d+ 个未能计价$/.test(text);
    const inScope = el => {
      const insidePane = Boolean(pane && pane.contains(el));
      if (scope === 'pane') return insidePane;
      if (scope === 'outside') return !insidePane;
      return true;
    };
    /** 一个容器「给用户看得到的字」= 可见文本 ∪ 它这一片的悬停提示(title)。 */
    const haystack = el => {
      if (!el) return '';
      const parts = [el.innerText || '', el.getAttribute?.('title') || ''];
      for (const withTitle of el.querySelectorAll?.('[title]') ?? []) {
        parts.push(withTitle.getAttribute('title') || '');
      }
      return parts.join('\n');
    };
    return [...document.querySelectorAll('*')]
      .filter(el => el.querySelector('*') === null && isMoney((el.textContent || '').trim()) && inScope(el))
      .map(el => ({
        text: el.textContent.trim(),
        title: el.parentElement?.getAttribute('title') || el.getAttribute('title') || null,
        // 轮末费用位：它的父容器里带「整轮命中率」（契约锁定的口径名，PA-519 同源断言）。
        // R43 起这个名字进了行容器的悬停提示(title) → 读法扩成「父容器可见文本 ∪ 父容器这一片的
        // 悬停提示」。位置判据不变（还是同一个名字、同一处容器），只是多读一个 title。
        isTurnFooter: haystack(el.parentElement).includes('整轮命中率'),
      }));
  }, { scope });
}

/**
 * 对话流窗格的「可见文本 ∪ 悬停提示(title)」。R43 起行容器把 `缓存命中/缓存写入/整轮命中率`
 * 收进了 `title` —— 探针的读法随之扩成「看得见的 + 悬停能看到的」，**断言的判据、字面量与
 * 数值一律不变**。只收渲染出来的元素的 title：隐藏面板里的悬停文案用户看不到，不能当证据。
 */
function paneTextAndTitles(page) {
  return page.evaluate(() => {
    const pane = document.querySelector('[data-testid="pane"]');
    if (!pane) return '';
    const parts = [pane.innerText || ''];
    const nodes = [...(pane.hasAttribute('title') ? [pane] : []), ...pane.querySelectorAll('[title]')];
    for (const el of nodes) {
      if (!el.getClientRects().length) continue;
      const tip = (el.getAttribute('title') || '').trim();
      if (tip) parts.push(tip);
    }
    return parts.join('\n');
  });
}

/**
 * 距锚点文字最近的「一行 / 一张卡片」里的金额与小标。
 * - `boundToButton`：走到最近的 `<button>` 就停（对话流的卡片都是按钮；这样卡片里**没有**金额时不会
 *   继续往上把轮末的钱算进来）——反面用例靠它才判得准。
 * - `siblingAnchors`：同一张列表里**别的行**的锚点文字。「一行」的边界 = 还**没有**把兄弟行包进来的
 *   那个祖先（行里本来没有金额时尤其重要，否则会一路爬到整段列表、把别人的金额算进这一行）。
 */
function moneyNearAnchor(page, { anchor, scope = 'all', boundToButton = false, siblingAnchors = [] }) {
  return page.evaluate(({ anchor, scope, boundToButton, siblingAnchors }) => {
    const pane = document.querySelector('[data-testid="pane"]');
    const isMoney = text => /^[¥$]\s?[\d,]+(?:\.\d+)?$/.test(text) || /^未能计价$|^另有 \d+ 个未能计价$/.test(text);
    const leaves = [...document.querySelectorAll('*')]
      .filter(el => (el.textContent || '').trim() === anchor && el.querySelector('*') === null)
      .filter(el => {
        const insidePane = Boolean(pane && pane.contains(el));
        if (scope === 'pane') return insidePane;
        if (scope === 'outside') return !insidePane;
        return true;
      });
    if (!leaves.length) return { anchorFound: false, rowFound: false, money: [], rowText: null };
    let row = null;
    let cur = leaves[0];
    while (cur && cur !== document.body) {
      if (boundToButton && cur.tagName === 'BUTTON') { row = cur; break; }
      const text = cur.innerText || '';
      if (siblingAnchors.some(other => other !== anchor && text.includes(other))) break; // 越过了本行
      row = cur;
      if ([...cur.querySelectorAll('*')].some(el => el.querySelector('*') === null && isMoney((el.textContent || '').trim()))) break;
      cur = cur.parentElement;
    }
    if (!row) return { anchorFound: true, rowFound: false, money: [], rowText: null };
    const money = [...row.querySelectorAll('*')]
      .filter(el => el.querySelector('*') === null && isMoney((el.textContent || '').trim()))
      .map(el => ({
        text: el.textContent.trim(),
        title: el.parentElement?.getAttribute('title') || el.getAttribute('title') || null,
      }));
    return { anchorFound: true, rowFound: true, money, rowText: (row.innerText || '').replace(/\n/g, ' | ').slice(0, 300) };
  }, { anchor, scope, boundToButton, siblingAnchors });
}

// ---------------------------------------------------------------------------
// 浏览器动作（只走用户可见入口）
// ---------------------------------------------------------------------------

async function dismissOverlays(page) {
  for (const name of ['关闭指引', '跳过', '稍后', '知道了', '开始使用', '下一步']) {
    const button = page.getByRole('button', { name, exact: true });
    if ((await button.count()) && await button.first().isVisible().catch(() => false)) {
      await button.first().click().catch(() => {});
      await page.waitForTimeout(200);
    }
  }
  // 「本次更新」/「更新说明」弹层会盖住整页（同 preset-save-ui.spec.mjs 的处理）。
  for (let i = 0; i < 3; i += 1) {
    const overlay = page.locator('div.fixed.inset-0').filter({ hasText: /本次更新|更新说明/ }).first();
    if (await overlay.count() && await overlay.isVisible().catch(() => false)) {
      await overlay.locator('button[title="关闭"]').first().click().catch(() => {});
      await page.waitForTimeout(300);
    } else break;
  }
}

async function openApp(page) {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2000);
  await dismissOverlays(page);
}

/** 侧栏搜索 → 结果行：用户打开会话的走法（同 pricing-batch5 套件的既有取法）。 */
async function openSession(page, marker) {
  await dismissOverlays(page);
  const search = page.getByRole('textbox', { name: /搜索项目/ }).first();
  await search.click({ timeout: 10_000 });
  await search.fill(marker);
  await page.waitForTimeout(1000);
  const row = page.getByRole('button', { name: new RegExp(marker) }).first();
  await expect(row, `侧栏搜索结果里必须有夹具会话（标记 ${marker}）`).toBeVisible({ timeout: 10_000 });
  await row.click();
  await page.waitForTimeout(1500);
  await expect(page.locator('[data-testid="pane"]').first(), '打开会话后必须有对话流窗格').toBeVisible();
}

/** 顶栏 → 监控（Subagent 监控）。 */
async function openMonitor(page) {
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

/** 每个用例自己装一份合成 catalog（客户端唯一的价目入口，契约 §3.1）。 */
async function routeCatalog(page) {
  const payload = catalogPayload();
  await page.route('**/api/pricing**', async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  });
}

async function turnFixtureData(request, section) {
  const { baseURL } = getRuntime();
  const { status, body } = await readMessages(request, baseURL, section.sessionId, subagentFixtures().projectHash);
  expect(status, `读夹具会话 ${section.sessionId} 的消息`).toBe(200);
  const turn = (body.messages || []).find(message => message.type === 'turn');
  expect(turn, '夹具会话必须有一个 turn').toBeTruthy();
  return turn;
}

// ---------------------------------------------------------------------------
// 实例前置：需要一个**不是**套餐档的激活 provider（否则 claude-* 模型按 PLAN_BILLING 不显示金额，
// 本文件的金额断言会全部落空 —— 那是环境问题不是产品结论）。走 §10.5 的公开 HTTP 入口建/切。
// ---------------------------------------------------------------------------

const UI_PROVIDER = {
  name: 'PA A 项 UI 计价', type: 'openai',
  baseURL: 'https://pa-a-ui.invalid/v1', apiKey: 'pa-placeholder',
  models: ['claude-opus-5', 'claude-sonnet-4-6'],
};

test.beforeAll(async ({ request }) => {
  const { baseURL } = getRuntime();
  const listed = await request.get(`${baseURL}/api/custom-providers`, { failOnStatusCode: false });
  const parsed = await listed.json().catch(() => []);
  const rows = Array.isArray(parsed) ? parsed : (parsed?.providers ?? []);
  let id = rows.find(row => row?.name === UI_PROVIDER.name)?.id;
  if (!id) {
    const created = await request.post(`${baseURL}/api/custom-providers`, { data: UI_PROVIDER, failOnStatusCode: false });
    const body = await created.json().catch(() => null);
    if (created.status() !== 200 || !body?.id) {
      throw new EnvironmentBlocked(`建不出 UI 用例的 provider：HTTP ${created.status()} ${JSON.stringify(body).slice(0, 160)}`);
    }
    id = body.id;
  }
  const switched = await request.post(`${baseURL}/api/provider/switch`, { data: { id }, failOnStatusCode: false });
  if (switched.status() !== 200) {
    throw new EnvironmentBlocked(`切不到 UI 用例的 provider（HTTP ${switched.status()}）—— 金额显示会被套餐档挡掉`);
  }
});

test.beforeEach(async ({ page }) => {
  requireUI();
  await page.setViewportSize({ width: 1600, height: 1100 });
});

// ---------------------------------------------------------------------------
// PA-514 前台子代理：对话流 Task 卡片 + 监控面板都显示金额，两处都等于该 agent 自己的用量算出来的数
// ---------------------------------------------------------------------------

test('PA-514 前台子代理：对话流 Task 卡片与监控面板都显示金额，两处同数且等于该 agent 自己的用量', async ({ page, request }) => {
  const fixture = subagentFixtures();
  const turn = await turnFixtureData(request, fixture.task);
  const agent = (turn.subUsage?.agents || []).find(item => item.agentSessionId === fixture.task.agentId);
  expect(agent, '夹具自证：Task 子代理必须可归属（出现在 subUsage.agents[] 里）').toBeTruthy();
  assertAgentIsCleanlyPriced(agent);
  expect((turn.toolCalls || []).map(call => call.id), '夹具自证：归属键必须属于本轮 toolCalls').toContain(agent.toolUseId);
  const expected = formatCny(expectedCny(agent));

  await routeCatalog(page);
  await openApp(page);
  await openSession(page, 'PA-TASK');

  // 对话流：Task 卡片上的金额（锚点 = 转写里的 agent 描述，只有那张卡片上有这串）
  await expect.poll(async () => (await moneyNearAnchor(page, { anchor: 'PA fixture task agent', scope: 'pane', boundToButton: true }))
    .money.map(item => item.text), {
    message: `对话流 Task 卡片上应显示金额 ${expected}`, timeout: 15_000,
  }).toEqual([expected]);

  // 监控面板：对应条目也显示同一个数（toolUseId 只出现在面板里，不会与卡片混）
  await openMonitor(page);
  const panelAnchors = taskPanelAnchors(fixture);
  await expect.poll(async () => (await moneyNearAnchor(page, { anchor: agent.toolUseId, siblingAnchors: panelAnchors }))
    .money.map(item => item.text), {
    message: `监控面板中 toolUseId ${agent.toolUseId} 的条目应显示同一个金额 ${expected}`, timeout: 15_000,
  }).toEqual([expected]);
});

// ---------------------------------------------------------------------------
// PA-515 后台子代理：金额只在监控面板显示（对话流那张卡片不得渲染金额）
//
// ⚠️ 本条按**需求书口径**断言，实测与产品行为冲突（对话流卡片仍渲染了金额）——
// 契约 §10.3 的卡片规则本身**不区分**前台/后台（「该 toolUseId 名下 1 个 agent」→ 显示合计），
// §10.6 #15 也写「每个子代理显示在各自位置：对话流 Task 卡片 + 监控面板」。
// 因此这条红是「需求书 vs INTERFACE §10.3」的**口径冲突**，不是单纯的实现漏做：
// 需协调者裁定是改产品、还是把「后台子代理」改成别的口径（例：若指的是 `claude --bg` 后台代理，
// 它本来就没有对话流卡片，本条应删）。裁定前**不要**为了转绿而放宽这里的断言。
// ---------------------------------------------------------------------------

test('PA-515 后台子代理（run_in_background: true）：金额只出现在监控面板，对话流卡片上不渲染金额', async ({ page, request }) => {
  const fixture = subagentFixtures();
  const turn = await turnFixtureData(request, fixture.background);
  const agent = (turn.subUsage?.agents || []).find(item => item.agentSessionId === fixture.background.agentId);
  expect(agent, '夹具自证：后台子代理也必须可归属（出现在 subUsage.agents[] 里）').toBeTruthy();
  const call = (turn.toolCalls || []).find(item => item.id === agent.toolUseId);
  expect(call, '夹具自证：本轮必须有那次 Agent 调用').toBeTruthy();
  expect(call.input?.run_in_background, '夹具自证：这次调用必须声明 run_in_background: true（否则本用例验的不是后台子代理）').toBe(true);
  assertAgentIsCleanlyPriced(agent);
  const expected = formatCny(expectedCny(agent));

  await routeCatalog(page);
  await openApp(page);
  await openSession(page, 'PA-BG-HELLO');
  await openMonitor(page);

  // 正面：监控面板上必须有这个数（需求书「后台子代理只在监控面板显示」）
  await expect.poll(async () => (await moneyNearAnchor(page, { anchor: agent.toolUseId, siblingAnchors: taskPanelAnchors(fixture) }))
    .money.map(item => item.text), {
    message: `监控面板中 toolUseId ${agent.toolUseId} 的条目应显示 ${expected}`, timeout: 15_000,
  }).toEqual([expected]);

  // 反面：对话流那张卡片不得有金额（也不得有「未能计价」小标 —— 这个 agent 是可计价的）
  const card = await moneyNearAnchor(page, { anchor: 'PA fixture background agent', scope: 'pane', boundToButton: true });
  expect(card.anchorFound, '对话流里必须有这次后台调用的卡片（按 agent 描述定位；找不到就判不出"只在监控面板"）').toBe(true);
  expect(card.money.map(item => item.text),
    '需求书：后台子代理的金额只在监控面板显示 —— 对话流这张卡片不得渲染金额').toEqual([]);
});

// ---------------------------------------------------------------------------
// PA-516 workflow：对话流卡片显示内部全部 agent 的合计；监控面板逐条各显示自己的金额
// ---------------------------------------------------------------------------

test('PA-516 workflow：对话流卡片显示内部全部 agent 的合计，监控面板逐条各显示自己的金额', async ({ page, request }) => {
  const fixture = subagentFixtures();
  const turn = await turnFixtureData(request, fixture.workflow);
  const agents = (turn.subUsage?.agents || []).filter(item => item.toolUseId === fixture.workflow.callId);
  expect(agents.length, '夹具自证：workflow 的内层 agent 必须都归到那次 Workflow 调用名下').toBe(fixture.workflow.agentIds.length);
  for (const agent of agents) assertAgentIsCleanlyPriced(agent);
  const perAgent = agents.map(item => formatCny(expectedCny(item)));
  const total = formatCny(agents.reduce((sum, item) => sum + expectedCny(item), 0));
  expect(new Set(perAgent).size, '夹具自证：内层 agent 的金额必须互不相同，才验得出"逐条各显示自己的"').toBe(agents.length);
  expect(perAgent, '夹具自证：合计必须与单个 agent 的金额不同').not.toContain(total);
  const turnOnly = formatCny(expectedCny(turn));
  expect(turnOnly, '夹具自证：这个合计必须与主回合自己的金额不同，两处才分得开').not.toBe(total);

  await routeCatalog(page);
  await openApp(page);
  await openSession(page, 'PA-WF');

  // 对话流：那一处 = workflow 卡片上的合计（不是轮末的费用位）
  await expect.poll(async () => {
    const money = await findMoneyLeaves(page, 'pane');
    const hit = money.filter(item => item.text === total);
    return { count: hit.length, onTurnFooter: hit.some(item => item.isTurnFooter), seen: money.map(item => item.text) };
  }, {
    message: `对话流里应恰好一处显示 workflow 内部全部 agent 的合计 ${total}`, timeout: 15_000,
  }).toEqual({ count: 1, onTurnFooter: false, seen: expect.any(Array) });

  // 监控面板：逐条各显示自己的金额（锚点 = 该 agent 在面板里的短 id）
  await openMonitor(page);
  for (const [index, agent] of agents.entries()) {
    const shortId = `#${agent.agentSessionId.slice(-4)}`;
    const siblingIds = agents.map(item => `#${item.agentSessionId.slice(-4)}`);
    await expect.poll(async () => (await moneyNearAnchor(page, { anchor: shortId, siblingAnchors: siblingIds })).money.map(item => item.text), {
      message: `监控面板中内层 agent ${shortId} 的条目应显示它自己的金额 ${perAgent[index]}（不是合计）`, timeout: 15_000,
    }).toEqual([perAgent[index]]);
  }
});

// ---------------------------------------------------------------------------
// PA-517 归属不上的子代理：只显示「未能计价」小标、金额留空，且不摊派到任何卡片
// ---------------------------------------------------------------------------

test('PA-517 归属不上的子代理：只显示「未能计价」小标、金额留空，且不摊派到对话流', async ({ page, request }) => {
  const fixture = subagentFixtures();
  const orphanMetaFile = path.join(fixture.dir, fixture.task.sessionId, 'subagents', `${fixture.task.orphanId}.meta.json`);
  const orphanMeta = JSON.parse(fs.readFileSync(orphanMetaFile, 'utf8'));
  const parentToolUseIds = readJsonl(path.join(fixture.dir, `${fixture.task.sessionId}.jsonl`))
    .flatMap(record => (Array.isArray(record?.message?.content) ? record.message.content : []))
    .filter(block => block?.type === 'tool_use').map(block => block.id);
  expect(parentToolUseIds, '夹具自证：孤儿 agent 的 toolUseId 本就不在父 jsonl 里（归不上）').not.toContain(orphanMeta.toolUseId);
  const turn = await turnFixtureData(request, fixture.task);
  expect((turn.subUsage?.agents || []).find(item => item.agentSessionId === fixture.task.agentId),
    '夹具自证：同一轮里必须**有**可计价的子代理（否则"只有小标、没有金额"平凡成立）').toBeTruthy();

  await routeCatalog(page);
  await openApp(page);
  await openSession(page, 'PA-TASK');
  await openMonitor(page);

  await expect.poll(async () => (await moneyNearAnchor(page, { anchor: orphanMeta.toolUseId, siblingAnchors: taskPanelAnchors(fixture) }))
    .money.map(item => item.text), {
    message: `归不上的 agent（toolUseId ${orphanMeta.toolUseId}）在监控面板里应显示小标「未能计价」`, timeout: 15_000,
  }).toEqual(['未能计价']);

  const row = await moneyNearAnchor(page, { anchor: orphanMeta.toolUseId, siblingAnchors: taskPanelAnchors(fixture) });
  expect(row.money[0].title, '§10.3：名下 0 个 agent 记录时，小标的 title 逐字为「未读到该子代理的用量记录，因此不显示金额」')
    .toBe('未读到该子代理的用量记录，因此不显示金额');
  expect(row.rowText, '不得显示 $0.00 之类的"算出来是零"').not.toMatch(/[¥$]\s?0\.00\b/);

  const paneText = await page.locator('[data-testid="pane"]').first().innerText();
  expect(paneText, '归属不上的 agent 不得出现在对话流里（不摊派）').not.toContain('PA-ORPHAN-HELLO');
});

// ---------------------------------------------------------------------------
// PA-520 母会话没打开的历史行：不渲染任何金额元素（连「未能计价」小标也不该有）
// ---------------------------------------------------------------------------

test('PA-520 母会话未打开的历史行：不渲染任何金额元素（不含小标）', async ({ page, request }) => {
  const fixture = subagentFixtures();
  // 夹具自证：这两行所属的 agent 都是**可归属且有金额**的（PA-514/PA-515 已分别验证它们在母会话打开时显示金额），
  // 所以这里"没有金额"不能是"本来就算不出来"。
  const agents = [
    ...((await turnFixtureData(request, fixture.task)).subUsage?.agents || []),
    ...((await turnFixtureData(request, fixture.background)).subUsage?.agents || []),
  ];
  for (const agentSessionId of [fixture.task.agentId, fixture.background.agentId]) {
    const agent = agents.find(item => item.agentSessionId === agentSessionId);
    expect(agent, `夹具自证：${agentSessionId} 必须可归属`).toBeTruthy();
    assertAgentIsCleanlyPriced(agent);
  }

  await routeCatalog(page);
  await openApp(page);
  await openSession(page, 'PA-WF'); // 打开的是 workflow 会话：上面两个 agent 的母会话都没打开
  await openMonitor(page);

  for (const [label, toolUseId] of [['Task 子代理', fixture.task.callId], ['后台子代理', fixture.background.callId]]) {
    const panelAnchors = taskPanelAnchors(fixture);
    await expect.poll(async () => (await moneyNearAnchor(page, { anchor: toolUseId, siblingAnchors: panelAnchors })).anchorFound, {
      message: `监控面板里应有${label}的历史行（toolUseId ${toolUseId}）`, timeout: 15_000,
    }).toBe(true);
    const row = await moneyNearAnchor(page, { anchor: toolUseId, siblingAnchors: panelAnchors });
    expect(row.money.map(item => item.text),
      `§10.3：母会话未打开的历史行不渲染任何金额元素（不含小标）—— ${label} 那一行现在渲染了 ${JSON.stringify(row.money.map(item => item.text))}`)
      .toEqual([]);
  }
});

// ---------------------------------------------------------------------------
// PA-518 轮末花费仍是主回合自己的（不并入子代理花费）
// ---------------------------------------------------------------------------

test('PA-518 轮末花费仍是主回合自己算的：等于主回合用量 × 报价，不含任何子代理的钱', async ({ page, request }) => {
  const fixture = subagentFixtures();
  const turn = await turnFixtureData(request, fixture.task);
  const agent = (turn.subUsage?.agents || []).find(item => item.agentSessionId === fixture.task.agentId);
  expect(agent, '夹具自证：这一轮里必须有可计价的子代理（否则"不并入"平凡成立）').toBeTruthy();
  assertAgentIsCleanlyPriced(agent);
  const agentCny = expectedCny(agent);
  const turnCny = expectedCny(turn);
  expect(Math.abs(turnCny - agentCny), '夹具自证：主回合金额与子代理金额必须差得开，才判得出"有没有并进去"').toBeGreaterThan(0.02);

  await routeCatalog(page);
  await openApp(page);
  await openSession(page, 'PA-TASK');

  const footer = await expect.poll(async () => (await findMoneyLeaves(page, 'pane'))
    .filter(item => item.isTurnFooter).map(item => item.text), {
    message: '轮末应恰好有一个费用位（父容器带「整轮命中率」）', timeout: 15_000,
  }).toHaveLength(1).then(() => findMoneyLeaves(page, 'pane').then(list => list.filter(item => item.isTurnFooter)));

  const shown = parseCny(footer[0].text);
  expect(shown, `轮末金额必须是一个 ¥ 数字（实测 ${footer[0].text}）`).not.toBeNull();
  expect(Math.abs(shown - turnCny), `轮末口径未变：金额 = 主回合自己的用量算出来的 ${formatCny(turnCny)}（实测 ${footer[0].text}）`)
    .toBeLessThanOrEqual(CNY_TOLERANCE);
  expect(Math.abs(shown - (turnCny + agentCny)), '轮末不得把子代理的钱并进来').toBeGreaterThan(CNY_TOLERANCE);
});

// ---------------------------------------------------------------------------
// PA-519 轮末与顶部的口径名一字未变，轮末数字仍按主回合 usage（安全边界）
// ---------------------------------------------------------------------------

test('PA-519 轮末与顶部命中率口径名一字未变，轮末数字仍等于主回合 usage（不掺子代理）', async ({ page, request }) => {
  const fixture = subagentFixtures();
  const turn = await turnFixtureData(request, fixture.task);
  const agent = (turn.subUsage?.agents || []).find(item => item.agentSessionId === fixture.task.agentId);
  expect(agent, '夹具自证：这一轮确实带着子代理数据（本项改的就是它，口径不该跟着动）').toBeTruthy();
  const u = turn.usage || {};
  const number = value => Number(value || 0).toLocaleString('en-US');

  await routeCatalog(page);
  await openApp(page);
  await openSession(page, 'PA-TASK');

  const paneText = await page.locator('[data-testid="pane"]').first().innerText();
  // R43 起轮末行把 `缓存命中/缓存写入/整轮命中率` 收进了行容器 title → 这三条改读
  // 「窗格可见文本 ∪ 悬停提示」；`输入/输出` 按合同仍留在行内，照旧只读可见文本。
  const paneHay = await paneTextAndTitles(page);
  const pageText = await page.locator('body').innerText();
  expect(paneHay, '轮末命中率口径名不得改').toContain('整轮命中率');
  expect(pageText, '顶部命中率口径名不得改').toContain('最近API命中率');
  expect(paneText, `轮末必须仍按主回合 usage 显示「输入 ${number(u.input_tokens)}」`).toContain(`输入 ${number(u.input_tokens)}`);
  expect(paneText, `轮末必须仍按主回合 usage 显示「输出 ${number(u.output_tokens)}」`).toContain(`输出 ${number(u.output_tokens)}`);
  expect(paneHay, '轮末必须仍按主回合 usage 显示缓存命中').toContain(`缓存命中 ${number(u.cache_read_input_tokens)}`);
  expect(paneHay, '轮末必须仍按主回合 usage 显示缓存写入').toContain(`缓存写入 ${number(u.cache_creation_input_tokens)}`);
  // 负向断言同样扩 haystack（方向是更严不是更松）：并进来的子代理数字写在行内或悬停文案里都算违规。
  expect(paneHay, '子代理的用量不得并进轮末的数字里')
    .not.toContain(`输入 ${number((u.input_tokens || 0) + (agent.usage?.input_tokens || 0))}`);
});
