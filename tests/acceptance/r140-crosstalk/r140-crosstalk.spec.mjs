// r140 会话串话验收(黑盒)。唯一依据:.devflow/INTERFACE-r140.md(对外行为契约)+ 既有夹具接口。
// 只由 run.sh 调起:tests/acceptance/r140-crosstalk/run.sh [-g 'H1']
//
// 本清单只管 r140 的**串话**:直播缓冲不串、定稿气泡不串、附属产物不串、排队消息不投错会话、
// 停止目标正确、切走后继续跑完、既有 r118 守卫不回归。
// "同一条 AI 回复被画两遍"(渲染去重)是另一个根因,属 r141,清单在 tests/acceptance/r141-duprender/。
//
// 设计要点(为什么这样测):
//  · 泄漏帧可能只活 200–300ms,"每 500ms 采样一次没看到"是弱断言 —— 所以每条跨会话用例都用
//    页内 MutationObserver 连续录制(helpers/ui.mjs 的 startRecorder):任何进入 DOM 的文字(包括
//    加了又立刻摘掉的节点、原地改文本的 characterData)都会被记下,断言的是"录制结果里 0 次"。
//  · 录制**从"页面已经干净地显示 B"之后**开始:切换本身会把 A 的视图拆掉(removed 节点里带着 A 的
//    文字),那属于拆自己的台,不是泄漏。开始录之前先等 A 的内容在页面上消失,并做一次基线检查。
//  · 阳性对照:同一次录制里必须录到"本该出现的东西"(B 自己的流式内容 / 界面确有变化),否则
//    "没录到泄漏"可能只是没录到东西。
//  · 时序不赌 sleep:桩件按会话憋住(<sid>.slow-ms)再精确放行(<sid>.go),并用桩件自己落的
//    <sid>.phase 证明"A 确实是在用户停在 B 的时候才吐字的"(泄漏路径被走到)。
import { test, expect } from '@playwright/test';
import { NAV, R140, live, transcriptMentions } from './helpers/fixtures.mjs';
import {
  assistantBlockCount, boot, clearError, clearSlowStart, clearSlowStartFor, dumpRecorder, hitsDump, hitsFor,
  hitsInPane, hitsInPaneDump, holdSession, injectError, messageVisible, openSessionBySearch, paneKeyContaining,
  paneText, phaseOf, readState, releaseAllRuns, releaseChunk2, releaseSession, releaseTurnEnd, runAlive, runPid,
  scanForText, sendPrompt, sessionRow, startRecorder, stopRecorder, switchTo, userBubbleCount, waitForPhase,
} from './helpers/ui.mjs';

const CTL = process.env.R118_CTL;
const ROUNDS = 3;

// 会话分配:R140 池各条只用一次(回合跑完后应用会改会话标题,侧栏行文字就变了)。
const S_H1 = R140.slice(0, 6);      // 3 轮 × (A, B)
const S_H1B = [R140[6], R140[7]];        // A1, A2
const S_H1BQ = [R140[27], R140[28]];    // 每轮一个独立的静默目标 Q(自检时要在它里面发消息,标题会变)
const S_H2 = R140.slice(9, 13);     // 2 轮 × (A, B)
const S_H4 = R140.slice(13, 17);    // 3 轮 × A + 静默目标 Q
const S_H5 = R140.slice(17, 19);    // A, B
const S_H6 = R140.slice(19, 21);    // A, Q
const S_H7 = R140.slice(21, 25);    // A(自证), A2, Q
const S_C5 = [R140[8], R140[25]];   // C5 每轮的 A(低位索引,侧栏一定能列到)
const S_C5Q = R140[26];             // C5 的静默目标 Q(永不跑回合,标题不变)
const ALL_FIX = [...R140];

/** 长消息:比侧栏标题的截断长度(40 字)长,整页文字检索才不会被侧栏标题骗到。 */
const promptA = (tag, i) => `R140 ${tag} 第${i + 1}轮:A 这条消息只属于 A 这条会话,任何时刻都不该出现在 B 的界面上。`;
const promptB = (tag, i) => `R140 ${tag} 第${i + 1}轮:B 自己在说话,用来证明"此刻确实在看 B 的页面"。`;
const A_MARKERS = (sid, pa) => ({ 第一块: live.chunk1(sid, pa), 第二块: live.chunk2(sid), 定稿: live.final(sid), 'A 的用户消息': pa });
const bOwnReply = (mark) => `${mark} 收到,这是这条会话里已有的旧回复。`;

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openSessionBySearch(page, NAV.mark);   // 打开一次,夹具项目与它的会话才进侧栏
  await expect(sessionRow(page, NAV.mark), '侧栏里应能看到夹具会话').toBeVisible({ timeout: 20_000 });
});

test.afterEach(async () => {
  clearSlowStart(CTL);
  for (const { sid } of ALL_FIX) { clearSlowStartFor(CTL, sid); clearError(CTL, sid); }
  releaseAllRuns(CTL);     // 别把任何一条会话的回合晾在停住状态
});

