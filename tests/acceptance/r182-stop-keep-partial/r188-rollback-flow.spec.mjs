// r188-rollback-flow 黑盒验收:回合还在进行(或刚被停止)时,对一条用户消息做「编辑后重发」「仅回退消息」,
// 页面先把这一轮停下、等它停稳,再回退会话记录并发出;被回退的旧消息不再留在页面上(切走再切回也没有),
// 更早一轮被停止而留在屏幕上的内容不受影响;没有回合在进行时不多等。
// 只依据接口文件的行为清单(B2 B3 B4 B5,一条对一条;K6 在 r182-stop-keep-partial.spec.mjs 里原地修订);只通过页面观测;假命令行见 helpers/fake-claude.mjs。
// 标【复现】的用例在改动之前应当因断言不成立而失败;标【守卫】的应当通过。
import { test as base, expect } from '@playwright/test';
import { seedPair, writeScenario, resetStatus, readStatus, requestAbort } from './helpers/fixtures.mjs';
import { openJia, sendMessage, stopBtn, waitView, series, uniqueTag } from './helpers/runtime.mjs';
import {
  RELAUNCH_SCENARIO, countOf, pickRollbackItem, editAndResendFill, observeRelaunch, startSampler, switchAwayAndBack, expectFiveFragments,
} from './helpers/rollback.mjs';

const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
    await use(page);
    expect(errors, '页面出现未捕获错误(pageerror)').toEqual([]);
  },
});

const KILLED = { persistThinking: false, persistPartialOnInterrupt: false, persistFinal: false }; // 强杀形

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

const promptOf = (k, round) => `R188-${k}-${round}-${uniqueTag()}`;
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
