// r197 "命令行初始化超时 + 排队消息" 验收(黑盒)。唯一依据:接口文件的行为清单 G1–G8 与错误契约。
// 只由 run.sh 调起:tests/acceptance/r197-start-timeout-queue/run.sh [-g 'G1']
// 只通过页面(输入框/排队栏/停止键/可见文字)、页面发出的 POST /api/chat 及其应答、会话文件、假命令行控制文件观察。
//
// 约定:T1 = 会话里发的第一条;T2 = 回复进行中再发、进排队栏的那一条;"超时那句话" = PHRASE。
// 每个用例用一条独立的夹具会话(回合跑完后应用会给会话改标题,不能复用)。
import { test, expect } from '@playwright/test';
import { POOL, live, countTranscriptLines } from './helpers/fixtures.mjs';
import {
  PHRASE, START_FAILED, autoRun, boot, clearHold, dieOnStart, holdOnce, installPhraseRecorder, openSessionBySearch, phraseCount,
  pidAlive, probe, queueItem, readPhraseRecorder, releaseAllRuns, releaseChunk2, releaseSession, releaseTurnEnd, resetTurnFiles,
  runPid, sendPrompt, stopButton, trackChat, until, waitBodyText, waitForPhase, waitStopGone,
} from './helpers/ui.mjs';

const CTL = process.env.R197_CTL;
const S = (n) => POOL[n];   // G1→0 … G8→7(G3 只用一条,三轮都在里面)

test.beforeEach(async ({ page }) => {
  if (!CTL) throw new Error('R197_CTL 没设置:请用 run.sh 运行');
  await boot(page);
});

test.afterEach(async () => {
  for (const { sid } of POOL) clearHold(CTL, sid);
  releaseAllRuns(CTL);   // 别把任何一条会话的回合晾在停住状态
});

// ---------------------------------------------------------------- 共用步骤
const msg = (tag, which) => `R197${tag}${which} 这是${tag}的${which === 'T1' ? '第一条' : '第二条'}消息请照常处理`;

/** 在已打开的会话里发 T1(命令行已被按住),约 1.5 秒后再发 T2(可省),确认 T2 进了排队栏。 */
async function sendHeldTurn(page, chat, t1, t2) {
  await sendPrompt(page, t1);
  await until(() => chat.postsWith(t1).length >= 1, { timeout: 15_000, message: '页面应发出含 T1 的 POST /api/chat' });
  if (!t2) return;
  await page.waitForTimeout(1_500);
  await sendPrompt(page, t2);
  await expect(queueItem(page, t2), 'T2 应进入排队栏(恰好 1 条)').toHaveCount(1, { timeout: 8_000 });
}

/** 等 T1 收到初始化超时(约 15 秒),核对后端应答形态,再等页面上出现超时那句话。返回页面上第一次见到那句话的时刻。 */
async function awaitStartTimeout(page, chat, t1, label, want = 1) {
  const r = await until(() => chat.respWith(t1)[0], { timeout: 40_000, message: `${label}T1 应收到后端应答` });
  expect(r.status, `${label}T1 的应答状态码`).toBe(504);
  expect(r.body && r.body.code, `${label}应答 code`).toBe('CHAT_START_TIMEOUT');
  expect(r.body.delivered, `${label}应答 delivered`).toBe('unknown');
  expect(r.body.status, `${label}应答 status`).toBe('running');
  expect(r.body.error, `${label}应答 error`).toBe('会话进程 15 秒内未完成初始化；内容可能稍后到达，请勿据此重发');
  expect(['number', 'string'], `${label}应答 pid 的类型`).toContain(typeof r.body.pid);
  const waited = r.t - (r.sentAt || r.t);
  expect(waited, `${label}超时应在约 15 秒时到(实际 ${waited} 毫秒)`).toBeGreaterThanOrEqual(12_000);
  expect(waited, `${label}超时应在约 15 秒时到(实际 ${waited} 毫秒)`).toBeLessThanOrEqual(22_000);
  await until(async () => (await phraseCount(page)) >= want, { timeout: 6_000, message: `${label}页面上应出现「${PHRASE}」` });
  return Date.now();
}

