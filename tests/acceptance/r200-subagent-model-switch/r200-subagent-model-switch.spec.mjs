// r200-subagent-model-switch 黑盒验收:命令行在子代理 / 主对话跑到一半换了模型时,页面如实显示。
// 只依据接口文件(.devflow/r200-subagent-model-switch-接口.md)的行为清单 1~11 与错误契约;只通过页面观测(文案 / 挂点 / title)。
// 编号:L1/L2 = 清单 1/2(直播);H3~H6、H8 = 清单 3~6、8(历史);C7 = 清单 7(费用);M9~M11 = 清单 9~11(主对话);
//       E1~E4 = 错误契约(伪模型名 / 被拦记录没有类别 / 通知没有类别 / 查不到价格)。
// 假命令行见 helpers/fake-claude.mjs;历史用例直接把主会话与子代理转写铺成文件(helpers/fixtures.mjs),再刷新页面打开。
import { test, expect } from '@playwright/test';
import { seedWorkspace, seedStatic, writeScenario } from './helpers/fixtures.mjs';
import {
  openApp, reloadApp, openWorkspaceGroup, clickSession, openNewSession, openStaticSession, sendText, waitTurnEnded,
  expandGroup, expandCard, openSubagentView, openMonitor, monitorRow, moneyIn, usdOf, messageList, norm, uniqueTag,
  routeCatalog, ensureNonPlanProvider, OFFICIAL_QUOTES,
} from './helpers/runtime.mjs';
import { ARROW } from './helpers/transcripts.mjs';

const FABLE = 'claude-fable-5-1';
const OPUS = 'claude-opus-5';
const SWITCHED = `${FABLE}${ARROW}${OPUS}`;
const SWITCH_MODELS = [FABLE, FABLE, OPUS, OPUS];
const soft = expect.configure({ soft: true });

test.beforeEach(async ({ page }) => {
  page.__pageErrors = [];
  page.__dialogs = [];
  page.on('pageerror', (e) => page.__pageErrors.push(String(e && e.message ? e.message : e)));
  page.on('dialog', (d) => { page.__dialogs.push(d.message()); d.dismiss().catch(() => {}); });
});
test.afterEach(async ({ page }) => {
  // 刷新页面时被取消的在途请求(WebKit 报「… due to access control checks」)是与本套件无关的环境噪声,不算页面错误
  const real = page.__pageErrors.filter((m) => !/due to access control checks/.test(m));
  expect(real, '页面不应有未捕获的错误(pageerror)').toEqual([]);
});

const textOf = async (loc) => norm(await loc.first().innerText().catch(() => ''));

/** 把消息区里还收着的折叠组都点开(说明行可能收在折叠组里)。 */
async function expandAllGroups(page) {
  const heads = page.locator('[data-work-group-head]');
  const n = await heads.count();
  for (let i = 0; i < n; i += 1) {
    const h = heads.nth(i);
    if ((await h.getAttribute('aria-expanded').catch(() => 'true')) === 'false') await h.click().catch(() => {});
  }
}

/** 范围里「同时含全部 needles(字符串或正则)的最小元素」的可见文字;没有返回 null。用来认「一行说明」。 */
async function noticeIn(locator, needles) {
  return await locator.first().evaluate((root, specs) => {
    const tests = specs.map((s) => (s.re ? new RegExp(s.re) : { test: (t) => t.includes(s.str) }));
    const all = (el) => tests.every((t) => t.test(el.innerText || ''));
    let best = null;
    for (const el of [root, ...root.querySelectorAll('*')]) {
      if (!all(el)) continue;
      if (!best || (el.innerText || '').length < (best.innerText || '').length) best = el;
    }
    return best ? (best.innerText || '').replace(/\s+/g, ' ').trim() : null;
  }, needles.map((n) => (n instanceof RegExp ? { re: n.source } : { str: n })));
}
const NEW_MODEL_RE = /claude-opus-5(?![-\d])/;