/** 把这条会话的回合憋住,并确认进程起来了、一个字都还没吐(这样才能说"切走时旧流尚未开始")。 */
async function holdAndStart(page, { sid, mark }, prompt) {
  holdSession(CTL, sid);
  await switchTo(page, mark);
  await sendPrompt(page, prompt);
  await expect.poll(() => runPid(CTL, sid), { message: `会话 ${mark} 的桩件进程应已起来`, timeout: 25_000 }).not.toBeNull();
  expect(phaseOf(CTL, sid), '切走之前 A 不该有任何产出(否则就不是"旧流未开始"这个窗口了)').toBeNull();
}

/** 切到另一条会话,等 A 的内容在页面上彻底消失,再装录制器并做一次基线检查。 */
async function switchCleanAndRecord(page, target, { name, goneText, markers }) {
  await switchTo(page, target.mark);
  if (goneText) {
    await expect.poll(async () => (await scanForText(page, goneText)).body, {
      message: '基线:切过去之后,原来那条会话的正文应从页面上消失', timeout: 15_000, intervals: [250],
    }).toBe(false);
  }
  await startRecorder(page, { name, markers });
  await page.waitForTimeout(400);
  const base = await dumpRecorder(page, name);
  for (const m of markers) {
    expect(hitsFor(base, m), `基线不干净:刚切过去(还没到放行 A 的时刻),B 的页面上就已经有「${m.slice(0, 24)}…」(${hitsDump(base, m)})`).toBe(0);
  }
  return base;
}

/** 精确放行这条会话,并等它真的吐到某一段(证明泄漏路径被走到)。 */
const releaseAndWait = (sid, stage) => { releaseSession(CTL, sid); return waitForPhase(CTL, sid, stage, 40_000); };

function expectNoMarker(rec, marker, label) {
  const n = hitsFor(rec, marker);
  expect(n, `${label}:${n} 次命中 —— 命中样例 ${hitsDump(rec, marker)}`).toBe(0);
}

// ============================================================ H1 直播缓冲串话 ============================================================

test(`H1 [契约§1.1] A 发完消息、还没吐字时切到 B 并在 B 发消息:A 的正文/思考/工具块任何时刻都不得进 B(${ROUNDS} 轮)`, async ({ page }) => {
  const results = [];
  for (let i = 0; i < ROUNDS; i += 1) {
    const A = S_H1[i * 2];
    const Bx = S_H1[i * 2 + 1];
    const pa = promptA('H1', i);
    const pb = promptB('H1B', i);
    try {
      await expect(sessionRow(page, Bx.mark), '侧栏里应能看到切过去的会话').toBeVisible({ timeout: 20_000 });
      await holdAndStart(page, A, pa);
      expect(await userBubbleCount(page, pa), 'A 里这条消息应恰好画一条').toBe(1);

      const A_M = A_MARKERS(A.sid, pa);
      const all = [...Object.values(A_M), live.chunk1(Bx.sid, pb), pb];
      await switchCleanAndRecord(page, Bx, { name: 'leak', goneText: pa, markers: all });
      expect((await scanForText(page, bOwnReply(Bx.mark))).body, '阳性对照:此刻看的确实是 B 的页面(能读到 B 自己的旧回复)').toBe(true);

      // 契约 §1.1 原样场景:切到 B 之后,在 B 也发一条
      await sendPrompt(page, pb);
      await expect(page.getByText(live.chunk1(Bx.sid, pb), { exact: false }).first(),
        '阳性对照:B 自己这一轮应开始产出').toBeVisible({ timeout: 40_000 });

      // ↓ 关键一步:用户此刻停在 B,现在才让 A 吐字(桩件的 phase 文件证明这一步真的发生了)
      await releaseAndWait(A.sid, 'chunk1');
      await page.waitForTimeout(1_500);
      const mid = await dumpRecorder(page, 'leak');
      expectNoMarker(mid, A_M.第一块, 'A 吐出第一块的瞬间,B 的界面上出现了它');

      releaseChunk2(CTL, A.sid); await waitForPhase(CTL, A.sid, 'chunk2', 40_000);
      await page.waitForTimeout(1_000);
      releaseTurnEnd(CTL, A.sid); await waitForPhase(CTL, A.sid, 'final', 40_000);
      await page.waitForTimeout(2_500);

      const rec = await stopRecorder(page, 'leak');
      for (const [label, m] of Object.entries(A_M)) expectNoMarker(rec, m, `B 的界面上出现过 A 的${label}`);
      expect(hitsFor(rec, live.chunk1(Bx.sid, pb)), '阳性对照:同一窗口里应录到 B 自己的第一块文字').toBeGreaterThan(0);

      const nowBody = await page.locator('body').innerText();
      expect(nowBody.includes(live.final(A.sid)), 'B 页面上此刻仍能看到 A 的定稿').toBe(false);
      expect(nowBody.includes(live.chunk1(A.sid, pa)), 'B 页面上此刻仍能看到 A 的第一块').toBe(false);
      expect(transcriptMentions(Bx.sid, live.final(A.sid)), 'B 的会话文件里被写进了 A 的内容').toBe(0);
      expect(transcriptMentions(Bx.sid, pa), 'B 的会话文件里被写进了 A 的用户消息').toBe(0);
      results.push(`第${i + 1}轮 PASS`);
    } catch (error) {
      results.push(`第${i + 1}轮 FAIL: ${String(error.message).split('\n')[0]}`);
    } finally {
      releaseChunk2(CTL, A.sid); releaseTurnEnd(CTL, A.sid);
      releaseSession(CTL, Bx.sid); releaseChunk2(CTL, Bx.sid); releaseTurnEnd(CTL, Bx.sid);
      await page.waitForTimeout(1_000);
    }
  }
  const bad = results.filter((r) => r.includes('FAIL'));
  expect(bad, `H1:${results.length} 轮里红 ${bad.length} 轮 —— ${results.join(' | ')}`).toEqual([]);
  console.log(`[r140] H1 复现稳定性:${results.join(' | ')}`);
});

