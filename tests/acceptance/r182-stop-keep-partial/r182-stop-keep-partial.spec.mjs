// r182-stop-keep-partial 黑盒验收:一轮回复被用户停止、或因长时间无输出被后端结束时,命令行可能没把这一轮已显示的内容写进会话文件;
// 这种内容应一直留在屏幕上(不消失、不重复、位置不乱);命令行正常写盘的情形屏幕上只有一份。
// 只依据接口文件的行为清单(K2 K3 K5 K6 K9 K11 K13 K14 K15 K19,一条对一条);只通过页面观测(文案 / data-* 锚点);假命令行见 helpers/fake-claude.mjs。
// 这个文件现在也包含 r188-rollback-flow 的 B2–B5(回合在进行或刚被停止时「仅回退消息」「编辑后重发」)。
// 标【复现】的用例在改动之前应当因断言不成立而失败;标【守卫】的应当通过。
import { test as base, expect } from '@playwright/test';
import { seedPair, writeScenario, resetStatus, readStatus, requestAbort } from './helpers/fixtures.mjs';
import {
  openJia, clickSession, sendMessage, stopBtn, composerBox, readView, waitView, observe, series, uniqueTag, syntheticReconcile, setStallTimeout,
  RELAUNCH_SCENARIO, countOf, pickRollbackItem, editAndResendFill, observeRelaunch, startSampler, switchAwayAndBack, expectFiveFragments,
} from './helpers/runtime.mjs';

// 监听页面的未捕获错误(pageerror),出现即失败。
const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
    await use(page);
    expect(errors, '页面出现未捕获错误(pageerror)').toEqual([]);
  },
});

const HALF = { persistThinking: true, persistPartialOnInterrupt: false, persistFinal: false }; // 半写形
const KILLED = { persistThinking: false, persistPartialOnInterrupt: false, persistFinal: false }; // 强杀形

/** 每个用例现建一对全新的甲 / 乙(各自独有标记、独立工作区)+ 清状态文件。场景在每次发消息前由 turn() 写。 */
let currentCtx = null;
function prepare() {
  const ctx = seedPair(uniqueTag('t'));
  currentCtx = ctx;
  resetStatus(ctx.workspaceName);
  return ctx;
}

