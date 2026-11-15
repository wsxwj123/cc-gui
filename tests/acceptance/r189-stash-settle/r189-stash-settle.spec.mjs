// r189 界面验收:回合进行中切走过的用户消息,在消息已写进会话记录后,切回来不再重复出现在对话末尾。
// 依据只有 .devflow/r189-stash-settle-接口.md 的行为清单(B1–B7 一条对应一条);没看实现。
// 只由 run.sh 调起:tests/acceptance/r189-stash-settle/run.sh
// 每个用例用自己的一条夹具会话 S(S1..S7),另一条 B 只用来切走、从不跑回合。
import { test, expect } from '@playwright/test';
import { B, NAV, S, appendFiller, appendNoticeAndReply, live } from './helpers/fixtures.mjs';
import {
  assistantBlockCount, boot, clearDeferUser, listText, messageRows, openSessionBySearch, releaseAllRuns, releaseChunk2,
  releaseTurnEnd, resetPhase, scrubberScope, sendByButton, sendPrompt, sessionRow, setDeferUser, stopButton, switchTo,
  userBubbleCount, waitPhase, waitTurnRunning, messageList,
} from './helpers/ui.mjs';

const CTL = process.env.R189_CTL;

test.beforeEach(async ({ page }) => {
  await boot(page);
  setDeferUser(CTL);   // 假命令行:回合收尾前,用户消息还没写进会话记录(切走时它不在记录里)
  await openSessionBySearch(page, NAV.mark);   // 打开一次,夹具项目与它的会话才进侧栏
  await expect(sessionRow(page, B.mark), '侧栏里应能看到夹具会话 B').toBeVisible({ timeout: 20_000 });
});

test.afterEach(async () => {
  clearDeferUser(CTL);
  releaseAllRuns(CTL);
});

/**
 * 在 S 里发 text,回复还在生成时切到 B,放行让回复结束(S 此时不在眼前)。
 * peek=true(默认):切走后、回复结束前,先切回 S 看一眼(回复仍在生成)再切走。
 * 实测(探路实测):只切走一次、回复在不在眼前时结束,旧代码下 M1 都不会重复出现;
 * 必须有「切回时回复仍在生成」这一步,旧消息才会被留在页面里,之后记录里有了它也不清。
 */
async function sendLeaveAndFinish(page, s, text, { peek = true } = {}) {
  await switchTo(page, s.mark);
  resetPhase(CTL, s.sid);
  await sendPrompt(page, text);
  await waitTurnRunning(page, live.chunk1(text));
  await switchTo(page, B.mark);
  if (peek) {
    await page.waitForTimeout(800);
    await switchTo(page, s.mark);
    await page.waitForTimeout(800);
    await switchTo(page, B.mark);
  }
  releaseChunk2(CTL, s.sid);
  releaseTurnEnd(CTL, s.sid);
  await waitPhase(page, CTL, s.sid, 'final');
  await page.waitForTimeout(1_000);   // 让后端把 result 收尾
}

/** 切回 S,等追加的最后一条回复出现在对话里,再多等一会儿让切回后的异步收尾走完。 */
async function switchBackAndSettle(page, s, lastReply) {
  await switchTo(page, s.mark);
  await expect(messageList(page).getByText(lastReply).first(), `切回后对话里应出现追加的最后一条回复「${lastReply}」`)
    .toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1_500);
}

const S5_ROW = /R189S05MARK|^\s*\/compact/;   // 发 /compact 后侧栏标题可能变成 /compact
const tailOf = async (page) => (await listText(page)).slice(-400);

test('B1 [复现] 回复生成时切走,记录追加 130 条用户消息/回复,切回:M1 气泡 0 次,最后一条是最后一条回复', async ({ page }) => {
  const s = S(1);
  const m1 = `${s.mark} 消息M1`;
  await sendLeaveAndFinish(page, s, m1);
  const last = appendFiller(s.sid, 'user');
  await switchBackAndSettle(page, s, last);
  expect.soft(await userBubbleCount(page, m1), `M1 的用户气泡应 0 次(在未加载的更早一页里);对话尾部=${await tailOf(page)}`).toBe(0);
  const rows = messageRows(page);
  expect.soft(await rows.last().innerText(), '对话最后一条应是追加的最后一条回复').toContain(last);
});

