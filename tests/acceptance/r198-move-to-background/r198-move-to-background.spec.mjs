// r198 "前台命令转到后台" 验收(黑盒)。唯一依据:接口文件第三节【新行为】1–12 条与第二节错误契约/页面提示。
// 只由 run.sh 调起:tests/acceptance/r198-move-to-background/run.sh [-g 'C1 ']
// 只通过页面(输入框 / 排队栏 / 卡片文字 / 「移到后台」按钮 / 停止键 / 弹框 / 进程面板)、页面发出的 POST 及其应答、
// 公开接口 GET /api/agents/active、会话文件、假命令行的控制文件观察。
//
// 用例编号 C1…C12 对应行为清单 1…12(C2、C12 各拆两个用例)。
// 约定:T1 = 会话里发的第一条;T2/T3 = 回复进行中再发的;fg = 假命令行里那条"跑很久"的前台 Bash;
//       fg 在约 3 秒时登记,被转走后约 1 秒出工具结果。每个用例用一条独立的夹具会话。
import { test, expect } from '@playwright/test';
import { POOL, countTranscriptLines } from './helpers/fixtures.mjs';
import {
  anyCustomDialog, anyStopVisible, armDialogs, bodyHas, bodyText, boot, btnOwnedBy, activeEntry, cardShown, cardTextAround, controlLog,
  dialogShows, dismissCustomDialogs, expandCardIfFolded, finishBgTasks, focusPane, footerText, killRun, logOf, mainStopButton,
  moveBtn, movedFooterCount, openGate, openRightPanel, openSessionBySearch, paneAt, phraseCount, pidAlive, queueItem, releaseAllRuns,
  reloadApp, runPid, sendPrompt, sendSteerKey, setBgMode, setInterruptDelay, setPanes, setScenario, taskStatus, trackBg, trackChat,
  until, waitBodyText, waitCardShown, waitStopGone,
} from './helpers/ui.mjs';

const CTL = process.env.R198_CTL;
const S = (n) => POOL[n];

test.beforeEach(async ({ page }) => {
  if (!CTL) throw new Error('R198_CTL 没设置:请用 run.sh 运行');
  await boot(page);
});
test.afterEach(async () => { releaseAllRuns(CTL); });   // 放行所有 gate,让每个假命令行退出,别晾着进程

// ---------------------------------------------------------------- 共用
const msgOf = (tag, w) => `R198${tag}${w} 这是${tag}的${w}消息请照常处理`;
const pre = (tag) => ({ t: 'text', text: `R198-PRE-${tag} 我先跑一条长命令` });
const fgStep = (tag, extra = {}) => ({
  t: 'bash-fg', toolId: `toolu_R198${tag}A`, taskId: `bbz${tag.toLowerCase()}a`,
  command: `R198CMD${tag} run-long-build`, description: `R198DESC${tag} 编译整个项目`, ...extra,
});
const gatePost = { t: 'gate', name: 'post' };
const MOVED = '已移到后台';

/** 打开夹具会话、写剧本、发 T1、等前台命令卡片出现。返回各类录制器与卡片出现的时刻。 */
async function startFg(page, A, steps, t1, fg) {
  await openSessionBySearch(page, A.mark);
  const chat = trackChat(page); const bg = trackBg(page); const dlg = armDialogs(page);
  setScenario(CTL, A.sid, steps);
  await sendPrompt(page, t1);
  const shownAt = await waitCardShown(page, fg);
  return { chat, bg, dlg, shownAt };
}
/** 命令已跑 3 秒以上的标志:卡片上出现「移到后台」按钮。 */
const waitBtn = (page, timeout = 12_000) => expect(moveBtn(page).first(), '命令开始约 3 秒后卡片上应出现「移到后台」按钮').toBeVisible({ timeout });
/** 等卡片变成"已移到后台"(页面可见文字里出现「已移到后台」)。返回等了多久。 */
async function waitMoved(page, since, timeout = 8_000, label = '') {
  await until(async () => (await phraseCount(page, MOVED)) > 0, { timeout, message: `${label}卡片应变成「${MOVED}」` });
  return Date.now() - since;
}
const textOnPage = async (page, s) => (await bodyText(page)).includes(s);
/** 点按钮后:要么原生 confirm / alert 出现,要么应用内 role=dialog 出现。 */
const waitAnyDialog = (page, dlg, label, timeout = 8_000) =>
  until(async () => dlg.pending || dlg.native.length > 0 || (await anyCustomDialog(page)), { timeout, message: `${label}应弹出框` });

// ============================================================ 1. 回车:排队 + 转后台 ============================================================

