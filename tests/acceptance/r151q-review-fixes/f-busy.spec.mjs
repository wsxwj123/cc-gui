// F. 会话忙(行为 16–18)。Q16 用共享实例 + 界面(旧进程被"推迟退出"撑住跨会话回合的派发占位期);Q17 / Q18 用一次性实例。
// 发送方 = 真 CLI 会话(只连本地假模型);目标 T = 假 claude 会话,把收到的每条用户消息记进回合记录。
import { test, expect } from '@playwright/test';
import { uniq, homeDir, ctlDir, realCliPath } from '../r151b-xsession-p1/helpers/fixtures.mjs';
import { xs, shared, API, waitFor } from '../r151b-xsession-p1/helpers/api.mjs';
import { boot, openSessionBySearch, sendPrompt } from '../r151b-xsession-p1/helpers/ui.mjs';
import { inboundOk, entry, waitMsg } from '../r151c-xsession-p2/helpers/p2.mjs';
import { newT, userTurn, chatStart, prepareOld, writeHeldScript, waitTurn, exitLog, turnsOf, procPids, fxRelease, releaseAll } from '../r151g-mode-ordering/helpers/g.mjs';
import { startHeldSender, waitNewCross, idsOf, msgNow, sleep } from './helpers/busy.mjs';
import { startInstanceQ } from './helpers/inst.mjs';

test.describe.configure({ timeout: 240_000 });
test.beforeEach(() => { test.skip(!realCliPath(), '本机没有真 claude CLI(跨会话发送方要用真 CLI 调 send_message)'); });
const userTurnsWith = (inst, sid, text) => turnsOf(inst.ctl, sid).filter((t) => String(t.text).includes(text));

async function targetWithProfile(inst, tag) {
  await xs(inst.c, inst.home).on();
  const T = newT(inst, tag);
  const first = await userTurn(inst.c, T, { mode: 'bypassPermissions', note: `${tag} 建档` });
  expect(first.status, `前置:T 跑一个用户回合(${String(first.text).slice(0, 200)})`).toBe(200);
  await inboundOk(inst.c, T.sid, 'auto');
  expect((await entry(inst.c, T.sid))?.hasProfile, '前置:T 有发送档案').toBe(true);
  return T;
}
/** 让一条跨会话消息的自动回合在 T 上"正在运行"(假 claude 被脚本扣住)。 */
async function crossTurnRunning(inst, T, run, tag) {
  const held = writeHeldScript(inst, `${tag}hold${run}`);
  const known = await idsOf(inst, T.sid);
  const sender = await startHeldSender(inst, T.sid, `R151Q ${tag} 跨会话 ${run} R151S:${held.name}`);
  sender.fire();
  const cross = await waitNewCross(inst, T.sid, known);
  expect(cross, '前置:跨会话消息到达 T').toBeTruthy();
  const crossTurn = await waitTurn(inst, T, held.name, 40_000);
  expect(crossTurn, `前置:跨会话自动回合已在 T 上运行(回合记录:${JSON.stringify(turnsOf(inst.ctl, T.sid).slice(-3))})`).toBeTruthy();
  return { held, sender, cross, crossTurn };
}
const busyFacts = (user, elapsed) => ({ status: user.status, ok: user.body && user.body.ok, code: user.body && user.body.code, hasError: !!(user.body && typeof user.body.error === 'string' && user.body.error.length), fast: elapsed < 3_000 });
const BUSY = { status: 409, ok: false, code: 'CHAT_SESSION_BUSY', hasError: true, fast: true };

