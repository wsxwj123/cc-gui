// r183-error-plain-text 黑盒验收:对话里的报错文字(上游/命令行给出的原文、发送失败时后端返回的说明)改为原样显示:
// 保留换行;Markdown / HTML 写法不当排版;不加载其中写的图片地址;不画 cgui-ui 交互组件;裸写的 http(s) 地址仍是可点链接(链接地址 = 显示文字);
// 助手的正常回复照旧按 Markdown 渲染。只依据接口文件的行为清单 E1–E12;只通过页面观测;假命令行见 helpers/fake-claude.mjs。
// 观察时机:报错出现后先确认文字可见,再等 3 秒复查,然后才下结论;「探针 0 次」在这 3 秒之后读。
// 复现用例的核心断言(逐字可见 / 无图片 / 无伪装链接 / 无按钮 / 探针 0 次)都在消息区范围内判断,不依赖新挂点;
// 新挂点 [data-cgui="error-text"] 只在 E3、E5、E9 里额外断言。
import { test, expect } from '@playwright/test';
import { seedWorkspace, writeScenario } from './helpers/fixtures.mjs';
import { reloadApp, openWorkspaceGroup, clickSession, openNewSession, sendText, stopBtn, readList, uniqueTag } from './helpers/runtime.mjs';
import { startProbe, blockNonLoopback, snapshotList, countButtons, startBadMonitor, readBadMonitor, observeAfterError, expectVerbatim } from './helpers/observe.mjs';

test.beforeEach(async ({ page }) => { await blockNonLoopback(page); });

/** 每个用例现建一个全新工作区 + 写这个工作区的场景。 */
function prepare(scenario) {
  const ctx = seedWorkspace(uniqueTag('t'));
  writeScenario(ctx.workspaceName, { resultShape: process.env.R183_RESULT_SHAPE || undefined, ...scenario });
  return ctx;
}

/** 起探针 → 跑 body(probe) → 无论成败都关探针。 */
async function withProbe(body) {
  const probe = await startProbe();
  try { await body(probe); } finally { await probe.close(); }
}

/** 回合结束 = 停止键先出现(回合已开始)、再消失。 */
async function waitTurnEnded(page) {
  await expect(stopBtn(page), '发出消息后应先看到停止键(回合已开始)').toBeVisible({ timeout: 20_000 });
  await expect(stopBtn(page), '回合应当结束(停止键消失)').toHaveCount(0, { timeout: 60_000 });
}

/** 新建会话 → 发一条消息 → 等回合结束。 */
async function runTurn(page, ctx, userText = '你好') {
  await openNewSession(page, ctx);
  await sendText(page, `${userText} ${uniqueTag('M')}`);
  await waitTurnEnded(page);
}

const hitsOf = (probe) => JSON.stringify(probe.hits);

// ───────────────────────── 甲形态:只有结束事件报错 ─────────────────────────
test('E1【复现】报错里的图片写法:原文逐字可见,消息区没有指向探针的图片,探针 0 次请求', async ({ page }) => {
  await withProbe(async (probe) => {
    const text = `余额不足 ![图](http://${probe.host}/pix.png) 请充值`;
    const ctx = prepare({ form: 'result-only', text });
    await runTurn(page, ctx);
    const snap = await observeAfterError(page, '请充值', probe.host, 'E1');
    expectVerbatim(snap, text, 'E1');
    expect.soft(snap.probeImgs, `E1:消息区里不应有 src 含探针 ${probe.host} 的图片;实际 = ${JSON.stringify(snap.probeImgs)}`).toEqual([]);
    expect.soft(probe.hits, `E1:探针应收到 0 次请求;实际 = ${hitsOf(probe)}`).toEqual([]);
  });
});