/** 子代理页 / 卡片 / 监控面板里某段文字出现(软断言,三处都报)。 */
async function expectCardText(page, cond, what) {
  const card = await expandCard(page);
  await soft.poll(async () => { const t = await textOf(card); return cond(t) ? 'OK' : t; }, { message: `${what}:子代理卡片(失败时显示的是卡片实际文字)`, timeout: 20_000 }).toBe('OK');
  return card;
}

// ───────────────────────── 清单 1~2:直播 ─────────────────────────
async function liveSubagent(page, models) {
  const ctx = seedWorkspace(uniqueTag('t'));
  writeScenario(ctx.workspaceName, { form: 'sub-live', models });
  await openNewSession(page, ctx);
  await sendText(page, `你好 ${uniqueTag('M')}`);
  await waitTurnEnded(page);
  await expandGroup(page);
  return ctx;
}

test('L1【复现】直播·子代理前两次用 fable、之后用 opus:卡片、监控面板、子代理页顶部都显示「claude-fable-5-1 → claude-opus-5」', async ({ page }) => {
  const ctx = await liveSubagent(page, SWITCH_MODELS);
  await expectCardText(page, (t) => t.includes(SWITCHED), 'L1');
  await openMonitor(page);
  await soft.poll(async () => (await monitorRow(page, ctx, 'model')).text, { message: 'L1:监控面板里这条子代理的模型', timeout: 20_000 }).toContain(SWITCHED);
  const view = await openSubagentView(page);
  await soft.poll(() => textOf(view), { message: 'L1:子代理页', timeout: 20_000 }).toContain(SWITCHED);
});

test('L2【回归】直播·子代理全程只用 claude-opus-5:卡片、监控面板、子代理页都只显示「claude-opus-5」,没有箭头', async ({ page }) => {
  const ctx = await liveSubagent(page, [OPUS, OPUS, OPUS]);
  const card = await expectCardText(page, (t) => t.includes(OPUS), 'L2');
  expect(await textOf(card), 'L2:卡片里不应有箭头').not.toContain('→');
  await openMonitor(page);
  await expect.poll(async () => (await monitorRow(page, ctx, 'model')).text, { message: 'L2:监控面板里应显示 claude-opus-5', timeout: 20_000 }).toContain(OPUS);
  expect((await monitorRow(page, ctx, 'model')).text, 'L2:监控面板这一行不应有箭头').not.toContain('→');
  const view = await openSubagentView(page);
  await expect.poll(() => textOf(view), { message: 'L2:子代理页应显示 claude-opus-5', timeout: 20_000 }).toContain(OPUS);
  expect(await textOf(view), 'L2:子代理页不应有箭头').not.toContain('→');
});

// ───────────────────────── 清单 3~6、8:历史 ─────────────────────────
test('H3【复现】历史·新版格式·换过模型:刷新后卡片与子代理页顶部都显示「claude-fable-5-1 → claude-opus-5」', async ({ page }) => {
  const ctx = seedStatic(uniqueTag('t'), { sub: { models: SWITCH_MODELS, format: 'new' } });
  await openStaticSession(page, ctx);
  await expandGroup(page);
  await expectCardText(page, (t) => t.includes(SWITCHED), 'H3');
  const view = await openSubagentView(page);
  await soft.poll(() => textOf(view), { message: 'H3:子代理页', timeout: 20_000 }).toContain(SWITCHED);
});

test('H4【复现】历史·新版格式·全程一个模型:刷新后卡片与子代理页显示 claude-opus-5,不是空白,没有箭头', async ({ page }) => {
  const ctx = seedStatic(uniqueTag('t'), { sub: { models: [OPUS, OPUS, OPUS], format: 'new' } });
  await openStaticSession(page, ctx);
  await expandGroup(page);
  const card = await expectCardText(page, (t) => t.includes(OPUS), 'H4');
  expect(await textOf(card), 'H4:卡片里不应有箭头').not.toContain('→');
  const view = await openSubagentView(page);
  await soft.poll(() => textOf(view), { message: 'H4:子代理页应显示 claude-opus-5', timeout: 20_000 }).toContain(OPUS);
  expect(await textOf(view), 'H4:子代理页不应有箭头').not.toContain('→');
});

