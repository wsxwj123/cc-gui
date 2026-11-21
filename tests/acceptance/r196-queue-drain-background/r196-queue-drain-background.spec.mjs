// r196 排队消息后台自动发出 —— 页面验收(黑盒)。唯一依据:.devflow/r196-queue-drain-background-接口.md 的「行为清单」V1–V10,一条对一条。
// 只由 run-isolated.sh 调起:bash tests/acceptance/r196-queue-drain-background/run-isolated.sh [--grep 'V1 ']
// 只通过页面(输入框 / 排队栏 / 窗格 / 顶栏 / 停止键)、页面发出的 POST /api/chat(Playwright 记录请求体与发出时刻;拦截 / 回 409 / 断开用 page.route)、
// GET /api/agents/active、会话文件、假命令行控制与观察文件做判断。
// 约定:A = 排队消息所属会话;Q / Q1 / Q2 = 用户后来在看的别的会话;p1 = A 里发的第一条(占住回复);p2 / p3 = 回复进行中排进排队栏的消息。
//       会话池每条只用一次(回合跑完应用会改标题)。fixtures 里会话编号 → 用例的分配见各用例开头。
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { NAV, POOL, homeDir, transcriptMentions, userLineCount, readTranscript } from './helpers/fixtures.mjs';
import {
  CTL, activeEntry, addImage, attachmentCards, bubbleAttachmentImages, boot, chooseMode, clearGlobal, composer, endOfRound, finishBgTasks, finishTurn, focusPane,
  isBusyStatus, openSessionBySearch, paneKeys, paneText, panes, phaseOf, queueItemOf, queueItems, queueMessage, receivedAll, receivedOf,
  recordChat, releaseAllRuns, releaseStart, reloadApp, roundsOf, routeChat, runPid, selectModel, sendPrompt, sessionRow, setAuto, setGlobal,
  setScenario, holdStart, sleep, spawnsOf, startRunning, stopBtn, switchTo, topModel, turnIdOf, userBubbleCount, waitForPhase, waitUntil,
} from './helpers/ui.mjs';

const SETTINGS_FILE = () => path.join(homeDir(), '.claude', 'settings.json');

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
  releaseAllRuns();
  clearGlobal('auto-ms');
  try { fs.unlinkSync(SETTINGS_FILE()); } catch { /* 本来就没有 */ }
});

async function open(page, opts) {
  if (!CTL) throw new Error('R196_CTL 没设置:请用 run-isolated.sh 运行');
  await boot(page, opts);
  await openSessionBySearch(page, NAV.mark);   // 打开一次,夹具工作区与它的会话才进侧栏
  await expect(sessionRow(page, NAV.mark), '侧栏里应能看到夹具会话').toBeVisible({ timeout: 20_000 });
}
const msg = (tag, what, mark) => `R196 ${tag} ${what} ${mark} 这条消息只属于这个会话,后台发出后只该落进它自己的会话文件。`;

/** 等后台请求:至少 n 个 queuedDrain 请求;超时返回当前个数(断言处报"没有发出后台请求")。 */
const waitDrains = async (rec, n, timeout = 15_000) => { await waitUntil(() => rec.drains().length >= n, { timeout }); return rec.drains(); };

