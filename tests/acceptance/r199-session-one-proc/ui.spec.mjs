// r199 一个会话同一时刻只有一个命令行进程 —— 页面层验收。依据 .devflow/r199-session-one-proc-接口.md 的行为清单。
// 用例标题里的 [第N条] 是覆盖的行为号。"页面还没认出这一轮在跑" 用拦截 /api/agents/active(拿掉该会话的进程条目)制造。
// 没覆盖:点输入框上方输入预测发送(第6条的另一半)、输入预测开着时点停止约 4 秒停稳(第8条的另一半):假命令行不产生输入预测建议条。
import { test, expect } from '@playwright/test';
import {
  sleep, uniq, newSession, http, openStream, isDone, waitFor, osProcs, turnStarts, turnEnds, autoRecs, writeScript, cleanupSession,
  primeProcess, startAutoTurn, waitAutoEnd, touchFile, rec,
} from './helpers/lib.mjs';
import {
  HINT_NEW, HINT_CARD, boot, openSessionBySearch, sendPrompt, stopButton, queueItems, bodyText, waitPhrase, probe, trackChat, hideActive, replyOf,
} from './helpers/ui.mjs';

test.describe.configure({ timeout: 240_000 });

/** 通用前置:会话 T 有一个带 2 条没结束后台命令的空闲进程;页面打开它,"看不见"这个会话的进程;命令行开始自己接着回复 autoMs 毫秒。 */
async function setupTail(page, name, autoMs) {
  const T = newSession(name);
  const prime = await primeProcess(T, { bgTasks: 2 });
  const hide = await hideActive(page, T.sid);
  const tr = trackChat(page);
  await boot(page);
  await openSessionBySearch(page, T.title, T.reply);
  hide.hide = true;
  await startAutoTurn(T, { taskId: prime.taskIds[1], sleepMs: autoMs });
  await sleep(1_000);
  return { T, prime, hide, tr };
}

// 用例修订(2026-11-19,test-r199-fix):U1 / U3 原来用接口 primeProcess 预先起进程,请求体不带页面会带的 globalRead:true 等字段,
// 页面后来发的消息按第 3 条「改配置后关旧开新」另起了新进程,进程号对不上。改成让页面自己发第一回合(做法同 stoppedProcess),进程配置与页面一致。
/** 同 setupTail,但预先起进程的那一回合由页面自己发(放出 2 条没结束的后台命令),之后才拦截轮询、命令行自己接着回复 autoMs 毫秒。prime.pid1 = 页面第一回合应答里的进程号。 */
async function setupTailByPage(page, name, autoMs) {
  const T = newSession(name);
  const hide = await hideActive(page, T.sid);
  const tr = trackChat(page);
  await boot(page);
  await openSessionBySearch(page, T.title, T.reply);
  const taskIds = [0, 1].map((i) => `${T.tag}-bg${i}`);
  writeScript(`${T.tag}-prime`, [...taskIds.map((taskId) => ({ bgStart: { taskId, description: 'sleep 120' } })), { say: `R199 ${name} 第一回合完` }]);
  const primeMark = `${name.toUpperCase()}PRIME`;
  await sendPrompt(page, `${primeMark}${uniq()} R199S:${T.tag}-prime`);
  expect(await waitFor(() => turnEnds(T.sid, primeMark).length > 0, 25_000, 100), '前置:页面发出的第一回合在命令行里结束').toBeTruthy();
  const primeResp = await waitFor(() => tr.respWith(primeMark).find((r) => r.status === 200) || null, 10_000, 100);
  expect(Boolean(primeResp && primeResp.body && primeResp.body.pid), '前置:页面第一回合应答 200 且带进程号').toBe(true);
  await sleep(8_000);
  hide.hide = true;
  await startAutoTurn(T, { taskId: taskIds[1], sleepMs: autoMs });
  await sleep(1_000);
  return { T, prime: { pid1: primeResp.body.pid, taskIds }, hide, tr, primeMark };
}