test('H1b [契约§1.2] 切到 B 之后不发消息,A 的流晚到(几秒后才开始产出)也不得写进 B(2 轮)', async ({ page }) => {
  const results = [];
  for (let i = 0; i < 2; i += 1) {
    const A = S_H1B[i];
    const Q = S_H1BQ[i];
    const pa = promptA('H1b', i);
    const pq = promptB('H1bQ', i);
    try {
      if (i === 0) await expect(sessionRow(page, Q.mark), '侧栏里应能看到切过去的会话').toBeVisible({ timeout: 20_000 });
      await holdAndStart(page, A, pa);
      const A_M = A_MARKERS(A.sid, pa);
      // 录制器的标记在装上时就固定了,所以"仪器自检"要用的 B 自己那条标记也必须一开始就带上
      await switchCleanAndRecord(page, Q, { name: 'late', goneText: pa, markers: [...Object.values(A_M), live.chunk1(Q.sid, pq)] });
      await page.waitForTimeout(2_000);            // 在 B 上干等:这一段正是"A 稍后自己冒出来"的窗口
      await releaseAndWait(A.sid, 'chunk1');
      await page.waitForTimeout(1_500);
      releaseChunk2(CTL, A.sid); await waitForPhase(CTL, A.sid, 'chunk2', 40_000);
      releaseTurnEnd(CTL, A.sid); await waitForPhase(CTL, A.sid, 'final', 40_000);
      await page.waitForTimeout(2_500);
      const rec = await stopRecorder(page, 'late');
      expect(rec, '录制器没装上?').not.toBeNull();
      for (const [label, m] of Object.entries(A_M)) expectNoMarker(rec, m, `B 上冒出了 A 的${label}`);
      expect(await userBubbleCount(page, pa), 'B 里被画进了 A 的用户消息').toBe(0);
      // 仪器自检:在 B 里发一条,B 自己的流式内容必须被同一个录制器录到
      // (否则"没录到 A 的泄漏"可能只是因为录制器根本没在工作)。上一步已经 stop 了旧录制器,这里重装一个。
      await startRecorder(page, { name: 'lateSelf', markers: [live.chunk1(Q.sid, pq)] });
      await sendPrompt(page, pq);
      await expect(page.getByText(live.chunk1(Q.sid, pq), { exact: false }).first(),
        '仪器自检:B 自己这一轮应开始产出').toBeVisible({ timeout: 40_000 });
      await page.waitForTimeout(1_000);
      const rec2 = await dumpRecorder(page, 'lateSelf');
      expect(hitsFor(rec2, live.chunk1(Q.sid, pq)), '仪器自检:录制器没有录到 B 自己的流式内容(录制器失效)').toBeGreaterThan(0);
      const rec3 = await dumpRecorder(page, 'late');
      for (const [label, m] of Object.entries(A_M)) expectNoMarker(rec3, m, `B 发出自己的消息后,页面上又冒出了 A 的${label}`);
      expect(transcriptMentions(Q.sid, live.final(A.sid)), 'B 的会话文件被写进了 A 的内容').toBe(0);
      results.push(`第${i + 1}轮 PASS`);
    } catch (error) {
      results.push(`第${i + 1}轮 FAIL: ${String(error.message).split('\n')[0]}`);
    } finally {
      releaseChunk2(CTL, A.sid); releaseTurnEnd(CTL, A.sid);
      await page.waitForTimeout(1_000);
    }
  }
  const bad = results.filter((r) => r.includes('FAIL'));
  expect(bad, `H1b:${results.length} 轮里红 ${bad.length} 轮 —— ${results.join(' | ')}`).toEqual([]);
});

// ============================================================ H2 定稿气泡串话 ============================================================