test('Q16 跨会话回合的派发停在占位期时用户在界面发消息 → 无错误气泡、有排队提示;跨会话回合结束前上游收不到、没被中止;结束后自动发出且只收到一次', async ({ page }) => {
  const inst = { c: shared, base: API, home: homeDir(), ctl: ctlDir() };
  const run = uniq(''); const userText = `R151Q-Q16-USER-${run}`;
  let T = null; let oldPid = null; let sender = null; let held = null;
  try {
    await xs(inst.c, inst.home).on();
    T = newT(inst, 'q16');
    held = writeHeldScript(inst, `q16hold${run}`);
    oldPid = await prepareOld(inst, T, { mode: 'bypassPermissions' }); // 老进程:被要求退出也不退(夹具撑住),设置已变不能复用
    await inboundOk(inst.c, T.sid, 'auto');
    expect((await entry(inst.c, T.sid))?.hasProfile, '前置:T 有发送档案').toBe(true);
    const known = await idsOf(inst, T.sid);
    sender = await startHeldSender(inst, T.sid, `R151Q q16 跨会话 ${run} R151S:${held.name}`);
    await boot(page);
    await openSessionBySearch(page, T.title, T.reply);
    sender.fire();
    const cross = await waitNewCross(inst, T.sid, known);
    expect(cross, '前置:跨会话消息到达 T').toBeTruthy();
    const asked = await waitFor(() => exitLog(inst.ctl, T.sid).find((e) => e.pid === oldPid && e.ev === 'exit-requested') || null, 20_000, 100);
    expect(asked, `前置:宿主为跨会话回合换下旧进程 ${oldPid}(派发停在占位期);退出记录:${JSON.stringify(exitLog(inst.ctl, T.sid).slice(-3))}`).toBeTruthy();
    const statusAtHold = (await msgNow(inst, T.sid, cross.id))?.status;

    const bodyText = () => page.evaluate(() => document.body.innerText);
    const listText = () => page.locator('[data-cgui="message-list"]').innerText().catch(() => '');
    const noticeRe = /排队|稍后|空闲后|等.{0,8}(结束|完成)后/; const errRe = /会话正在运行|CHAT_SESSION_BUSY/;
    const baseBody = await bodyText();
    await sendPrompt(page, userText);
    await waitFor(async () => noticeRe.test(await bodyText()) || errRe.test(await listText()), 10_000, 200);
    const body1 = await bodyText(); const list1 = await listText();
    const atHold = {
      noticeShown: noticeRe.test(body1) && !noticeRe.test(baseBody),
      errorBubble: errRe.test(list1),
      userReachedCli: userTurnsWith(inst, T.sid, userText).length,
      crossMessageStatus: (await msgNow(inst, T.sid, cross.id))?.status,
    };
    expect.soft(atHold, `占位期内界面与上游的状态(消息区文字:${list1.slice(-600)};占位时跨会话消息状态 ${statusAtHold})`)
      .toEqual({ noticeShown: true, errorBubble: false, userReachedCli: 0, crossMessageStatus: statusAtHold });

    fxRelease(inst.ctl, oldPid); // 放行旧进程退出 → 新进程起来跑跨会话回合(被脚本扣住)
    const crossTurn = await waitTurn(inst, T, held.name, 40_000);
    expect.soft(crossTurn, '放行后跨会话回合开始运行').toBeTruthy();
    await sleep(3_000);
    const running = { userReachedCli: userTurnsWith(inst, T.sid, userText).length, crossMessageStatus: (await msgNow(inst, T.sid, cross.id))?.status };
    expect.soft(running, '跨会话回合运行期间:用户消息仍没发出,跨会话回合没被中止').toEqual({ userReachedCli: 0, crossMessageStatus: 'processing' });
    held.release(); // 跨会话回合结束
    const fin = await waitMsg(inst.c, T.sid, (x) => x.id === cross.id && x.status === 'done', 40_000);
    expect.soft(fin, '跨会话回合照常跑完(done、自动处理)').toMatchObject({ status: 'done', via: 'auto' });
    await waitFor(() => userTurnsWith(inst, T.sid, userText).length >= 1, 40_000, 200);
    await sleep(2_500);
    expect.soft(userTurnsWith(inst, T.sid, userText).length, '跨会话回合结束后,用户消息自动发出,上游只收到一次').toBe(1);
  } finally {
    if (sender) await sender.finish();
    if (held) held.release();
    if (oldPid) fxRelease(inst.ctl, oldPid);
    if (T) releaseAll(inst, T.sid);
  }
});