// ============================================================ V1 ============================================================
test('V1 A 回复中排一条(带一张图)→ 结果出来后立刻切到 Q 不切回:10 秒内这条后台发进 A;Q 没有;切回 A 恰好 1 条用户消息 + 附件卡片 + 回复,排队栏已空', async ({ page }) => {
  const A = POOL[0]; const Q = POOL[1];
  const p1 = msg('V1', '第一条(占住 A 的回复)', A.mark);
  const p2 = msg('V1', '排队消息(带图)', A.mark);
  await open(page);
  const rec = recordChat(page);
  await startRunning(page, A, p1);
  const stored = await addImage(page, 'r196-v1.png');
  await queueMessage(page, p2);
  await finishTurn(A.sid);
  setAuto(A.sid, 800);                       // 后台发出的那一轮让它自己走完
  await switchTo(page, Q.mark);              // 结果刚出来就切走,不再切回
  const landed = await waitUntil(() => userLineCount(A.sid, p2) === 1, { timeout: 10_000, every: 250 });
  expect(landed, `V1:A 的回合结束、用户已在 Q 之后 10 秒内,这条排队消息应已落进 A 的会话文件(现在 A 里 ${userLineCount(A.sid, p2)} 次;后台请求 ${rec.drains().length} 个)`).toBeTruthy();
  const drains = rec.drains();
  expect(drains.length, 'V1:带 queuedDrain 的后台请求应恰好 1 个').toBe(1);
  expect(drains[0].body.sessionId, 'V1:后台请求的 sessionId 应是 A').toBe(A.sid);
  expect(drains[0].body.queuedDrain, 'V1:后台请求体 queuedDrain 应为 true').toBe(true);
  expect(String(drains[0].body.prompt), 'V1:后台请求的提示里应有附件引用(上传后的文件名)').toContain(stored);
  expect(drains[0].panes, 'V1:发出时窗格应显示 Q 而不是 A').toEqual([Q.sid]);
  expect(userLineCount(Q.sid, p2) + transcriptMentions(Q.sid, p2), 'V1:Q 的会话文件里不应有这条').toBe(0);
  expect(((await paneText(page, Q.sid)) || '').includes(p2), 'V1:Q 的窗格里不应出现这条').toBe(false);

  await switchTo(page, A.mark);
  await expect.poll(() => userBubbleCount(page, p2), { message: 'V1:切回 A,这条用户消息应恰好显示 1 个', timeout: 20_000 }).toBe(1);
  await expect.poll(() => bubbleAttachmentImages(page, p2, 'r196-v1.png'), { message: 'V1:切回 A,这条用户消息上应带附件图片卡片(r196-v1.png)', timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  await expect(page.getByText(`R196-CHUNK1 ${A.sid.slice(0, 8)} 收到:${p2}`, { exact: false }).first(), 'V1:这条的回复应可见').toBeVisible({ timeout: 20_000 });
  expect(await queueItemOf(page, p2).count(), 'V1:排队栏里不应再有这条').toBe(0);
  expect(userLineCount(A.sid, p2), 'V1:A 的会话文件里这条恰好 1 次').toBe(1);
});

// ============================================================ V2 ============================================================
test('V2 两个窗格分别显示 Q1、Q2,A 不在任何窗格,A 排了两条 → 按顺序各发一次、都进 A;第二次发出时第一轮已结束', async ({ page }) => {
  const A = POOL[2]; const Q1 = POOL[3]; const Q2 = POOL[4];
  const p1 = msg('V2', '第一条(占住 A 的回复)', A.mark);
  const p2 = msg('V2', '排队第一条', A.mark);
  const p3 = msg('V2', '排队第二条', A.mark);
  await open(page, { split: true });
  await expect(panes(page), 'V2:应是两格分屏').toHaveCount(2, { timeout: 15_000 });
  const rec = recordChat(page);
  const left = panes(page).nth(0);
  await startRunning(page, A, p1, left);
  await queueMessage(page, p2, left);
  await queueMessage(page, p3, left);
  await focusPane(page, 1); await switchTo(page, Q2.mark);
  await focusPane(page, 0); await switchTo(page, Q1.mark);
  expect(await paneKeys(page), 'V2:前置:两格应分别显示 Q1、Q2,A 不在任何窗格').toEqual([Q1.sid, Q2.sid]);
  await finishTurn(A.sid);
  setAuto(A.sid, 1200);
  const both = await waitUntil(() => userLineCount(A.sid, p2) === 1 && userLineCount(A.sid, p3) === 1, { timeout: 30_000, every: 300 });
  expect(both, `V2:A 的会话文件里两条排队消息应各 1 次(p2=${userLineCount(A.sid, p2)} p3=${userLineCount(A.sid, p3)};后台请求 ${rec.drains().length} 个)`).toBeTruthy();
  const drains = rec.drains();
  expect(drains.map((d) => d.body.sessionId), 'V2:两次后台请求都应发给 A').toEqual([A.sid, A.sid]);
  expect(drains.map((d) => (String(d.body.prompt).includes(p2) ? 'p2' : (String(d.body.prompt).includes(p3) ? 'p3' : '?'))), 'V2:两次后台请求应一前一后:先 p2 后 p3').toEqual(['p2', 'p3']);
  const end2 = endOfRound(A.sid, p2);
  expect(end2, 'V2:第一条后台消息那一轮应已结束').not.toBeNull();
  expect(drains[1].t, 'V2:第二次发出时,第一条后台消息那一轮应已结束').toBeGreaterThanOrEqual(end2.t);
  const order = readTranscript(A.sid).map((l) => JSON.stringify(l)).filter((s) => s.includes(p2) || s.includes(p3));
  expect(order.findIndex((s) => s.includes(p2)) < order.findIndex((s) => s.includes(p3)), 'V2:会话文件里 p2 应在 p3 之前').toBe(true);
  for (const Q of [Q1, Q2]) {
    expect(transcriptMentions(Q.sid, p2) + transcriptMentions(Q.sid, p3), `V2:${Q.mark} 的会话文件里不应有这两条`).toBe(0);
    const t = (await paneText(page, Q.sid)) || '';
    expect(t.includes(p2) || t.includes(p3), `V2:${Q.mark} 的窗格里不应出现这两条`).toBe(false);
  }
});

// ============================================================ V3 ============================================================
test('V3 A 有命令在前台跑时回车发第二条(命令转后台、消息进排队)→ 切到 Q → 这一轮结束后第二条后台发进 A;命令跑完后通知那一轮照常出现、没另起进程、进程号不变', async ({ page }) => {
  const A = POOL[5]; const Q = POOL[6];
  const p1 = msg('V3', '第一条(带一条前台命令)', A.mark);
  const p2 = msg('V3', '命令在跑时回车发的第二条', A.mark);
  await open(page);
  const rec = recordChat(page);
  setScenario(A.sid, [{ t: 'bash-fg', toolId: 'toolu_r196_v3', taskId: 'bgr196v3', command: 'sleep 600', description: 'R196V3 长命令', registerMs: 1500 }]);
  await switchTo(page, A.mark);
  await sendPrompt(page, p1);
  await page.waitForTimeout(4_500);                 // 命令登记后再回车(跑了 3 秒以上)
  await queueMessage(page, p2);
  await expect(page.getByText(`R196-CHUNK1 ${A.sid.slice(0, 8)} 收到:${p1}`, { exact: false }).first(), 'V3:命令转后台后这一轮应接着往下走').toBeVisible({ timeout: 30_000 });
  const pidBefore = (await activeEntry(A.sid))?.pid ?? null;
  await switchTo(page, Q.mark);
  await finishTurn(A.sid);
  setAuto(A.sid, 800);
  const landed = await waitUntil(() => userLineCount(A.sid, p2) === 1, { timeout: 15_000, every: 250 });
  expect(landed, `V3:这一轮结束、用户在 Q 之后,第二条应后台发进 A(现在 A 里 ${userLineCount(A.sid, p2)} 次;后台请求 ${rec.drains().length} 个)`).toBeTruthy();
  expect(rec.drains()[0].body.sessionId, 'V3:后台请求的 sessionId 应是 A').toBe(A.sid);
  expect(await waitUntil(() => endOfRound(A.sid, p2), { timeout: 15_000 }), 'V3:后台发出的那一轮应跑完').toBeTruthy();

  finishBgTasks(A.sid);                             // 被转走的命令跑完 → 命令行自己起通知那一轮
  const notified = await waitUntil(() => transcriptMentions(A.sid, 'R196-NOTIFY-REPLY') >= 1, { timeout: 15_000 });
  expect(notified, 'V3:命令跑完后,通知那一轮的回复应出现在 A 的会话文件里').toBeTruthy();
  const notifyEnd = await waitUntil(() => roundsOf(A.sid).find((r) => r.ev === 'end' && r.notify), { timeout: 10_000 });
  expect(notifyEnd && notifyEnd.why, 'V3:通知那一轮应正常结束(没有被中止)').toBe('result');
  expect(spawnsOf(A.sid).length, 'V3:不应给 A 另起命令行进程').toBe(1);
  const pidAfter = (await activeEntry(A.sid))?.pid ?? null;
  expect(pidBefore, 'V3:/api/agents/active 里应能读到 A 的进程号').not.toBeNull();
  expect(pidAfter, 'V3:/api/agents/active 里 A 的进程号应不变').toBe(pidBefore);
  expect(userLineCount(A.sid, p2), 'V3:A 的会话文件里第二条恰好 1 次').toBe(1);
  expect(userLineCount(Q.sid, p2), 'V3:Q 里不应有这条').toBe(0);
});

// ============================================================ V4a / V4b ============================================================
test('V4a A 设「逐步确认」+ 模型甲,Q 设「全部放行」+ 模型乙 → 在 Q 期间后台发出 A 的那条:请求体是甲 + 逐步确认,没有「A + 乙」的命令行启动', async ({ page }) => {
  const A = POOL[7]; const Q = POOL[8];
  const p1 = msg('V4a', '第一条', A.mark);
  const p2 = msg('V4a', '排队消息', A.mark);
  await open(page);
  const rec = recordChat(page);
  await switchTo(page, A.mark);
  await selectModel(page, 'opus'); await chooseMode(page, 'default');
  const modelA = await topModel(page);
  await startRunning(page, A, p1);
  const bodyModelA = rec.posts[0].body.model;          // A 在场发出第一条时请求体里的模型(甲,界面别名对应的真实模型名)
  await queueMessage(page, p2);
  await switchTo(page, Q.mark);
  await selectModel(page, 'haiku'); await chooseMode(page, 'bypassPermissions');
  const modelQ = await topModel(page);
  expect(modelQ, 'V4a:前置:Q 的模型应与 A 不同').not.toBe(modelA);
  await finishTurn(A.sid);
  setAuto(A.sid, 800);
  const drains = await waitDrains(rec, 1, 15_000);
  expect(drains.length, `V4a:Q 期间应发出后台请求(现在 ${drains.length} 个)`).toBe(1);
  expect(drains[0].body.sessionId, 'V4a:后台请求的 sessionId 应是 A').toBe(A.sid);
  expect(drains[0].body.model, `V4a:后台请求体的模型应是 A 自己的(甲=${modelA}),不是 Q 的(乙=${modelQ})`).toBe(bodyModelA);
  expect(drains[0].body.permissionMode, 'V4a:后台请求体的权限模式应是 A 自己的「逐步确认」(default)').toBe('default');
  await waitUntil(() => userLineCount(A.sid, p2) === 1, { timeout: 15_000 });
  expect([...new Set(spawnsOf(A.sid).map((s) => s.model))], 'V4a:A 的会话的命令行启动只应用甲模型,不应有「A + 乙模型」的启动').toEqual([bodyModelA]);
});

test('V4b A 从没设过权限档、全局默认「全部放行」,Q 也是「全部放行」→ 后台发出 A 的那条:权限模式是「逐步确认」', async ({ page }) => {
  const A = POOL[9]; const Q = POOL[10];
  const p1 = msg('V4b', '第一条', A.mark);
  const p2 = msg('V4b', '排队消息', A.mark);
  await open(page);
  const rec = recordChat(page);
  // 全局默认 = 全部放行:在没有任何会话选中的新会话首页上选「全部放行」(此处没有 A 的单独设置);A 本身从不设档位
  await page.getByRole('button', { name: '新建会话', exact: true }).first().click();
  await chooseMode(page, 'bypassPermissions');
  await openSessionBySearch(page, A.mark);          // 从首页回到侧栏会话列表要走搜索
  await startRunning(page, A, p1);
  expect(rec.posts[0] && rec.posts[0].body.permissionMode, 'V4b:前置:A 没单独设过档位,第一条在场发出时应按全局默认「全部放行」(bypassPermissions)').toBe('bypassPermissions');
  await queueMessage(page, p2);
  await switchTo(page, Q.mark);
  await chooseMode(page, 'bypassPermissions');
  await finishTurn(A.sid);
  setAuto(A.sid, 800);
  const drains = await waitDrains(rec, 1, 15_000);
  expect(drains.length, `V4b:Q 期间应发出后台请求(现在 ${drains.length} 个)`).toBe(1);
  expect(drains[0].body.sessionId, 'V4b:后台请求的 sessionId 应是 A').toBe(A.sid);
  expect(drains[0].body.permissionMode, 'V4b:A 没单独设过档位,后台发出的那一轮应按「逐步确认」(default)').toBe('default');
});

// ============================================================ V5 ============================================================
test('V5 在 A 上点停止后立刻切到 Q → 停稳后这条后台发进 A 一次;发出时刻晚于 A 在 /api/agents/active 里转为空闲', async ({ page }) => {
  const A = POOL[11]; const Q = POOL[12];
  const p1 = msg('V5', '第一条(随后被停止)', A.mark);
  const p2 = msg('V5', '排队消息', A.mark);
  await open(page);
  const rec = recordChat(page);
  await startRunning(page, A, p1);
  await queueMessage(page, p2);
  setAuto(A.sid, 800);
  const samples = [];
  let polling = true;
  const poller = (async () => { while (polling) { const e = await activeEntry(A.sid); samples.push({ t: Date.now(), busy: isBusyStatus(e), status: e ? e.status : null }); await sleep(100); } })();
  const stopAt = Date.now();
  await stopBtn(page).first().click();
  await switchTo(page, Q.mark);
  const landed = await waitUntil(() => userLineCount(A.sid, p2) === 1, { timeout: 25_000, every: 250 });
  polling = false; await poller;
  expect(landed, `V5:停止后停稳、用户在 Q 时,这条应后台发进 A(现在 A 里 ${userLineCount(A.sid, p2)} 次;后台请求 ${rec.drains().length} 个)`).toBeTruthy();
  const drains = rec.drains();
  expect(drains.length, 'V5:后台请求应恰好 1 个').toBe(1);
  expect(drains[0].body.sessionId, 'V5:后台请求的 sessionId 应是 A').toBe(A.sid);
  const idle = samples.find((s) => s.t >= stopAt && !s.busy);
  expect(idle, `V5:点停止之后应观察到 A 转为空闲(采样 ${JSON.stringify(samples.slice(0, 6).map((s) => s.status))}…)`).toBeTruthy();
  expect(drains[0].t + 250, `V5:后台请求发出时刻(${drains[0].t - stopAt}ms)应晚于 A 转为空闲(${idle.t - stopAt}ms)`).toBeGreaterThanOrEqual(idle.t);
  expect(userLineCount(Q.sid, p2), 'V5:Q 里不应有这条').toBe(0);
});

// ============================================================ V6 ============================================================
test('V6 第一次后台请求发出后、服务端还没答完时页面这边断开 → 用同一个回合编号重发 → A 只开一轮、这条在会话文件里 1 次', async ({ page }) => {
  const A = POOL[13]; const Q = POOL[14];
  const p1 = msg('V6', '第一条', A.mark);
  const p2 = msg('V6', '排队消息', A.mark);
  await open(page);
  const rec = recordChat(page);
  let firstBody = null;
  await routeChat(page, async (route) => {
    const b = route.request().postDataJSON();
    if (b && b.queuedDrain === true && firstBody === null) {
      firstBody = b;
      route.fetch().catch(() => {});               // 请求照常送到服务端
      await sleep(500);
      await route.abort('connectionreset');       // 页面这边断开,收不到应答
      return;
    }
    await route.continue();
  });
  await startRunning(page, A, p1);
  await queueMessage(page, p2);
  await finishTurn(A.sid);
  const spawnsBefore = spawnsOf(A.sid).length;
  holdStart(A.sid);                                // 后台发出的这一轮慢启动:服务端答不完
  setAuto(A.sid, 800);
  await switchTo(page, Q.mark);
  const reached = await waitUntil(() => receivedOf(A.sid).some((r) => r.text.includes(p2)), { timeout: 15_000 });
  expect(reached, `V6:第一次后台请求应已送到服务端、A 的命令行收到这条(后台请求 ${rec.drains().length} 个)`).toBeTruthy();
  // 主会话修订(锁定前):重发必须是页面自己发的(结果不明后同号再发),测试不代发。
  const retried = await waitUntil(() => rec.drains().length >= 2, { timeout: 25_000 });
  expect(retried, `V6:页面这边断开后,应由页面自己用同一个回合编号重发(25 秒内;现在后台请求 ${rec.drains().length} 个)`).toBeTruthy();
  releaseStart(A.sid);
  const drains = rec.drains();
  expect(drains.length, 'V6:应有两次带 queuedDrain 的请求(断开的一次 + 重发的一次)').toBeGreaterThanOrEqual(2);
  expect(turnIdOf(drains[0].body), 'V6:请求体里应有回合编号').not.toBeNull();
  expect(turnIdOf(drains[1].body), 'V6:两次请求的回合编号应相同').toBe(turnIdOf(drains[0].body));
  await waitUntil(() => userLineCount(A.sid, p2) === 1, { timeout: 20_000 });
  await sleep(3_000);
  expect(receivedOf(A.sid).filter((r) => r.text.includes(p2)).length, 'V6:A 的命令行只应收到这条一次(只开一轮)').toBe(1);
  expect(spawnsOf(A.sid).length - spawnsBefore, 'V6:最多只多一个命令行进程').toBeLessThanOrEqual(1);
  expect(userLineCount(A.sid, p2), 'V6:A 的会话文件里这条恰好 1 次').toBe(1);
});

// ============================================================ V7 ============================================================
test('V7 第一次后台请求被拦下回 409 → 等待期间切回 A → 按在场时的规则发出(2 秒加一拍轮询内),只成功发一次', async ({ page }) => {
  const A = POOL[15]; const Q = POOL[16];
  const p1 = msg('V7', '第一条', A.mark);
  const p2 = msg('V7', '排队消息', A.mark);
  await open(page);
  const rec = recordChat(page);
  let intercepted = 0;
  await routeChat(page, async (route) => {
    const b = route.request().postDataJSON();
    if (b && b.queuedDrain === true && intercepted === 0) {
      intercepted += 1;
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ ok: false, code: 'CHAT_SESSION_BUSY', error: '会话忙', reason: 'session-turn-running', pid: runPid(A.sid) }) });
      return;
    }
    await route.continue();
  });
  await startRunning(page, A, p1);
  await queueMessage(page, p2);
  await finishTurn(A.sid);
  setAuto(A.sid, 800);
  await switchTo(page, Q.mark);
  const got409 = await waitUntil(() => rec.drains().some((d) => d.status === 409), { timeout: 15_000 });
  expect(got409, `V7:Q 期间应发出后台请求并被回 409(后台请求 ${rec.drains().length} 个)`).toBeTruthy();
  const switchedAt = Date.now();
  await switchTo(page, A.mark);
  const okPost = await waitUntil(() => rec.withText(p2).find((x) => x.status === 200), { timeout: 15_000, every: 100 });
  expect(okPost, 'V7:切回 A 之后这条应被发出并成功').toBeTruthy();
  expect(okPost.t - switchedAt, 'V7:切回 A 后应在 2 秒加一拍轮询内发出(这里按 5 秒判)').toBeLessThanOrEqual(5_000);
  await waitUntil(() => userLineCount(A.sid, p2) === 1, { timeout: 15_000 });
  await sleep(3_000);
  expect(rec.withText(p2).filter((x) => x.status === 200).length, 'V7:成功发出的请求应只有 1 个').toBe(1);
  expect(userLineCount(A.sid, p2), 'V7:A 的会话文件里这条恰好 1 次').toBe(1);
  expect(userLineCount(Q.sid, p2), 'V7:Q 里不应有这条').toBe(0);
  expect((await page.locator('body').innerText()).includes('自动发送没有成功'), 'V7:409 不算失败,页面上不应出现「自动发送没有成功」').toBe(false);
});

