// r178-error-vanish 黑盒验收:回合以「命令行不存盘的报错」或「什么都没回」结束时,页面上的报错块 / 提示不再自己消失,
// 且报错原文之后多一段中文说明;下一条消息发出后上一轮的报错撤掉;正常回复不受影响。
// 只依据接口文件的行为清单 S1–S9;只通过页面观测(消息区文字 / 停止键 / 输入框);假命令行见 helpers/fake-claude.mjs。
// 「出现」靠页面内高频观察器(每 25 毫秒 + 每次 DOM 变动采样一次,见 helpers/runtime.mjs 的 startMonitor),
// 「连续 N 秒一直在」= 观察器在这 N 秒里的每一次采样都有该子串(采样间隔 ≤ 500 毫秒才算数)。
import { test, expect } from '@playwright/test';
import { seedWorkspace, writeScenario, resetStatus } from './helpers/fixtures.mjs';
import {
  reloadApp, openWorkspaceGroup, clickSession, openNewSession, sendText, stopBtn,
  readList, countOf, startMonitor, waitFirstSeen, checkPresentFor, waitAfter, waitProcessed, waitStopGone, uniqueTag,
} from './helpers/runtime.mjs';

const EDE = 'ede_diagnostic';
const EMPTY_NOTE = '上游返回了内容为空的回复';
const UNKNOWN_NOTE = '无法识别的内容类型(reasoning)';
const EMPTY_SUCCESS_NOTE = '没有返回任何内容';

/** 每个用例现建一个全新工作区(带本用例独有标记的种子会话)+ 写场景(形态列表)+ 清状态文件。 */
function prepare(shapes) {
  const ctx = seedWorkspace(uniqueTag('t'));
  writeScenario({ shapes });
  resetStatus(ctx.workspaceName);
  return ctx;
}

/** 本用例独有的消息标记:R178-M1-<随机串>。 */
const marker = (name) => `R178-${name}-${uniqueTag()}`;
const tail = (text) => JSON.stringify(text.length > 500 ? `…${text.slice(-500)}` : text);

/** 第 n 条的回合已结束(夹具已输出回合结束事件)且停止键不在。 */
async function waitTurnDone(page, ctx, n, what) {
  const processed = await waitProcessed(page, ctx, n, 20_000);
  expect(processed, `${what}:第 ${n} 条的回合应在 20 秒内结束(夹具状态文件 processed ≥ ${n});实际 ${processed}`).toBeGreaterThanOrEqual(n);
  expect(await waitStopGone(page, 15_000), `${what}:第 ${n} 条回合结束后停止键应消失`).toBe(true);
}

/** 新建会话 → 装观察器 → 发 M1。返回 { ctx, m1 }。 */
async function startSession(page, shapes, needles) {
  const ctx = prepare(shapes);
  await openNewSession(page, ctx);
  await startMonitor(page, needles);
  const m1 = marker('M1');
  await sendText(page, `${m1} 你好`);
  return { ctx, m1 };
}

// ───────────────────────── S1 ─────────────────────────
test('S1 空内容报错:报错块(ede_diagnostic)出现后连续 10 秒一直在,10 秒后 M1 恰好 1 次、停止键不在', async ({ page }) => {
  const { m1 } = await startSession(page, ['empty-error'], [EDE]);
  const t0 = await waitFirstSeen(page, EDE, 15_000);
  expect(t0, `S1:发出 M1 后 15 秒内消息区应出现 ${EDE}(等不到 = 报错块根本没留下)`).not.toBeNull();
  const held = await checkPresentFor(page, EDE, t0, 10_000);
  expect(held.ok, `S1:${EDE} 出现后应连续 10 秒一直在;实际 ${JSON.stringify(held)}(firstMissingAtMs = 出现后第几毫秒起不在了)`).toBe(true);
  const text = await readList(page);
  expect(countOf(text, m1), `S1:10 秒后 M1 标记应恰好出现 1 次;消息区尾部 = ${tail(text)}`).toBe(1);
  expect(await stopBtn(page).count(), 'S1:10 秒后停止键应不在').toBe(0);
});

// ───────────────────────── S2 ─────────────────────────
test('S2 空内容报错:出现「上游返回了内容为空的回复」,5 秒后仍在,原文 last_content_type=none 保留且 ede_diagnostic 恰好 1 次', async ({ page }) => {
  await startSession(page, ['empty-error'], [EMPTY_NOTE]);
  const t0 = await waitFirstSeen(page, EMPTY_NOTE, 15_000);
  expect(t0, `S2:发出 M1 后 15 秒内消息区应出现「${EMPTY_NOTE}」`).not.toBeNull();
  await waitAfter(page, t0, 5_000);
  const text = await readList(page);
  expect(text, `S2:出现后 5 秒时「${EMPTY_NOTE}」应仍在;消息区尾部 = ${tail(text)}`).toContain(EMPTY_NOTE);
  expect(text, `S2:报错原文应保留 last_content_type=none;消息区尾部 = ${tail(text)}`).toContain('last_content_type=none');
  expect(countOf(text, EDE), `S2:${EDE} 应恰好出现 1 次;消息区尾部 = ${tail(text)}`).toBe(1);
});