// 用例收场:让假命令行把遗留的长回合尽快正常收尾(最多等 10 秒)。
test.afterEach(async () => {
  if (!currentCtx) return;
  const name = currentCtx.workspaceName;
  requestAbort(name);
  for (let i = 0; i < 100; i += 1) {
    const st = readStatus(name);
    if (!st || st.openedAt == null || st.ended) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  currentCtx = null;
});

const promptOf = (k, round) => `R182-${k}-${round}-${uniqueTag()}`;
/** 写场景再发一轮。 */
async function turn(page, scenario, prompt) {
  writeScenario(scenario);
  await sendMessage(page, prompt);
}
/** 等第 ti 轮片段数 ≥ n 且停止键在;返回最后一次读数。 */
async function waitFragments(page, prompts, ti, n, what) {
  const r = await waitView(page, prompts, (v) => v.stop && v.turns[ti].n >= n, 40_000);
  expect(r.ok, `${what}:第 ${ti + 1} 轮片段数应在 40 秒内到 ${n} 且停止键在;最后一次读到 ${r.v.turns[ti].n} 个(停止键${r.v.stop ? '在' : '不在'})`).toBe(true);
  return r.v;
}
/** 「片段数保持」:各次读数都不小于停止前读数,且从起点后 0.5 秒起各次读数彼此相等。 */
function expectHeld(samples, ti, pre, what) {
  const ns = samples.map((s) => s.turns[ti].n);
  expect(Math.min(...ns), `${what}:观察期内片段数不应少于停止前读数 ${pre};各次读数 = ${series(samples, ti)}`).toBeGreaterThanOrEqual(pre);
  const later = samples.filter((s) => s.dt >= 500).map((s) => s.turns[ti].n);
  expect(later.length, `${what}:应有 0.5 秒之后的读数`).toBeGreaterThan(0);
  expect(new Set(later).size, `${what}:从 0.5 秒起各次读数应彼此相等;各次读数 = ${series(samples, ti)}`).toBe(1);
}
const maxId = (t) => Math.max(0, ...Object.values(t.ids));

// ───────────────────────── K2 ─────────────────────────
test('K2 【复现】半写形:片段数≥40 时点停止,8 秒内片段数保持,期末思考 1 个、气泡 1 个', async ({ page }) => {
  const ctx = prepare();
  await openJia(page, ctx);
  const prompts = [promptOf('K2', 'a')];
  await turn(page, { ...HALF }, prompts[0]);
  const pre = (await waitFragments(page, prompts, 0, 40, 'K2')).turns[0].n;
  await stopBtn(page).click();
  const samples = await observe(page, prompts, 8000);
  expectHeld(samples, 0, pre, 'K2');
  const end = samples[samples.length - 1].turns[0];
  expect(end.think, `K2:期末这一轮的思考个数;各次片段数 = ${series(samples, 0)}`).toBe(1);
  expect(end.bubbles, 'K2:期末这一轮的气泡数').toBe(1);
});

// ───────────────────────── K3 ─────────────────────────
test('K3 【复现】强杀形:切走 2 秒再切回、继续长出≥10 片段后点停止,8 秒内片段数保持,期末思考 1 个、气泡 1 个', async ({ page }) => {
  const ctx = prepare();
  await openJia(page, ctx);
  const prompts = [promptOf('K3', 'a')];
  await turn(page, { ...KILLED }, prompts[0]);
  const r10 = await waitView(page, prompts, (v) => v.turns[0].n >= 10, 40_000);
  expect(r10.ok, `K3:发出后片段数应到 10;最后一次读到 ${r10.v.turns[0].n}`).toBe(true);
  await clickSession(page, 'yi', ctx);
  await page.waitForTimeout(2000);
  await clickSession(page, 'jia', ctx);
  const first = await readView(page, prompts);
  const n0 = first.turns[0].n;
  const r = await waitView(page, prompts, (v) => v.stop && v.turns[0].n >= n0 + 10, 40_000);
  expect(r.ok, `K3:切回后停止键应出现且片段数比切回后第一次读数 ${n0} 多出至少 10;最后一次读到 ${r.v.turns[0].n}(停止键${r.v.stop ? '在' : '不在'})`).toBe(true);
  const pre = r.v.turns[0].n;
  await stopBtn(page).click();
  const samples = await observe(page, prompts, 8000);
  expectHeld(samples, 0, pre, 'K3');
  const end = samples[samples.length - 1].turns[0];
  expect(end.think, `K3:期末这一轮的思考个数;各次片段数 = ${series(samples, 0)}`).toBe(1);
  expect(end.bubbles, 'K3:期末这一轮的气泡数').toBe(1);
});

// ───────────────────────── K5 ─────────────────────────
test('K5 【复现】前一轮已写盘结束、这一轮强杀形停在 5 片段:停止后做一次合成核对,8 秒内片段数恒为 5、思考恒为 1 个', async ({ page }) => {
  const ctx = prepare();
  await openJia(page, ctx);
  const prompts = [promptOf('K5', 'a'), promptOf('K5', 'b')];
  await turn(page, { chunkCount: 5 }, prompts[0]);
  const done = await waitView(page, prompts, (v) => v.turns[0].n === 5 && !v.stop, 40_000);
  expect(done.ok, `K5:前置一轮应自然结束(片段数 5、停止键消失);最后一次读到 ${done.v.turns[0].n} 个(停止键${done.v.stop ? '在' : '不在'})`).toBe(true);
  await turn(page, { ...KILLED, chunkIntervalMs: 1500 }, prompts[1]);
  const five = await waitView(page, prompts, (v) => v.stop && v.turns[1].n >= 5, 40_000);
  expect(five.ok, `K5:被观察的这一轮片段数应到 5;最后一次读到 ${five.v.turns[1].n}`).toBe(true);
  await page.waitForTimeout(300);
  await stopBtn(page).click();
  let reconciled = false;
  const samples = await observe(page, prompts, 8000, async (v) => {
    if (!reconciled && v.dt >= 3000) { reconciled = true; await syntheticReconcile(page); }
  });
  expect(reconciled, 'K5:应已在停止后 3 秒做过合成核对').toBe(true);
  const ns = samples.map((s) => s.turns[1].n);
  expect(ns.every((n) => n === 5), `K5:每次读数这一轮片段数都应等于 5;各次读数 = ${series(samples, 1)};这一轮用户消息${samples[0].turns[1].present ? '在' : '不在'}页面上;前一轮片段数 = ${series(samples, 0)}`).toBe(true);
  const th = samples.map((s) => s.turns[1].think);
  expect(th.every((n) => n === 1), `K5:每次读数这一轮思考都应是 1 个;各次读数 = ${series(samples, 1, (s) => s.turns[1].think)}`).toBe(true);
});

// ───────────────────────── K6 ─────────────────────────
test('K6 【复现】强杀形回合进行中「编辑后重发」并发出新内容:新一轮进行期间整个消息区片段数不超过 5,期末 5、每个编号恰好 1 次、「重发轮。」恰好 1 次、第 1 条提示词 0 次、第 2 条恰好 1 次,切走再切回后仍如此', async ({ page }) => {
  test.setTimeout(150_000);
  const ctx = prepare();
  await openJia(page, ctx);
  const oldPrompt = promptOf('K6', 'a');
  const newPrompt = promptOf('K6', 'b');
  const prompts = [oldPrompt, newPrompt];
  await turn(page, { ...KILLED }, oldPrompt);
  await waitFragments(page, prompts, 0, 40, 'K6');
  // 不点停止:回合还在跑时,对这一轮提示词那张用户消息卡做「回滚 / 重新编辑」→「编辑后重发」,原文回到输入框(此时回合仍在跑)。
  const card = page.locator('[data-cgui="message-user"]').filter({ hasText: oldPrompt }).first();
  await expect(card, 'K6:这一轮的用户消息卡应带 data-message-id(最多等 5 秒)').toHaveAttribute('data-message-id', /.+/, { timeout: 5_000 });
  await card.hover();
  await card.getByTitle('回滚 / 重新编辑').click();
  await page.getByRole('button', { name: /编辑后重发/ }).click();
  await expect(composerBox(page).last(), 'K6:「编辑后重发」应把这一轮提示词原文放回输入框').toHaveValue(oldPrompt, { timeout: 20_000 });
  // 换成新提示词发送(页面此时才回滚并发出新一轮);新一轮:打断形、5 个片段、间隔 1.5 秒、前缀「重发轮。」。
  writeScenario({ chunkCount: 5, chunkIntervalMs: 1500, textPrefix: '重发轮。' });
  const t0 = Date.now();
  await sendMessage(page, newPrompt);
  // 观察窗口:从消息区第一次出现「重发轮。」起,每 250 毫秒读一次,直到新一轮结束(见过停止键之后停止键消失)后 6 秒。
  const { appearMs, samples, doneAt } = await observeRelaunch(page, prompts, t0);
  expect(appearMs, `K6:「重发轮。」应在发送后 40 秒内出现;最后一次读到整个消息区片段数 ${samples[samples.length - 1].total}`).not.toBeNull();
  expect(doneAt, `K6:新一轮应在 60 秒内结束(停止键出现后又消失);各次读数(整个消息区片段数) = ${series(samples, 0, (s) => s.total)}`).not.toBeNull();
  const totalSeries = series(samples, 0, (s) => s.total);
  expect(Math.max(...samples.map((s) => s.total)), `K6:观察窗口内每次读数整个消息区的片段数都不应超过 5;各次读数 = ${totalSeries}`).toBeLessThanOrEqual(5);
  const end = samples[samples.length - 1];
  expect(end.total, `K6:期末整个消息区片段数应为 5;各次读数 = ${totalSeries}`).toBe(5);
  expectFiveFragments(end, 'K6 期末');
  expect(countOf(end.text, oldPrompt), 'K6:期末第 1 条提示词在消息区出现的次数').toBe(0);
  expect(countOf(end.text, newPrompt), 'K6:期末第 2 条提示词在消息区出现的次数').toBe(1);
  expect(appearMs, 'K6:从点发送到「重发轮。」出现的毫秒数应不超过 20000').toBeLessThanOrEqual(20_000);
  // 切走再切回。
  const back = await switchAwayAndBack(page, ctx, prompts);
  expect(countOf(back.text, oldPrompt), 'K6:切走再切回后第 1 条提示词出现的次数').toBe(0);
  expect(countOf(back.text, newPrompt), 'K6:切走再切回后第 2 条提示词出现的次数').toBe(1);
  expect(back.total, 'K6:切走再切回后整个消息区片段总数').toBe(5);
});

// ───────────────────────── K9 ─────────────────────────
test('K9 【守卫】打断形:片段数≥40 时点停止,8 秒内片段数不减少、每个编号最多 1 次、气泡不超过 1;期末与状态文件的打断点相差≤5、气泡 1 个', async ({ page }) => {
  const ctx = prepare();
  await openJia(page, ctx);
  const prompts = [promptOf('K9', 'a')];
  await turn(page, {}, prompts[0]);
  const pre = (await waitFragments(page, prompts, 0, 40, 'K9')).turns[0].n;
  await stopBtn(page).click();
  const samples = await observe(page, prompts, 8000);
  const ns = samples.map((s) => s.turns[0].n);
  expect(Math.min(...ns), `K9:各次读数都不应少于停止前读数 ${pre};各次读数 = ${series(samples, 0)}`).toBeGreaterThanOrEqual(pre);
  const dup = samples.filter((s) => maxId(s.turns[0]) > 1).length;
  expect(dup, `K9:每次读数这一轮每个编号最多 1 次;有 ${dup} 次读数出现重复编号`).toBe(0);
  const bub = samples.map((s) => s.turns[0].bubbles);
  expect(Math.max(...bub), `K9:气泡数不应超过 1;各次读数 = ${series(samples, 0, (s) => s.turns[0].bubbles)}`).toBeLessThanOrEqual(1);
  const st = readStatus(ctx.workspaceName);
  expect(st && st.interruptedAtChunks, 'K9:状态文件应记下被打断时的片段数').not.toBeNull();
  const end = samples[samples.length - 1].turns[0];
  expect(Math.abs(end.n - st.interruptedAtChunks), `K9:期末片段数 ${end.n} 与打断点 ${st.interruptedAtChunks} 相差不应超过 5`).toBeLessThanOrEqual(5);
  expect(end.bubbles, 'K9:期末气泡数').toBe(1);
});

// ───────────────────────── K11 ─────────────────────────
async function runNaturalEnd(page, k, extra) {
  const ctx = prepare();
  await openJia(page, ctx);
  const prompts = [promptOf(k, 'a')];
  await turn(page, { chunkCount: 150, ...extra }, prompts[0]);
  const done = await waitView(page, prompts, (v) => {
    const st = readStatus(ctx.workspaceName);
    return Boolean(st && st.ended) && !v.stop && v.turns[0].n > 0;
  }, 60_000);
  expect(done.ok, `${k}:回合应在 60 秒内自然结束(停止键消失);最后一次读到 ${done.v.turns[0].n} 个(停止键${done.v.stop ? '在' : '不在'})`).toBe(true);
  const samples = await observe(page, prompts, 6000);
  const dup = samples.filter((s) => maxId(s.turns[0]) > 1).length;
  expect(dup, `${k}:每次读数这一轮每个编号最多 1 次;有 ${dup} 次读数出现重复编号;各次片段数 = ${series(samples, 0)}`).toBe(0);
  const end = samples[samples.length - 1].turns[0];
  expect(end.n, `${k}:期末这一轮片段数;各次片段数 = ${series(samples, 0)}`).toBe(150);
  expect(Object.keys(end.ids).length, `${k}:期末这一轮应有 150 个不同编号`).toBe(150);
  expect(maxId(end), `${k}:期末每个编号恰好 1 次`).toBe(1);
  return { samples, end };
}

test('K11 【守卫】打断形 150 片段自然结束:结束后 6 秒内每个编号最多 1 次,期末 150 片段、每个编号恰好 1 次、气泡 1 个', async ({ page }) => {
  const { end } = await runNaturalEnd(page, 'K11', {});
  expect(end.bubbles, 'K11:期末气泡数').toBe(1);
});

// ───────────────────────── K13 ─────────────────────────
test('K13 【守卫】写盘正文比流里多一句「规整补句。」:结束后每个编号最多 1 次,期末 150 片段、每个编号恰好 1 次、「规整补句。」恰好 1 次', async ({ page }) => {
  const { end } = await runNaturalEnd(page, 'K13', { persistFinalVariant: 'longer' });
  const extra = end.seg.split('规整补句。').length - 1;
  expect(extra, 'K13:「规整补句。」在这一轮范围里出现的次数').toBe(1);
});

// ───────────────────────── K14 ─────────────────────────
test('K14 【复现】第 1 轮强杀形停止后接着发第 2 轮:第 1 轮内容一直在原位且不变,第 2 轮片段数≤5、期末 5,「下一轮。」恰好 1 次', async ({ page }) => {
  const ctx = prepare();
  await openJia(page, ctx);
  const prompts = [promptOf('K14', 'a'), promptOf('K14', 'b')];
  await turn(page, { ...KILLED }, prompts[0]);
  const pre1 = (await waitFragments(page, prompts, 0, 40, 'K14')).turns[0].n;
  await stopBtn(page).click();
  await page.waitForTimeout(3000);
  writeScenario({ chunkCount: 5, textPrefix: '下一轮。' });
  const t0 = Date.now();
  const posted = sendMessage(page, prompts[1]);
  // 从第 2 轮发出起一直观察到第 2 轮结束(片段数 5、停止键消失)后 6 秒。
  const samples = [];
  let doneAt = null;
  for (;;) {
    const v = await readView(page, prompts);
    v.dt = v.t - t0;
    samples.push(v);
    if (doneAt == null && v.turns[1].n >= 5 && !v.stop) doneAt = v.t;
    if (doneAt != null && v.t - doneAt >= 6000) break;
    if (v.t - t0 > 60_000) break;
    await page.waitForTimeout(250);
  }
  await posted;
  expect(doneAt, `K14:第 2 轮应在 60 秒内自然结束(片段数 5、停止键消失);各次读数(第 2 轮) = ${series(samples, 1)}`).not.toBeNull();
  const n1 = samples.map((s) => s.turns[0].n);
  expect(Math.min(...n1), `K14:第 1 轮片段数每次读数都不应少于停止前读数 ${pre1};各次读数 = ${series(samples, 0)}`).toBeGreaterThanOrEqual(pre1);
  expect(new Set(n1).size, `K14:第 1 轮片段数各次读数应彼此相等;各次读数 = ${series(samples, 0)}`).toBe(1);
  const n2 = samples.map((s) => s.turns[1].n);
  expect(Math.max(...n2), `K14:第 2 轮片段数不应超过 5;各次读数 = ${series(samples, 1)}`).toBeLessThanOrEqual(5);
  const end = samples[samples.length - 1];
  expect(end.turns[1].n, 'K14:期末第 2 轮片段数').toBe(5);
  const next = end.text.split('下一轮。').length - 1;
  expect(next, 'K14:「下一轮。」在整个消息区出现的次数').toBe(1);
});

// ───────────────────────── K15 ─────────────────────────
test('K15 【复现】强杀形停止后 3 秒切走、1.5 秒后切回:5 秒后这一轮片段数不少于停止前读数、思考 1 个、气泡 1 个', async ({ page }) => {
  const ctx = prepare();
  await openJia(page, ctx);
  const prompts = [promptOf('K15', 'a')];
  await turn(page, { ...KILLED }, prompts[0]);
  const pre = (await waitFragments(page, prompts, 0, 40, 'K15')).turns[0].n;
  await stopBtn(page).click();
  await page.waitForTimeout(3000);
  await clickSession(page, 'yi', ctx);
  await page.waitForTimeout(1500);
  await clickSession(page, 'jia', ctx);
  await page.waitForTimeout(5000);
  const v = await readView(page, prompts);
  expect(v.turns[0].n, `K15:切回 5 秒后这一轮片段数不应少于停止前读数 ${pre}(用户消息${v.turns[0].present ? '在' : '不在'}页面上)`).toBeGreaterThanOrEqual(pre);
  expect(v.turns[0].think, 'K15:切回 5 秒后这一轮思考个数').toBe(1);
  expect(v.turns[0].bubbles, 'K15:切回 5 秒后这一轮气泡数').toBe(1);
});

// ───────────────────────── K19 ─────────────────────────
test('K19 【复现】半写形、输出 30 片段后永久静默被后端结束:出现「⏸」提示且停止键消失后 6 秒内,片段数恒为 30、提示一直在', async ({ page }) => {
  await setStallTimeout('5m'); // 准备步骤:启用静默超时(后端带 CGUI_STALL_MS=4000,即 4 秒)
  const ctx = prepare();
  await openJia(page, ctx);
  const prompts = [promptOf('K19', 'a')];
  await turn(page, { ...HALF, stallAfterChunks: 30 }, prompts[0]);
  const r = await waitView(page, prompts, (v) => v.notice && !v.stop, 60_000);
  expect(r.ok, `K19:60 秒内应出现「⏸」提示且停止键消失;最后一次读到片段 ${r.v.turns[0].n} 个(提示${r.v.notice ? '在' : '不在'},停止键${r.v.stop ? '在' : '不在'});消息区尾部 = ${JSON.stringify(r.v.text.slice(-200))}`).toBe(true);
  const samples = await observe(page, prompts, 6000);
  expect(samples.every((s) => s.turns[0].n === 30), `K19:每次读数这一轮片段数都应等于 30;各次读数 = ${series(samples, 0)}`).toBe(true);
  expect(samples.every((s) => s.notice), `K19:每次读数「⏸」提示都应在;各次读数 = ${series(samples, 0, (s) => (s.notice ? '有' : '无'))}`).toBe(true);
});

// ───────────────────────── B2 ─────────────────────────
test('B2 【复现】强杀形回合进行中「仅回退消息」:新一轮进行期间整个消息区片段数不超过 5,期末这条提示词恰好 1 次、片段 5、每个编号恰好 1 次、「重发轮。」恰好 1 次,切走再切回后仍如此', async ({ page }) => {
  test.setTimeout(150_000);
  const ctx = prepare();
  await openJia(page, ctx);
  const prompt = promptOf('B2', 'a');
  const prompts = [prompt];
  await turn(page, { ...KILLED }, prompt);
  await waitFragments(page, prompts, 0, 40, 'B2');
  // 新一轮的场景要在点「仅回退消息」之前写好(点下去页面立刻把原文重新发出)。
  writeScenario({ ...RELAUNCH_SCENARIO });
  const t0 = Date.now();
  await pickRollbackItem(page, prompt, /仅回退消息/, 'B2');
  const { appearMs, samples, doneAt } = await observeRelaunch(page, prompts, t0);
  expect(appearMs, `B2:「重发轮。」应在点「仅回退消息」后 40 秒内出现;最后一次读到整个消息区片段数 ${samples[samples.length - 1].total}`).not.toBeNull();
  expect(doneAt, `B2:新一轮应在 60 秒内结束;各次读数(整个消息区片段数) = ${series(samples, 0, (s) => s.total)}`).not.toBeNull();
  const totalSeries = series(samples, 0, (s) => s.total);
  expect(Math.max(...samples.map((s) => s.total)), `B2:观察窗口内每次读数整个消息区的片段数都不应超过 5;各次读数 = ${totalSeries}`).toBeLessThanOrEqual(5);
  const end = samples[samples.length - 1];
  expect(countOf(end.text, prompt), 'B2:期末这条提示词在消息区出现的次数').toBe(1);
  expectFiveFragments(end, 'B2 期末');
  const back = await switchAwayAndBack(page, ctx, prompts);
  expect(countOf(back.text, prompt), 'B2:切走再切回后这条提示词出现的次数').toBe(1);
  expect(back.total, 'B2:切走再切回后整个消息区片段总数').toBe(5);
});

// ───────────────────────── B3 ─────────────────────────
test('B3 【复现】打断形点停止、停止键消失后立刻「仅回退消息」:期末这条提示词恰好 1 次、片段 5、每个编号恰好 1 次、「重发轮。」恰好 1 次,切走再切回后仍如此', async ({ page }) => {
  test.setTimeout(150_000);
  const ctx = prepare();
  await openJia(page, ctx);
  const prompt = promptOf('B3', 'a');
  const prompts = [prompt];
  await turn(page, {}, prompt);
  await waitFragments(page, prompts, 0, 40, 'B3');
  await stopBtn(page).click();
  const tStop = Date.now();
  const gone = await waitView(page, prompts, (v) => !v.stop, 10_000, 100);
  expect(gone.ok, 'B3:点停止后停止键应在 10 秒内消失').toBe(true);
  writeScenario({ ...RELAUNCH_SCENARIO });
  const t0 = Date.now();
  await pickRollbackItem(page, prompt, /仅回退消息/, 'B3');
  const clickedAfter = Date.now() - tStop;
  expect(clickedAfter, `B3:从点下停止到点下「仅回退消息」应不超过 3000 毫秒(前提),实际 ${clickedAfter} 毫秒`).toBeLessThanOrEqual(3000);
  const { appearMs, samples, doneAt } = await observeRelaunch(page, prompts, t0);
  expect(appearMs, `B3:「重发轮。」应在点「仅回退消息」后 40 秒内出现;最后一次读到整个消息区片段数 ${samples[samples.length - 1].total}`).not.toBeNull();
  expect(doneAt, `B3:新一轮应在 60 秒内结束;各次读数(整个消息区片段数) = ${series(samples, 0, (s) => s.total)}`).not.toBeNull();
  const end = samples[samples.length - 1];
  expect(countOf(end.text, prompt), `B3:期末这条提示词在消息区出现的次数;各次读数(整个消息区片段数) = ${series(samples, 0, (s) => s.total)}`).toBe(1);
  expectFiveFragments(end, 'B3 期末');
  const back = await switchAwayAndBack(page, ctx, prompts);
  expect(countOf(back.text, prompt), 'B3:切走再切回后这条提示词出现的次数').toBe(1);
  expect(back.total, 'B3:切走再切回后整个消息区片段总数').toBe(5);
});

// ───────────────────────── B4 ─────────────────────────
test('B4 【复现】第 1 轮强杀形被停止、后面第 2 轮自然结束,再对第 2 条「编辑后重发」换成第 3 条:第 1 轮内容一直不少于停止时片段数且稳定,期末第 2 条与「第二轮。」都不在、第 3 条恰好 1 次、「重发轮。」恰好 1 次', async ({ page }) => {
  test.setTimeout(180_000);
  const ctx = prepare();
  await openJia(page, ctx);
  const prompts = [promptOf('B4', 'a'), promptOf('B4', 'b'), promptOf('B4', 'c')];
  await turn(page, { ...KILLED }, prompts[0]);
  const pre = (await waitFragments(page, prompts, 0, 40, 'B4')).turns[0].n;
  await stopBtn(page).click();
  const tStop = Date.now();
  const sampler = startSampler(page, prompts, tStop);
  try {
    await page.waitForTimeout(3000);
    await turn(page, { chunkCount: 5, textPrefix: '第二轮。' }, prompts[1]);
    const done2 = await waitView(page, prompts, (v) => v.turns[1].n === 5 && !v.stop, 40_000);
    expect(done2.ok, `B4:第 2 轮应自然结束(片段数 5、停止键消失);最后一次读到 ${done2.v.turns[1].n} 个(停止键${done2.v.stop ? '在' : '不在'})`).toBe(true);
    writeScenario({ ...RELAUNCH_SCENARIO });
    await editAndResendFill(page, prompts[1], 'B4');
    await sendMessage(page, prompts[2]);
    // 观察窗口(同口径):从「重发轮。」第一次出现,到新一轮结束后 6 秒;采样器一直在读。
    const deadline = Date.now() + 100_000;
    let doneAt = null;
    for (;;) {
      const all = sampler.samples;
      const iAppear = all.findIndex((s) => s.text.includes('重发轮。'));
      if (iAppear >= 0) {
        let seenStop = false;
        for (let i = iAppear; i < all.length; i += 1) {
          if (all[i].stop) seenStop = true;
          if (doneAt == null && seenStop && !all[i].stop) doneAt = all[i].t;
        }
        if (doneAt != null && all.length && all[all.length - 1].t - doneAt >= 6000) break;
      }
      if (Date.now() > deadline) break;
      await page.waitForTimeout(250);
    }
    expect(doneAt, 'B4:「重发轮。」应出现且新一轮应在 100 秒内结束(停止键出现后又消失)').not.toBeNull();
  } finally {
    await sampler.stop();
  }
  const samples = sampler.samples;
  const ns = samples.map((s) => s.turns[0].n);
  expect(Math.min(...ns), `B4:从点停止起第 1 轮片段数每次读数都不应少于停止前读数 ${pre};各次读数 = ${series(samples, 0)}`).toBeGreaterThanOrEqual(pre);
  const later = samples.filter((s) => s.dt >= 500).map((s) => s.turns[0].n);
  expect(later.length, 'B4:应有 0.5 秒之后的读数').toBeGreaterThan(0);
  expect(new Set(later).size, `B4:从 0.5 秒起第 1 轮片段数各次读数应彼此相等;各次读数 = ${series(samples, 0)}`).toBe(1);
  const end = samples[samples.length - 1];
  expect(countOf(end.text, prompts[1]), 'B4:期末第 2 条提示词在消息区出现的次数').toBe(0);
  expect(countOf(end.text, '第二轮。'), 'B4:期末「第二轮。」在消息区出现的次数').toBe(0);
  expect(countOf(end.text, prompts[2]), 'B4:期末第 3 条提示词在消息区出现的次数').toBe(1);
  expect(countOf(end.text, '重发轮。'), 'B4:期末「重发轮。」在消息区出现的次数').toBe(1);
});

// ───────────────────────── B5 ─────────────────────────
test('B5 【守卫】回合已自然结束后「编辑后重发」并发出新内容:不多等(8 秒内出现「重发轮。」),期末第 1 条提示词 0 次、第 2 条恰好 1 次、片段 5、每个编号恰好 1 次', async ({ page }) => {
  test.setTimeout(150_000);
  const ctx = prepare();
  await openJia(page, ctx);
  const prompts = [promptOf('B5', 'a'), promptOf('B5', 'b')];
  await turn(page, { chunkCount: 5 }, prompts[0]);
  const done = await waitView(page, prompts, (v) => v.turns[0].n === 5 && !v.stop, 40_000);
  expect(done.ok, `B5:第 1 轮应自然结束(片段数 5、停止键消失);最后一次读到 ${done.v.turns[0].n} 个(停止键${done.v.stop ? '在' : '不在'})`).toBe(true);
  await editAndResendFill(page, prompts[0], 'B5');
  writeScenario({ ...RELAUNCH_SCENARIO });
  const t0 = Date.now();
  await sendMessage(page, prompts[1]);
  const { appearMs, samples, doneAt } = await observeRelaunch(page, prompts, t0);
  expect(appearMs, `B5:「重发轮。」应在发送后 40 秒内出现;最后一次读到整个消息区片段数 ${samples[samples.length - 1].total}`).not.toBeNull();
  expect(appearMs, 'B5:从点发送到「重发轮。」出现的毫秒数应不超过 8000').toBeLessThanOrEqual(8000);
  expect(doneAt, `B5:新一轮应在 60 秒内结束;各次读数(整个消息区片段数) = ${series(samples, 0, (s) => s.total)}`).not.toBeNull();
  const end = samples[samples.length - 1];
  expect(countOf(end.text, prompts[0]), 'B5:期末第 1 条提示词在消息区出现的次数').toBe(0);
  expect(countOf(end.text, prompts[1]), 'B5:期末第 2 条提示词在消息区出现的次数').toBe(1);
  expectFiveFragments(end, 'B5 期末', { withRelaunch: false });
});