test('E2【复现】报错里的链接写法:原文逐字可见,消息区没有文字恰为「点这里充值」的链接,探针 0 次', async ({ page }) => {
  await withProbe(async (probe) => {
    const text = `请 [点这里充值](http://${probe.host}/pay) 后重试`;
    const ctx = prepare({ form: 'result-only', text });
    await runTurn(page, ctx);
    const snap = await observeAfterError(page, '后重试', probe.host, 'E2');
    expectVerbatim(snap, text, 'E2');
    expect.soft(snap.fakeLinks, `E2:消息区里不应有文字恰为「点这里充值」的链接;实际 = ${JSON.stringify(snap.fakeLinks)}`).toEqual([]);
    expect.soft(probe.hits, `E2:探针应收到 0 次请求;实际 = ${hitsOf(probe)}`).toEqual([]);
  });
});

test('E3【复现】报错里的加粗 / 标题 / 表格 / 标签写法:四行逐字可见,error-text 存在且里面没有 strong、h1、table', async ({ page }) => {
  const lines = ['前缀 **加粗R183** 后缀', '# 标题R183', '| a | b |', '尾行 <b>x</b>'];
  const ctx = prepare({ form: 'result-only', text: lines.join('\n') });
  await runTurn(page, ctx);
  const snap = await observeAfterError(page, '尾行', '127.0.0.1:0', 'E3');
  for (const line of lines) expectVerbatim(snap, line, 'E3');
  // 消息区范围内的判断(不依赖新挂点):没有把写法渲染成加粗 / 标题 / 表格
  expect.soft(snap.strongTexts.filter((t) => t.includes('加粗R183')), 'E3:消息区里不应有包着「加粗R183」的 strong 元素').toEqual([]);
  expect.soft(snap.h1Texts.filter((t) => t.includes('标题R183')), 'E3:消息区里不应有包着「标题R183」的 h1 元素').toEqual([]);
  expect.soft(snap.tableCount, 'E3:消息区里不应有 table 元素').toBe(0);
  // 新挂点
  expect.soft(snap.errorTexts.length, 'E3:[data-cgui="error-text"] 应存在').toBeGreaterThanOrEqual(1);
  for (const e of snap.errorTexts) {
    expect.soft({ strong: e.strong, h1: e.h1, table: e.table }, 'E3:error-text 里不应有 strong、h1、table 元素').toEqual({ strong: 0, h1: 0, table: 0 });
  }
});

test('E4【复现】报错里的 cgui-ui 围栏:页面上没有文字为 R183BTN 的按钮,R183BTN 作为普通文字可见', async ({ page }) => {
  const fence = '```cgui-ui\n{"items":[{"type":"button","label":"R183BTN","action":"r183-act"}]}\n```';
  const ctx = prepare({ form: 'result-only', text: `第一行\n${fence}\n最后一行` });
  await runTurn(page, ctx);
  const snap = await observeAfterError(page, '最后一行', '127.0.0.1:0', 'E4');
  expect.soft(await countButtons(page, 'R183BTN'), 'E4:页面上不应有文字为 R183BTN 的按钮元素').toBe(0);
  expect.soft(snap.text, 'E4:R183BTN 这几个字应作为普通文字可见').toContain('R183BTN');
});

test('E5【复现】报错里的换行:两段都可见,且两者之间有换行(消息区与 error-text 都是)', async ({ page }) => {
  const ctx = prepare({ form: 'result-only', text: '第一行R183A\n第二行R183B' });
  await runTurn(page, ctx);
  const snap = await observeAfterError(page, '第二行R183B', '127.0.0.1:0', 'E5');
  const gap = (t) => {
    const a = t.indexOf('第一行R183A');
    const b = t.indexOf('第二行R183B');
    return a >= 0 && b > a ? t.slice(a + '第一行R183A'.length, b) : null;
  };
  expect.soft(gap(snap.text), `E5:消息区里「第一行R183A」与「第二行R183B」之间应含换行;实际消息区 = ${JSON.stringify(snap.text.slice(-200))}`).toContain('\n');
  expect.soft(snap.errorTexts.length, 'E5:[data-cgui="error-text"] 应存在').toBeGreaterThanOrEqual(1);
  expect.soft(snap.errorTexts.map((e) => gap(e.text)), 'E5:error-text 的可见文字里两段之间应含换行').toContainEqual(expect.stringContaining('\n'));
});