test('U1 [第6、7条] 页面没认出这一轮在跑时在输入框发消息:不出错误块,这条进待发队列并给提示;那一轮结束后自动发出、回复正常显示,交给同一个进程,进程数 1', async ({ page }) => {
  let T = null;
  try {
    const ctx = await setupTailByPage(page, 'u1', 16_000);
    T = ctx.T;
    const msg = `U1MSG${uniq()}`;
    await sendPrompt(page, msg);
    const hint = await waitPhrase(page, HINT_NEW, 15_000);
    // 用例修订(2026-11-19,test-r199-fix):拦截轮询只用来制造「发送那一刻页面还没认出」;收到 409(看到排队提示)后放开,否则页面一直认不出这一轮、会重发多收 409。
    ctx.hide.hide = false;
    const p6 = await probe(page, msg);
    expect({ hintShown: hint.seen, queuedCount: p6.queued, errorText: p6.errorText, statuses: ctx.tr.statusesOf(msg) }, `提示等了 ${hint.ms}ms;排队栏:${JSON.stringify(p6.queueTexts)}`)
      .toEqual({ hintShown: true, queuedCount: 1, errorText: false, statuses: [409] });

    expect(await waitAutoEnd(T, 1, 40_000), '前置:命令行自己接着回复的那一段结束').toBeTruthy();
    await expect(replyOf(page, msg), '排队的这条自动发出后,回复正常显示').toBeVisible({ timeout: 40_000 });
    const after = await probe(page, msg);
    const okResp = ctx.tr.respWith(msg).filter((r) => r.status === 200);
    expect({ statuses: ctx.tr.statusesOf(msg), samePid: okResp.length === 1 && okResp[0].body.pid === ctx.prime.pid1, queuedCount: after.queued, processCount: osProcs(T.sid).length })
      .toEqual({ statuses: [409, 200], samePid: true, queuedCount: 0, processCount: 1 });
  } finally { if (T) await cleanupSession(T); }
});

test('U2 [第8条] 页面没认出这一轮在跑、消息已排队后点停止:那一轮停下后排队的这条自动发出、回复正常显示,进程数 1,这条在那一轮停稳之后才发出', async ({ page }) => {
  let T = null;
  try {
    const ctx = await setupTail(page, 'u2', 30_000);
    T = ctx.T;
    const msg = `U2MSG${uniq()}`;
    await sendPrompt(page, msg);
    expect((await waitPhrase(page, HINT_NEW, 15_000)).seen, '前置:出现排队提示').toBe(true);
    // 锁定前主会话修订(2026-11-19):被 409 退回之后放开轮询,等页面真的接回这一轮(发出该进程的回合流请求)再点停止。
    // 一直拦着轮询的话页面手上没有可停的进程,点停止什么也不做,那一轮会自己跑完,本条测不到「停止」;
    // 有后台命令时主停止键一直亮着,停止键可见不能当「接回」的判据。
    const tUnhide = Date.now();
    ctx.hide.hide = false;
    const reattached = await waitFor(() => ctx.tr.streamsOf(ctx.prime.pid1, tUnhide)[0] || null, 10_000, 100);
    expect(Boolean(reattached), '前置:放开轮询后页面接回这一轮(发出该进程的回合流请求)').toBe(true);
    await stopButton(page).first().click();
    const ended = await waitFor(() => autoRecs(T.sid, 'end')[0] || null, 45_000, 100);
    await expect(replyOf(page, msg), '那一轮停下后排队的这条自动发出、回复正常显示').toBeVisible({ timeout: 40_000 });
    const posts = ctx.tr.postsWith(msg);
    expect({ turnStopped: Boolean(ended) && ended.interrupted === true, statuses: ctx.tr.statusesOf(msg), lastPostAfterTurnEnded: Boolean(ended) && posts.length >= 2 && posts[posts.length - 1].t >= ended.t - 300, processCount: osProcs(T.sid).length })
      .toEqual({ turnStopped: true, statuses: [409, 200], lastPostAfterTurnEnded: true, processCount: 1 });
  } finally { if (T) await cleanupSession(T); }
});