test('C1 回车:命令跑了 3 秒以上时回车发消息 → 进排队栏、约 1 秒内卡片变已移到后台、一次请求、这一轮结束后排队消息自动发出并得到回复、命令仍在后台', async ({ page }) => {
  const A = S(0); const tag = 'C1'; const fg = fgStep(tag); const t1 = msgOf(tag, 'T1'); const t2 = msgOf(tag, 'T2');
  const { chat, bg } = await startFg(page, A, [pre(tag), fg], t1, fg);
  await waitBtn(page);
  const tPress = Date.now();
  await sendPrompt(page, t2);
  await expect(queueItem(page, t2), 'T2 应进入排队栏(恰好 1 条)').toHaveCount(1, { timeout: 8_000 });
  const waited = await waitMoved(page, tPress, 8_000, '回车后 ');
  expect(waited, `回车后卡片应在约 1 秒内变已移到后台(实际 ${waited} 毫秒)`).toBeLessThanOrEqual(4_500);

  // 页面只发了一次"全部"请求,应答 200 且 moved 含这条命令
  await until(() => bg.calls.length >= 1 && bg.calls[0].done, { timeout: 8_000, message: '应有一次 POST /api/chat/background-tasks 并拿到应答' });
  expect(bg.calls.length, '回车那一路只请求一次').toBe(1);
  const c = bg.calls[0];
  expect(c.body && c.body.sessionId, '请求体 sessionId').toBe(A.sid);
  expect(c.body && 'toolUseId' in c.body, '回车那一路请求"全部",不带 toolUseId').toBe(false);
  expect(c.status, '应答状态码').toBe(200);
  expect(c.resp && c.resp.ok, '应答 ok').toBe(true);
  expect(c.resp && c.resp.moved, '应答 moved').toEqual([fg.toolId]);

  // 这一轮结束后排队消息自动发出并得到回复;命令仍在后台
  const p2 = await until(() => chat.postsWith(t2)[0], { timeout: 30_000, message: '这一轮结束后页面应发出含 T2 的 POST /api/chat' });
  expect(p2.t, 'T2 应在转走之后才发出').toBeGreaterThanOrEqual(tPress);
  await waitBodyText(page, `R198-REPLY ${t2}`, 25_000).toBe(true);
  await expect(queueItem(page, t2), 'T2 发出后应从排队栏消失').toHaveCount(0, { timeout: 10_000 });
  expect(countTranscriptLines(A.sid, 'user', t2), 'T2 在会话文件里恰好 1 条用户消息').toBe(1);
  expect(taskStatus(CTL, A.sid, fg.taskId), '命令仍在后台运行(没被杀)').toBe('running');
  const e = await activeEntry(page, A.sid);
  expect(e && Array.isArray(e.movedTasks), 'GET /api/agents/active 的会话条目应带 movedTasks').toBe(true);
  const mt = e.movedTasks.find((m) => m.taskId === fg.taskId);
  expect(mt && mt.toolUseId, 'movedTasks 里该命令的 toolUseId').toBe(fg.toolId);
  expect(mt && mt.description, 'movedTasks 里该命令的 description').toBe(fg.description);
  expect(String(mt && mt.outputPath), 'movedTasks 里该命令的 outputPath 含任务编号').toContain(fg.taskId);
});

// ============================================================ 2. Cmd/Ctrl+Enter 与「⚡ 并入」 ============================================================

test('C2a Cmd/Ctrl+Enter:命令跑了 3 秒以上时用 Cmd/Ctrl+Enter 发消息 → 卡片变已移到后台、模型在同一轮里回复这条消息(不另起一轮)', async ({ page }) => {
  const A = S(1); const tag = 'C2A'; const fg = fgStep(tag); const t1 = msgOf(tag, 'T1'); const t2 = msgOf(tag, 'T2');
  const { chat, bg } = await startFg(page, A, [pre(tag), fg], t1, fg);
  await waitBtn(page);
  const tPress = Date.now();
  await sendSteerKey(page, t2);
  const waited = await waitMoved(page, tPress, 8_000, 'Cmd/Ctrl+Enter 后 ');
  expect(waited, `卡片应很快变已移到后台(实际 ${waited} 毫秒)`).toBeLessThanOrEqual(4_500);
  await waitBodyText(page, `R198-STEER-REPLY ${t2}`, 25_000).toBe(true);   // 同一轮里回复并入的消息
  const replies = logOf(CTL, A.sid, 'steer-reply');
  expect(replies.length, '命令行在同一轮里回复了并入消息(恰好 1 次)').toBe(1);
  expect(replies[0].turn, '并入消息的回复发生在第 1 轮(T1 那一轮)里').toBe(1);
  expect(replies[0].text, '并入消息原文').toBe(t2);
  expect(logOf(CTL, A.sid, 'turn-start').filter((x) => String(x.text).includes(t2)).length, 'T2 不应另起一轮').toBe(0);
  expect(chat.postsWith(t2).length, 'T2 不应走 POST /api/chat(它是并入)').toBe(0);
  expect(bg.calls.length >= 1 && bg.calls.every((c) => c.status === 200), '转后台请求应答 200').toBe(true);
  expect(logOf(CTL, A.sid, 'moved').length, '命令只被转了一次').toBe(1);
  expect(taskStatus(CTL, A.sid, fg.taskId), '命令仍在后台运行').toBe('running');
});