test('E6【守卫】报错里裸写的网址:消息区有一个链接,文字与 href 都是该网址', async ({ page }) => {
  const url = 'https://example.com/docs/r183';
  const ctx = prepare({ form: 'result-only', text: `详见 ${url} 即可` });
  await runTurn(page, ctx);
  const snap = await observeAfterError(page, '即可', '127.0.0.1:0', 'E6');
  const same = snap.links.filter((l) => l.text === url);
  expect(same.length, `E6:消息区里应有文字为 ${url} 的链接;实际链接 = ${JSON.stringify(snap.links)}`).toBeGreaterThanOrEqual(1);
  expect(same.map((l) => l.href), `E6:这些链接的 href 都应是 ${url}`).toEqual(same.map(() => url));
});

test('E7【守卫】401 报错:报错可见,点「检查 Provider 设置」后 Provider 弹层打开(出现「管理 Provider」)', async ({ page }) => {
  const ctx = prepare({ form: 'result-only', text: 'API Error: 401 Unauthorized' });
  await runTurn(page, ctx);
  const snap = await observeAfterError(page, '401 Unauthorized', '127.0.0.1:0', 'E7');
  expect(snap.text, 'E7:报错原文应可见').toContain('API Error: 401 Unauthorized');
  const btn = page.getByRole('button', { name: /检查 Provider 设置/ }).first();
  await expect(btn, 'E7:报错下方应有含「检查 Provider 设置」的按钮').toBeVisible({ timeout: 10_000 });
  await btn.click();
  await expect(page.getByText('管理 Provider').first(), 'E7:点按钮后应出现「管理 Provider」字样(设置 / Provider 面板已打开)').toBeVisible({ timeout: 10_000 });
});

test('E10【守卫】先正常说一句带加粗的话再以甲形态报错:「正文R183C」仍在 strong 元素里', async ({ page }) => {
  const ctx = prepare({ form: 'result-only', prelude: '前面是**正文R183C**', text: '上游报错R183X' });
  await runTurn(page, ctx);
  const snap = await observeAfterError(page, '上游报错R183X', '127.0.0.1:0', 'E10');
  expect(snap.strongTexts, `E10:助手的正常回复照旧按 Markdown 渲染,「正文R183C」应在 strong 元素里;消息区 = ${JSON.stringify(snap.text.slice(-300))}`).toContain('正文R183C');
});

// ───────────────────────── 乙形态:先写一条报错助手消息 ─────────────────────────
function apiMessageText(host) {
  return `余额不足 ![图](http://${host}/pix.png) 请充值,请 [点这里充值](http://${host}/pay) 后重试`;
}

test('E8【复现】乙形态报错含图片与链接写法:回合进行中与结束之后都没有指向探针的图片 / 伪装链接,原文逐字可见,探针 0 次', async ({ page }) => {
  await withProbe(async (probe) => {
    const text = apiMessageText(probe.host);
    const ctx = prepare({ form: 'api-message', text });
    await openNewSession(page, ctx);
    await startBadMonitor(page, probe.host);
    await sendText(page, `你好 ${uniqueTag('M')}`);
    await waitTurnEnded(page);
    const snap = await observeAfterError(page, '后重试', probe.host, 'E8');
    expectVerbatim(snap, text, 'E8');
    expect.soft(snap.probeImgs, `E8:结束之后消息区里不应有指向探针的图片;实际 = ${JSON.stringify(snap.probeImgs)}`).toEqual([]);
    expect.soft(snap.fakeLinks, `E8:结束之后消息区里不应有文字为「点这里充值」的链接;实际 = ${JSON.stringify(snap.fakeLinks)}`).toEqual([]);
    const mon = await readBadMonitor(page);
    expect.soft(mon.img, `E8:回合进行中(整个观察期)消息区里出现过指向探针的图片的采样次数应为 0;实际 ${mon.img}`).toBe(0);
    expect.soft(mon.link, `E8:回合进行中(整个观察期)消息区里出现过「点这里充值」链接的采样次数应为 0;实际 ${mon.link}`).toBe(0);
    expect.soft(probe.hits, `E8:探针应收到 0 次请求;实际 = ${hitsOf(probe)}`).toEqual([]);
  });
});