// ============================================================ V8 ============================================================
test('V8 后台请求被拦住期间切回 A:那条显示「正在自动发出…」无编辑 / 删除按钮、「⚡ 并入」为灰、↑ 召回不取它;手打一条进排队栏不直发;放开后后台那条在前、手打那条在后各 1 次', async ({ page }) => {
  const A = POOL[17]; const Q = POOL[18];
  const p1 = msg('V8', '第一条', A.mark);
  const p2 = msg('V8', '排队消息(后台发出)', A.mark);
  const p3 = msg('V8', '手打的新消息', A.mark);
  await open(page);
  const rec = recordChat(page);
  let release; const gate = new Promise((r) => { release = r; });
  let held = 0;
  await routeChat(page, async (route) => {
    const b = route.request().postDataJSON();
    if (b && b.queuedDrain === true && held === 0) { held += 1; await gate; }
    await route.continue();
  });
  await startRunning(page, A, p1);
  await queueMessage(page, p2);
  await finishTurn(A.sid);
  setAuto(A.sid, 800);
  await switchTo(page, Q.mark);
  const sent = await waitDrains(rec, 1, 15_000);
  expect(sent.length, `V8:Q 期间应发出后台请求(现在 ${sent.length} 个)`).toBe(1);
  await switchTo(page, A.mark);
  const item = queueItemOf(page, p2);
  await expect(item, 'V8:正在自动发出的那一条应显示「正在自动发出…」').toContainText('正在自动发出…', { timeout: 10_000 });
  expect(await item.locator('button').count(), 'V8:正在自动发出的那一条不应有编辑、删除按钮').toBe(0);
  await expect(page.getByRole('button', { name: /并入/ }).first(), 'V8:「⚡ 并入」应为灰(不可用)').toBeDisabled();
  const box = composer(page);
  await box.focus();
  await box.press('ArrowUp');
  await page.waitForTimeout(600);
  await expect(box, 'V8:按 ↑ 召回不应取出正在自动发出的那一条').toHaveValue('');
  expect(await queueItemOf(page, p2).count(), 'V8:按 ↑ 之后那一条仍应在排队栏里').toBe(1);
  await sendPrompt(page, p3);
  await expect.poll(() => queueItemOf(page, p3).count(), { message: 'V8:手打的新消息应进排队栏', timeout: 10_000 }).toBe(1);
  await page.waitForTimeout(1_500);
  expect(rec.withText(p3).length, 'V8:手打的新消息不应直接发出').toBe(0);
  const texts = await queueItems(page).allInnerTexts();
  expect(texts.findIndex((t) => t.includes(p2)) < texts.findIndex((t) => t.includes(p3)), 'V8:排队栏里后台那条应在前、手打那条在后').toBe(true);

  release();
  const both = await waitUntil(() => userLineCount(A.sid, p2) === 1 && userLineCount(A.sid, p3) === 1, { timeout: 40_000, every: 300 });
  expect(both, `V8:放开后两条应各进 A 一次(p2=${userLineCount(A.sid, p2)} p3=${userLineCount(A.sid, p3)})`).toBeTruthy();
  const order = readTranscript(A.sid).map((l) => JSON.stringify(l)).filter((s) => s.includes(p2) || s.includes(p3));
  expect(order.findIndex((s) => s.includes(p2)) < order.findIndex((s) => s.includes(p3)), 'V8:会话文件里后台那条应在前、手打那条在后').toBe(true);
  const end2 = await waitUntil(() => endOfRound(A.sid, p2), { timeout: 15_000 });
  expect(end2 && end2.why, 'V8:后台那一轮应正常结束').toBe('result');
});