async function sampleFor(page, ms, queued, every = 400) {
  const out = [];
  const end = Date.now() + ms;
  for (;;) {
    out.push({ at: Date.now(), ...(await probe(page, queued)) });
    if (Date.now() >= end) return out;
    await page.waitForTimeout(every);
  }
}

/** G1 的观察窗口:超时之后 8 秒里,逐次采样核对。want = 这一轮超时后页面上那句话应有的条数(同一会话前几轮留下的 + 这一轮的 1 条)。 */
async function assertG1Window(page, chat, t2, label, want = 1) {
  const samples = await sampleFor(page, 8_000, t2);
  const bad = (f) => samples.filter((s) => !f(s));
  expect(bad((s) => s.phrase === want).map((s) => s.phrase), `${label}超时那句话应恒为恰好 ${want} 次;全部采样 ${JSON.stringify(samples.map((s) => s.phrase))}`).toEqual([]);
  expect(bad((s) => s.queue === 1).length, `${label}T2 应一直在排队栏里;各次采样的排队条数 ${JSON.stringify(samples.map((s) => s.queue))}`).toBe(0);
  expect(bad((s) => s.stops >= 1).length, `${label}停止键应一直在;各次采样的停止键个数 ${JSON.stringify(samples.map((s) => s.stops))}`).toBe(0);
  expect(chat.postsWith(t2).map((p) => p.prompt.slice(0, 30)), `${label}超时后 8 秒内页面不该发出含 T2 的 POST /api/chat`).toEqual([]);
}

/** 放开被按住的命令行,让这一轮跑完,并核对:这一轮结束前不发 T2、结束后才发出 T2、回复显示在会话里、超时那句话不重复。 */
async function releaseAndExpectDrain(page, chat, S1, t1, t2, label, want = 1) {
  const { sid } = S1;
  releaseSession(CTL, sid);
  await waitForPhase(CTL, sid, 'chunk1');
  await page.waitForTimeout(2_000);   // 给"这一轮没结束就提前发出 T2"留出发生的时间
  const mid = await probe(page, t2);
  expect(mid.phrase, `${label}这一轮进行中超时那句话应恰好 ${want} 次`).toBe(want);
  expect(mid.stops, `${label}这一轮还没结束,停止键应在`).toBeGreaterThanOrEqual(1);
  expect(mid.queue, `${label}这一轮还没结束,T2 应仍在排队栏`).toBe(1);
  expect(chat.postsWith(t2).length, `${label}这一轮还没结束,不该已发出含 T2 的 POST`).toBe(0);

  releaseChunk2(CTL, sid);
  await waitForPhase(CTL, sid, 'chunk2');
  const tEnd = Date.now();
  releaseTurnEnd(CTL, sid);
  await waitForPhase(CTL, sid, 'final');
  await waitBodyText(page, live.chunk1(sid, t1), 20_000).toBe(true);   // R1 回复正文显示在这个会话里
  await waitBodyText(page, live.final(sid), 20_000).toBe(true);

  const p2 = await until(() => chat.postsWith(t2)[0], { timeout: 30_000, message: `${label}这一轮结束后页面应发出含 T2 的 POST /api/chat` });
  expect(p2.t, `${label}含 T2 的 POST 应发生在这一轮结束(放行收尾)之后`).toBeGreaterThanOrEqual(tEnd);
  await expect(queueItem(page, t2), `${label}T2 发出后应从排队栏消失`).toHaveCount(0, { timeout: 15_000 });
  await until(() => countTranscriptLines(sid, 'user', t2) >= 1, { timeout: 20_000, message: `${label}T2 原文应出现在会话文件里` });
  expect(countTranscriptLines(sid, 'user', t2), `${label}T2 在会话文件里应恰好 1 条用户消息`).toBe(1);
}

/** T2 那一轮也放行跑完(多轮用例要接着发下一轮)。 */
async function finishQueuedTurn(page, sid) {
  await waitForPhase(CTL, sid, 'chunk1');
  releaseChunk2(CTL, sid);
  await waitForPhase(CTL, sid, 'chunk2');
  releaseTurnEnd(CTL, sid);
  await waitStopGone(page, 20_000, 'T2 那一轮结束后');
}