test('H2 [契约§1.3] 流跑完时补写的那条定稿气泡不得进 B(2 轮,含"切走再切回 B"的持久化检查)', async ({ page }) => {
  const results = [];
  for (let i = 0; i < 2; i += 1) {
    const A = S_H2[i * 2];
    const Bx = S_H2[i * 2 + 1];
    const pa = promptA('H2', i);
    try {
      if (i === 0) await expect(sessionRow(page, Bx.mark), '侧栏里应能看到切过去的会话').toBeVisible({ timeout: 20_000 });
      await holdAndStart(page, A, pa);
      const A_M = A_MARKERS(A.sid, pa);
      const pb = promptB('H2B', i);
      const markers = [...Object.values(A_M), live.chunk1(Bx.sid, pb)];
      await switchCleanAndRecord(page, Bx, { name: 'fin', goneText: pa, markers });
      expect((await scanForText(page, bOwnReply(Bx.mark))).body, '阳性对照:此刻看的确实是 B 的页面').toBe(true);
      // B 自己也开一轮(切会话时"当前这一轮"的槽位就是串话发生的地方),然后让它停在连接中
      holdSession(CTL, Bx.sid);
      await sendPrompt(page, pb);
      await expect.poll(() => runPid(CTL, Bx.sid), { timeout: 25_000 }).not.toBeNull();
      releaseSession(CTL, Bx.sid);
      await expect(page.getByText(live.chunk1(Bx.sid, pb), { exact: false }).first(),
        '阳性对照:B 自己这一轮应开始产出').toBeVisible({ timeout: 40_000 });

      // 让 A 在"用户停在 B"的时候整轮跑完 —— 定稿就是在这一刻补写的
      await releaseAndWait(A.sid, 'chunk1');
      releaseChunk2(CTL, A.sid); await waitForPhase(CTL, A.sid, 'chunk2', 40_000);
      releaseTurnEnd(CTL, A.sid); await waitForPhase(CTL, A.sid, 'final', 40_000);
      await page.waitForTimeout(3_000);

      // 持久化路径:从 B 切走、再切回 B,重新对账一次历史
      await switchTo(page, NAV.mark);
      await page.waitForTimeout(1_000);
      await switchTo(page, Bx.mark);
      await page.waitForTimeout(2_500);

      const rec = await stopRecorder(page, 'fin');
      for (const [label, m] of Object.entries(A_M)) {
        expectNoMarker(rec, m, `B 的界面上出现过 A 的${label}(含只在几百毫秒内闪过的帧)`);
      }
      expect(hitsFor(rec, live.chunk1(Bx.sid, pb)), '阳性对照:同一窗口里应录到 B 自己的第一块文字').toBeGreaterThan(0);
      expect(await assistantBlockCount(page, live.final(A.sid)), '切回 B 之后,正文卡里还能数到 A 的定稿').toBe(0);
      const body = await page.locator('body').innerText();
      expect(body.includes(live.final(A.sid)), 'B 页面上此刻能看到 A 的定稿').toBe(false);
      expect(body.includes(live.chunk2(A.sid)), 'B 页面上此刻能看到 A 的第二块').toBe(false);
      expect(transcriptMentions(Bx.sid, live.final(A.sid)), 'B 的会话文件里被写进了 A 的定稿').toBe(0);
      expect(rec.muts, '阳性对照:录制器应记到界面变化').toBeGreaterThan(0);
      results.push(`第${i + 1}轮 PASS`);
    } catch (error) {
      results.push(`第${i + 1}轮 FAIL: ${String(error.message).split('\n')[0]}`);
    } finally {
      releaseChunk2(CTL, A.sid); releaseTurnEnd(CTL, A.sid);
      releaseChunk2(CTL, Bx.sid); releaseTurnEnd(CTL, Bx.sid);
      await page.waitForTimeout(1_000);
    }
  }
  const bad = results.filter((r) => r.includes('FAIL'));
  expect(bad, `H2:${results.length} 轮里红 ${bad.length} 轮 —— ${results.join(' | ')}`).toEqual([]);
});

// ============================================================ H4 排队消息不得投错会话 ============================================================