// ============================================================ V9 ============================================================
test('V9 后台请求一直被拦住时刷新页面 → 进入 A:排队栏那条显示「不能确定是否已经发出」那句,20 秒内没有任何一方再发它', async ({ page }) => {
  const A = POOL[19]; const Q = POOL[20];
  const p1 = msg('V9', '第一条', A.mark);
  const p2 = msg('V9', '排队消息', A.mark);
  await open(page);
  const rec = recordChat(page);
  await routeChat(page, async (route) => {
    const b = route.request().postDataJSON();
    if (b && b.queuedDrain === true) return;     // 一直拦住:既不放行也不回应
    await route.continue();
  });
  await startRunning(page, A, p1);
  await queueMessage(page, p2);
  await finishTurn(A.sid);
  setAuto(A.sid, 800);
  await switchTo(page, Q.mark);
  const sent = await waitDrains(rec, 1, 15_000);
  expect(sent.length, `V9:Q 期间应发出后台请求(现在 ${sent.length} 个)`).toBe(1);
  const before = rec.posts.length;
  await reloadApp(page);
  await openSessionBySearch(page, A.mark);
  const SENTENCE = '这条在自动发出时被打断（网络中断、页面刷新或服务重启），不能确定是否已经发出；请先查看会话记录，再决定重发或删除。';
  await expect.poll(async () => (await queueItemOf(page, p2).allInnerTexts()).join(' ').replace(/\s+/g, ' '), { message: 'V9:进入 A,排队栏那条应显示「不能确定是否已经发出」那句', timeout: 15_000 }).toContain(SENTENCE);
  await sleep(20_000);
  expect(rec.posts.slice(before).filter((x) => String((x.body && x.body.prompt) || '').includes(p2)).length, 'V9:刷新后页面不应再发这条').toBe(0);
  expect(userLineCount(A.sid, p2), 'V9:A 的会话文件里不应有这条(没有任何一方发它)').toBe(0);
  expect(receivedOf(A.sid).filter((r) => r.text.includes(p2)).length, 'V9:A 的命令行不应收到这条').toBe(0);
});