// ───────────────────────── S3 ─────────────────────────
test('S3 不认识的内容类型:出现「无法识别的内容类型(reasoning)」,5 秒后仍在,原文 last_content_type=reasoning 保留,不含「内容为空」说明', async ({ page }) => {
  await startSession(page, ['unknown-type'], [UNKNOWN_NOTE]);
  const t0 = await waitFirstSeen(page, UNKNOWN_NOTE, 15_000);
  expect(t0, `S3:发出 M1 后 15 秒内消息区应出现「${UNKNOWN_NOTE}」`).not.toBeNull();
  await waitAfter(page, t0, 5_000);
  const text = await readList(page);
  expect(text, `S3:出现后 5 秒时「${UNKNOWN_NOTE}」应仍在;消息区尾部 = ${tail(text)}`).toContain(UNKNOWN_NOTE);
  expect(text, `S3:报错原文应保留 last_content_type=reasoning;消息区尾部 = ${tail(text)}`).toContain('last_content_type=reasoning');
  expect(text, `S3:不该出现「${EMPTY_NOTE}」(那是 none 才有的说明);消息区尾部 = ${tail(text)}`).not.toContain(EMPTY_NOTE);
});

// ───────────────────────── S4 ─────────────────────────
test('S4 规范的空回复:提示「没有返回任何内容」出现后连续 10 秒一直在,10 秒后 M1 恰好 1 次、停止键不在', async ({ page }) => {
  const { m1 } = await startSession(page, ['empty-success'], [EMPTY_SUCCESS_NOTE]);
  const t0 = await waitFirstSeen(page, EMPTY_SUCCESS_NOTE, 15_000);
  expect(t0, `S4:发出 M1 后 15 秒内消息区应出现「${EMPTY_SUCCESS_NOTE}」(等不到 = 提示根本没留下)`).not.toBeNull();
  const held = await checkPresentFor(page, EMPTY_SUCCESS_NOTE, t0, 10_000);
  expect(held.ok, `S4:「${EMPTY_SUCCESS_NOTE}」出现后应连续 10 秒一直在;实际 ${JSON.stringify(held)}`).toBe(true);
  const text = await readList(page);
  expect(countOf(text, m1), `S4:10 秒后 M1 标记应恰好出现 1 次;消息区尾部 = ${tail(text)}`).toBe(1);
  expect(await stopBtn(page).count(), 'S4:10 秒后停止键应不在').toBe(0);
});

// ───────────────────────── S5 ─────────────────────────
test('S5 先有正文再报错:停止键消失 5 秒后与再过 5 秒,R178PARTIAL 与 ede_diagnostic 各恰好 1 次且正文在报错之前', async ({ page }) => {
  const { ctx } = await startSession(page, ['partial-then-error'], [EDE]);
  await waitTurnDone(page, ctx, 1, 'S5');
  const check = async (phase) => {
    const text = await readList(page);
    const iPartial = text.indexOf('R178PARTIAL');
    const iEde = text.indexOf(EDE);
    expect(countOf(text, 'R178PARTIAL'), `S5(${phase}):R178PARTIAL 应恰好出现 1 次;消息区尾部 = ${tail(text)}`).toBe(1);
    expect(countOf(text, EDE), `S5(${phase}):${EDE} 应恰好出现 1 次(0 = 报错块没留下);消息区尾部 = ${tail(text)}`).toBe(1);
    expect(iPartial, `S5(${phase}):R178PARTIAL(位置 ${iPartial})应在 ${EDE}(位置 ${iEde})之前`).toBeLessThan(iEde);
  };
  await page.waitForTimeout(5_000);
  await check('停止键消失 5 秒后');
  await page.waitForTimeout(5_000);
  await check('再过 5 秒');
});