// ============================================================ G1–G4 复现 ============================================================

test('G1 [复现] 初始化超时后:超时那句话恰好 1 次、T2 仍在排队栏、不发出 T2、停止键还在(观察 8 秒)', async ({ page }) => {
  const A = S(0);
  const t1 = msg('G1', 'T1'); const t2 = msg('G1', 'T2');
  await openSessionBySearch(page, A.mark);
  const chat = trackChat(page);
  holdOnce(CTL, A.sid);
  await sendHeldTurn(page, chat, t1, t2);
  await awaitStartTimeout(page, chat, t1, 'G1:');
  await assertG1Window(page, chat, t2, 'G1:');
});

test('G2 [复现] 放开命令行后:回复显示在会话里、这一轮结束后才发出 T2、T2 进会话文件、超时那句话没有重复', async ({ page }) => {
  const A = S(1);
  const t1 = msg('G2', 'T1'); const t2 = msg('G2', 'T2');
  await openSessionBySearch(page, A.mark);
  const chat = trackChat(page);
  await installPhraseRecorder(page);
  holdOnce(CTL, A.sid);
  await sendHeldTurn(page, chat, t1, t2);
  await awaitStartTimeout(page, chat, t1, 'G2:');
  await releaseAndExpectDrain(page, chat, A, t1, t2, 'G2:');
  const rec = await readPhraseRecorder(page);
  expect(rec.max, 'G2:全程页面上超时那句话同时出现的次数最大值应为 1').toBe(1);
});

test('G3 [复现] 同一会话连做 3 轮(G1+G2):每一轮重新拉起命令行进程并初始化超时,每一轮都满足 G1、G2', async ({ page }) => {
  test.setTimeout(480_000);
  const A = S(2);
  await openSessionBySearch(page, A.mark);
  const chat = trackChat(page);
  for (let i = 0; i < 3; i += 1) {
    const label = `G3 第${i + 1}轮:`;
    const t1 = msg(`G3r${i + 1}`, 'T1'); const t2 = msg(`G3r${i + 1}`, 'T2');
    resetTurnFiles(CTL, A.sid);
    holdOnce(CTL, A.sid);
    // 主会话修订(2026-11-18):会话的命令行进程还常驻着时,后端把新消息直接交给它、立刻回 200,不走初始化等待,
    // 不可能出现初始化超时。所以每轮开始前先结束上一轮留下的进程,让这一轮重新拉起、被按住、超时(超时后这一轮的进程还在)。
    if (i > 0) {
      const prev = runPid(CTL, A.sid);
      if (prev && pidAlive(prev)) { try { process.kill(Number(prev), 'SIGTERM'); } catch { /* 已经不在 */ } }
      await until(() => !(prev && pidAlive(prev)), { timeout: 10_000, message: `${label}上一轮留下的命令行进程应已结束` });
      await page.waitForTimeout(2_000);
    }
    // 主会话修订(2026-11-18):超时提示和其它报错一样留在对话里,同一会话前几轮的会留着;按「这一轮开始前的条数 + 1」核对。
    const want = (await phraseCount(page)) + 1;
    await sendHeldTurn(page, chat, t1, t2);
    await awaitStartTimeout(page, chat, t1, label, want);
    await assertG1Window(page, chat, t2, label, want);
    await releaseAndExpectDrain(page, chat, A, t1, t2, label, want);
    await finishQueuedTurn(page, A.sid);
    await expect(stopButton(page), `${label}两条都跑完后停止键应消失`).toHaveCount(0, { timeout: 15_000 });
  }
});