test('B2 [复现] 同 B1,追加的 130 条全是任务通知/回复:切回 M1 气泡 0 次', async ({ page }) => {
  const s = S(2);
  const m1 = `${s.mark} 消息M1`;
  await sendLeaveAndFinish(page, s, m1);
  const last = appendFiller(s.sid, 'notice');
  await switchBackAndSettle(page, s, last);
  expect(await userBubbleCount(page, m1), `M1 的用户气泡应 0 次;对话尾部=${await tailOf(page)}`).toBe(0);
});

test('B3 [复现] 在 B1 的结果上再发 N:M1 气泡 0 次,N 气泡 1 次,N 的回复 1 次', async ({ page }) => {
  const s = S(3);
  const m1 = `${s.mark} 消息M1`;
  const n = `${s.mark} 消息N`;
  await sendLeaveAndFinish(page, s, m1);
  const last = appendFiller(s.sid, 'user');
  await switchBackAndSettle(page, s, last);

  resetPhase(CTL, s.sid);
  await sendPrompt(page, n);
  await waitTurnRunning(page, live.chunk1(n));
  releaseChunk2(CTL, s.sid);
  releaseTurnEnd(CTL, s.sid);
  await waitPhase(page, CTL, s.sid, 'final');
  await expect(messageList(page).getByText(live.final(n)).first(), 'N 的回复应出现').toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1_500);

  expect.soft(await userBubbleCount(page, m1), `M1 的用户气泡应 0 次;对话尾部=${await tailOf(page)}`).toBe(0);
  expect.soft(await userBubbleCount(page, n), 'N 的用户气泡应恰好 1 次').toBe(1);
  expect.soft(await assistantBlockCount(page, live.final(n)), 'N 的回复应恰好 1 次').toBe(1);
});

test('B4 [复现] M1、M2 各在回复生成时切走过一次,再追加 130 条,切回:M1、M2 气泡都 0 次', async ({ page }) => {
  const s = S(4);
  const m1 = `${s.mark} 消息M1`;
  const m2 = `${s.mark} 消息M2`;
  await sendLeaveAndFinish(page, s, m1);
  await sendLeaveAndFinish(page, s, m2);
  const last = appendFiller(s.sid, 'user');
  await switchBackAndSettle(page, s, last);
  const tail = await tailOf(page);
  expect.soft(await userBubbleCount(page, m1), `M1 的用户气泡应 0 次;对话尾部=${tail}`).toBe(0);
  expect.soft(await userBubbleCount(page, m2), `M2 的用户气泡应 0 次;对话尾部=${tail}`).toBe(0);
});

test('B5 [复现] 压缩进行中切走,压缩完成后切回:/compact 气泡 0 次,压缩分隔条在', async ({ page }) => {
  const s = S(5);
  await switchTo(page, S5_ROW);
  resetPhase(CTL, s.sid);
  await sendByButton(page, '/compact');
  await waitPhase(page, CTL, s.sid, 'compact-wait');
  await expect(stopButton(page), '压缩进行中应有可用的停止按钮').toBeEnabled({ timeout: 10_000 });
  await switchTo(page, B.mark);
  releaseTurnEnd(CTL, s.sid);
  await waitPhase(page, CTL, s.sid, 'final');
  await page.waitForTimeout(1_500);
  await switchTo(page, S5_ROW);
  await page.waitForTimeout(3_000);

  const text = await listText(page);
  // 分隔条:对话列表里、不在用户气泡内、字样带「压缩」的元素
  const divider = await page.evaluate(() => {
    const ml = document.querySelector('[data-cgui="message-list"]');
    if (!ml) return [];
    return [...ml.querySelectorAll('*')]
      .filter((el) => !el.closest('.chat-user-bubble') && !el.children.length && /压缩/.test(el.textContent || ''))
      .map((el) => (el.textContent || '').trim());
  });
  expect.soft(await userBubbleCount(page, '/compact'), `文字为 /compact 的用户气泡应 0 次;对话文字=${text.slice(-500)}`).toBe(0);
  expect.soft(divider.length, `压缩分隔条应在(对话里找不到带「压缩」字样的非气泡元素);对话文字=${text.slice(-500)}`).toBeGreaterThan(0);
});

