// r141 渲染去重验收(黑盒)。**不属于 r140 串话清单**(r140 的锁定目录是 tests/acceptance/r140-crosstalk/)。
// 只由 run.sh 调起:tests/acceptance/r141-duprender/run.sh [-g 'R141']
//
// 现场证据(2026-10-01,paperhot 项目会话 7f4d8731-…,39MB、被 compact/continue 过):
//   用户发「搞完了吗」之后,同一条 AI 回复被画了两遍(21:42 一条、21:43 一条),正文完全相同;
//   第二条多一行「思考与工具调用 · 2 步 / 1 次工具调用」折叠摘要,第一条右上带「已并入」小标;
//   两条各自带不同的 token 统计。判据:那条正文在 jsonl 里**只有一条**。
//
// 本用例要能区分两种情况:
//   ①jsonl 里只有 1 条、界面画了 2 条  → 纯渲染重复(本地定稿副本没和 jsonl 对账结果去重)
//   ②jsonl 里真有 2 条                → 数据重复(另一个 bug,不是渲染问题)
// 判定方法:先数 jsonl(grep 正文前 20 字,按 role=assistant),再数界面,两个数字一起写进断言消息。
import { test, expect } from '@playwright/test';
import { NAV, OLD, R141, countTranscriptLines, live } from './helpers/fixtures.mjs';
import {
  boot, clearError, clearSlowStart, clearSlowStartFor, holdSession, openSessionBySearch, releaseAllRuns,
  releaseChunk2, releaseSession, releaseTurnEnd, runPid, scanForText, sendPrompt, sessionRow, switchTo,
  userBubbleCount, waitForPhase,
} from './helpers/ui.mjs';

const CTL = process.env.R118_CTL;
const ALL_FIX = [...R141, ...OLD];

/** 界面上"同一条正文"被画了几遍:逐元素看 data-turn-uuid(本地副本是 chat-assistant-<ms>)。 */
const replyCopies = (page, text) => page.evaluate((t) => {
  const els = [...document.querySelectorAll('[data-turn-uuid]')].filter((e) => (e.textContent || '').includes(t));
  const decorated = els.length ? els : [...document.querySelectorAll('.markdown-content')].filter((e) => (e.textContent || '').includes(t));
  return decorated.map((e) => ({
    uuid: e.getAttribute('data-turn-uuid'),
    local: /^chat-/.test(String(e.getAttribute('data-turn-uuid') || '')),   // chat-assistant-<ms> / chat-stopped-<ms> 都是本地临时键,不是真 uuid
    snippet: (e.textContent || '').slice(0, 60),
  }));
}, text);

/**
 * 判据 + 断言。jsonl 计数用 role=assistant 的行数(countTranscriptLines 里就是 grep 正文前 20 字那套判定)。
 */
async function expectSingleReply(page, sid, text, label) {
  const nJson = countTranscriptLines(sid, 'assistant', text.slice(0, 20));
  const copies = await replyCopies(page, text);
  const nUi = copies.length;
  const local = copies.filter((c) => c.local);
  const real = copies.filter((c) => !c.local);
  const verdict = nJson <= 1 && nUi > 1
    ? `①纯渲染重复:jsonl 里只有 ${nJson} 条,界面画了 ${nUi} 条`
    : `②jsonl 里真有 ${nJson} 条 → 数据重复(另一个 bug),不是纯渲染问题`;
  expect(nUi, `${label}:界面画了 ${nUi} 遍(应当恰好 1 遍)。${verdict}。`
    + `本地副本 ${local.length} 个(${JSON.stringify(local.map((c) => c.uuid))})、真 uuid ${real.length} 个`
    + `(本地副本与真 uuid 同正文共存 = 那一对重复)。明细 ${JSON.stringify(copies)}`).toBe(1);
  expect(nJson, `${label}:jsonl 里出现 ${nJson} 条同正文的 assistant 记录(应当恰好 1 条;>1 说明是数据重复)`).toBe(1);
}

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openSessionBySearch(page, NAV.mark);
  await expect(sessionRow(page, NAV.mark), '侧栏里应能看到夹具会话').toBeVisible({ timeout: 20_000 });
});