test('C2b ⚡并入:先回车进排队栏(转后台被拒、命令仍在前台),再点排队栏的「⚡ 并入」→ 并入被接受后卡片变已移到后台、模型在同一轮里回复', async ({ page }) => {
  const A = S(2); const tag = 'C2B'; const fg = fgStep(tag); const t1 = msgOf(tag, 'T1'); const t2 = msgOf(tag, 'T2');
  const { chat, bg } = await startFg(page, A, [pre(tag), fg], t1, fg);
  await waitBtn(page);
  setBgMode(CTL, A.sid, 'reject:R198拒绝原话-后台任务已被关闭');   // 让回车那一路的转后台失败,这样"并入"那一路的转后台才是唯一能转走命令的动作
  await sendPrompt(page, t2);
  await expect(queueItem(page, t2), 'T2 应进入排队栏(恰好 1 条)').toHaveCount(1, { timeout: 8_000 });
  await until(() => bg.calls.length >= 1 && bg.calls[0].done, { timeout: 8_000, message: '回车应触发一次转后台请求' });
  await page.waitForTimeout(1_500);
  expect(await phraseCount(page, MOVED), '回车那一路被拒绝,命令应仍在前台').toBe(0);
  setBgMode(CTL, A.sid, 'ok');
  const callsBefore = bg.calls.length;
  const tClick = Date.now();
  await page.getByRole('button', { name: /并入/ }).click();
  const waited = await waitMoved(page, tClick, 10_000, '点并入后 ');
  expect(waited, `并入后卡片应很快变已移到后台(实际 ${waited} 毫秒)`).toBeLessThanOrEqual(5_500);
  expect(bg.calls.length, '并入被接受后应再请求一次转后台').toBeGreaterThan(callsBefore);
  await waitBodyText(page, `R198-STEER-REPLY ${t2}`, 25_000).toBe(true);
  const replies = logOf(CTL, A.sid, 'steer-reply');
  expect(replies.map((r) => r.turn), '并入消息在 T1 那一轮里被回复(恰好 1 次)').toEqual([1]);
  expect(chat.postsWith(t2).length, 'T2 不应再走 POST /api/chat').toBe(0);
  await expect(queueItem(page, t2), '并入后排队栏里不再有 T2').toHaveCount(0, { timeout: 10_000 });
  expect(countTranscriptLines(A.sid, 'user', t2) <= 1, 'T2 不重复进会话').toBe(true);
});

// ============================================================ 3. 命令刚开始就回车 ============================================================

test('C3 命令刚开始(不到 3 秒)就回车 → 消息进排队栏;约 3 秒登记后命令被自动转走,卡片变已移到后台;命令行只转了一次', async ({ page }) => {
  const A = S(3); const tag = 'C3'; const fg = fgStep(tag); const t1 = msgOf(tag, 'T1'); const t2 = msgOf(tag, 'T2');
  const { chat, shownAt } = await startFg(page, A, [pre(tag), fg], t1, fg);
  const sinceShown = Date.now() - shownAt;
  await sendPrompt(page, t2);
  await expect(queueItem(page, t2), 'T2 应进入排队栏(恰好 1 条)').toHaveCount(1, { timeout: 8_000 });
  if (sinceShown < 1_500) {
    await page.waitForTimeout(500);
    expect(await phraseCount(page, MOVED), '命令还没登记(不到 3 秒)时卡片不该显示已移到后台').toBe(0);
  } else {
    test.info().annotations.push({ type: '计时提示', description: `回车发在卡片出现后 ${sinceShown} 毫秒,未做"登记前不显示已移到后台"的检查` });
  }
  const elapsed = await waitMoved(page, shownAt, 12_000, '登记后 ');
  expect(elapsed, `命令约 3 秒登记后应被转走(卡片出现后 ${elapsed} 毫秒)`).toBeGreaterThanOrEqual(2_500);
  expect(elapsed, `命令应在登记后不久被转走(卡片出现后 ${elapsed} 毫秒)`).toBeLessThanOrEqual(9_000);
  const reg = logOf(CTL, A.sid, 'registered'); const mv = logOf(CTL, A.sid, 'moved');
  expect(reg.length, '命令行登记过这条命令').toBe(1);
  expect(mv.length, '命令只被转了一次').toBe(1);
  expect(mv[0].ts, '转走发生在登记之后').toBeGreaterThanOrEqual(reg[0].ts);
  await waitBodyText(page, `R198-REPLY ${t2}`, 30_000).toBe(true);   // 这一轮结束后排队消息照常发出
  expect(chat.postsWith(t2).length, 'T2 只发一次').toBe(1);
  expect(countTranscriptLines(A.sid, 'user', t2), 'T2 在会话文件里恰好 1 条').toBe(1);
});

// ============================================================ 4. 「移到后台」按钮 ============================================================