test('B6 [相邻回归] 消息还没写进记录时切走,切走期间记录追加 1 条任务通知 + 1 条回复,切回:M 气泡恰好 1 次', async ({ page }) => {
  const s = S(6);
  const m = `${s.mark} 消息M`;
  await switchTo(page, s.mark);
  resetPhase(CTL, s.sid);
  await sendPrompt(page, m);
  await waitTurnRunning(page, live.chunk1(m));
  await switchTo(page, B.mark);
  await page.waitForTimeout(800);
  appendNoticeAndReply(s.sid, 'B6');
  await switchTo(page, s.mark);
  await page.waitForTimeout(1_500);
  const counts = [];
  for (let i = 0; i < 8; i += 1) { counts.push(await userBubbleCount(page, m)); await page.waitForTimeout(500); }
  expect(counts, `切回后 4 秒内每次采样 M 的用户气泡数都应是 1;对话尾部=${await tailOf(page)}`).toEqual(new Array(8).fill(1));
});

test('B7 [相邻回归] 在 B1 的结果上反复点「加载更早」直到 M1 那一页加载出来:M1 气泡恰好 1 次,在它的回复之前', async ({ page }) => {
  const s = S(7);
  const m1 = `${s.mark} 消息M1`;
  await sendLeaveAndFinish(page, s, m1);
  const last = appendFiller(s.sid, 'user');
  await switchBackAndSettle(page, s, last);

  const scope = scrubberScope(page);
  const loadedOf = async () => (await scope.count()) ? Number(/(\d+)\s*\/\s*\d+/.exec(await scope.first().innerText())?.[1] ?? 0) : Infinity;
  for (let i = 0; i < 8 && (await scope.count()); i += 1) {
    const before = await loadedOf();
    await scope.first().click();
    await expect.poll(loadedOf, { message: `点「加载更早」后已加载数应增加(点前 ${before})`, timeout: 20_000 }).toBeGreaterThan(before);
    await page.waitForTimeout(500);
  }
  expect(await scope.count(), '反复点之后「加载更早」按钮应消失(全部历史已加载)').toBe(0);

  // 已加载但可能没挂载:滚到顶再数
  await expect.poll(async () => {
    await messageList(page).evaluate((el) => { el.scrollTop = 0; });
    await page.waitForTimeout(300);
    return userBubbleCount(page, m1);
  }, { message: 'M1 那一页加载出来后应能在对话列表里找到 M1 的用户气泡', timeout: 20_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(500);

  expect.soft(await userBubbleCount(page, m1), 'M1 的用户气泡应恰好 1 次').toBe(1);
  const order = await page.evaluate(({ m1Text, replyText }) => {
    const bubble = [...document.querySelectorAll('.chat-user-bubble')].find((el) => (el.textContent || '').trim() === m1Text);
    const reply = [...document.querySelectorAll('.markdown-content')].find((el) => (el.textContent || '').includes(replyText));
    if (!bubble || !reply) return { bubble: !!bubble, reply: !!reply, before: null };
    return { bubble: true, reply: true, before: !!(bubble.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING) };
  }, { m1Text: m1, replyText: live.chunk1(m1) });
  expect.soft(order, 'M1 的用户气泡应在它那一轮回复之前').toEqual({ bubble: true, reply: true, before: true });
});