// ============================================================ V10 ============================================================
test('V10 新会话第一条初始化慢(少于 15 秒)时排第二条 → 立刻切到 Q → 第一条跑完后第二条自动发进这个新会话;点进新会话排队栏已空;Q 没有', async ({ page }) => {
  const Q = POOL[21];
  const p1 = 'R196V10A 新会话的第一条,初始化会比较慢,这期间用户会切走。';
  const p2 = 'R196V10B 新会话初始化期间排进去的第二条,拿到正式编号后应自动发进这个新会话。';
  await open(page);
  const rec = recordChat(page);
  setGlobal('slow-ms', 6_000);
  setGlobal('auto-ms', 800);
  await page.getByRole('button', { name: '新建会话', exact: true }).first().click();
  await expect(composer(page), 'V10:点「新建会话」后应出现输入框').toBeVisible({ timeout: 15_000 });
  await sendPrompt(page, p1);
  await expect.poll(() => queueMessageCountOrSent(page, p1), { message: 'V10:第一条应已发出', timeout: 15_000 }).toBe(true);
  await sendPrompt(page, p2);
  await expect.poll(() => queueItemOf(page, p2).count(), { message: 'V10:初始化期间第二条应进排队栏', timeout: 15_000 }).toBe(1);
  await switchTo(page, Q.mark);
  const newSid = await waitUntil(() => (receivedAll().find((r) => r.text.includes('R196V10A')) || {}).sid, { timeout: 30_000 });
  expect(newSid, 'V10:假命令行应收到新会话的第一条').toBeTruthy();
  await waitForPhase(newSid, 'chunk1', 30_000);
  clearGlobal('slow-ms');
  const landed = await waitUntil(() => userLineCount(newSid, p2) === 1, { timeout: 40_000, every: 300 });
  expect(landed, `V10:第一条跑完后第二条应自动发进新会话 ${newSid}(现在 ${userLineCount(newSid, p2)} 次;后台请求 ${rec.drains().length} 个)`).toBeTruthy();
  const drains = rec.drains();
  expect(drains.length, 'V10:后台请求应恰好 1 个').toBe(1);
  expect(drains[0].body.sessionId, 'V10:后台请求的 sessionId 应是新会话编号').toBe(newSid);
  expect(userLineCount(Q.sid, p2) + transcriptMentions(Q.sid, p2), 'V10:Q 没有这条').toBe(0);
  await openSessionBySearch(page, 'R196V10');
  await expect.poll(() => queueItems(page).count(), { message: 'V10:点进新会话,排队栏应已空', timeout: 15_000 }).toBe(0);
  expect(userLineCount(newSid, p2), 'V10:新会话文件里第二条恰好 1 次').toBe(1);
});

