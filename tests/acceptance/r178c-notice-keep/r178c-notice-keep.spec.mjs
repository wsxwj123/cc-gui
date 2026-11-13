// r178c-notice-keep 黑盒验收:上游长时间没有输出、应用自动结束本回合时给出的说明(「上游超过 N 分钟无后续输出,已结束本回合……」)
// 不再在回合收尾后自己消失,留到用户发下一条消息 / 切会话 / 刷新为止;只提示版(不结束回合)不变;压缩完成提示同样保留。
// 只依据接口文件的行为清单 T1–T4;只通过页面观测(消息区文字 / 停止键 / 输入框);假命令行见 helpers/fake-claude.mjs;
// 后端带 CGUI_STALL_MS=2000(静默超时 2 秒),设置接口 PUT /api/prefs/stall-timeout 只在准备步骤里调用。
// 「出现」靠页面内高频观察器(每 25 毫秒 + 每次 DOM 变动采样一次,见 helpers/runtime.mjs 的 startMonitor),
// 「连续 N 秒一直在」= 观察器在这 N 秒里的每一次采样都有该子串(采样间隔 ≤ 500 毫秒才算数)。
import { test, expect } from '@playwright/test';
import { seedWorkspace, writeScenario, resetStatus } from './helpers/fixtures.mjs';
import {
  setStallTimeout, openNewSession, sendText, sendTextByButton, stopBtn,
  readList, countOf, startMonitor, waitFirstSeen, snapshotOf, pageNow, checkPresentFor, waitAfter, waitStopGone, uniqueTag,
} from './helpers/runtime.mjs';

const NOTICE = '无后续输出';
const ENDED = '已结束本回合';
const ONLY_HINT = '不自动结束本回合';
const COMPACTED = '上下文已压缩，可继续对话';
const MAIN_MARK = 'R178CMAIN';
const OK_MARK = 'R178OK';

/** 每个用例现建一个全新工作区(带本用例独有标记的种子会话)+ 写场景(形态列表)+ 清状态文件。 */
function prepare(shapes) {
  const ctx = seedWorkspace(uniqueTag('t'));
  writeScenario({ shapes });
  resetStatus(ctx.workspaceName);
  return ctx;
}

/** 本用例独有的消息标记:R178C-M1-<随机串>。 */
const marker = (name) => `R178C-${name}-${uniqueTag()}`;
const tail = (text) => JSON.stringify(text.length > 600 ? `…${text.slice(-600)}` : text);

/** 先显式设静默超时(不依赖别的用例留下的状态)→ 新建会话 → 装观察器 → 发 M1。返回 { ctx, m1 }。 */
async function startSession(page, { stall, shapes, needles }) {
  await setStallTimeout(stall);
  const ctx = prepare(shapes);
  await openNewSession(page, ctx);
  await startMonitor(page, needles);
  const m1 = marker('M1');
  await sendText(page, `${m1} 你好`);
  return { ctx, m1 };
}

// ───────────────────────── T1 ─────────────────────────
test('T1 静默超时结束本回合:提示(无后续输出+已结束本回合)出现、停止键消失后连续 10 秒一直在,R178CMAIN 与 M1 各恰好 1 次', async ({ page }) => {
  const { m1 } = await startSession(page, { stall: '5m', shapes: ['subagent-silent'], needles: [NOTICE] });
  const t0 = await waitFirstSeen(page, NOTICE, 20_000);
  expect(t0, `T1:发出 M1 后 20 秒内消息区应出现「${NOTICE}」`).not.toBeNull();
  const snap = await snapshotOf(page, NOTICE);
  expect(snap, `T1:提示出现时应同时含「${ENDED}」;那一刻的消息区尾部 = ${tail(snap)}`).toContain(ENDED);
  expect(await waitStopGone(page, 15_000), 'T1:提示出现后停止键应在 15 秒内消失(回合被结束)').toBe(true);
  const tGone = await pageNow(page);
  const held = await checkPresentFor(page, NOTICE, tGone, 10_000);
  expect(held.ok, `T1:停止键消失后「${NOTICE}」应连续 10 秒一直在;实际 ${JSON.stringify(held)}(firstMissingAtMs = 停止键消失后第几毫秒起提示不在了)`).toBe(true);
  const text = await readList(page);
  expect(countOf(text, MAIN_MARK), `T1:10 秒后 ${MAIN_MARK} 应恰好 1 次;消息区尾部 = ${tail(text)}`).toBe(1);
  expect(countOf(text, m1), `T1:10 秒后 M1 标记应恰好 1 次;消息区尾部 = ${tail(text)}`).toBe(1);
});

