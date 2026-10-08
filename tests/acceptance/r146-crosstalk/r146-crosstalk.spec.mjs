// r146 串会话 / 状态归属验收(黑盒)。只由 run.sh 调起:tests/acceptance/r146-crosstalk/run.sh [-g 'R1']
// 依据:.devflow/BRIEF-r146.md(R1–R8)。套件结构照抄 r140-crosstalk(假 claude + 隔离实例 + 会话切换助手),
// helpers 是从 r140 复制来的副本(r140 原目录只读)。
//
// 为什么要拦 /api/checkpoints:普通发送里,用户气泡要等"发送前拍快照"那一次往返回来才画
// (App.jsx 的 deferBubbleForAsk),POST /api/chat 也在它之后才发。真实用户机器上大项目的 git 快照
// 要几百毫秒到几秒 —— 用户在这段时间里点侧栏切会话,就是 R1 / R2 的现场。夹具工作区是空目录,快照
// 毫秒级就回来,窗口太窄点不进去,所以测试把这一次往返拦住、等切走之后再放行(只拖延,不改响应)。
import { test, expect } from '@playwright/test';
import { NAV, R146, live, transcriptMentions } from './helpers/fixtures.mjs';
import {
  boot, clearError, clearSlowStart, clearSlowStartFor, closePaneAt, focusPane, hitsDump, hitsFor, holdRequests,
  holdSession, injectError, openRightPanel, openSessionBySearch, paneAt, paneOwners, phaseOf, recordChatPosts,
  releaseAllRuns, releaseChunk2, releaseSession, releaseTurnEnd, runAlive, scanForText, sendInPaneAt, sendPrompt,
  sessionRow, setPanes, startRecorder, stopRecorder, switchTo, userBubbleCount, waitTurnRunning,
} from './helpers/ui.mjs';

const CTL = process.env.R118_CTL;

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openSessionBySearch(page, NAV.mark);   // 打开一次,夹具项目与它的会话才进侧栏
  await expect(sessionRow(page, NAV.mark), '侧栏里应能看到夹具会话').toBeVisible({ timeout: 20_000 });
});

test.afterEach(async ({ page }) => {
  try { await page.unroute('**/api/checkpoints'); } catch { /* 页面可能已关 */ }
  clearSlowStart(CTL);
  for (const { sid } of R146) { clearSlowStartFor(CTL, sid); clearError(CTL, sid); }
  releaseAllRuns(CTL);     // 别把任何一条会话的回合晾在停住状态
});

/** 拦住"发送前拍快照"的 POST(只拖延,放行后原样转发)。 */
async function gateCheckpoints(page) {
  let open;
  const gate = new Promise((r) => { open = r; });
  let held = 0;
  await page.route('**/api/checkpoints', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    held += 1;
    await gate;
    return route.continue();
  });
  return { release: () => open(), held: () => held };
}

