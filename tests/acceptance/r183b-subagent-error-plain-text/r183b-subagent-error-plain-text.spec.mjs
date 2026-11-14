// r183b-subagent-error-plain-text 黑盒验收:子代理的请求被上游拒绝时,报错原文在「子代理视图」「子代理卡片展开后的子代理回复」里原样显示
// (不解释 Markdown / HTML、不出图片、不出伪装链接、保留换行、带 data-cgui="error-text");子代理正常正文照旧按 Markdown 渲染;
// 主会话里命令行写下的两块合成报错刷新后两块都原样显示;报错里的回车换行显示为换行。
// 只依据接口文件的行为清单 S1–S6;只通过页面观测;假命令行见 helpers/fake-claude.mjs(场景 sub-error / sub-normal / api-message)。
// 观察时机:原文出现后先确认可见,再等 3 秒复查,然后才下结论;「探针 0 次」在这 3 秒之后读。
import { test, expect } from '@playwright/test';
import { seedWorkspace, writeScenario } from './helpers/fixtures.mjs';
import { reloadApp, openWorkspaceGroup, clickSession, openNewSession, sendText, stopBtn, uniqueTag } from './helpers/runtime.mjs';
import { startProbe, blockNonLoopback, snapshotList, observeAfterError, observeIn } from './helpers/observe.mjs';

/** 每条用例:只放行回环地址;监听页面未捕获错误(出现即失败)。 */
test.beforeEach(async ({ page }) => {
  await blockNonLoopback(page);
  page.__pageErrors = [];
  page.on('pageerror', (e) => page.__pageErrors.push(String(e && e.message ? e.message : e)));
});
test.afterEach(async ({ page }) => {
  expect(page.__pageErrors, '页面不应有未捕获的错误(pageerror)').toEqual([]);
});

function prepare(scenario) {
  const ctx = seedWorkspace(uniqueTag('t'));
  writeScenario(ctx.workspaceName, scenario);
  return ctx;
}

async function withProbe(body) {
  const probe = await startProbe();
  try { await body(probe); } finally { await probe.close(); }
}

/** 回合结束 = 停止键先出现(回合已开始)、再消失。 */
async function waitTurnEnded(page) {
  await expect(stopBtn(page), '发出消息后应先看到停止键(回合已开始)').toBeVisible({ timeout: 20_000 });
  await expect(stopBtn(page), '回合应当结束(停止键消失)').toHaveCount(0, { timeout: 60_000 });
}

async function runTurn(page, ctx) {
  await openNewSession(page, ctx);
  await sendText(page, `你好 ${uniqueTag('M')}`);
  await waitTurnEnded(page);
}

const hitsOf = (probe) => JSON.stringify(probe.hits);

// ── 子代理场景的定位 ──
/** 报错原文(子代理报错轮):图片写法 + 链接写法 + 加粗写法 + 标签写法。 */
const subErrorBody = (host) => `余额不足 ![图](http://${host}/sub.png) 请 [点这里充值](http://${host}/pay) 后重试 **粗体R183B** <b>x</b>`;
const NORMAL_SUB_TEXT = '正常回复 **粗体R183B** 结束';
const OPEN_VIEW_TITLE = '在子代理会话窗口打开';

/** 子代理卡片 = 主会话那一轮里名字为 Agent 的工具卡:含「在子代理会话窗口打开」按钮的那个条目。 */
const cardEntry = (page) => page.locator('[data-entry-state]').filter({ has: page.locator(`[title="${OPEN_VIEW_TITLE}"]`) });

/** 回合结束后工具调用收在折叠组里:点组头展开,直到子代理卡片可见。 */
async function expandGroup(page) {
  const head = page.locator('[data-work-group-head]').first();
  await expect(head, '回合结束后应有折叠组的组头').toBeVisible({ timeout: 20_000 });
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
  await expect(cardEntry(page).first(), '展开折叠组后应看到子代理卡片(名字为 Agent 的工具卡)').toBeVisible({ timeout: 15_000 });
}

/** 展开子代理卡片:点标题行,aria-expanded false → true,里面出现「子代理回复」。返回卡片范围。 */
async function expandCard(page) {
  const card = cardEntry(page).first();
  const titleRow = card.locator('button[aria-expanded]').first();
  await titleRow.click();
  await expect(titleRow, '点标题行后 aria-expanded 应变成 true').toHaveAttribute('aria-expanded', 'true', { timeout: 10_000 });
  await expect(card.getByText('子代理回复').first(), '展开后卡片里应有标着「子代理回复」的一块').toBeVisible({ timeout: 15_000 });
  return card;
}