test('U3 [第18条] 第一条发出后、应答回来之前再手打一条;第一条被 409 退回:待发队列里第一条在前第二条在后,那一轮结束后按这个顺序发出,两条回复都正常显示', async ({ page }) => {
  let T = null;
  try {
    const ctx = await setupTailByPage(page, 'u3', 22_000);
    T = ctx.T;
    const first = `U3A${uniq()}`;
    const second = `U3B${uniq()}`;
    await sendPrompt(page, first);
    await sleep(700);
    await sendPrompt(page, second);
    expect((await waitPhrase(page, HINT_NEW, 15_000)).seen, '前置:第一条被退回后出现排队提示').toBe(true);
    // 用例修订(2026-11-19,test-r199-fix):收到第一个 409 后放开对 /api/agents/active 的拦截(同 U2 / U22)。
    ctx.hide.hide = false;
    await sleep(500);
    const q = await probe(page, '');
    const order = q.queueTexts.map((t) => (t.includes(first) ? 'first' : t.includes(second) ? 'second' : 'other'));
    expect(order, `排队栏:${JSON.stringify(q.queueTexts)}`).toEqual(['first', 'second']);

    expect(await waitAutoEnd(T, 1, 40_000), '前置:那一轮结束').toBeTruthy();
    // 用例修订(2026-11-19,test-r199-fix):replyOf 用 getByText 正则,Playwright 会把整块文字折成一行,「第一条回复 + 排队栏里还没发的第二条」同在一个容器里也能匹配(假通过:第二条还在排队就判成回复已显示)。
    // 本条改成只认回复段落(p)里的文字,第二条没真发出去就等不到。
    const replyPara = (marker) => page.locator('p').filter({ hasText: `R199-REPLY ${marker}` }).first();
    await expect(replyPara(first), '第一条回复显示').toBeVisible({ timeout: 40_000 });
    await expect(replyPara(second), '第二条回复显示').toBeVisible({ timeout: 40_000 });
    // 用例修订(2026-11-19,test-r199-fix):页面自己发的第一回合(预先起进程那条)也在录制里,顺序只看 first / second 两条。
    const okOrder = ctx.tr.resps.filter((r) => r.status === 200 && !r.prompt.includes(ctx.primeMark)).map((r) => (r.prompt.includes(first) ? 'first' : r.prompt.includes(second) ? 'second' : 'other'));
    const startOrder = turnStarts(T.sid).map((t) => (String(t.text).includes(first) ? 'first' : String(t.text).includes(second) ? 'second' : null)).filter(Boolean);
    expect({ okOrder, startOrder, processCount: osProcs(T.sid).length }).toEqual({ okOrder: ['first', 'second'], startOrder: ['first', 'second'], processCount: 1 });
  } finally { if (T) await cleanupSession(T); }
});

test('U20 [第20条] 点跨会话卡片「处理」时遇到「这一轮还在运行」:出现专用提示,这条不进待发队列;卡片先显示处理中,60 秒内回到待处理并带「未能开始处理」;再点「处理」能正常处理', async ({ page }) => {
  let B = null; let A = null;
  try {
    const on = await http('PUT', '/api/xsession/config', { enabled: true });
    expect(on.status, '前置:打开跨会话总开关').toBe(200);
    A = newSession('u20-a');
    B = newSession('u20-b');
    const prime = await primeProcess(B, { bgTasks: 2 });
    const body = `U20MSG${uniq()}`;
    const sent = await http('POST', '/api/xsession/messages', { to: [B.sid], body, fromSessionId: A.sid });
    expect(sent.status, `前置:A 给 B 发一条跨会话消息(${sent.text.slice(0, 200)})`).toBe(200);
    const id = sent.body.messages[0].id;
    const hide = await hideActive(page, B.sid);
    const tr = trackChat(page);
    await boot(page);
    await openSessionBySearch(page, B.title, B.reply);
    const card = page.locator(`[data-testid="xs-card"][data-message-id="${id}"]`);
    await expect(card, '前置:B 里出现这条消息的卡片').toBeVisible({ timeout: 20_000 });
    hide.hide = true;
    await startAutoTurn(B, { taskId: prime.taskIds[1], sleepMs: 22_000 });
    await sleep(1_000);
    await card.getByTestId('xs-card-process').click();
    const processingSeen = await waitFor(async () => /处理中/.test(await card.innerText().catch(() => '')), 3_500, 100);
    const hint = await waitPhrase(page, HINT_CARD, 20_000);
    const p = await probe(page, body);
    expect({ processingShown: Boolean(processingSeen), hintShown: hint.seen, queuedCount: p.queued, statuses: tr.resps.map((r) => r.status) }, `提示等了 ${hint.ms}ms;排队栏:${JSON.stringify(p.queueTexts)}`)
      .toEqual({ processingShown: true, hintShown: true, queuedCount: 0, statuses: [409] });
    const back = await waitFor(async () => /未能开始处理/.test(await card.innerText().catch(() => '')), 65_000, 300);
    expect(Boolean(back), `卡片 60 秒内回到待处理并带「未能开始处理」(卡片文字:${(await card.innerText().catch(() => '')).slice(0, 200)})`).toBe(true);

    expect(await waitAutoEnd(B, 1, 40_000), '前置:那一轮结束').toBeTruthy();
    await sleep(1_000);
    await card.getByTestId('xs-card-process').click();
    await expect(page.locator('[data-testid="peer-message"][data-via="card"]').filter({ hasText: body }), '再点「处理」后跨会话消息正常显示').toHaveCount(1, { timeout: 40_000 });
    const done = await waitFor(async () => {
      const r = await http('GET', `/api/xsession/messages?sessionId=${B.sid}&status=${encodeURIComponent('pending,queued,claimed,processing,done,dismissed')}`);
      const m = r.body && Array.isArray(r.body.messages) && r.body.messages.find((x) => x.id === id);
      return m && m.status === 'done' ? m : null;
    }, 30_000, 300);
    expect(done, '消息状态最终是 done').toBeTruthy();
  } finally { if (B) await cleanupSession(B); if (A) await cleanupSession(A); }
});