// 分类(2026-10-02 复核后修正):这条**不是"修前必红"**,是**防回归**。
// 用修正后的仪器(命中按窗格归属;removed 节点不回退归属)在修前(HEAD 干净副本)与修后各跑一次:两次都绿。
// 早先那次"修前红"是仪器误归属:测试自己会切回 A 发第二条,A 自己的排队条理应出现在 A 自己的窗格里;
// 当时把"拆台时 removed 的旧内容"按变化点 r.target(已经在 Q 的窗格里)归属,凭空造出"Q 窗格 2 条命中"。
test('H4 [契约§1.7] 排队消息不得投错会话:Q 的窗格/界面/jsonl 里都不能出现它(3 轮)', async ({ page }) => {
  const results = [];
  for (let i = 0; i < ROUNDS; i += 1) {
    const A = S_H4[i];
    const Q = S_H4[3];
    const p1 = `R140 H4 第${i + 1}轮:第一条(占住 A 的运行)`;
    const p2 = promptA('H4Q', i);
    try {
      if (i === 0) await expect(sessionRow(page, Q.mark), '侧栏里应能看到切过去的会话').toBeVisible({ timeout: 20_000 });
      // 让 A 有"正在跑的回合":第二条消息必然走排队那条路
      holdSession(CTL, A.sid);
      await switchTo(page, A.mark);
      await sendPrompt(page, p1);
      await expect.poll(() => runPid(CTL, A.sid), { message: 'A 的桩件进程应已起来', timeout: 25_000 }).not.toBeNull();
      await page.waitForTimeout(1_000);

      await switchTo(page, Q.mark);
      await expect.poll(async () => (await scanForText(page, p1)).body, { message: '切过去后 A 的正文应从页面上消失', timeout: 15_000, intervals: [250] }).toBe(false);
      // 机制自检:此刻显示的那一格窗格的 owner key 必须就是 Q 这条会话的 id
      const qKey = await paneKeyContaining(page, bOwnReply(Q.mark));
      expect(qKey, '机制自检:窗格 owner key 应等于那一格正在显示的会话 id').toBe(Q.sid);

      // 录制**整段**(含测试自己切回 A 发消息那一段)。命中一律按"落在哪一格窗格"归属:
      // A 自己的排队条出现在 A 自己的窗格里是**正常**的,只有落进 Q 的窗格才是串话。
      await startRecorder(page, { name: 'queue', markers: [p2, p1] });
      await switchTo(page, A.mark);               // 回到 A 发第二条
      await sendPrompt(page, p2);                 // 发出去……
      await switchTo(page, Q.mark);               // ……立刻切走(不等任何东西)
      await page.waitForTimeout(4_000);
      const rec = await stopRecorder(page, 'queue');
      const perPane = JSON.stringify(rec.perPane);

      // 阳性对照:A 自己的窗格里必须出现过这条排队条 —— 证明"排队"这条路真的被走到了(否则本用例是空的)
      expect(hitsInPane(rec, p2, A.sid), `阳性对照:A 自己的窗格里没出现过这条排队条(排队路径没走到)perPane=${perPane}`).toBeGreaterThan(0);
      // 红线:Q 的窗格里出现过 A 的排队消息(或 A 的第一条)
      const inQ = hitsInPane(rec, p2, Q.sid) + hitsInPane(rec, p1, Q.sid);
      expect(inQ, `Q 的窗格里出现了 A 的排队消息:${inQ} 次 —— perPane=${perPane};该格命中明细 ${hitsInPaneDump(rec, Q.sid)}`).toBe(0);
      // 无法归属到窗格的命中(节点在回调时已被摘掉):added 类的必须为 0(add 的那一刻节点还挂着,归属得到)
      const unassignedAdded = rec.hits.filter((h) => h.pane === null && h.kind === 'added');
      expect(unassignedAdded.length, `有 ${unassignedAdded.length} 条 added 命中无法归属到任何窗格(会漏判):${JSON.stringify(unassignedAdded.slice(0, 4))}`).toBe(0);

      // 终点态:Q 那一格的文字里读不到它(持久化路径),气泡也数不到
      const qText = (await paneText(page, Q.sid)) || '';
      expect(qText.includes(p2), 'Q 窗格此刻还能读到 A 的排队消息').toBe(false);
      expect(qText.includes(p1), 'Q 窗格此刻还能读到 A 的第一条消息').toBe(false);
      expect(await userBubbleCount(page, p2), 'Q 里被画进了 A 的排队消息气泡').toBe(0);

      // 数据红线(不可撤销的污染):Q 的会话文件里绝不能有它
      expect(transcriptMentions(Q.sid, p2), `切走后,这条排队消息被写进了别的会话(${Q.mark})的会话文件`).toBe(0);
      expect(transcriptMentions(Q.sid, p1), `A 的第一条消息被写进了别的会话(${Q.mark})的会话文件`).toBe(0);

      // 反向:消息必须还在原会话的记录/队列里(排队中,不该丢、不该改嫁)
      await switchTo(page, A.mark);
      await page.waitForTimeout(1_000);
      const aPane = (await paneText(page, A.sid)) || '';
      const backBubbles = await userBubbleCount(page, p2);
      expect(aPane.includes(p2) || backBubbles > 0,
        `回到原会话 A 后,这条排队消息应仍在它的记录/队列里(A 窗格里读得到? ${aPane.includes(p2)};气泡数 ${backBubbles})`).toBe(true);
      // 阳性对照 2:同一套"发出去 → 落地"的通路是通的(A 的第一条确实进了 A 的会话文件)
      releaseSession(CTL, A.sid);
      await waitForPhase(CTL, A.sid, 'chunk1', 40_000);
      releaseChunk2(CTL, A.sid); await waitForPhase(CTL, A.sid, 'chunk2', 40_000);
      releaseTurnEnd(CTL, A.sid); await waitForPhase(CTL, A.sid, 'final', 40_000);
      await page.waitForTimeout(2_000);
      expect(transcriptMentions(A.sid, p1), '阳性对照:A 的第一条消息应正常落进 A 的会话文件(否则整条通路本身没跑起来)').toBeGreaterThan(0);
      expect(transcriptMentions(Q.sid, p2), '这一轮跑完之后,排队消息仍然被写进了别的会话的会话文件').toBe(0);
      results.push(`第${i + 1}轮 PASS`);
    } catch (error) {
      results.push(`第${i + 1}轮 FAIL: ${String(error.message).split('\n')[0]}`);
    } finally {
      releaseChunk2(CTL, A.sid); releaseTurnEnd(CTL, A.sid);
      await page.waitForTimeout(1_000);
    }
  }
  const bad = results.filter((r) => r.includes('FAIL'));
  expect(bad, `H4:${results.length} 轮里红 ${bad.length} 轮 —— ${results.join(' | ')}`).toEqual([]);
});

// ============================================================ C5 排队消息的排空投递 ============================================================