test('H5【复现】历史·被拦:换模型前最后一条 fable 记录被拦(类别 bio)→ 子代理页有一行说明,含 fable、opus、「安全检查」、bio', async ({ page }) => {
  const ctx = seedStatic(uniqueTag('t'), { sub: { models: SWITCH_MODELS, format: 'new', refuse: { at: 1, category: 'bio' } } });
  await openStaticSession(page, ctx);
  await expandGroup(page);
  const view = await openSubagentView(page);
  await expect.poll(() => textOf(view), { message: 'H5:子代理页先要加载出来(有子代理最后一段回复)', timeout: 20_000 }).toContain('R200-SUB-DONE-3');
  await soft.poll(() => noticeIn(view, [FABLE, NEW_MODEL_RE, '安全检查', 'bio']), {
    message: `H5:子代理页应有一个元素同时含 ${FABLE}、${OPUS}、安全检查、bio`, timeout: 10_000,
  }).not.toBeNull();
});

test('H6【复现】历史·换过模型但没有被拦记录:子代理页显示「claude-fable-5-1 → claude-opus-5」,页面上没有含「安全检查」的说明', async ({ page }) => {
  const ctx = seedStatic(uniqueTag('t'), { sub: { models: SWITCH_MODELS, format: 'new' } });
  await openStaticSession(page, ctx);
  await expandGroup(page);
  const view = await openSubagentView(page);
  await soft.poll(() => textOf(view), { message: 'H6:子代理页应显示换过模型', timeout: 20_000 }).toContain(SWITCHED);
  await page.waitForTimeout(1500);
  expect(await textOf(view), 'H6:子代理页不应有「安全检查」说明').not.toContain('安全检查');
  expect(await textOf(messageList(page)), 'H6:消息区不应有「安全检查」说明').not.toContain('安全检查');
});

test('H8【回归】历史·旧版格式(第一条助手记录在第 3 条)·全程一个模型:刷新后卡片与子代理页显示这个模型名', async ({ page }) => {
  const ctx = seedStatic(uniqueTag('t'), { sub: { models: [OPUS, OPUS], format: 'old' } });
  await openStaticSession(page, ctx);
  await expandGroup(page);
  const card = await expectCardText(page, (t) => t.includes(OPUS), 'H8');
  expect(await textOf(card), 'H8:卡片里不应有箭头').not.toContain('→');
  const view = await openSubagentView(page);
  await expect.poll(() => textOf(view), { message: 'H8:子代理页应显示 claude-opus-5', timeout: 20_000 }).toContain(OPUS);
  expect(await textOf(view), 'H8:子代理页不应有箭头').not.toContain('→');
});

// ───────────────────────── 清单 7:费用 ─────────────────────────
const COST_USAGE = { input_tokens: 100_000, output_tokens: 0 };
const nearThree = (leaves) => leaves.some((t) => { const v = usdOf(t); return v !== null && Math.abs(v - 3) < 0.01; });

test('C7【复现】费用·按实际模型:fable 两次 + opus 两次(每次输入 10 万、输出 0)→ 卡片和监控面板的费用都是 $3.00,不是 $4.00 / $2.00', async ({ page, request }) => {
  await ensureNonPlanProvider(request);
  await routeCatalog(page, OFFICIAL_QUOTES);
  const ctx = seedStatic(uniqueTag('t'), { sub: { models: SWITCH_MODELS, format: 'new', usage: COST_USAGE } });
  await openStaticSession(page, ctx);
  await expandGroup(page);
  const card = cardEntryLocator(page);
  await soft.poll(async () => { const m = await moneyIn(card); return nearThree(m) ? 'OK' : `卡片金额叶节点 = ${JSON.stringify(m)}`; }, { message: 'C7:卡片上的费用应折合 $3.00(= 2×$1.00 + 2×$0.50)', timeout: 20_000 }).toBe('OK');
  await openMonitor(page);
  await soft.poll(async () => { const m = (await monitorRow(page, ctx, 'money')).money; return nearThree(m) ? 'OK' : `监控面板金额叶节点 = ${JSON.stringify(m)}`; }, { message: 'C7:监控面板上这条子代理的费用应折合 $3.00', timeout: 20_000 }).toBe('OK');
});