test('C4 按钮:约 3 秒后前台命令卡片出现「移到后台」按钮(已结束的命令、模型用后台方式起的命令卡片上没有)→ 点它只转这一条,按钮消失,这一轮接着走', async ({ page }) => {
  const A = S(4); const tag = 'C4'; const fg = fgStep(tag); const t1 = msgOf(tag, 'T1');
  const done = { t: 'bash-done', toolId: 'toolu_R198C4D', command: 'R198CMD-C4DONE echo hi', description: 'R198DESC-C4DONE 已结束的命令' };
  const mbg = { t: 'bash-modelbg', toolId: 'toolu_R198C4M', taskId: 'bbzc4m', command: 'R198CMD-C4MBG npm run dev', description: 'R198DESC-C4MBG 模型用后台方式起的命令' };
  const { bg, shownAt } = await startFg(page, A, [pre(tag), done, mbg, fg, gatePost], t1, fg);
  if (Date.now() - shownAt < 2_300) expect(await moveBtn(page).count(), '命令刚开始(不到 3 秒)时还没有按钮').toBe(0);
  await waitBtn(page);
  await page.waitForTimeout(800);
  expect(await moveBtn(page).count(), '整页只有前台那一条命令有按钮(已结束的、模型后台起的都没有)').toBe(1);
  await expect(moveBtn(page).first(), '按钮的 aria-label').toHaveAttribute('aria-label', '移到后台');
  const own = await btnOwnedBy(page, [fg.command, fg.description], [done.command, done.description, mbg.command, mbg.description]);
  expect(own.found, '按钮应在前台命令的卡片里').toBe(true);
  expect(own.hasOthers, '按钮所在卡片不应同时包含别的命令').toBe(false);

  await moveBtn(page).first().click();
  await until(() => bg.withTool().length >= 1 && bg.withTool()[0].done, { timeout: 8_000, message: '点按钮应发出带 toolUseId 的请求并拿到应答' });
  const c = bg.withTool()[0];
  expect(c.body.sessionId, '请求体 sessionId').toBe(A.sid);
  expect(c.body.toolUseId, '按钮只转这一条:toolUseId = 前台命令的 tool_use_id').toBe(fg.toolId);
  expect(c.status, '应答状态码').toBe(200);
  expect(c.resp && c.resp.moved, '应答 moved').toEqual([fg.toolId]);
  await waitMoved(page, Date.now(), 8_000, '点按钮后 ');
  expect(await moveBtn(page).count(), '转走后按钮应消失').toBe(0);
  expect(await phraseCount(page, '已移到后台运行'), '只有被点的那条命令显示已移到后台(1 处底栏)').toBe(1);
  expect(taskStatus(CTL, A.sid, mbg.taskId), '模型自己起的后台命令不受影响').toBe('running');
  openGate(CTL, A.sid, 'post');   // 这一轮接着往下走
  await waitBodyText(page, `R198-REPLY ${t1}`, 20_000).toBe(true);
  await waitStopGone(page, 20_000, '这一轮接着走完后');
});

// ============================================================ 5. 切会话 / 刷新后按钮仍在;进程面板 ============================================================

test('C5 命令仍在前台时切到别的会话再切回、刷新页面后回到这个会话,按钮仍在;被转走的命令列在进程面板「后台任务」里(刷新后仍在),能在那里停掉', async ({ page }) => {
  const A = S(5); const B = S(6); const tag = 'C5'; const fg = fgStep(tag); const t1 = msgOf(tag, 'T1');
  await startFg(page, A, [pre(tag), fg, gatePost], t1, fg);
  await waitBtn(page);
  const fe = await activeEntry(page, A.sid);
  expect(fe && fe.fgTasks, 'GET /api/agents/active 的会话条目应带 fgTasks(这一轮仍在前台的命令)').toEqual([fg.toolId]);

  await openSessionBySearch(page, B.mark);   // 切到别的会话
  await openSessionBySearch(page, A.mark);   // 再切回
  await expect(moveBtn(page).first(), '切走再切回,前台命令卡片上的按钮仍在').toBeVisible({ timeout: 15_000 });
  expect(await moveBtn(page).count(), '切回后按钮恰好 1 个').toBe(1);

  await reloadApp(page);
  await openSessionBySearch(page, A.mark);
  await expect(moveBtn(page).first(), '刷新页面后回到会话,按钮仍在').toBeVisible({ timeout: 20_000 });

  await moveBtn(page).first().click();
  await waitMoved(page, Date.now(), 10_000, '点按钮后 ');
  await openRightPanel(page, 'Subagent 监控');
  await waitBodyText(page, fg.description, 15_000).toBe(true);
  await reloadApp(page);
  await openSessionBySearch(page, A.mark);
  await openRightPanel(page, 'Subagent 监控');
  expect(await phraseCount(page, fg.description) >= 1, '刷新后进程面板里仍列着被转走的命令').toBe(true);
  const me = await activeEntry(page, A.sid);
  expect(me && me.movedTasks && me.movedTasks.map((m) => m.taskId), 'movedTasks 仍含这条命令').toContain(fg.taskId);

  // 在面板里停掉它(主会话锁定前修订):进程面板里后台命令那一行的「停止」是 role="button" 的元素;现有产品按输出文件
  // 定位系统进程去杀(页面发 POST /api/bgtask/kill,body {path}),不经命令行的 stop_task。假命令行没有真实的系统进程,
  // 所以这里断言页面对这条被转走的命令发出了带正确输出文件路径的停止请求。
  const outPath = (me.movedTasks.find((m) => m.taskId === fg.taskId) || {}).outputPath;
  expect(typeof outPath === 'string' && outPath.length > 0, 'movedTasks 里这条命令带输出文件路径').toBe(true);
  const row = page.locator('div', { has: page.getByText(fg.description) })
    .filter({ has: page.locator('[role="button"]', { hasText: '停止' }) }).last();
  const stopBtn = row.locator('[role="button"]', { hasText: '停止' }).first();
  await expect(stopBtn, '进程面板里被转走的命令那一行应有「停止」').toBeVisible({ timeout: 10_000 });
  const [killReq] = await Promise.all([
    page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/bgtask/kill', { timeout: 10_000 }),
    stopBtn.click(),
  ]);
  expect(JSON.parse(killReq.postData() || '{}').path, '停止请求指向这条被转走的命令的输出文件').toBe(outPath);
});