/** 等下一次 POST /api/chat 的响应(= 这条消息真的发给了服务端)。 */
const nextChatPost = (page) => page.waitForResponse(
  (r) => /\/api\/chat$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST', { timeout: 30_000 });

/** 让 B 先跑起来并停在第一块(B 有一条在跑的回合)。 */
async function startLongTurn(page, S, prompt) {
  await switchTo(page, S.mark);
  await sendPrompt(page, prompt);
  await waitTurnRunning(page, S.sid, prompt);
}

/** 放行一整轮并等它在界面上收尾(定稿文字出现 + 停止按钮消失)。 */
async function finishTurn(page, S) {
  releaseChunk2(CTL, S.sid);
  releaseTurnEnd(CTL, S.sid);
  await expect(page.getByText(live.final(S.sid), { exact: false }).first(), '这一轮应跑完并显示定稿').toBeVisible({ timeout: 40_000 });
  await expect(page.getByRole('button', { name: /^停止/ }), '回合结束后不应再有停止按钮').toHaveCount(0, { timeout: 20_000 });
}

// ============================================================ R1 ============================================================
test('R1 A 发出后、快照往返期间切到正在生成的 B:A 的用户气泡任何时刻都不得出现在 B;切回 A 仍在且只画一条', async ({ page }) => {
  const A = R146[0];
  const Bx = R146[1];
  const pb = 'R146 R1 这是 B 自己的长回合,让 B 窗格有一条正在跑的流(用户实报现场 d7020984 在 Mulling)。';
  const pa = 'R146 R1 A 这条消息只属于 A:快照往返期间切走,它不该以任何形式出现在 B 的界面上。';

  await startLongTurn(page, Bx, pb);
  await switchTo(page, A.mark);
  const ck = await gateCheckpoints(page);
  const posted = nextChatPost(page);
  await sendPrompt(page, pa);
  await expect.poll(() => ck.held(), { message: '发送前的拍快照请求应已发出并被拦住', timeout: 10_000 }).toBeGreaterThan(0);

  // 快照还没回来,就切回 B(B 有回合在跑 → 自动接回它的流)
  await switchTo(page, Bx.mark);
  await expect(page.getByText(live.chunk1(Bx.sid, pb), { exact: false }).first(), '阳性对照:B 的流应已接回').toBeVisible({ timeout: 20_000 });
  await startRecorder(page, { name: 'r1', markers: [pa] });

  ck.release();
  await posted;   // A 的消息此刻才真正发出
  await expect.poll(() => transcriptMentions(A.sid, pa), { message: 'A 的会话文件应写入这条消息(证明发送路径走到了)', timeout: 30_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(2_000);
  const rec = await stopRecorder(page, 'r1');
  expect(hitsFor(rec, pa), `A 的用户消息出现在了 B 的界面上(${hitsDump(rec, pa)})`).toBe(0);
  expect(transcriptMentions(Bx.sid, pa), 'B 的会话文件里不应有 A 的消息').toBe(0);

  // 切走再切回 B(r118 暂存的入口):残留的条目会被当成 B 的暂存洗白,这里再确认一次
  await switchTo(page, NAV.mark);
  await switchTo(page, Bx.mark);
  await page.waitForTimeout(1_500);
  expect((await scanForText(page, pa)).bubbles, '再次进入 B,也不应看到 A 的消息').toBe(0);

  // 回到 A:这条消息属于 A,应当在,且只画一条
  await switchTo(page, A.mark);
  await expect.poll(() => userBubbleCount(page, pa), { message: '回到 A,这条消息应恰好显示一条', timeout: 20_000 }).toBe(1);
});

// ============================================================ R2 ============================================================
test('R2 A 的第二条在快照往返期间切走、B 有回合在跑:切回 A 时第一轮已落盘的回复必须完整显示,第二轮跑完不残留"连接中"', async ({ page }) => {
  const A = R146[3];
  const Bx = R146[4];
  const pb = 'R146 R2 这是 B 自己的长回合,让 B 有一条正在跑的流,并且它的起点早于 A 的第一轮。';
  const pa1 = 'R146 R2 A 第一轮:这一轮会完整跑完,它的回复早已写进 A 的会话文件。';
  const pa2 = 'R146 R2 A 第二轮:发出后在快照往返期间切走,切回时第一轮的回复不能被藏掉。';

  await startLongTurn(page, Bx, pb);
  // A 跑完整一轮(第一轮回复落盘)
  await switchTo(page, A.mark);
  await sendPrompt(page, pa1);
  await waitTurnRunning(page, A.sid, pa1);
  await finishTurn(page, A);
  await expect(page.getByText(live.final(A.sid), { exact: false }).first()).toBeVisible();

  // A 第二轮:憋住不产出;快照往返期间切到 B
  holdSession(CTL, A.sid);
  const ck = await gateCheckpoints(page);
  const posted = nextChatPost(page);
  await sendPrompt(page, pa2);
  await expect.poll(() => ck.held(), { message: '发送前的拍快照请求应已发出并被拦住', timeout: 10_000 }).toBeGreaterThan(0);
  await switchTo(page, Bx.mark);
  await expect(page.getByText(live.chunk1(Bx.sid, pb), { exact: false }).first(), '阳性对照:B 的流应已接回').toBeVisible({ timeout: 20_000 });
  ck.release();
  await posted;
  await page.waitForTimeout(1_500);

  // 切回 A:第一轮的回复早已落盘,必须显示
  await switchTo(page, A.mark);
  await page.waitForTimeout(3_000);   // 给自动接回(1.5s 一轮的轮询)留出时间
  await expect(page.getByText(live.final(A.sid), { exact: false }).first(), '切回 A:第一轮已经落盘的回复被藏掉了').toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(live.chunk1(A.sid, pa1), { exact: false }).first(), '切回 A:第一轮的第一块也应在').toBeVisible({ timeout: 5_000 });

  // 放行第二轮跑完:不残留"连接中",第二轮回复显示,第一轮回复仍在
  releaseSession(CTL, A.sid);
  await expect(page.getByText(live.chunk1(A.sid, pa2), { exact: false }).first(), '第二轮应开始产出').toBeVisible({ timeout: 40_000 });
  releaseChunk2(CTL, A.sid);
  releaseTurnEnd(CTL, A.sid);
  await expect(page.getByRole('button', { name: /^停止/ }), '第二轮结束后不应再有停止按钮').toHaveCount(0, { timeout: 40_000 });
  await page.waitForTimeout(2_000);
  const body = await page.locator('body').innerText();
  expect(body.includes('Connecting'), '回合已结束,界面仍挂着"Connecting"').toBe(false);
  await expect(page.getByText(live.final(A.sid), { exact: false }), '两轮的定稿都应可见').toHaveCount(2, { timeout: 15_000 });
});

// ============================================================ R3 ============================================================
test('R3 「仅回退消息」的裁剪请求未返回时切到 B:A 的历史与原文不得写进 B,B 正在跑的回合不得被停', async ({ page }) => {
  const A = R146[6];
  const Bx = R146[7];
  const pb = 'R146 R3 B 自己的长回合:A 那边的回退重发绝不能把它停掉。';
  const pa1 = 'R146 R3 A 第一轮:稍后对这条点「仅回退消息」(裁剪后自动重发原文)。';

  await startLongTurn(page, Bx, pb);
  await switchTo(page, A.mark);
  await sendPrompt(page, pa1);
  await waitTurnRunning(page, A.sid, pa1);
  await finishTurn(page, A);

  const trim = await holdRequests(page, '**/api/sessions/*/trim', (u, m) => m === 'POST');
  const card = page.locator('[data-message-id]').filter({ hasText: pa1 }).first();
  await card.hover();
  await card.getByTitle('回滚 / 重新编辑').click();
  await page.getByRole('button', { name: /仅回退消息/ }).click();
  await expect.poll(() => trim.held(), { message: '裁剪请求应已发出并被拦住', timeout: 10_000 }).toBeGreaterThan(0);

  await switchTo(page, Bx.mark);
  await expect(page.getByText(live.chunk1(Bx.sid, pb), { exact: false }).first(), '阳性对照:B 的流应已接回').toBeVisible({ timeout: 20_000 });
  trim.release();
  await page.waitForTimeout(7_000);   // 覆盖"等停止落地再重发"的 ≤4s 等待

  expect(await paneOwners(page), '窗格应仍显示 B').toEqual([Bx.sid]);
  expect(transcriptMentions(Bx.sid, pa1), 'A 的原文被重发进了 B 的会话文件').toBe(0);
  expect((await scanForText(page, `${A.mark} 收到`)).body, 'B 的界面上出现了 A 的历史').toBe(false);
  expect(runAlive(CTL, Bx.sid), 'B 正在跑的回合进程被停掉了').toBe(true);
  expect(phaseOf(CTL, Bx.sid), 'B 的回合应仍停在第一块(没被打断、没被替换)').toBe('chunk1');
});

// ============================================================ R4 ============================================================
test('R4 签名自愈的自动重发在落地前切到 B:A 的原文不得发进 B', async ({ page }) => {
  const A = R146[9];
  const Bx = R146[10];
  const pa = 'R146 R4 A 这条触发签名自愈;自愈完成之前切到 B,原文绝不能被发进 B。';

  await switchTo(page, Bx.mark);
  await switchTo(page, A.mark);
  injectError(CTL, A.sid, 'API Error: 400 Invalid signature in thinking block');
  const strip = await holdRequests(page, '**/api/sessions/*/strip-thinking', (u, m) => m === 'POST');
  await sendPrompt(page, pa);
  await waitTurnRunning(page, A.sid, pa);
  releaseChunk2(CTL, A.sid);
  releaseTurnEnd(CTL, A.sid);
  await expect.poll(() => strip.held(), { message: '签名自愈的剥离请求应已发出并被拦住', timeout: 20_000 }).toBeGreaterThan(0);

  await switchTo(page, Bx.mark);
  clearError(CTL, A.sid);
  strip.release();
  await page.waitForTimeout(5_000);

  expect(await paneOwners(page), '窗格应仍显示 B').toEqual([Bx.sid]);
  expect(transcriptMentions(Bx.sid, pa), 'A 的原文被自动重发进了 B 的会话文件').toBe(0);
  expect((await scanForText(page, pa)).bubbles, 'B 的界面上出现了 A 的消息').toBe(0);
});

// ============================================================ R5 ============================================================
test('R5 分屏 [A|B]:B 生成中排了一条,关掉左边 A,B 回合结束后排队消息必须自动发出', async ({ page }) => {
  const A = R146[12];
  const Bx = R146[13];
  const pb = 'R146 R5 B 在右格跑的长回合。';
  const pq = 'R146 R5 B 生成中排队的这条:关掉左格之后,B 回合结束时它必须自动发出。';

  await switchTo(page, A.mark);
  await setPanes(page, 2);
  await focusPane(page, 1);
  await switchTo(page, Bx.mark);
  await expect.poll(() => paneOwners(page), { message: '两格应分别是 A、B', timeout: 10_000 }).toEqual([A.sid, Bx.sid]);

  await sendInPaneAt(page, 1, pb);
  await expect(paneAt(page, 1).getByText(live.chunk1(Bx.sid, pb), { exact: false }).first(), 'B 的回合应开始产出').toBeVisible({ timeout: 30_000 });
  await sendInPaneAt(page, 1, pq);
  await expect(paneAt(page, 1).getByText(pq, { exact: false }).first(), '这条应进了 B 的排队').toBeVisible({ timeout: 10_000 });

  await closePaneAt(page, 0);
  expect(await paneOwners(page), '关掉左格后只剩 B').toEqual([Bx.sid]);
  releaseChunk2(CTL, Bx.sid);
  releaseTurnEnd(CTL, Bx.sid);
  await expect.poll(() => transcriptMentions(Bx.sid, pq), { message: 'B 回合结束后,排队的那条没有自动发出', timeout: 25_000 }).toBeGreaterThan(0);
});

// ============================================================ R6 ============================================================
test('R6 换过模型再撞 1M 被拒:自动恢复应沿用本次实际发送的模型(去掉 1M),不得换回旧模型', async ({ page }) => {
  const A = R146[15];
  const pa = 'R146 R6 A 这条用新选的模型 + 1M 发出,被拒后应以同一个模型的标准上下文重发。';
  const posts = recordChatPosts(page);
  await switchTo(page, A.mark);

  const trigger = page.locator('[data-cgui="model-selector"] > button').first();
  const modelNow = async () => String((await trigger.getAttribute('title')) || '').replace(/^模型:\s*/, '').replace(/（.*$/, '').trim();
  const before = await modelNow();
  expect(before, '应能读到当前模型').not.toBe('');
  // 换一个不同的模型:用菜单顶部的「自定义模型 ID」输入(列表内容随 provider 变,输入框是稳定入口)
  const chosen = before.replace(/\[1m\]/i, '') === 'claude-opus-4-6' ? 'claude-sonnet-4-5' : 'claude-opus-4-6';
  await trigger.click();
  const custom = page.getByPlaceholder('自定义模型 ID...').first();
  await expect(custom, '模型菜单应已展开').toBeVisible({ timeout: 5_000 });
  await custom.fill(chosen);
  await custom.press('Enter');
  await expect.poll(modelNow, { message: '应已切到新模型', timeout: 5_000 }).toBe(chosen);
  // 再打开 1M
  await trigger.click();
  await page.getByRole('button', { name: /1M 上下文/ }).first().click();
  await page.keyboard.press('Escape').catch(() => {});
  await expect.poll(modelNow, { message: '应已切到新模型并带 1M', timeout: 5_000 }).toBe(`${chosen}[1m]`);

  injectError(CTL, A.sid, 'API Error: 400 Usage credits required for 1M context');
  await sendPrompt(page, pa);
  await waitTurnRunning(page, A.sid, pa);
  releaseChunk2(CTL, A.sid);
  releaseTurnEnd(CTL, A.sid);
  await expect.poll(() => posts.length, { message: '被拒后应自动重发一次', timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  clearError(CTL, A.sid);
  expect(posts[0].model, '第一次发送用的应是新选的模型 + 1M').toBe(`${chosen}[1m]`);
  expect(posts[1].model, `自动恢复被换回了旧模型(本次实际发送的是 ${chosen})`).toBe(chosen);
});

// ============================================================ R7 ============================================================
test('R7 文件审查面板:A 的慢响应在切到 B 之后才回来,面板不得显示 A 的结果', async ({ page }) => {
  const A = R146[18];
  const Bx = R146[19];
  const STALE = 'R146 R7 这是 A 会话迟到的响应';
  await switchTo(page, Bx.mark);
  await switchTo(page, A.mark);
  let open;
  const gate = new Promise((r) => { open = r; });
  let heldA = 0;
  await page.route('**/api/sessions/*/file-changes*', async (route) => {
    if (!route.request().url().includes(A.sid)) return route.continue();
    heldA += 1;
    await gate;
    return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: STALE }) });
  });
  await openRightPanel(page, '文件审查');
  await expect.poll(() => heldA, { message: '面板应已对 A 发起取数(被拦住)', timeout: 10_000 }).toBeGreaterThan(0);
  await switchTo(page, Bx.mark);
  await expect(page.getByText('该会话没有文件变更记录').first(), '面板应已显示 B 的结果').toBeVisible({ timeout: 15_000 });
  open();
  await page.waitForTimeout(2_000);
  expect((await page.locator('body').innerText()).includes(STALE), '面板显示了 A 会话迟到的响应').toBe(false);
  await expect(page.getByText('该会话没有文件变更记录').first(), '面板应仍是 B 的结果').toBeVisible();
});