/**
 * 契约 §1.7 的"排空"那一半:排队消息最终**被投给谁**。
 * H4 覆盖的是"消息刚发出就切走"的短窗口(那时 POST 还在飞、A 的回合被憋住,排空路径压根没走到);
 * 这一条把 A 的回合**真正跑完**,再让排空发生 —— 这是数据污染唯一能真正发生的地方。
 */
// 分类(2026-10-02 实测):**防回归**(修前绿、修后绿)。
// 实测前提(探针,已删):A 的回合收尾时用户**不在** A 上,排空根本不会发生(30 秒内 A/Q 的 jsonl 都没有它);
// 用户在原会话上看着回合收尾时,排空在收尾后约 3 秒发生,投递目标在修前/修后都正确。
// 所以断言的形态是"可观测的投递目标"(A 的 jsonl 收到它、Q 的 jsonl 绝不含它、A 的进程开了第二回合),
// 而不是去赌投递那一瞬间的几十毫秒。
test('C5 [契约§1.7] 排队消息的排空投递必须落在原会话 A(而不是排空发生时在看的 Q)(2 轮)', async ({ page }) => {
  const results = [];
  for (let i = 0; i < 2; i += 1) {
    const A = S_C5[i];
    const Q = S_C5Q;
    const p1 = `R140 C5 第${i + 1}轮:第一条(占住 A 的运行)`;
    const p2 = `R140 C5 第${i + 1}轮:A 的排队消息,排空之后只该落进 A 的会话文件。`;
    try {
      if (i === 0) await expect(sessionRow(page, Q.mark), '侧栏里应能看到切过去的会话').toBeVisible({ timeout: 20_000 });
      holdSession(CTL, A.sid);
      await switchTo(page, A.mark);
      await sendPrompt(page, p1);
      await expect.poll(() => runPid(CTL, A.sid), { message: 'A 的桩件进程应已起来', timeout: 25_000 }).not.toBeNull();
      await page.waitForTimeout(1_200);
      await sendPrompt(page, p2);                      // A 正在跑 ⇒ 这条必然入队
      await expect.poll(async () => userBubbleCount(page, p2), {
        message: '阳性对照:第二条消息应出现在 A 的排队里(排队条画出来)', timeout: 20_000, intervals: [250],
      }).toBeGreaterThan(0);
      expect(transcriptMentions(A.sid, p2), '阳性对照:还没收尾,这条排队消息不该已经投出去').toBe(0);

      // 让 A 的回合真正收尾 —— 排空的前提(实测:用户不在 A 上时排空不会发生)
      releaseSession(CTL, A.sid);
      await waitForPhase(CTL, A.sid, 'chunk1', 40_000);
      releaseChunk2(CTL, A.sid); await waitForPhase(CTL, A.sid, 'chunk2', 40_000);
      releaseTurnEnd(CTL, A.sid); await waitForPhase(CTL, A.sid, 'final', 40_000);

      // 排空的投递就发生在回合收尾之后的这几秒里 —— 此刻切走,让"投递"发生在用户不在 A 的时候。
      // 串话 bug 的窗口就在这里:投递如果按"当前在看哪一格"找收件人,就会打到 Q 头上。
      await switchTo(page, Q.mark);
      const qKey = await paneKeyContaining(page, bOwnReply(Q.mark));
      expect(qKey, '机制自检:此刻显示的窗格应是 Q').toBe(Q.sid);

      let landedA = 0; let landedQ = 0;
      const deadline = Date.now() + 45_000;
      do {
        landedA = transcriptMentions(A.sid, p2);
        landedQ = transcriptMentions(Q.sid, p2);
        expect(landedQ, `排空把 A 的排队消息投进了别的会话(${Q.mark})的会话文件 = 不可撤销的数据污染`).toBe(0);
        if (landedA) break;
        await page.waitForTimeout(1_000);
      } while (Date.now() < deadline);

      expect(landedQ, `排空期间,Q 的会话文件里出现了 A 的排队消息(${landedQ} 次)`).toBe(0);
      expect(landedA, 'A 的回合收尾后,排队的消息没有被投回 A(A 的会话文件里始终没有它)。'
        + `明细:A jsonl p1=${transcriptMentions(A.sid, p1)} p2=${landedA};Q jsonl p2=${landedQ};phase=${phaseOf(CTL, A.sid)}`).toBeGreaterThan(0);
      expect(phaseOf(CTL, A.sid), 'A 的桩件没有开第二回合(= 投递没到 A 的进程)').toBe('chunk1');
      // 用户此刻停在 Q:Q 的窗格/气泡里都不该有它
      expect(((await paneText(page, Q.sid)) || '').includes(p2), 'Q 窗格里出现/残留了 A 的排队消息').toBe(false);
      expect(await userBubbleCount(page, p2), 'Q 里被画进了 A 的排队消息气泡').toBe(0);
      results.push(`第${i + 1}轮 PASS`);
    } catch (error) {
      results.push(`第${i + 1}轮 FAIL: ${String(error.message).split('\n')[0]}`);
    } finally {
      clearSlowStartFor(CTL, A.sid);
      releaseChunk2(CTL, A.sid); releaseTurnEnd(CTL, A.sid);
      await page.waitForTimeout(1_000);
    }
  }
  const bad = results.filter((r) => r.includes('FAIL'));
  expect(bad, `C5:${results.length} 轮里红 ${bad.length} 轮 —— ${results.join(' | ')}`).toEqual([]);
});