test('Q17 跨会话回合已在运行时经 /api/chat 发用户消息 → 立即回 409 CHAT_SESSION_BUSY;跨会话回合照常跑完、没被中止', async () => {
  const inst = await startInstanceQ('q17');
  const run = uniq(''); const userText = `R151Q-Q17-USER-${run}`;
  let T = null; let ctx = null;
  try {
    T = await targetWithProfile(inst, 'q17');
    ctx = await crossTurnRunning(inst, T, run, 'q17');
    const t0 = Date.now();
    const user = await chatStart(inst.c, T, { prompt: userText, mode: 'bypassPermissions', postMs: 15_000 });
    const elapsed = Date.now() - t0;
    await sleep(1_500);
    const mid = await msgNow(inst, T.sid, ctx.cross.id);
    const alive = (await procPids(inst.c, T.sid)).includes(Number(ctx.crossTurn.pid));
    ctx.held.release();
    const fin = await waitMsg(inst.c, T.sid, (x) => x.id === ctx.cross.id && x.status === 'done', 25_000);
    expect.soft(busyFacts(user, elapsed), `用户消息的应答原文:${String(user.text).slice(0, 300)}`).toEqual(BUSY);
    expect.soft({ crossProcessAlive: alive, crossStatus: mid && mid.status, userReachedCli: userTurnsWith(inst, T.sid, userText).length }, '409 之后跨会话回合没被中止、用户消息没进上游')
      .toEqual({ crossProcessAlive: true, crossStatus: 'processing', userReachedCli: 0 });
    expect.soft(fin, '跨会话回合照常跑完').toMatchObject({ status: 'done', via: 'auto' });
  } finally {
    if (ctx) { await ctx.sender.finish(); ctx.held.release(); }
    if (T) releaseAll(inst, T.sid);
    await inst.stop();
  }
});

test('Q18 用户消息被 409 后 60 秒内同会话又来一条同类跨会话消息 → 保持排队、不起新自动回合;用户消息发出并开始回合后才处理它', async () => {
  const inst = await startInstanceQ('q18');
  const run = uniq(''); const cross2Text = `R151Q q18 跨会话二 ${run}`;
  let T = null; let ctx = null; let sender2 = null;
  try {
    T = await targetWithProfile(inst, 'q18');
    ctx = await crossTurnRunning(inst, T, run, 'q18');
    const first = await chatStart(inst.c, T, { prompt: `R151Q-Q18-USER1-${run}`, mode: 'bypassPermissions', postMs: 15_000 });
    const t409 = Date.now();
    expect(first.status, `前置:用户消息被 409(应答:${String(first.text).slice(0, 200)})`).toBe(409);
    ctx.held.release();
    const fin1 = await waitMsg(inst.c, T.sid, (x) => x.id === ctx.cross.id && x.status === 'done', 25_000);
    expect(fin1, '前置:第一条跨会话回合跑完').toBeTruthy();

    const known2 = await idsOf(inst, T.sid);
    sender2 = await startHeldSender(inst, T.sid, cross2Text);
    sender2.fire();
    const cross2 = await waitNewCross(inst, T.sid, known2);
    expect(cross2, '前置:第二条跨会话消息到达 T').toBeTruthy();
    const seen = []; const w0 = Date.now();
    while (Date.now() - w0 < 4_500) { seen.push((await msgNow(inst, T.sid, cross2.id))?.status); await sleep(300); }
    const startedEarly = userTurnsWith(inst, T.sid, cross2Text).length;
    expect.soft({ statuses: [...new Set(seen)], autoTurnsStarted: startedEarly }, `409 后 ${Math.round((Date.now() - t409) / 1000)} 秒内:第二条跨会话消息应保持排队(状态序列 ${JSON.stringify(seen)})`)
      .toEqual({ statuses: ['queued'], autoTurnsStarted: 0 });
    expect(Date.now() - t409, '前置:仍在 409 之后的 60 秒内').toBeLessThan(58_000);

    const user = await userTurn(inst.c, T, { mode: 'bypassPermissions', note: `q18 用户 ${run}` });
    expect.soft(user.status, `用户消息发出并开始回合(应答:${String(user.text).slice(0, 200)})`).toBe(200);
    const fin2 = await waitMsg(inst.c, T.sid, (x) => x.id === cross2.id && x.status === 'done', 40_000);
    expect.soft(fin2, '用户回合之后排队的跨会话消息被处理').toMatchObject({ status: 'done', via: 'auto' });
    const uRec = userTurnsWith(inst, T.sid, user.mark)[0]; const cRec = userTurnsWith(inst, T.sid, cross2Text)[0];
    expect.soft(uRec && cRec && Date.parse(uRec.at) < Date.parse(cRec.at), `先开始用户回合(${uRec && uRec.at}),再开始排队的跨会话回合(${cRec && cRec.at})`).toBe(true);
  } finally {
    if (sender2) await sender2.finish();
    if (ctx) { await ctx.sender.finish(); ctx.held.release(); }
    if (T) releaseAll(inst, T.sid);
    await inst.stop();
  }
});