// ============================================================ 6. 卡片底栏文案 + 回看历史 ============================================================

test('C6 被转走的命令卡片底栏写「已移到后台运行 · 任务 <编号> · 后台最长 30m,到点由命令行停止」、不出现「成功」;关掉会话再打开(回看历史)显示相同', async ({ page }) => {
  const A = S(7); const tag = 'C6'; const fg = fgStep(tag); const t1 = msgOf(tag, 'T1');
  const { bg } = await startFg(page, A, [pre(tag), fg], t1, fg);
  await waitBtn(page);
  await moveBtn(page).first().click();
  await until(() => bg.withTool().length >= 1 && bg.withTool()[0].done, { timeout: 8_000, message: '点按钮应发出请求' });
  await waitMoved(page, Date.now(), 10_000, '点按钮后 ');
  await waitBodyText(page, `R198-REPLY ${t1}`, 20_000).toBe(true);   // 直播:这一轮走完
  await waitStopGone(page, 20_000, '这一轮结束后');
  const foot = footerText(fg.taskId);
  await expandCardIfFolded(page, fg, fg.taskId);
  await waitBodyText(page, foot, 8_000).toBe(true);
  const live = await cardTextAround(page, foot, [fg.command, fg.description]);
  expect(live, '应找到含底栏文字的卡片').not.toBeNull();
  expect(live.includes('成功'), `直播时卡片里不应出现「成功」;卡片文字:${String(live).slice(0, 200)}`).toBe(false);
  expect(await phraseCount(page, MOVED) >= 2, '卡头与底栏各有一处「已移到后台」').toBe(true);

  // 关掉会话进程(命令行退出),刷新后重新打开:从会话文件回看
  const pid = runPid(CTL, A.sid);
  killRun(CTL, A.sid);
  await until(() => !pidAlive(pid), { timeout: 15_000, message: '假命令行应已退出' });
  await reloadApp(page);
  await openSessionBySearch(page, `R198${tag}T1`);
  await expandCardIfFolded(page, fg, fg.taskId);
  await waitBodyText(page, foot, 20_000).toBe(true);
  const hist = await cardTextAround(page, foot, [fg.command, fg.description]);
  expect(hist.includes('成功'), `回看历史时卡片里不应出现「成功」;卡片文字:${String(hist).slice(0, 200)}`).toBe(false);
  expect(await phraseCount(page, foot), '回看历史:底栏文字恰好出现 1 次').toBe(1);
  expect(await moveBtn(page).count(), '回看历史的卡片没有按钮').toBe(0);
});

// ============================================================ 7. 命令跑完 → 通知回合 ============================================================

test('C7 被转走的命令跑完 → 命令行自动起一轮通知模型,模型的回复显示在对话里(恰好 1 次)', async ({ page }) => {
  const A = S(8); const tag = 'C7'; const fg = fgStep(tag); const t1 = msgOf(tag, 'T1');
  await startFg(page, A, [pre(tag), fg], t1, fg);
  await waitBtn(page);
  await moveBtn(page).first().click();
  await waitMoved(page, Date.now(), 10_000, '点按钮后 ');
  await waitBodyText(page, `R198-REPLY ${t1}`, 20_000).toBe(true);
  await waitStopGone(page, 20_000, '这一轮结束后');
  expect(await bodyHas(page, 'R198-NOTIFY-REPLY'), '命令没跑完之前不该有通知回复').toBe(false);

  finishBgTasks(CTL, A.sid);   // 命令"跑完"
  await waitBodyText(page, `R198-NOTIFY-REPLY ${fg.taskId}`, 25_000).toBe(true);
  expect(await phraseCount(page, `R198-NOTIFY-REPLY ${fg.taskId}`), '通知回复在对话里恰好出现 1 次').toBe(1);
  expect(taskStatus(CTL, A.sid, fg.taskId), '命令行里这条任务已完成').toBe('completed');
  expect(logOf(CTL, A.sid, 'notify-turn').length, '命令行自动起了 1 轮通知回合').toBe(1);
});

// ============================================================ 8. 转走后点停止 ============================================================

test('C8 命令被转走后点主停止键 → 这一轮停下,被转走的命令没被杀(命令行进程还在、没收到停止任务),跑完后照样出现通知回复', async ({ page }) => {
  const A = S(9); const tag = 'C8'; const fg = fgStep(tag); const t1 = msgOf(tag, 'T1');
  await startFg(page, A, [pre(tag), fg, gatePost], t1, fg);   // 转走后这一轮停在 gate 上,模拟"模型还在继续干活"
  await waitBtn(page);
  await moveBtn(page).first().click();
  await waitMoved(page, Date.now(), 10_000, '点按钮后 ');
  expect(await anyStopVisible(page), '转走后这一轮还没结束,停止键应在').toBe(true);
  const pid = runPid(CTL, A.sid);

  await mainStopButton(page).click();
  await waitStopGone(page, 20_000, '点停止后');
  expect(logOf(CTL, A.sid, 'interrupt').length >= 1, '命令行应收到停止(interrupt)').toBe(true);
  expect(logOf(CTL, A.sid, 'stop-task').length, '不应对被转走的任务发停止').toBe(0);
  expect(taskStatus(CTL, A.sid, fg.taskId), '被转走的命令没被杀').toBe('running');
  expect(pidAlive(pid), '命令行进程还活着(后台任务还在跑)').toBe(true);

  finishBgTasks(CTL, A.sid);
  await waitBodyText(page, `R198-NOTIFY-REPLY ${fg.taskId}`, 25_000).toBe(true);
  expect(taskStatus(CTL, A.sid, fg.taskId), '命令跑完').toBe('completed');
});

