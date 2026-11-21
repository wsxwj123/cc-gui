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