// ============================================================ H5 停止的目标必须正确 ============================================================

test('H5 [契约§1.6] 在 B 按停止:A 那一轮必须仍在跑(进程活着 + 还能跑完)', async ({ page }) => {
  const A = S_H5[0];
  const Bx = S_H5[1];
  const pa = promptA('H5', 0);
  const pb = promptB('H5B', 0);
  await expect(sessionRow(page, Bx.mark), '侧栏里应能看到切过去的会话').toBeVisible({ timeout: 20_000 });

  await holdAndStart(page, A, pa);
  const aPid = runPid(CTL, A.sid);
  expect(aPid, 'A 的桩件进程应已起来').toBeTruthy();

  await switchTo(page, Bx.mark);
  await sendPrompt(page, pb);
  await expect(page.getByText(live.chunk1(Bx.sid, pb), { exact: false }).first(), 'B 这一轮应跑起来').toBeVisible({ timeout: 40_000 });
  await expect(page.getByRole('button', { name: /^停止/ }).first(), 'B 进行中应有停止按钮').toBeEnabled({ timeout: 15_000 });

  await page.getByRole('button', { name: /^停止/ }).first().click();
  await page.waitForTimeout(3_000);

  // 阳性对照:停的确实是 B(点完停止,B 这一轮在界面上结束)
  expect((await readState(page)).stops, '阳性对照:在 B 点停止后,B 的停止按钮应消失').toBe(0);
  // 红线:A 不许被牵连
  expect(phaseOf(CTL, A.sid), 'A 被停止牵连:它已经开始产出了').toBeNull();
  expect(runAlive(CTL, A.sid), `在 B 点停止把 A 的进程(${aPid})也停掉了`).toBe(true);

  await releaseAndWait(A.sid, 'chunk1');
  releaseChunk2(CTL, A.sid); await waitForPhase(CTL, A.sid, 'chunk2', 40_000);
  releaseTurnEnd(CTL, A.sid); await waitForPhase(CTL, A.sid, 'final', 40_000);
  await switchTo(page, A.mark);
  await page.waitForTimeout(1_500);
  expect(await messageVisible(page, live.final(A.sid)), 'A 这一轮应能跑完并在 A 的界面里看到定稿').toBe(true);
});

// ============================================================ H6 切走后 A 继续跑完 ============================================================

test('H6 [契约§1.5] 切走期间不掐断:A 在后台跑完,切回来能看到完整回复(2 轮)', async ({ page }) => {
  const results = [];
  for (let i = 0; i < 2; i += 1) {
    const A = S_H6[i];
    const Q = S_H6[1];
    const pa = promptA('H6', i);
    try {
      if (i === 0) await expect(sessionRow(page, Q.mark), '侧栏里应能看到切过去的会话').toBeVisible({ timeout: 20_000 });
      await holdAndStart(page, A, pa);
      await switchTo(page, Q.mark);
      await page.waitForTimeout(2_000);

      await releaseAndWait(A.sid, 'chunk1');         // 产出发生在"用户不在 A 上"的时候
      expect(runAlive(CTL, A.sid), 'A 的进程在切走期间被掐断了').toBe(true);
      releaseChunk2(CTL, A.sid); await waitForPhase(CTL, A.sid, 'chunk2', 40_000);
      releaseTurnEnd(CTL, A.sid); await waitForPhase(CTL, A.sid, 'final', 40_000);
      await page.waitForTimeout(2_000);

      // 界面层:切回去能看到完整回复,且每段各一条
      await switchTo(page, A.mark);
      await page.waitForTimeout(2_000);
      for (const [label, m] of [['第一块', live.chunk1(A.sid, pa)], ['第二块', live.chunk2(A.sid)], ['定稿', live.final(A.sid)]]) {
        const n = await assistantBlockCount(page, m);
        expect(n, `切回 A 后,${label}在界面上找不到(这一轮被掐断/丢了);画了几条=${n}(条数是否 >1 属 r141 去重清单)`).toBeGreaterThanOrEqual(1);
      }
      const nb = await userBubbleCount(page, pa);
      expect(nb, `切回 A 后,这条用户消息找不到了(画了几条=${nb})`).toBeGreaterThanOrEqual(1);
      results.push(`第${i + 1}轮 PASS`);
    } catch (error) {
      results.push(`第${i + 1}轮 FAIL: ${String(error.message).split('\n')[0]}`);
    } finally {
      releaseChunk2(CTL, A.sid); releaseTurnEnd(CTL, A.sid);
      await page.waitForTimeout(1_000);
    }
  }
  const bad = results.filter((r) => r.includes('FAIL'));
  expect(bad, `H6:${results.length} 轮里红 ${bad.length} 轮 —— ${results.join(' | ')}`).toEqual([]);
});

// ============================================================ H7 附属产物不挂错会话 ============================================================