// ───────────────────────── 清单 9~11:主对话 ─────────────────────────
const MODEL_SELECTOR = '[data-cgui="model-selector"]';
const noticeLines = async (page) => (await messageList(page).first().innerText()).split('\n').filter((l) => l.includes('安全检查'));

test('M9【复现】主对话·直播:一轮里换模型通知到达 → 这一轮出现含 opus-5-5、opus-5、「安全检查」、bio 的一行;不弹对话框;回复显示完;模型选择不变', async ({ page }) => {
  await page.addInitScript(() => {
    window.__r200dlg = 0;
    const tick = () => { if (document.querySelector('[role="dialog"], [role="alertdialog"], [aria-modal="true"]')) window.__r200dlg += 1; };
    setInterval(tick, 50);
  });
  const ctx = seedWorkspace(uniqueTag('t'));
  writeScenario(ctx.workspaceName, { form: 'main-switch', category: 'bio' });
  await openNewSession(page, ctx);
  await sendText(page, `你好 ${uniqueTag('M')}`);
  await expect(messageList(page), 'M9:换模型前那段回复应先显示').toContainText('R200-BEFORE', { timeout: 30_000 });
  const selectorBefore = await textOf(page.locator(MODEL_SELECTOR));
  await waitTurnEnded(page);
  await expect(messageList(page), 'M9:换模型后的回复应照常显示完').toContainText('R200-AFTER', { timeout: 20_000 });
  await expandAllGroups(page);
  await soft.poll(() => noticeIn(messageList(page), ['claude-opus-5-5', NEW_MODEL_RE, '安全检查', 'bio']), {
    message: 'M9:这一轮应有一个元素同时含 claude-opus-5-5、claude-opus-5、安全检查、bio', timeout: 15_000,
  }).not.toBeNull();
  expect(await page.evaluate(() => window.__r200dlg), 'M9:不应出现对话框').toBe(0);
  expect(page.__dialogs, 'M9:不应有浏览器原生对话框').toEqual([]);
  expect(selectorBefore, 'M9:发消息后模型选择应有内容').not.toBe('');
  expect(await textOf(page.locator(MODEL_SELECTOR)), 'M9:输入框上的模型选择不应被换模型通知改动').toBe(selectorBefore);
});

test('M10【复现】主对话·历史:转写里有落盘的换模型通知 → 刷新后打开会话看到同样的一行,连续刷新两次仍只有一行', async ({ page }) => {
  const ctx = seedStatic(uniqueTag('t'), { kind: 'main-switch', category: 'bio' });
  await openStaticSession(page, ctx);
  await expandAllGroups(page);
  await soft.poll(() => noticeIn(messageList(page), ['claude-opus-5-5', NEW_MODEL_RE, '安全检查', 'bio']), {
    message: 'M10:第一次刷新后应有含 claude-opus-5-5、claude-opus-5、安全检查、bio 的一行', timeout: 15_000,
  }).not.toBeNull();
  expect((await noticeLines(page)).length, `M10:第一次刷新后含「安全检查」的行应恰有 1 行;实际 = ${JSON.stringify(await noticeLines(page))}`).toBe(1);
  await reloadApp(page);
  await openWorkspaceGroup(page, ctx);
  await clickSession(page, 'seed', ctx);
  await expect(messageList(page)).toContainText(ctx.doneText, { timeout: 30_000 });
  await expandAllGroups(page);
  await page.waitForTimeout(1500);
  const lines = await noticeLines(page);
  expect(lines.length, `M10:第二次刷新后含「安全检查」的行应恰有 1 行;实际 = ${JSON.stringify(lines)}`).toBe(1);
});