// ============================================================ 9. 先点停止、还没停下时回车 ============================================================

test('C9 先点停止、这一轮还没停下时回车 → 不转后台(接口回 409 BG_STOPPING、命令行没收到任何转后台请求、卡片不显示已移到后台、无提示),消息不丢不重复;命令随停止一起结束', async ({ page }) => {
  const A = S(10); const tag = 'C9'; const fg = fgStep(tag); const t1 = msgOf(tag, 'T1'); const t2 = msgOf(tag, 'T2');
  await startFg(page, A, [pre(tag), fg], t1, fg);
  await waitBtn(page);
  setInterruptDelay(CTL, A.sid, 6_000);   // 停止后拖 6 秒才真正收尾,造出"还没停下"的窗口
  await mainStopButton(page).click();
  await until(() => logOf(CTL, A.sid, 'interrupt').length >= 1, { timeout: 8_000, message: '命令行应收到停止' });
  await sendPrompt(page, t2);   // 停止期间发的消息怎么排(进排队栏还是直接发)沿用现有规则,本用例不断言;只断言它不丢、不重复、不触发转后台
  // 直接打接口(这一轮已收到停止请求):必须拒绝,不转
  const direct = await page.evaluate(async (sessionId) => {
    const r = await fetch('/api/chat/background-tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId }) });
    let body = null; try { body = await r.json(); } catch { /* 不是 JSON */ }
    return { status: r.status, body };
  }, A.sid);
  expect(direct.status, '这一轮已收到停止请求时,POST /api/chat/background-tasks 的状态码').toBe(409);
  expect(direct.body, '应答体').toEqual({ ok: false, code: 'BG_STOPPING', error: '这一轮正在停止' });
  await page.waitForTimeout(2_000);
  expect(logOf(CTL, A.sid, 'bg-recv').length, '停止之后命令行不该收到任何转后台请求').toBe(0);
  expect(await phraseCount(page, MOVED), '卡片不该显示已移到后台').toBe(0);
  expect(await bodyHas(page, '这一轮正在停止'), '回车那一路不提示').toBe(false);
  expect(await bodyHas(page, '没能移到后台'), '回车那一路不提示').toBe(false);
  expect(await bodyHas(page, '移到后台的结果未知'), '回车那一路不提示').toBe(false);
  expect(taskStatus(CTL, A.sid, fg.taskId), '停止还没收尾,命令还在前台').toBe('foreground');

  await waitStopGone(page, 25_000, '停止收尾后');
  expect(taskStatus(CTL, A.sid, fg.taskId), '命令随这一轮的停止一起结束').toBe('interrupted');
  expect(logOf(CTL, A.sid, 'moved').length, '命令从没被转走').toBe(0);
  expect(logOf(CTL, A.sid, 'bg-recv').length, '收尾后命令行也没收到过转后台请求').toBe(0);
  // 消息不丢、不重复:停止期间发的 T2 最终恰好进会话 1 次
  await until(() => countTranscriptLines(A.sid, 'user', t2) >= 1, { timeout: 30_000, message: 'T2 最终应进会话文件' });
  await page.waitForTimeout(1_500);
  expect(countTranscriptLines(A.sid, 'user', t2), 'T2 在会话文件里恰好 1 条').toBe(1);
});

// ============================================================ 10. 超长时限 ============================================================

test('C10 命令的 timeout 大于 30 分钟:回车不转它(窗格出现「有 1 条命令设了超过 30 分钟的前台时限…」,消息照旧排队);点它的按钮先弹确认,确认前不发请求,确认后才转', async ({ page }) => {
  const A = S(11); const tag = 'C10'; const fg = fgStep(tag, { timeout: 2_400_000 }); const t1 = msgOf(tag, 'T1'); const t2 = msgOf(tag, 'T2');
  const { bg, dlg } = await startFg(page, A, [pre(tag), fg, gatePost], t1, fg);
  await waitBtn(page);
  await sendPrompt(page, t2);
  await expect(queueItem(page, t2), 'T2 照旧进排队栏').toHaveCount(1, { timeout: 8_000 });
  await waitBodyText(page, '有 1 条命令设了超过 30 分钟的前台时限', 10_000).toBe(true);
  const line = (await bodyText(page)).split('\n').find((l) => l.includes('设了超过 30 分钟的前台时限')) || '';
  expect(line, '提示整行').toBe('有 1 条命令设了超过 30 分钟的前台时限,移到后台会在后台满 30 分钟时被命令行停掉,这次没有移动;需要的话点它卡片上的「移到后台」。');
  const first = bg.all()[0];
  expect(first && first.status, '回车那一路的请求应答 200').toBe(200);
  expect(first && first.resp && first.resp.skipped, 'skipped 含这条命令,原因 LONG_TIMEOUT').toEqual([{ toolUseId: fg.toolId, reason: 'LONG_TIMEOUT' }]);
  expect(first && first.resp && first.resp.moved, 'moved 为空').toEqual([]);
  await page.waitForTimeout(1_500);
  expect(await phraseCount(page, MOVED), '超长时限的命令没被转').toBe(0);
  expect(logOf(CTL, A.sid, 'moved').length, '命令行没转过它').toBe(0);

  // 点按钮:先弹确认
  dlg.hold = true;
  await moveBtn(page).first().click();
  await waitAnyDialog(page, dlg, '点超长时限命令的按钮后 ');
  await page.waitForTimeout(800);
  expect(bg.withTool().length, '确认之前不该发出带 toolUseId 的请求').toBe(0);
  expect(await phraseCount(page, MOVED), '确认之前卡片不变').toBe(0);
  if (dlg.pending) { await dlg.pending.accept(); dlg.pending = null; }
  else {
    const d = page.locator('[role="dialog"], [role="alertdialog"]').filter({ hasText: /\S/ }).first();
    const ok = d.getByRole('button', { name: /^(确定|确认|继续|仍然移到后台|移到后台)$/ }).first();
    await ok.click();
  }
  await until(() => bg.withTool().length >= 1 && bg.withTool()[0].done, { timeout: 8_000, message: '确认后应发出带 toolUseId 的请求' });
  expect(bg.withTool()[0].body.toolUseId, '按钮请求只转这一条').toBe(fg.toolId);
  expect(bg.withTool()[0].resp && bg.withTool()[0].resp.moved, '带 toolUseId 的请求不套长时限保护').toEqual([fg.toolId]);
  await waitMoved(page, Date.now(), 8_000, '确认后 ');
});

// ============================================================ 11. 两个窗格同一会话 ============================================================

test('C11 两个窗格开着同一个会话,一个窗格回车 → 命令只被转一次,两个窗格里这张卡片都变已移到后台,另一个窗格里不再有按钮,T2 不重复', async ({ page }) => {
  const A = S(12); const tag = 'C11'; const fg = fgStep(tag); const t1 = msgOf(tag, 'T1'); const t2 = msgOf(tag, 'T2');
  await openSessionBySearch(page, A.mark);
  await setPanes(page, 2);
  await focusPane(page, 1);
  await openSessionBySearch(page, A.mark);
  await focusPane(page, 0);
  await openSessionBySearch(page, A.mark);
  expect(await page.locator('[data-testid="pane"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-owner-key') || '')).then((k) => k[0] !== '' && k[0] === k[1]), '前置:两格看的是同一会话').toBe(true);
  const chat = trackChat(page); armDialogs(page);
  setScenario(CTL, A.sid, [pre(tag), fg, gatePost]);
  await sendPrompt(page, t1, paneAt(page, 0));
  await waitCardShown(page, fg);
  await expect(moveBtn(paneAt(page, 0)).first(), '第 1 格有按钮').toBeVisible({ timeout: 15_000 });
  await expect(moveBtn(paneAt(page, 1)).first(), '第 2 格也有按钮').toBeVisible({ timeout: 15_000 });

  await sendPrompt(page, t2, paneAt(page, 0));
  await until(async () => (await paneAt(page, 0).innerText()).includes(MOVED) && (await paneAt(page, 1).innerText()).includes(MOVED), { timeout: 10_000, message: '两个窗格里这张卡片都应变已移到后台' });
  await page.waitForTimeout(1_500);
  expect(logOf(CTL, A.sid, 'moved').length, '命令只被转了一次').toBe(1);
  expect((await paneAt(page, 0).innerText()).split(`已移到后台运行 · 任务 ${fg.taskId}`).length - 1, '第 1 格底栏 1 处').toBe(1);
  expect((await paneAt(page, 1).innerText()).split(`已移到后台运行 · 任务 ${fg.taskId}`).length - 1, '第 2 格底栏 1 处').toBe(1);
  expect(await moveBtn(paneAt(page, 1)).count(), '另一个窗格里不再有按钮').toBe(0);
  expect(await moveBtn(paneAt(page, 0)).count(), '发送的窗格里也没有按钮了').toBe(0);

  openGate(CTL, A.sid, 'post');
  await waitBodyText(page, `R198-REPLY ${t2}`, 30_000).toBe(true);
  await page.waitForTimeout(1_500);
  expect(chat.postsWith(t2).length, 'T2 只发一次').toBe(1);
  expect(countTranscriptLines(A.sid, 'user', t2), 'T2 在会话文件里恰好 1 条').toBe(1);
  for (const i of [0, 1]) {
    expect((await paneAt(page, i).innerText()).split(`R198-REPLY ${t2}`).length - 1, `第 ${i + 1} 格里 T2 的回复恰好 1 次`).toBe(1);
  }
});