test('G4 [复现] 超时后用户点停止:点之前 T2 没发、停止键在;点之后这一轮停下(停止键消失),超时那句话不重复', async ({ page }) => {
  const A = S(3);
  const t1 = msg('G4', 'T1'); const t2 = msg('G4', 'T2');
  await openSessionBySearch(page, A.mark);
  const chat = trackChat(page);
  await installPhraseRecorder(page);
  holdOnce(CTL, A.sid);
  await sendHeldTurn(page, chat, t1, t2);
  await awaitStartTimeout(page, chat, t1, 'G4:');
  await page.waitForTimeout(1_000);
  const before = await probe(page, t2);
  expect(before.stops, 'G4:点停止之前停止键应在').toBeGreaterThanOrEqual(1);
  expect(before.queue, 'G4:点停止之前 T2 应仍在排队栏').toBe(1);
  expect(chat.postsWith(t2).length, 'G4:点停止之前不该已发出含 T2 的 POST').toBe(0);
  autoRun(CTL, A.sid);   // 停止后如果 T2 被发出,那一轮自己跑完,不影响"停止键消失"的判断
  await stopButton(page).first().click();
  await waitStopGone(page, 15_000, 'G4:点停止后');
  // 主会话修订(2026-11-18):不再断言"停止键消失那一刻那句话恰好 1 次"——停止后 T2 按现有规则可能被发出,
  // 而同一会话发下一条消息时,页面会撤掉上一轮留下的提示(见接口文件),那时这句话为 0 是正常的。
  const after = await sampleFor(page, 3_000, t2);
  expect(after.filter((s) => s.phrase > 1).map((s) => s.phrase), `G4:停止后超时那句话不应重复出现;采样 ${JSON.stringify(after.map((s) => s.phrase))}`).toEqual([]);
  const rec = await readPhraseRecorder(page);
  expect(rec.max, 'G4:全程超时那句话同时出现的次数最大值应为 1').toBe(1);
});

// ============================================================ G5–G8 相邻回归 ============================================================

test('G5 [相邻回归] 命令行正常初始化:回复进行中排队的 T2 在这一轮结束后自动发出,进会话文件,页面没有超时那句话', async ({ page }) => {
  const A = S(4);
  const t1 = msg('G5', 'T1'); const t2 = msg('G5', 'T2');
  await openSessionBySearch(page, A.mark);
  const chat = trackChat(page);
  await installPhraseRecorder(page);
  await sendPrompt(page, t1);
  await waitBodyText(page, live.chunk1(A.sid, t1), 30_000).toBe(true);   // 这一轮已在进行
  await expect(stopButton(page).first(), 'G5:回复进行中停止键应可用').toBeEnabled({ timeout: 10_000 });
  await sendPrompt(page, t2);
  await expect(queueItem(page, t2), 'G5:T2 应进入排队栏').toHaveCount(1, { timeout: 8_000 });
  await page.waitForTimeout(1_500);
  expect(chat.postsWith(t2).length, 'G5:这一轮没结束前不该发出含 T2 的 POST').toBe(0);

  releaseChunk2(CTL, A.sid);
  await waitForPhase(CTL, A.sid, 'chunk2');
  const tEnd = Date.now();
  releaseTurnEnd(CTL, A.sid);
  await waitForPhase(CTL, A.sid, 'final');
  const p2 = await until(() => chat.postsWith(t2)[0], { timeout: 30_000, message: 'G5:这一轮结束后页面应发出含 T2 的 POST /api/chat' });
  expect(p2.t, 'G5:含 T2 的 POST 应发生在这一轮结束之后').toBeGreaterThanOrEqual(tEnd);
  await expect(queueItem(page, t2), 'G5:T2 发出后应从排队栏消失').toHaveCount(0, { timeout: 15_000 });
  await until(() => countTranscriptLines(A.sid, 'user', t2) >= 1, { timeout: 20_000, message: 'G5:T2 原文应出现在会话文件里' });
  expect(countTranscriptLines(A.sid, 'user', t2), 'G5:T2 在会话文件里应恰好 1 条用户消息').toBe(1);
  const rec = await readPhraseRecorder(page);
  expect(rec.seen, 'G5:全程页面上不该出现超时那句话').toBe(false);
  expect(rec.max, 'G5:全程超时那句话出现次数').toBe(0);
});