test('M11【回归】主对话:转写里没有换模型通知 → 刷新后页面上没有含「安全检查」的说明', async ({ page }) => {
  const ctx = seedStatic(uniqueTag('t'), { kind: 'main-plain' });
  await openStaticSession(page, ctx);
  await expandAllGroups(page);
  await expect(messageList(page), 'M11:会话应已加载(含换模型前的那段回复)').toContainText('R200-BEFORE', { timeout: 20_000 });
  await page.waitForTimeout(1500);
  expect(await textOf(messageList(page)), 'M11:没有换模型通知时不应有「安全检查」').not.toContain('安全检查');
});

// ───────────────────────── 错误契约 ─────────────────────────
test('E1【契约】尖括号开头的伪模型名(<synthetic>)不算模型:只用 opus 的子代理夹着一条 <synthetic> 记录 → 显示 claude-opus-5,没有箭头,不出现 <synthetic>', async ({ page }) => {
  const ctx = seedStatic(uniqueTag('t'), { sub: { models: [OPUS, OPUS], format: 'new', synthetic: true } });
  await openStaticSession(page, ctx);
  await expandGroup(page);
  const card = await expectCardText(page, (t) => t.includes(OPUS), 'E1');
  const view = await openSubagentView(page);
  await expect.poll(() => textOf(view), { message: 'E1:子代理页应显示 claude-opus-5', timeout: 20_000 }).toContain(OPUS);
  for (const [name, text] of [['卡片', await textOf(card)], ['子代理页', await textOf(view)]]) {
    expect.soft(text, `E1:${name}里不应有箭头`).not.toContain('→');
    expect.soft(text, `E1:${name}里不应出现伪模型名`).not.toContain('<synthetic>');
  }
});

test('E2【契约】被拦记录没有类别:子代理页的说明照样出现,类别处写「未知」', async ({ page }) => {
  const ctx = seedStatic(uniqueTag('t'), { sub: { models: SWITCH_MODELS, format: 'new', refuse: { at: 1, category: undefined } } });
  await openStaticSession(page, ctx);
  await expandGroup(page);
  const view = await openSubagentView(page);
  await expect.poll(() => textOf(view), { message: 'E2:子代理页先要加载出来(有子代理最后一段回复)', timeout: 20_000 }).toContain('R200-SUB-DONE-3');
  await soft.poll(() => noticeIn(view, [FABLE, NEW_MODEL_RE, '安全检查', '未知']), {
    message: 'E2:应有一个元素同时含 fable、opus、安全检查、未知', timeout: 10_000,
  }).not.toBeNull();
});

test('E3【契约】主对话换模型通知没有类别:说明照样出现,类别处写「未知」', async ({ page }) => {
  const ctx = seedStatic(uniqueTag('t'), { kind: 'main-switch', category: null });
  await openStaticSession(page, ctx);
  await expandAllGroups(page);
  await soft.poll(() => noticeIn(messageList(page), ['claude-opus-5-5', NEW_MODEL_RE, '安全检查', '未知']), {
    message: 'E3:应有一个元素同时含 claude-opus-5-5、claude-opus-5、安全检查、未知', timeout: 15_000,
  }).not.toBeNull();
});

test('E4【契约】某个模型查不到价格:前两次调用用一个没有报价的模型、后两次用 opus → 这个子代理的费用标为不完整(出现「未能计价」)', async ({ page, request }) => {
  await ensureNonPlanProvider(request);
  const ctx = seedStatic(uniqueTag('t'), { sub: { models: ['claude-nopricex-9', 'claude-nopricex-9', OPUS, OPUS], format: 'new', usage: COST_USAGE } });
  await openStaticSession(page, ctx);
  await expandGroup(page);
  const card = cardEntryLocator(page);
  await soft.poll(async () => (await moneyIn(card)).join('|'), { message: 'E4:卡片上应出现「未能计价」(失败时显示的是卡片上的金额叶节点)', timeout: 20_000 }).toContain('未能计价');
});

function cardEntryLocator(page) {
  return page.locator('[data-entry-state]').filter({ has: page.locator('[title="在子代理会话窗口打开"]') }).first();
}