/** 第一条已发出:输入框已清空且假命令行收到了它。 */
async function queueMessageCountOrSent(page, text) {
  return receivedAll().some((r) => r.text.includes(text));
}

// ============================================================ r208:W1–W4(发出时切走用谁的模型) / C1–C4(压缩分隔线只一条) ============================================================
// 会话分配(下标取自 POOL):W1 A=22 Q=23;W2 A=24 Q=25;W3 A=26 Q=27;W4 A=28;C1 A=30;C2 A=32 Q=33;C3 A=34;C4 A=36(带 2 次更早的压缩)。
// 下标 >= 22 的奇数下标(Q 类)历史回复里的模型是「乙」,其余是「甲」(见 fixtures.mjs)。
import { MODEL_JIA, MODEL_YI } from './helpers/fixtures.mjs';
import { compactNow } from './helpers/ui.mjs';

/** 前提自证:A 与 Q 都没钉模型,A 的徽章显示甲、Q 的显示乙,甲 ≠ 乙。返回 [甲, 乙] 的徽章文字。 */
async function proveBadges(page, A, Q, tag) {
  await switchTo(page, A.mark); await page.waitForTimeout(700);
  const jia = await topModel(page);
  await switchTo(page, Q.mark); await page.waitForTimeout(700);
  const yi = await topModel(page);
  expect(jia.length, `${tag}:前提:A 的模型徽章应有内容`).toBeGreaterThan(0);
  expect(yi, `${tag}:前提:A 的徽章(甲=${jia})与 Q 的徽章(乙=${yi})应不同,做不到请上报,不要改判据`).not.toBe(jia);
  return [jia, yi];
}
/** 把第一次 POST /api/checkpoints 拖住 ms 毫秒再放行;返回计数对象(hit = 已到达的快照请求数)。 */
async function holdFirstCheckpoint(page, ms = 3_000) {
  const st = { hit: 0 };
  await page.route((url) => url.pathname === '/api/checkpoints', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    st.hit += 1;
    if (st.hit === 1) await sleep(ms);
    return route.continue();
  });
  return st;
}
/** 在 A 里发 text,等快照请求被拖住,然后立刻把窗格切到 Q。 */
async function sendThenSwitchAway(page, A, Q, text, st) {
  await switchTo(page, A.mark);
  await sendPrompt(page, text);
  expect(await waitUntil(() => st.hit >= 1, { timeout: 10_000, every: 50 }), `${A.mark} 发出后页面应先发 POST /api/checkpoints(拍文件快照)`).toBeTruthy();
  await switchTo(page, Q.mark);
}
const bodyOf = (rec, text) => (rec.withText(text)[0] || {}).body || null;

test('W1 [复现] A 发出后快照被拖住 3 秒、期间切到 Q:A 这条的请求体 sessionId=A、model=甲;A 会话文件里 1 次,Q 里 0 次', async ({ page }) => {
  const A = POOL[22]; const Q = POOL[23];
  const p = msg('W1', 'A 发出后切走', A.mark);
  await open(page);
  const rec = recordChat(page);
  await proveBadges(page, A, Q, 'W1');
  const st = await holdFirstCheckpoint(page);
  setAuto(A.sid, 800);
  await sendThenSwitchAway(page, A, Q, p, st);
  expect(await waitUntil(() => rec.withText(p).length >= 1, { timeout: 20_000 }), 'W1:快照放行后,这条应发出 POST /api/chat').toBeTruthy();
  const b = bodyOf(rec, p);
  expect(b.sessionId, 'W1:请求体 sessionId 应是 A').toBe(A.sid);
  expect(b.model, `W1:请求体 model 应是 A 历史回复里的模型(甲=${MODEL_JIA}),不是 Q 的(乙=${MODEL_YI})`).toBe(MODEL_JIA);
  await waitUntil(() => userLineCount(A.sid, p) >= 1, { timeout: 20_000 });
  await sleep(2_000);
  expect(userLineCount(A.sid, p), 'W1:A 的会话文件里这条恰好 1 次').toBe(1);
  expect(userLineCount(Q.sid, p) + transcriptMentions(Q.sid, p), 'W1:Q 的会话文件里不应有这条').toBe(0);
});