/**
 * 第 21、22 条的前置:全程经页面发消息(页面带的配置一致,同一个进程被复用)——
 * 页面发第一回合(放出 2 条没结束的后台命令)→ 空闲 8 秒 → 页面发一条慢消息 → 点停止 → 被停的这一轮收尾。返回 { T, tr, hide, goFile, taskIds, firstPid }。
 * 假命令行收到 interrupt 就提前收尾;若 6 秒内没收到(停止没落到命令行),放行慢回合让它自己结束,继续往下走。
 */
async function stoppedProcess(page, name, { afterStopMs = 5_500 } = {}) {
  const T = newSession(name);
  const hide = await hideActive(page, T.sid);
  const tr = trackChat(page);
  await boot(page);
  await openSessionBySearch(page, T.title, T.reply);
  const taskIds = [0, 1].map((i) => `${T.tag}-bg${i}`);
  writeScript(`${T.tag}-prime`, [...taskIds.map((taskId) => ({ bgStart: { taskId, description: 'sleep 120' } })), { say: `R199 ${name} 第一回合完` }]);
  const primeMsg = `${name.toUpperCase()}PRIME${uniq()} R199S:${T.tag}-prime`;
  await sendPrompt(page, primeMsg);
  expect(await waitFor(() => turnEnds(T.sid, `${name.toUpperCase()}PRIME`).length > 0, 25_000, 100), '前置:页面发出的第一回合在命令行里结束').toBeTruthy();
  await sleep(8_000);
  const goFile = `${T.tag}-go`;
  writeScript(`${T.tag}-slow`, [{ say: `R199 ${name} 慢的一轮` }, { waitFile: goFile }]);
  const slowMark = `${name.toUpperCase()}SLOW`;
  await sendPrompt(page, `${slowMark}${uniq()} R199S:${T.tag}-slow`);
  // 锁定前主会话修订(2026-11-19):等这条慢消息的发送应答(200)回来、页面记下这一轮的进程号之后再点停止。
  // 原写法只等停止键可见:有后台命令时停止键一直亮着,会在发送请求发出之前就点下去,停止什么也没做
  // (不发停止请求、也不记「已停止」),第 21 条的前置根本没成立。改后停止必须真的送到命令行,否则前置失败。
  expect(await waitFor(() => tr.respWith(slowMark).find((r) => r.status === 200) || null, 20_000, 100), '前置:慢的一轮已发出(应答 200)').toBeTruthy();
  await sleep(500);
  await stopButton(page).first().click();
  const interrupted = await waitFor(() => turnEnds(T.sid, slowMark).find((x) => x.interrupted) || null, 8_000, 100);
  expect(Boolean(interrupted), '前置:停止送到了命令行(被停的这一轮以打断收尾)').toBe(true);
  // 用例修订(2026-11-19,test-r199-fix):原来在命令行收到停止后只等约 3 秒就开始续跑,落在被停那一轮停稳之前(开着输入预测时约 4 秒才停稳,页面默认开着)。
  // 选「从命令行收到停止起至少等 5 秒」而不是轮询 /api/agents/active:该条目的在跑状态字段属于内部形态,接口文件没有约定;5.5 秒 > 约 4 秒,留有余量。
  // r199-1 第1条用 afterStopMs 缩短这段等待(命令行收到停止后不到 4 秒就续跑);默认 5.5 秒不变,U21 / U22 行为不变。
  await sleep(afterStopMs);
  const firstResp = tr.resps.find((r) => r.status === 200);
  return { T, tr, hide, goFile, taskIds, firstPid: firstResp && firstResp.body && firstResp.body.pid };
}