test('G6 [相邻回归] 命令行进程在吐出第一条事件前退出:显示「会话进程启动失败」报错,排队的 T2 在报错后自动发出', async ({ page }) => {
  const A = S(5);
  const t1 = msg('G6', 'T1'); const t2 = msg('G6', 'T2');
  await openSessionBySearch(page, A.mark);
  const chat = trackChat(page);
  await installPhraseRecorder(page);
  dieOnStart(CTL, A.sid, 5_000);   // 进程起来后静默 5 秒再退出,给 T2 留出进排队栏的时间
  await sendHeldTurn(page, chat, t1, t2);
  const r = await until(() => chat.respWith(t1)[0], { timeout: 40_000, message: 'G6:T1 应收到后端应答' });
  expect(r.status, 'G6:T1 的应答状态码').toBe(500);
  expect(r.body && r.body.code, 'G6:应答 code').toBe('CHAT_START_FAILED');
  expect(String(r.body.error), 'G6:应答 error 的开头').toMatch(/^会话进程启动失败：/);
  await waitBodyText(page, START_FAILED, 10_000).toBe(true);
  const p2 = await until(() => chat.postsWith(t2)[0], { timeout: 30_000, message: 'G6:报错后页面应发出含 T2 的 POST /api/chat' });
  expect(p2.t, 'G6:含 T2 的 POST 应发生在报错应答之后').toBeGreaterThanOrEqual(r.t - 200);
  await expect(queueItem(page, t2), 'G6:T2 发出后应从排队栏消失').toHaveCount(0, { timeout: 15_000 });
  const rec = await readPhraseRecorder(page);
  expect(rec.seen, 'G6:启动失败不是初始化超时,页面不该出现超时那句话').toBe(false);
});

test('G7 [复现] 没有排队消息:T1 超时后放开命令行,回复显示在会话里,超时那句话恰好 1 次', async ({ page }) => {
  const A = S(6);
  const t1 = msg('G7', 'T1');
  await openSessionBySearch(page, A.mark);
  const chat = trackChat(page);
  await installPhraseRecorder(page);
  holdOnce(CTL, A.sid);
  await sendHeldTurn(page, chat, t1, null);
  await awaitStartTimeout(page, chat, t1, 'G7:');
  releaseSession(CTL, A.sid);
  await waitForPhase(CTL, A.sid, 'chunk1');
  releaseChunk2(CTL, A.sid);
  await waitForPhase(CTL, A.sid, 'chunk2');
  releaseTurnEnd(CTL, A.sid);
  await waitForPhase(CTL, A.sid, 'final');
  await waitBodyText(page, live.chunk1(A.sid, t1), 20_000).toBe(true);   // 回复正文显示在 A 的对话里
  await waitBodyText(page, live.final(A.sid), 20_000).toBe(true);
  expect(await phraseCount(page), 'G7:这一轮跑完后超时那句话应恰好 1 次').toBe(1);
  await page.waitForTimeout(1_500);
  const rec = await readPhraseRecorder(page);
  expect(rec.max, 'G7:全程超时那句话同时出现的次数最大值应为 1').toBe(1);
});

test('G8 [相邻回归] 普通回合进行中点停止:这一轮停下(停止键消失),页面上没有超时那句话', async ({ page }) => {
  const A = S(7);
  const t1 = msg('G8', 'T1');
  await openSessionBySearch(page, A.mark);
  await installPhraseRecorder(page);
  await sendPrompt(page, t1);
  await waitBodyText(page, live.chunk1(A.sid, t1), 30_000).toBe(true);
  await expect(stopButton(page).first(), 'G8:回复进行中停止键应可用').toBeEnabled({ timeout: 10_000 });
  await stopButton(page).first().click();
  await waitStopGone(page, 15_000);
  await page.waitForTimeout(3_000);
  expect((await probe(page, '')).stops, 'G8:停止 3 秒后停止键仍应不在').toBe(0);
  const rec = await readPhraseRecorder(page);
  expect(rec.seen, 'G8:全程页面上不该出现超时那句话').toBe(false);
  expect(rec.max, 'G8:全程超时那句话出现次数').toBe(0);
});