// ───────────────────────── S6 ─────────────────────────
test('S6 先空内容报错、再正常回复:发 M2 后上一轮报错撤掉,只剩 M1、M2、R178OK 各 1 次且顺序正确', async ({ page }) => {
  const { ctx, m1 } = await startSession(page, ['empty-error', 'normal'], [EDE, 'R178OK']);
  await waitTurnDone(page, ctx, 1, 'S6');
  await page.waitForTimeout(1_000);
  const m2 = marker('M2');
  await sendText(page, `${m2} 再来一条`);
  expect(await waitFirstSeen(page, 'R178OK', 15_000), 'S6:发出 M2 后 15 秒内消息区应出现 R178OK').not.toBeNull();
  await waitTurnDone(page, ctx, 2, 'S6');
  await page.waitForTimeout(3_000);
  const text = await readList(page);
  const [i1, i2, iOk] = [text.indexOf(m1), text.indexOf(m2), text.indexOf('R178OK')];
  expect(countOf(text, EDE), `S6:发出 M2 并正常回复后,上一轮的报错应已撤掉(不含 ${EDE});消息区尾部 = ${tail(text)}`).toBe(0);
  expect(countOf(text, 'R178OK'), `S6:R178OK 应恰好 1 次;消息区尾部 = ${tail(text)}`).toBe(1);
  expect(countOf(text, m1), `S6:M1 标记应恰好 1 次;消息区尾部 = ${tail(text)}`).toBe(1);
  expect(countOf(text, m2), `S6:M2 标记应恰好 1 次;消息区尾部 = ${tail(text)}`).toBe(1);
  expect(i1 < i2 && i2 < iOk, `S6:位置顺序应是 M1(${i1}) < M2(${i2}) < R178OK(${iOk})`).toBe(true);
});

// ───────────────────────── S7 ─────────────────────────
test('S7 连续两次空内容报错:第二条后上一轮报错撤掉,ede_diagnostic 只剩 1 次且在 M2 之后,M1、M2 各 1 次', async ({ page }) => {
  const { ctx, m1 } = await startSession(page, ['empty-error', 'empty-error'], [EDE]);
  await waitTurnDone(page, ctx, 1, 'S7');
  await page.waitForTimeout(1_000);
  const m2 = marker('M2');
  await sendText(page, `${m2} 再来一条`);
  await waitTurnDone(page, ctx, 2, 'S7');
  await page.waitForTimeout(5_000);
  const text = await readList(page);
  const [i1, i2, iEde] = [text.indexOf(m1), text.indexOf(m2), text.indexOf(EDE)];
  expect(countOf(text, EDE), `S7:${EDE} 应恰好出现 1 次(只剩第二轮的报错);消息区尾部 = ${tail(text)}`).toBe(1);
  expect(iEde, `S7:${EDE}(位置 ${iEde})应在 M2 标记(位置 ${i2})之后`).toBeGreaterThan(i2);
  expect(countOf(text, m1), `S7:M1 标记应恰好 1 次;消息区尾部 = ${tail(text)}`).toBe(1);
  expect(countOf(text, m2), `S7:M2 标记应恰好 1 次;消息区尾部 = ${tail(text)}`).toBe(1);
  expect(i1, `S7:M1(位置 ${i1})应在 M2(位置 ${i2})之前`).toBeLessThan(i2);
});

// ───────────────────────── S8 ─────────────────────────
test('S8 正常回复:5 秒后 R178OK 与 M1 各恰好 1 次,不出现 ede_diagnostic 与「没有返回任何内容」', async ({ page }) => {
  const { m1 } = await startSession(page, ['normal'], ['R178OK']);
  expect(await waitFirstSeen(page, 'R178OK', 15_000), 'S8:发出 M1 后 15 秒内消息区应出现 R178OK').not.toBeNull();
  expect(await waitStopGone(page, 15_000), 'S8:正常回复结束后停止键应消失').toBe(true);
  await page.waitForTimeout(5_000);
  const text = await readList(page);
  expect(countOf(text, 'R178OK'), `S8:R178OK 应恰好 1 次;消息区尾部 = ${tail(text)}`).toBe(1);
  expect(countOf(text, m1), `S8:M1 标记应恰好 1 次;消息区尾部 = ${tail(text)}`).toBe(1);
  expect(text, `S8:正常回复不该出现 ${EDE};消息区尾部 = ${tail(text)}`).not.toContain(EDE);
  expect(text, `S8:正常回复不该出现「${EMPTY_SUCCESS_NOTE}」;消息区尾部 = ${tail(text)}`).not.toContain(EMPTY_SUCCESS_NOTE);
});

// ───────────────────────── S9 ─────────────────────────
test('S9 空内容报错后刷新页面并从侧栏点回会话:3 秒后 M1 标记恰好 1 次', async ({ page }) => {
  const { ctx, m1 } = await startSession(page, ['empty-error'], [EDE]);
  await waitTurnDone(page, ctx, 1, 'S9');
  await page.waitForTimeout(2_000);
  await reloadApp(page);
  await openWorkspaceGroup(page, ctx);
  await clickSession(page, 'fresh', ctx);
  await page.waitForTimeout(3_000);
  const text = await readList(page);
  expect(countOf(text, m1), `S9:刷新并点回会话 3 秒后 M1 标记应恰好 1 次;消息区尾部 = ${tail(text)}`).toBe(1);
});