/** 打开子代理视图:悬停卡片,点 title 为「在子代理会话窗口打开」的按钮。返回视图范围。 */
async function openSubagentView(page) {
  const card = cardEntry(page).first();
  await card.hover();
  await card.locator(`[title="${OPEN_VIEW_TITLE}"]`).first().click({ timeout: 10_000 });
  const view = page.locator('[data-cgui="subagent-view"]');
  await expect(view.first(), '点「在子代理会话窗口打开」后应出现 [data-cgui="subagent-view"]').toBeVisible({ timeout: 15_000 });
  return view;
}

/** 同 r183 的核心断言,范围换成视图 / 卡片:原文逐字、在 error-text 里、没有探针图片、没有伪装链接。 */
function expectErrorPlain(snap, body, probe, what) {
  expect.soft(snap.text, `${what}:可见文字应逐字包含 ${JSON.stringify(body)};实际 = ${JSON.stringify(snap.text.slice(-500))}`).toContain(body);
  expect.soft(snap.errorTexts.filter((e) => e.text.includes(body)).length,
    `${what}:报错原文应整段出现在 [data-cgui="error-text"] 里;实际 error-text = ${JSON.stringify(snap.errorTexts.map((e) => e.text))}`).toBeGreaterThanOrEqual(1);
  expect.soft(snap.probeImgs, `${what}:范围内不应有 src 含探针 ${probe.host} 的图片;实际 = ${JSON.stringify(snap.probeImgs)}`).toEqual([]);
  expect.soft(snap.fakeLinks, `${what}:范围内不应有文字恰为「点这里充值」的链接;实际 = ${JSON.stringify(snap.fakeLinks)}`).toEqual([]);
  expect.soft(probe.hits, `${what}:探针应收到 0 次请求;实际 = ${hitsOf(probe)}`).toEqual([]);
}

// ───────────────────────── 子代理 ─────────────────────────
test('S1【复现】子代理报错轮结束后(不刷新)打开子代理视图:报错原文逐字可见且在 error-text 里,视图里没有探针图片 / 伪装链接,探针 0 次', async ({ page }) => {
  await withProbe(async (probe) => {
    const body = subErrorBody(probe.host);
    const ctx = prepare({ form: 'sub-error', text: body });
    await runTurn(page, ctx);
    await expandGroup(page);
    const view = await openSubagentView(page);
    const snap = await observeIn(page, view, '余额不足', probe.host, 'S1');
    expectErrorPlain(snap, body, probe, 'S1');
  });
});

test('S2【复现】子代理报错轮结束后(不刷新)展开子代理卡片:「子代理回复」里报错原文逐字可见且在 error-text 里,卡片里没有探针图片 / 伪装链接,探针 0 次', async ({ page }) => {
  await withProbe(async (probe) => {
    const body = subErrorBody(probe.host);
    const ctx = prepare({ form: 'sub-error', text: body });
    await runTurn(page, ctx);
    await expandGroup(page);
    const card = await expandCard(page);
    const snap = await observeIn(page, card, '余额不足', probe.host, 'S2');
    expectErrorPlain(snap, body, probe, 'S2');
  });
});

test('S3【复现】子代理报错轮结束后刷新页面、重新打开会话、再打开子代理视图(内容读自子代理记录文件):同 S1 的断言', async ({ page }) => {
  await withProbe(async (probe) => {
    const body = subErrorBody(probe.host);
    const ctx = prepare({ form: 'sub-error', text: body });
    await runTurn(page, ctx);
    await reloadApp(page);
    await openWorkspaceGroup(page, ctx);
    await clickSession(page, 'fresh', ctx);
    await expect(page.locator('[data-cgui="message-list"]'), '重新打开后应看到主代理正文').toContainText('R183B-MAIN-DONE', { timeout: 20_000 });
    await expandGroup(page);
    const view = await openSubagentView(page);
    const snap = await observeIn(page, view, '余额不足', probe.host, 'S3');
    expectErrorPlain(snap, body, probe, 'S3');
  });
});