test.afterEach(async () => {
  clearSlowStart(CTL);
  for (const { sid } of ALL_FIX) { clearSlowStartFor(CTL, sid); clearError(CTL, sid); }
  releaseAllRuns(CTL);
});

const promptOf = (tag, i) => `R141 ${tag} 第${i + 1}轮:这条回复只该被画一遍。`;

/** 完整跑一轮:hold → 发消息 → (可选)切走 → 放行三段 → (可选)切回。 */
async function runFullTurn(page, A, prompt, { leaveDuring = false, preReconcile = false }) {
  holdSession(CTL, A.sid);
  await switchTo(page, A.mark);
  await sendPrompt(page, prompt);
  await expect.poll(() => runPid(CTL, A.sid), { timeout: 25_000 }).not.toBeNull();
  if (leaveDuring) {
    await switchTo(page, NAV.mark);
    await expect.poll(async () => (await scanForText(page, prompt)).body, { timeout: 15_000, intervals: [250] }).toBe(false);
    await page.waitForTimeout(1_000);
  }
  releaseSession(CTL, A.sid);
  await waitForPhase(CTL, A.sid, 'chunk1', 40_000);
  releaseChunk2(CTL, A.sid); await waitForPhase(CTL, A.sid, 'chunk2', 40_000);
  releaseTurnEnd(CTL, A.sid); await waitForPhase(CTL, A.sid, 'final', 40_000);
  await page.waitForTimeout(3_000);
  if (leaveDuring) await switchTo(page, A.mark);
  if (preReconcile) {                       // 切走再切回 = 让"历史对账"再跑一次
    await switchTo(page, NAV.mark);
    await page.waitForTimeout(1_000);
    await switchTo(page, A.mark);
    await page.waitForTimeout(2_500);
  }
}

test('R141 [双画] 直播收尾 + 历史对账之后,同一条 AI 回复只能有一条(3 种时序)', async ({ page }) => {
  const cases = [
    { tag: 'live', A: R141[0], leaveDuring: false, preReconcile: true, desc: '直播看着它跑完,再切走切回对账' },
    { tag: 'away', A: R141[1], leaveDuring: true, preReconcile: false, desc: '切走期间跑完,切回来靠历史对账' },
    { tag: 'old', A: OLD[0], leaveDuring: false, preReconcile: true, desc: '被 compact 过的老会话,直播跑完再对账' },
    { tag: 'oldaway', A: OLD[1], leaveDuring: true, preReconcile: true, desc: '被 compact 过的老会话,切走期间跑完再对账' },
  ];
  const results = [];
  for (const [i, c] of cases.entries()) {
    const prompt = promptOf(c.tag, i);
    try {
      await expect(sessionRow(page, c.A.mark), `侧栏里应能看到会话 ${c.A.mark}`).toBeVisible({ timeout: 20_000 });
      await switchTo(page, c.A.mark);
      await page.waitForTimeout(1_500);
      await runFullTurn(page, c.A, prompt, c);
      await expectSingleReply(page, c.A.sid, live.final(c.A.sid), `${c.desc} · 定稿`);
      await expectSingleReply(page, c.A.sid, live.chunk1(c.A.sid, prompt), `${c.desc} · 第一块`);
      const nb = await userBubbleCount(page, prompt);
      expect(nb, `${c.desc}:这条用户消息被画了 ${nb} 遍(应当恰好 1 遍)`).toBe(1);
      // 延迟再数一次:防"过一会儿又冒出来一条"
      await page.waitForTimeout(2_500);
      await expectSingleReply(page, c.A.sid, live.final(c.A.sid), `${c.desc} · 定稿(延迟 2.5s 后再数)`);
      results.push(`${c.tag} PASS`);
    } catch (error) {
      results.push(`${c.tag} FAIL: ${String(error.message).split('\n')[0]}`);
    } finally {
      releaseChunk2(CTL, c.A.sid); releaseTurnEnd(CTL, c.A.sid);
      await page.waitForTimeout(1_000);
    }
  }
  const bad = results.filter((r) => r.includes('FAIL'));
  expect(bad, `R141:${results.length} 种时序里红 ${bad.length} 种 —— ${results.join(' | ')}`).toEqual([]);
  console.log(`[r141] 复现稳定性:${results.join(' | ')}`);
});