test('U21 [第21条] 对某进程点过停止;之后后台命令结束、命令行续跑:约 2 秒内页面接回这一轮、出现停止键;这期间在输入框发的消息进待发队列、不发请求;这一轮结束后自动发出,进程号不变', async ({ page }) => {
  let T = null; let goFile = null;
  try {
    const ctx = await stoppedProcess(page, 'u21');
    T = ctx.T; goFile = ctx.goFile;
    const t0 = await startAutoTurn(T, { taskId: ctx.taskIds[1], sleepMs: 16_000 });
    // 锁定前主会话修订(2026-11-19):「页面接回这一轮」以页面发出该进程的回合流请求为准(有后台命令时停止键一直亮着,不能当判据)。
    const re = await waitFor(() => ctx.tr.streamsOf(ctx.firstPid, t0)[0] || null, 6_000, 100);
    const reattachMs = re ? re.t - t0 : Infinity;
    const msg = `U21MSG${uniq()}`;
    await sendPrompt(page, msg);
    await sleep(3_000);
    const p = await probe(page, msg);
    expect({ reattachedWithin3500ms: reattachMs <= 3_500, queuedCount: p.queued, postsWhileRunning: ctx.tr.postsWith(msg).length }, `接回用了 ${reattachMs}ms;排队栏:${JSON.stringify(p.queueTexts)}`)
      .toEqual({ reattachedWithin3500ms: true, queuedCount: 1, postsWhileRunning: 0 });
    expect(await waitAutoEnd(T, 1, 40_000), '前置:这一轮结束').toBeTruthy();
    await expect(replyOf(page, msg), '这一轮结束后排队的这条自动发出、回复显示').toBeVisible({ timeout: 40_000 });
    const okResp = ctx.tr.respWith(msg).filter((r) => r.status === 200);
    expect({ statuses: ctx.tr.statusesOf(msg), samePid: okResp.length === 1 && okResp[0].body.pid === ctx.firstPid, processCount: osProcs(T.sid).length }).toEqual({ statuses: [200], samePid: true, processCount: 1 });
  } finally { if (T) await cleanupSession(T, goFile ? [goFile] : []); }
});

test('U22 [第22条] 同第 21 条,但页面没来得及认出续跑就发了一条:收到 409 之后页面不再屏蔽该进程、接回这一轮;这条只被退回一次,之后不会每隔几秒重新出现又消失;这一轮结束后自动发出', async ({ page }) => {
  let T = null; let goFile = null;
  try {
    const ctx = await stoppedProcess(page, 'u22');
    T = ctx.T; goFile = ctx.goFile;
    ctx.hide.hide = true;
    await startAutoTurn(T, { taskId: ctx.taskIds[1], sleepMs: 20_000 });
    const msg = `U22MSG${uniq()}`;
    await sendPrompt(page, msg);
    expect((await waitPhrase(page, HINT_NEW, 15_000)).seen, '前置:被 409 退回后出现排队提示').toBe(true);
    // 锁定前主会话修订(2026-11-19):被 409 退回之后放开轮询(页面下一次轮询就能看到这一轮);
    // 「接回」以页面发出该进程的回合流请求为准(有后台命令时停止键一直亮着,不能当判据)。
    const tUnhide = Date.now();
    ctx.hide.hide = false;
    const re = await waitFor(() => ctx.tr.streamsOf(ctx.firstPid, tUnhide)[0] || null, 6_000, 100);
    expect(Boolean(re), '409 之后页面接回这一轮(发出该进程的回合流请求)').toBe(true);
    // 采样 8 秒:排队项一旦出现就不应再消失;这条的发送请求不应再多发
    let seenQueued = false; let flicker = 0;
    const t1 = Date.now();
    while (Date.now() - t1 < 8_000 && autoRecs(T.sid, 'end').length === 0) {
      const q = (await probe(page, msg)).queued;
      if (q > 0) seenQueued = true; else if (seenQueued) flicker += 1;
      await sleep(200);
    }
    const postsBeforeEnd = ctx.tr.postsWith(msg).length;
    expect({ queuedSeen: seenQueued, disappearedCount: flicker, postsBeforeTurnEnd: postsBeforeEnd, statusesBeforeEnd: ctx.tr.statusesOf(msg) }).toEqual({ queuedSeen: true, disappearedCount: 0, postsBeforeTurnEnd: 1, statusesBeforeEnd: [409] });
    expect(await waitAutoEnd(T, 1, 40_000), '前置:这一轮结束').toBeTruthy();
    await expect(replyOf(page, msg), '这一轮结束后排队的这条自动发出、回复显示').toBeVisible({ timeout: 40_000 });
    expect({ statuses: ctx.tr.statusesOf(msg), processCount: osProcs(T.sid).length }).toEqual({ statuses: [409, 200], processCount: 1 });
  } finally { if (T) await cleanupSession(T, goFile ? [goFile] : []); }
});