test('S4【守卫】正常子代理轮结束后(不刷新):子代理视图里、卡片的「子代理回复」里「粗体R183B」都在 strong 元素里,两处都没有 error-text', async ({ page }) => {
  await withProbe(async (probe) => {
    const ctx = prepare({ form: 'sub-normal', text: NORMAL_SUB_TEXT });
    await runTurn(page, ctx);
    await expandGroup(page);
    const card = await expandCard(page);
    const cardSnap = await observeIn(page, card, '粗体R183B', probe.host, 'S4(卡片)');
    expect.soft(cardSnap.strongTexts, `S4:卡片的「子代理回复」里「粗体R183B」应在 strong 元素里;卡片文字 = ${JSON.stringify(cardSnap.text.slice(-300))}`).toContain('粗体R183B');
    expect.soft(cardSnap.errorTexts, 'S4:卡片里不应有 error-text 元素').toEqual([]);
    const view = await openSubagentView(page);
    const viewSnap = await observeIn(page, view, '粗体R183B', probe.host, 'S4(视图)');
    expect.soft(viewSnap.strongTexts, `S4:子代理视图里「粗体R183B」应在 strong 元素里;视图文字 = ${JSON.stringify(viewSnap.text.slice(-300))}`).toContain('粗体R183B');
    expect.soft(viewSnap.errorTexts, 'S4:子代理视图里不应有 error-text 元素').toEqual([]);
  });
});

// ───────────────────────── 主会话 ─────────────────────────
test('S5【复现】主会话两块报错:刷新后重新打开会话,两块原文都逐字可见且在 error-text 里,消息区没有探针图片 / 伪装链接,探针 0 次', async ({ page }) => {
  await withProbe(async (probe) => {
    const block1 = `第一块R183B ![图](http://${probe.host}/two.png)`;
    const block2 = `第二块R183B [点这里充值](http://${probe.host}/pay)`;
    const ctx = prepare({ form: 'api-message', text: `API Error: 400 ${block1}`, blocks: [`API Error: 400 ${block1}`, block2] });
    await runTurn(page, ctx);
    await reloadApp(page);
    await openWorkspaceGroup(page, ctx);
    await clickSession(page, 'fresh', ctx);
    const snap = await observeAfterError(page, '第二块R183B', probe.host, 'S5');
    expect.soft(snap.text, `S5:消息区应逐字含第一块原文;实际 = ${JSON.stringify(snap.text.slice(-400))}`).toContain(block1);
    expect.soft(snap.text, `S5:消息区应逐字含第二块原文;实际 = ${JSON.stringify(snap.text.slice(-400))}`).toContain(block2);
    const errs = snap.errorTexts.map((e) => e.text);
    expect.soft(errs.some((t) => t.includes(block1)), `S5:第一块原文应在 error-text 里;实际 error-text = ${JSON.stringify(errs)}`).toBe(true);
    expect.soft(errs.some((t) => t.includes(block2)), `S5:第二块原文应在 error-text 里;实际 error-text = ${JSON.stringify(errs)}`).toBe(true);
    expect.soft(snap.probeImgs, `S5:消息区不应有指向探针的图片;实际 = ${JSON.stringify(snap.probeImgs)}`).toEqual([]);
    expect.soft(snap.fakeLinks, `S5:消息区不应有文字恰为「点这里充值」的链接;实际 = ${JSON.stringify(snap.fakeLinks)}`).toEqual([]);
    expect.soft(probe.hits, `S5:探针应收到 0 次请求;实际 = ${hitsOf(probe)}`).toEqual([]);
  });
});

test('S6【复现】主会话报错里的回车换行:刷新后重新打开会话,error-text 的 textContent 不含 \\r,且两行之间恰为一个换行', async ({ page }) => {
  const ctx = prepare({ form: 'api-message', text: 'API Error: 400 第一行R183B\r\n第二行R183B' });
  await runTurn(page, ctx);
  await reloadApp(page);
  await openWorkspaceGroup(page, ctx);
  await clickSession(page, 'fresh', ctx);
  await observeAfterError(page, '第二行R183B', '127.0.0.1:0', 'S6');
  const snap = await snapshotList(page, '127.0.0.1:0');
  const mine = snap.errorTexts.filter((e) => e.text.includes('第一行R183B'));
  expect(mine.length, `S6:应有含「第一行R183B」的 error-text 元素;实际 error-text = ${JSON.stringify(snap.errorTexts.map((e) => e.text))}`).toBeGreaterThanOrEqual(1);
  const content = await page.evaluate(() => {
    const el = [...document.querySelectorAll('[data-cgui="error-text"]')].find((e) => (e.textContent || '').includes('第一行R183B'));
    return el ? el.textContent : null;
  });
  expect.soft(content, `S6:error-text 的 textContent 不应含回车字符 \\r;实际 = ${JSON.stringify(content)}`).not.toContain('\r');
  expect.soft(content, `S6:error-text 的 textContent 应含「第一行R183B\\n第二行R183B」;实际 = ${JSON.stringify(content)}`).toContain('第一行R183B\n第二行R183B');
});