// ───────────────────────── T2 ─────────────────────────
test('T2 提示出现后再发一条消息:提示撤掉,R178OK、M1、M2 各恰好 1 次,顺序 M1 < R178CMAIN < M2 < R178OK', async ({ page }) => {
  const { m1 } = await startSession(page, { stall: '5m', shapes: ['subagent-silent', 'normal'], needles: [NOTICE, OK_MARK] });
  expect(await waitFirstSeen(page, NOTICE, 20_000), `T2:发出 M1 后 20 秒内消息区应出现「${NOTICE}」`).not.toBeNull();
  expect(await waitStopGone(page, 15_000), 'T2:M1 的回合被结束后停止键应消失').toBe(true);
  await page.waitForTimeout(2_000);
  const m2 = marker('M2');
  await sendText(page, `${m2} 再来一条`);
  expect(await waitFirstSeen(page, OK_MARK, 20_000), `T2:发出 M2 后 20 秒内消息区应出现 ${OK_MARK}`).not.toBeNull();
  expect(await waitStopGone(page, 15_000), 'T2:M2 正常回复后停止键应消失').toBe(true);
  await page.waitForTimeout(3_000);
  const text = await readList(page);
  const [i1, iMain, i2, iOk] = [text.indexOf(m1), text.indexOf(MAIN_MARK), text.indexOf(m2), text.indexOf(OK_MARK)];
  expect(text, `T2:发出 M2 并正常回复后上一轮的提示应已撤掉(不含「${NOTICE}」);消息区尾部 = ${tail(text)}`).not.toContain(NOTICE);
  expect(countOf(text, OK_MARK), `T2:${OK_MARK} 应恰好 1 次;消息区尾部 = ${tail(text)}`).toBe(1);
  expect(countOf(text, m1), `T2:M1 标记应恰好 1 次;消息区尾部 = ${tail(text)}`).toBe(1);
  expect(countOf(text, m2), `T2:M2 标记应恰好 1 次;消息区尾部 = ${tail(text)}`).toBe(1);
  expect(i1 >= 0 && i1 < iMain && iMain < i2 && i2 < iOk,
    `T2:位置顺序应是 M1(${i1}) < ${MAIN_MARK}(${iMain}) < M2(${i2}) < ${OK_MARK}(${iOk})`).toBe(true);
});

// ───────────────────────── T3 ─────────────────────────
test('T3 只提示不结束:提示(不自动结束本回合)出现后 4 秒停止键仍在;点停止后提示不保留,R178CMAIN 恰好 1 次', async ({ page }) => {
  try {
    await startSession(page, { stall: 'never', shapes: ['subagent-silent'], needles: [NOTICE] });
    const t0 = await waitFirstSeen(page, NOTICE, 20_000);
    expect(t0, `T3:发出 M1 后 20 秒内消息区应出现「${NOTICE}」`).not.toBeNull();
    const snap = await snapshotOf(page, NOTICE);
    expect(snap, `T3:提示出现时应含「${ONLY_HINT}」;那一刻的消息区尾部 = ${tail(snap)}`).toContain(ONLY_HINT);
    expect(snap, `T3:提示出现时不该含「${ENDED}」(只提示版不结束回合);那一刻的消息区尾部 = ${tail(snap)}`).not.toContain(ENDED);
    await waitAfter(page, t0, 4_000);
    expect(await stopBtn(page).count(), 'T3:提示出现 4 秒后停止键应仍在(回合没被结束)').toBeGreaterThan(0);
    await stopBtn(page).first().click();
    expect(await waitStopGone(page, 15_000), 'T3:点停止后停止键应在 15 秒内消失').toBe(true);
    await page.waitForTimeout(5_000);
    const text = await readList(page);
    expect(text, `T3:停止键消失 5 秒后消息区不该再含「${NOTICE}」(只提示版回合结束后不保留);消息区尾部 = ${tail(text)}`).not.toContain(NOTICE);
    expect(countOf(text, MAIN_MARK), `T3:${MAIN_MARK} 应恰好 1 次;消息区尾部 = ${tail(text)}`).toBe(1);
  } finally {
    await setStallTimeout('5m');
  }
});

// ───────────────────────── T4 ─────────────────────────
test('T4 压缩完成提示:发 /compact 后出现「上下文已压缩,可继续对话」,停止键消失后连续 10 秒一直在', async ({ page }) => {
  await startSession(page, { stall: '5m', shapes: ['normal', 'compact'], needles: [OK_MARK, COMPACTED] });
  expect(await waitFirstSeen(page, OK_MARK, 20_000), `T4:发出 M1 后 20 秒内消息区应出现 ${OK_MARK}`).not.toBeNull();
  expect(await waitStopGone(page, 15_000), 'T4:M1 正常回复后停止键应消失').toBe(true);
  await page.waitForTimeout(2_000);
  await sendTextByButton(page, '/compact');
  const t0 = await waitFirstSeen(page, COMPACTED, 20_000);
  const before = await readList(page);
  expect(t0, `T4:发出 /compact 后 20 秒内消息区应出现「${COMPACTED}」;消息区尾部 = ${tail(before)}`).not.toBeNull();
  expect(await waitStopGone(page, 15_000), 'T4:压缩回合结束后停止键应消失').toBe(true);
  const tGone = await pageNow(page);
  const held = await checkPresentFor(page, COMPACTED, tGone, 10_000);
  expect(held.ok, `T4:停止键消失后「${COMPACTED}」应连续 10 秒一直在;实际 ${JSON.stringify(held)}(firstMissingAtMs = 停止键消失后第几毫秒起提示不在了)`).toBe(true);
});