test('W2 [复现] 同 W1 但第一次请求被回 409(会话正忙)、窗格一直停在 Q:自动发出(queuedDrain)的请求体 sessionId=A、model=甲;A 会话文件里最终 1 次,Q 里 0 次', async ({ page }) => {
  const A = POOL[24]; const Q = POOL[25];
  const p = msg('W2', '被 409 退回排队栏', A.mark);
  await open(page);
  const rec = recordChat(page);
  await proveBadges(page, A, Q, 'W2');
  const st = await holdFirstCheckpoint(page);
  let busyAnswered = 0;
  await routeChat(page, async (route) => {
    const b = route.request().postDataJSON();
    if (b && !b.queuedDrain && String(b.prompt || '').includes(p) && busyAnswered === 0) {
      busyAnswered += 1;
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ ok: false, code: 'CHAT_SESSION_BUSY', error: '会话忙', reason: 'session-turn-running', pid: process.pid }) });
      return;
    }
    await route.continue();
  });
  setAuto(A.sid, 800);
  await sendThenSwitchAway(page, A, Q, p, st);
  expect(await waitUntil(() => rec.withText(p).some((x) => x.status === 409), { timeout: 20_000 }), 'W2:第一次请求应被回 409').toBeTruthy();
  const drains = await waitDrains(rec, 1, 25_000);
  expect(drains.length, `W2:被退回排队栏后应自动发出(带 queuedDrain 的请求 ${drains.length} 个)`).toBeGreaterThanOrEqual(1);
  expect(await paneKeys(page), 'W2:窗格应一直停在 Q').toEqual([Q.sid]);
  expect(drains[0].body.sessionId, 'W2:自动发出请求体 sessionId 应是 A').toBe(A.sid);
  expect(drains[0].body.model, `W2:自动发出请求体 model 应是 A 的(甲=${MODEL_JIA}),不是 Q 的(乙=${MODEL_YI})`).toBe(MODEL_JIA);
  await waitUntil(() => userLineCount(A.sid, p) >= 1, { timeout: 20_000 });
  await sleep(2_000);
  expect(userLineCount(A.sid, p), 'W2:A 的会话文件里这条最终恰好 1 次').toBe(1);
  expect(userLineCount(Q.sid, p) + transcriptMentions(Q.sid, p), 'W2:Q 的会话文件里不应有这条').toBe(0);
});

test('W3 [回归] A 钉了模型丙(haiku)、发出后快照被拖住期间切到 Q:请求体 model 是丙,不是甲也不是乙', async ({ page }) => {
  const A = POOL[26]; const Q = POOL[27];
  const p = msg('W3', 'A 钉了模型', A.mark);
  await open(page);
  const rec = recordChat(page);
  const [jia, yi] = await proveBadges(page, A, Q, 'W3');
  await switchTo(page, A.mark);
  await selectModel(page, 'haiku');
  const bing = await topModel(page);
  expect(bing, `W3:前提:钉模型后 A 的徽章(丙=${bing})应与甲(${jia})、乙(${yi})都不同`).not.toBe(jia);
  expect(bing, 'W3:前提:丙应不同于乙').not.toBe(yi);
  const st = await holdFirstCheckpoint(page);
  setAuto(A.sid, 800);
  await sendThenSwitchAway(page, A, Q, p, st);
  expect(await waitUntil(() => rec.withText(p).length >= 1, { timeout: 20_000 }), 'W3:快照放行后这条应发出').toBeTruthy();
  const b = bodyOf(rec, p);
  expect(b.sessionId, 'W3:请求体 sessionId 应是 A').toBe(A.sid);
  expect(b.model, 'W3:请求体 model 应是钉的模型丙(haiku)').toMatch(/haiku/i);
  expect([MODEL_JIA, MODEL_YI], 'W3:请求体 model 不应是甲或乙').not.toContain(b.model);
  await waitUntil(() => userLineCount(A.sid, p) >= 1, { timeout: 20_000 });
  expect(userLineCount(Q.sid, p) + transcriptMentions(Q.sid, p), 'W3:Q 里不应有这条').toBe(0);
});

test('W4 [回归] A 没钉模型、不切走:请求体 model=甲;这一轮结束后 A 里这条用户消息 1 个、回复 1 个,排队栏为空', async ({ page }) => {
  const A = POOL[28];
  const p = msg('W4', '不切走', A.mark);
  await open(page);
  const rec = recordChat(page);
  const st = await holdFirstCheckpoint(page, 500);
  setAuto(A.sid, 800);
  await switchTo(page, A.mark);
  await sendPrompt(page, p);
  expect(await waitUntil(() => st.hit >= 1, { timeout: 10_000, every: 50 }), 'W4:发出后页面应先发 POST /api/checkpoints').toBeTruthy();
  expect(await waitUntil(() => rec.withText(p).length >= 1, { timeout: 20_000 }), 'W4:这条应发出').toBeTruthy();
  const b = bodyOf(rec, p);
  expect(b.sessionId, 'W4:请求体 sessionId 应是 A').toBe(A.sid);
  expect(b.model, `W4:A 没钉模型,请求体 model 应是 A 历史回复里的模型(甲=${MODEL_JIA})`).toBe(MODEL_JIA);
  expect(await waitUntil(() => endOfRound(A.sid, p), { timeout: 30_000 }), 'W4:这一轮应结束').toBeTruthy();
  const reply = `R196-FINAL ${A.sid.slice(0, 8)}`;
  await expect.poll(() => leafCount(page, reply), { message: 'W4:这一轮的回复(收尾那块)应恰好显示 1 个', timeout: 20_000 }).toBe(1);
  await expect.poll(() => userBubbleCount(page, p), { message: 'W4:这条用户消息应恰好显示 1 个', timeout: 15_000 }).toBe(1);
  await sleep(2_000);
  expect(await userBubbleCount(page, p), 'W4:隔 2 秒后用户消息仍恰好 1 个').toBe(1);
  expect(await leafCount(page, reply), 'W4:隔 2 秒后回复仍恰好 1 个').toBe(1);
  expect(await queueItems(page).count(), 'W4:排队栏应为空').toBe(0);
  expect(userLineCount(A.sid, p), 'W4:A 的会话文件里这条恰好 1 次').toBe(1);
});