// ============================================================ 12. 拒绝 / 不回执 ============================================================

test('C12a 回车那一路:命令行拒绝转后台 → 窗格一行「没能移到后台:<原话>」;5 秒不回执 → 窗格一行「移到后台的结果未知:…」;两种情况消息都照旧在排队栏、命令仍在前台', async ({ page }) => {
  const A = S(13); const tag = 'C12A'; const fg = fgStep(tag); const t1 = msgOf(tag, 'T1'); const t2 = msgOf(tag, 'T2'); const t3 = msgOf(tag, 'T3');
  const REASON = 'R198拒绝原话-后台任务已被关闭';
  const { bg } = await startFg(page, A, [pre(tag), fg], t1, fg);
  await waitBtn(page);

  setBgMode(CTL, A.sid, `reject:${REASON}`);
  await sendPrompt(page, t2);
  await expect(queueItem(page, t2), 'T2 照旧在排队栏').toHaveCount(1, { timeout: 8_000 });
  await until(() => bg.all()[0] && bg.all()[0].done, { timeout: 8_000, message: '回车应触发请求并拿到应答' });
  const r1 = bg.all()[0];
  expect(r1.status, '被拒绝:HTTP 状态').toBe(409);
  expect(r1.resp && r1.resp.code, '被拒绝:code').toBe('BG_REJECTED');
  expect(r1.resp && r1.resp.error, '被拒绝:error 带命令行原话').toBe(`命令行拒绝转到后台:${REASON}`);
  await waitBodyText(page, '没能移到后台:', 8_000).toBe(true);
  expect(await bodyHas(page, REASON), '提示里带命令行原话').toBe(true);
  expect(await phraseCount(page, '没能移到后台:'), '提示只出现 1 次').toBe(1);
  expect(await phraseCount(page, MOVED), '被拒绝后卡片仍是前台').toBe(0);

  setBgMode(CTL, A.sid, 'silent');   // 命令行不回执
  const tSend = Date.now();
  await sendPrompt(page, t3);
  await expect(queueItem(page, t3), 'T3 照旧在排队栏').toHaveCount(1, { timeout: 8_000 });
  await waitBodyText(page, '移到后台的结果未知', 12_000).toBe(true);
  const waited = Date.now() - tSend;
  expect(waited, `约 5 秒不回执后才提示(实际 ${waited} 毫秒)`).toBeGreaterThanOrEqual(4_000);
  const r2 = bg.all()[1];
  expect(r2 && r2.status, '不回执:HTTP 状态').toBe(504);
  expect(r2 && r2.resp && r2.resp.code, '不回执:code').toBe('BG_TIMEOUT');
  expect(await phraseCount(page, '移到后台的结果未知'), '提示只出现 1 次').toBe(1);
  expect(await phraseCount(page, MOVED), '不回执时卡片仍是前台').toBe(0);
  expect(await queueItem(page, t2).count(), 'T2 仍在排队栏').toBe(1);
  expect(await queueItem(page, t3).count(), 'T3 仍在排队栏').toBe(1);
  expect(taskStatus(CTL, A.sid, fg.taskId), '命令仍在前台').toBe('foreground');
  expect(logOf(CTL, A.sid, 'moved').length, '命令从没被转走').toBe(0);
});