test('H7 [契约§1.4] A 跑失败时的错误提示不得出现在 B 上(先自证:同一条路径在 A 上确实看得见)', async ({ page }) => {
  const A = S_H7[0];
  const A2 = S_H7[1];
  const Q = S_H7[2];   // 阶段二的 B
  const pa = promptA('H7', 0);
  const pa2 = promptA('H7b', 0);
  const errA = `R140H7ERR-${A.sid.slice(0, 8)} 这一跑失败了:A 的附属产物`;
  const errA2 = `R140H7ERR-${A2.sid.slice(0, 8)} 这一跑失败了:B 不该看到它`;

  // ---- 阶段一(自证):让 A 自己出错,并把"A 的界面上冒出来的错误类文字"原样录下来当标记 ----
  await expect(sessionRow(page, A.mark), '侧栏里应能看到 A').toBeVisible({ timeout: 20_000 });
  holdSession(CTL, A.sid);
  await switchTo(page, A.mark);
  injectError(CTL, A.sid, errA);
  await sendPrompt(page, pa);
  await expect.poll(() => runPid(CTL, A.sid), { timeout: 25_000 }).not.toBeNull();
  await startRecorder(page, { name: 'discover', markers: [errA] });
  await releaseSession(CTL, A.sid);
  await waitForPhase(CTL, A.sid, 'chunk1', 40_000);
  releaseChunk2(CTL, A.sid); await waitForPhase(CTL, A.sid, 'chunk2', 40_000);
  releaseTurnEnd(CTL, A.sid); await waitForPhase(CTL, A.sid, 'error', 40_000);
  await page.waitForTimeout(4_000);
  const disc = await stopRecorder(page, 'discover');
  const errLike = [...new Set((disc.texts || [])
    .filter((t) => t && t.length < 220 && /❌|错误|失败|出错|Error/i.test(t)))]
    .filter((t) => !t.includes('R140'))          // 排除夹具自己的文字
    .slice(0, 12);
  expect(errLike.length, `自证失败:A 自己出错时,它的界面上没有出现任何可辨识的错误类文字(这条路走不到,`
    + `就不能反证 B 干净)。录到的片段:${JSON.stringify((disc.texts || []).slice(-20))}`).toBeGreaterThan(0);

  // ---- 阶段二:同样的失败发生在 A2 上,而用户停在 B ----
  await expect(sessionRow(page, Q.mark), '侧栏里应能看到切过去的会话').toBeVisible({ timeout: 20_000 });
  holdSession(CTL, A2.sid);
  await switchTo(page, A2.mark);
  injectError(CTL, A2.sid, errA2);
  await sendPrompt(page, pa2);
  await expect.poll(() => runPid(CTL, A2.sid), { timeout: 25_000 }).not.toBeNull();
  await switchTo(page, Q.mark);
  await expect.poll(async () => (await scanForText(page, pa2)).body, { timeout: 15_000, intervals: [250] }).toBe(false);
  const pq = promptB('H7B', 0);
  const markers2 = [errA2, errA2.slice(0, 16), ...errLike, live.final(A2.sid), live.chunk1(A2.sid, pa2)];
  await startRecorder(page, { name: 'attach', markers: [...markers2, live.chunk1(Q.sid, pq)] });
  expect((await scanForText(page, bOwnReply(Q.mark))).body, '阳性对照:此刻看的确实是 B 的页面').toBe(true);
  // B 自己也开一轮(串话走的正是"当前这一轮"这个槽),然后停在连接中
  holdSession(CTL, Q.sid);
  await sendPrompt(page, pq);
  await expect.poll(() => runPid(CTL, Q.sid), { timeout: 25_000 }).not.toBeNull();
  releaseSession(CTL, Q.sid);
  await expect(page.getByText(live.chunk1(Q.sid, pq), { exact: false }).first(),
    '阳性对照:B 自己这一轮应开始产出').toBeVisible({ timeout: 40_000 });

  await releaseSession(CTL, A2.sid);
  await waitForPhase(CTL, A2.sid, 'chunk1', 40_000);
  releaseChunk2(CTL, A2.sid); await waitForPhase(CTL, A2.sid, 'chunk2', 40_000);
  releaseTurnEnd(CTL, A2.sid); await waitForPhase(CTL, A2.sid, 'error', 40_000);
  await page.waitForTimeout(4_000);
  const rec = await stopRecorder(page, 'attach');
  for (const m of markers2) expectNoMarker(rec, m, `B 的界面上出现了 A 的附属产物「${m.slice(0, 24)}…」`);
  expect(hitsFor(rec, live.chunk1(Q.sid, pq)), '阳性对照:同一窗口里应录到 B 自己的第一块文字').toBeGreaterThan(0);
  const body = await page.locator('body').innerText();
  expect(body.includes(errA2), 'B 页面上此刻能看到 A 的错误文本').toBe(false);
  expect(rec.muts, '阳性对照:录制器应记到界面变化').toBeGreaterThan(0);
});

// ============================================================ H3 既有守卫 ============================================================
// H3(反向守卫)不在这里重复实现:同目录下的 r118-switch-back.spec.mjs 是从 r118 原目录**逐字复制**的,
// 由同一次 playwright 运行执行(G1/G2/B1–B5 全跑)。它必须保持全绿。