/** 消息区里「文字含 needle 且没有更内层的元素也含它」的元素个数(避免嵌套元素重复计数)。 */
const leafCount = (page, needle) => page.evaluate((n) => {
  const list = document.querySelector('[data-cgui="message-list"]');
  if (!list) return -1;
  return [...list.querySelectorAll('*')].filter((e) => (e.textContent || '').includes(n) && ![...e.children].some((c) => (c.textContent || '').includes(n))).length;
}, needle);

/** 消息区里整段文字恰好是「上下文已压缩」的分隔线条数;userText 给了就只数该用户消息之后的,null 数整页。-2 = 找不到那条用户消息。 */
const dividers = (page, userText) => page.evaluate(({ userText: ut }) => {
  const norm = (e) => (e.textContent || '').replace(/\s+/g, ' ').trim();
  const list = document.querySelector('[data-cgui="message-list"]');
  if (!list) return -1;
  const divs = [...list.querySelectorAll('*')].filter((e) => norm(e) === '上下文已压缩' && ![...e.children].some((c) => norm(c) === '上下文已压缩'));
  if (ut === null) return divs.length;
  const us = [...list.querySelectorAll('[data-cgui="message-user"]')].filter((b) => (b.textContent || '').includes(ut));
  if (!us.length) return -2;
  const u = us[us.length - 1];
  return divs.filter((d) => !u.contains(d) && (u.compareDocumentPosition(d) & Node.DOCUMENT_POSITION_FOLLOWING)).length;
}, { userText });
/** 分隔线条数先等到 n,再保持 3 秒每 0.4 秒复查一次都仍是 n(抓「后来又多出一条 / 少一条」)。 */
async function expectDividers(page, userText, n, label) {
  await expect.poll(() => dividers(page, userText), { message: `${label}:这一轮用户消息之后的压缩分隔线应恰好 ${n} 条`, timeout: 15_000, intervals: [250] }).toBe(n);
  for (let i = 0; i < 8; i += 1) { await sleep(400); expect(await dividers(page, userText), `${label}:保持 3 秒内分隔线应一直是 ${n} 条(第 ${i + 1} 次复查)`).toBe(n); }
}
/** 回合在跑且页面已显示它(第一块文字 + 可用的停止键)。 */
async function expectRunningShown(page, A, p1, label) {
  await expect(page.getByText(`R196-CHUNK1 ${A.sid.slice(0, 8)} 收到:${p1}`, { exact: false }).first(), `${label}:页面应显示这一轮正在进行`).toBeVisible({ timeout: 30_000 });
  await expect(stopBtn(page).first(), `${label}:这一轮还在跑,停止键应可用`).toBeEnabled({ timeout: 15_000 });
}

test('C1 [复现] A 有一轮在跑、刷新页面后进入 A(重新接上),命令行此时压缩一次:在跑时分隔线恰好 1 条,结束后仍恰好 1 条', async ({ page }) => {
  const A = POOL[30];
  const p1 = msg('C1', '一轮进行中(刷新)', A.mark);
  await open(page);
  await startRunning(page, A, p1);
  await reloadApp(page);
  await openSessionBySearch(page, A.mark);
  await expectRunningShown(page, A, p1, 'C1');
  compactNow(A.sid);
  await expectDividers(page, p1, 1, 'C1(这一轮还在跑)');
  await finishTurn(A.sid);
  await expect.poll(() => phaseOf(A.sid), { message: 'C1:这一轮应结束' }).toBe('final');
  await expectDividers(page, p1, 1, 'C1(这一轮结束后)');
});

test('C2 [回归] A 有一轮在跑、切到 Q 期间命令行压缩一次、再切回 A:在跑时分隔线恰好 1 条,结束后仍恰好 1 条', async ({ page }) => {
  const A = POOL[32]; const Q = POOL[33];
  const p1 = msg('C2', '一轮进行中(切走再切回)', A.mark);
  await open(page);
  await startRunning(page, A, p1);
  await switchTo(page, Q.mark);
  compactNow(A.sid);                        // 切走期间压缩
  await sleep(1_500);
  await switchTo(page, A.mark);
  await expectRunningShown(page, A, p1, 'C2');
  await expectDividers(page, p1, 1, 'C2(这一轮还在跑)');
  await finishTurn(A.sid);
  await expect.poll(() => phaseOf(A.sid), { message: 'C2:这一轮应结束' }).toBe('final');
  await expectDividers(page, p1, 1, 'C2(这一轮结束后)');
});

test('C3 [回归] 一直看着 A,这一轮中途压缩一次:在跑时分隔线已出现且恰好 1 条,结束后仍恰好 1 条', async ({ page }) => {
  const A = POOL[34];
  const p1 = msg('C3', '一直看着', A.mark);
  await open(page);
  await startRunning(page, A, p1);
  compactNow(A.sid);
  await expectDividers(page, p1, 1, 'C3(这一轮还在跑)');
  await finishTurn(A.sid);
  await expect.poll(() => phaseOf(A.sid), { message: 'C3:这一轮应结束' }).toBe('final');
  await expectDividers(page, p1, 1, 'C3(这一轮结束后)');
});

test('C4 [回归] A 的会话记录里有 2 次更早的压缩:打开 A,整页压缩分隔线恰好 2 条', async ({ page }) => {
  const A = POOL[36];
  await open(page);
  await switchTo(page, A.mark);
  await expect(page.locator('[data-cgui="message-list"]').getByText(`${A.mark} 压缩后的第2条回复。`).first(), 'C4:A 的历史应已显示出来').toBeVisible({ timeout: 20_000 });
  await expectDividers(page, null, 2, 'C4(打开 A)');
});