test('C12b 按钮那一路:命令行拒绝转后台 → 弹框带原话、按钮恢复可点;5 秒不回执 → 弹框说结果未知、按钮恢复可点', async ({ page }) => {
  const A = S(14); const tag = 'C12B'; const fg = fgStep(tag); const t1 = msgOf(tag, 'T1');
  const REASON = 'R198拒绝原话-后台任务已被关闭';
  const { bg, dlg } = await startFg(page, A, [pre(tag), fg], t1, fg);
  await waitBtn(page);

  setBgMode(CTL, A.sid, `reject:${REASON}`);
  await moveBtn(page).first().click();
  await until(async () => dialogShows(page, dlg, REASON), { timeout: 10_000, message: '拒绝后应弹框且带命令行原话' });
  expect(bg.withTool()[0].status, '被拒绝:HTTP 状态').toBe(409);
  expect(bg.withTool()[0].resp && bg.withTool()[0].resp.code, '被拒绝:code').toBe('BG_REJECTED');
  await dismissCustomDialogs(page);
  await expect(moveBtn(page).first(), '被拒绝后按钮恢复可点').toBeVisible();
  await expect(moveBtn(page).first(), '被拒绝后按钮恢复可点').toBeEnabled({ timeout: 5_000 });
  expect(await phraseCount(page, MOVED), '被拒绝后卡片仍是前台').toBe(0);

  setBgMode(CTL, A.sid, 'silent');
  const tClick = Date.now();
  await moveBtn(page).first().click();
  await until(async () => dialogShows(page, dlg, '结果未知'), { timeout: 14_000, message: '5 秒不回执后应弹框说结果未知' });
  const waited = Date.now() - tClick;
  expect(waited, `约 5 秒不回执后才弹框(实际 ${waited} 毫秒)`).toBeGreaterThanOrEqual(4_000);
  expect(bg.withTool()[1].status, '不回执:HTTP 状态').toBe(504);
  expect(bg.withTool()[1].resp && bg.withTool()[1].resp.code, '不回执:code').toBe('BG_TIMEOUT');
  await dismissCustomDialogs(page);
  await expect(moveBtn(page).first(), '不回执后按钮恢复可点').toBeEnabled({ timeout: 5_000 });
  expect(await phraseCount(page, MOVED), '不回执时卡片仍是前台').toBe(0);
  expect(taskStatus(CTL, A.sid, fg.taskId), '命令仍在前台').toBe('foreground');
});