test('E9【复现】乙形态报错(E8 之后)刷新页面重新打开会话:原文逐字可见且在 error-text 里,没有图片与伪装链接,探针仍是 0 次', async ({ page }) => {
  await withProbe(async (probe) => {
    const text = apiMessageText(probe.host);
    const ctx = prepare({ form: 'api-message', text });
    await runTurn(page, ctx);
    await observeAfterError(page, '后重试', probe.host, 'E9(刷新前)');
    await reloadApp(page);
    await openWorkspaceGroup(page, ctx);
    await clickSession(page, 'fresh', ctx);
    const snap = await observeAfterError(page, '后重试', probe.host, 'E9(刷新后)');
    expectVerbatim(snap, text, 'E9');
    expect.soft(snap.probeImgs, `E9:重新打开后消息区里不应有指向探针的图片;实际 = ${JSON.stringify(snap.probeImgs)}`).toEqual([]);
    expect.soft(snap.fakeLinks, `E9:重新打开后消息区里不应有文字为「点这里充值」的链接;实际 = ${JSON.stringify(snap.fakeLinks)}`).toEqual([]);
    expect.soft(snap.errorTexts.filter((e) => e.inList && e.text.includes(text)).length, `E9:原文应整段出现在消息区内的 [data-cgui="error-text"] 里;实际 error-text = ${JSON.stringify(snap.errorTexts)}`).toBeGreaterThanOrEqual(1);
    expect.soft(probe.hits, `E9:探针仍应是 0 次请求;实际 = ${hitsOf(probe)}`).toEqual([]);
  });
});

// ───────────────────────── 其它 ─────────────────────────
test('E11【守卫】正常回复里的图片写法照旧渲染:消息区有指向探针的图片,探针收到对 /ok.png 的请求', async ({ page }) => {
  await withProbe(async (probe) => {
    const ctx = prepare({ form: 'normal', text: `看图 ![图](http://${probe.host}/ok.png)` });
    await runTurn(page, ctx);
    await expect.poll(() => probe.hits.some((h) => h.startsWith('GET /ok.png')), { timeout: 15_000, message: `E11:探针应收到对 /ok.png 的请求;实际 = ${hitsOf(probe)}` }).toBe(true);
    const snap = await snapshotList(page, probe.host);
    expect(snap.probeImgs.length, `E11:正常回复里应渲染出指向探针的图片;消息区图片 = ${JSON.stringify(snap.allImgs)}`).toBeGreaterThanOrEqual(1);
  });
});

test('E12【复现】发送请求 POST /api/chat 被拦成 HTTP 500:页面显示说明文字,逐字可见,没有指向探针的图片,探针 0 次', async ({ page }) => {
  await withProbe(async (probe) => {
    const msg = `发送出错 ![图](http://${probe.host}/e12.png)`;
    const ctx = prepare({ form: 'normal', text: '好的' });
    let intercepted = 0;
    await page.route(/\/api\/chat(\?.*)?$/, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      intercepted += 1;
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: msg }) });
    });
    await openNewSession(page, ctx);
    await sendText(page, `你好 ${uniqueTag('M')}`);
    await expect.poll(() => intercepted, { timeout: 15_000, message: 'E12:前置:发送后页面应发出 POST /api/chat(被拦截的次数)' }).toBeGreaterThanOrEqual(1);
    const snap = await observeAfterError(page, '发送出错', probe.host, 'E12');
    expectVerbatim(snap, msg, 'E12');
    expect.soft(snap.probeImgs, `E12:消息区里不应有指向探针的图片;实际 = ${JSON.stringify(snap.probeImgs)}`).toEqual([]);
    expect.soft(probe.hits, `E12:探针应收到 0 次请求;实际 = ${hitsOf(probe)}`).toEqual([]);
  });
});