test('U23 [r199-1 第1条] 点停止后不到 4 秒命令行就续跑(先出一句、之后约 20 秒没输出),页面没来得及认出续跑就发了一条:第一次应答是 409(reason=session-turn-running、pid=被停那一轮的进程),只退回一次,这一轮结束后自动发出、回复显示,进程数 1', async ({ page }) => {
  let T = null; let goFile = null;
  try {
    // 命令行收到停止后只等 2.8 秒就续跑(加上轮询误差约 3 秒,不到 4 秒)
    const ctx = await stoppedProcess(page, 'u23', { afterStopMs: 2_800 });
    T = ctx.T; goFile = ctx.goFile;
    const slowResp = ctx.tr.respWith('U23SLOW').find((r) => r.status === 200);
    expect(Boolean(slowResp && slowResp.body && slowResp.body.pid) && String(slowResp.body.pid) === String(ctx.firstPid), '前置:被停那一轮的进程号 = 第一回合的进程号').toBe(true);
    const stoppedPid = String(slowResp.body.pid);
    ctx.hide.hide = true;
    await startAutoTurn(T, { taskId: ctx.taskIds[1], sleepMs: 20_000 });
    // 前置:时序钉住。时间都取自假命令行自己的记录(收到停止 = control.jsonl 里第一条 interrupt;续跑开始 = auto.jsonl 的 start),不取页面渲染时刻。
    const interruptRec = rec('control.jsonl', T.sid).filter((x) => x.subtype === 'interrupt').sort((a, b) => a.t - b.t)[0];
    const autoStart = autoRecs(T.sid, 'start')[0];
    expect(Boolean(interruptRec && autoStart), '前置:假命令行记下了收到停止和续跑开始').toBe(true);
    const gapMs = autoStart.t - interruptRec.t;
    expect(gapMs > 0 && gapMs < 4_000, `前置:续跑从命令行收到停止起不到 4 秒才开始(实际 ${gapMs}ms)`).toBe(true);

    const msg = `U23MSG${uniq()}`;
    await sendPrompt(page, msg);
    const first = await waitFor(() => ctx.tr.respWith(msg)[0] || null, 15_000, 50);
    // 收到第一次应答后放开拦截(同 U22),否则页面一直认不出续跑、会重发多收 409
    ctx.hide.hide = false;
    expect(Boolean(first), '前置:这条消息收到了发送应答').toBe(true);
    expect({ status: first.status, code: first.body && first.body.code, reason: first.body && first.body.reason, pid: first.body && String(first.body.pid) },
      `第一次应答原文:${first.status} ${JSON.stringify(first.body).slice(0, 200)};续跑距收到停止 ${gapMs}ms`)
      .toEqual({ status: 409, code: 'CHAT_SESSION_BUSY', reason: 'session-turn-running', pid: stoppedPid });

    expect(await waitAutoEnd(T, 1, 40_000), '前置:续跑这一轮结束').toBeTruthy();
    const endRec = autoRecs(T.sid, 'end')[0];
    await expect(replyOf(page, msg), '这一轮结束后排队的这条自动发出、回复显示').toBeVisible({ timeout: 40_000 });
    const postsBeforeEnd = ctx.tr.postsWith(msg).filter((p) => p.t < endRec.t).length;
    expect({ postsBeforeTurnEnd: postsBeforeEnd, statuses: ctx.tr.statusesOf(msg), processCount: osProcs(T.sid).length })
      .toEqual({ postsBeforeTurnEnd: 1, statuses: [409, 200], processCount: 1 });
  } finally { if (T) await cleanupSession(T, goFile ? [goFile] : []); }
});
