// r207 页面验收(黑盒):接口文件行为清单 6、7。只由 run.sh 调起(bash tests/acceptance/r207-huge-session-open/run.sh --ui-only)。
// 只通过页面文案 / role、页面发出的请求(Playwright 记录与拦截,只拦被测会话的历史接口 GET)、假命令行观察文件判断。
import { test, expect } from '@playwright/test';
import { POOL, lastReplyOf } from './helpers/ui-fixtures.mjs';
import {
  CTL, boot, openSessionBySearch, sendPrompt, interceptHistory, isHistoryUrl, clearTurnEnd, waitTurnEnd, sleep,
} from './helpers/ui.mjs';

const TXT_TIMEOUT = '读取会话历史超时，可重试';
const TXT_FAILED = '读取会话历史失败，可重试';
const TXT_EMPTY = '该会话没有可显示的消息';
const retryBtn = (page) => page.getByRole('button', { name: '重试', exact: true });

test.beforeEach(() => { if (!CTL) throw new Error('R207_CTL 没设置:请用 run.sh 运行'); });

async function failThenRetry(page, S, mode, wantText, otherText) {
  const ctl = await interceptHistory(page, S.sid, mode);
  await boot(page);
  await openSessionBySearch(page, S.mark);
  await expect(page.getByText(wantText).first(), `会话历史请求失败(${mode})时,对话区应显示「${wantText}」`).toBeVisible({ timeout: 30_000 });
  await expect(retryBtn(page), '失败提示旁应有名为「重试」的按钮').toBeVisible();
  expect(await page.getByText(TXT_EMPTY).count(), `不应显示「${TXT_EMPTY}」`).toBe(0);
  expect(await page.getByText(otherText).count(), `不应显示另一种失败文字「${otherText}」`).toBe(0);
  const before = ctl.hits.length;
  ctl.mode = 'pass';   // 让请求恢复正常
  await retryBtn(page).click();
  await expect(page.getByText(lastReplyOf(S.mark)).first(), '点「重试」且请求成功后,对话区应显示这个会话的消息').toBeVisible({ timeout: 30_000 });
  expect(ctl.hits.length, '点「重试」应重新发出历史请求').toBeGreaterThan(before);
  expect(await page.getByText(wantText).count(), '成功后失败文字应消失').toBe(0);
  expect(await retryBtn(page).count(), '成功后「重试」按钮应消失').toBe(0);
}

test('T6a 第一次加载历史回 504:显示「读取会话历史超时，可重试」+「重试」按钮,不出现空会话文案;恢复后点重试显示消息', async ({ page }) => {
  await failThenRetry(page, POOL.A, '504', TXT_TIMEOUT, TXT_FAILED);
});

test('T6b 第一次加载历史回 500:显示「读取会话历史失败，可重试」+「重试」按钮,不出现空会话文案;恢复后点重试显示消息', async ({ page }) => {
  await failThenRetry(page, POOL.B, '500', TXT_FAILED, TXT_TIMEOUT);
});

test('T6c 会话已显示消息时后台刷新失败(回合结束后的刷新回 504):消息照旧、不出现失败文字与重试按钮', async ({ page }) => {
  const S = POOL.C;
  const ctl = await interceptHistory(page, S.sid, 'pass');
  await boot(page);
  await openSessionBySearch(page, S.mark);
  await expect(page.getByText(lastReplyOf(S.mark)).first(), '前置:会话应已显示消息').toBeVisible({ timeout: 30_000 });
  ctl.mode = '504';
  clearTurnEnd(S.sid);
  const tSend = Date.now();
  await sendPrompt(page, `${S.mark} 后台刷新失败那一轮`);
  await waitTurnEnd(S.sid);
  const failedRefresh = async () => { const t0 = Date.now(); while (Date.now() - t0 < 20_000) { if (ctl.hits.some((h) => h.t >= tSend && h.mode === '504')) return true; await sleep(200); } return false; };
  expect(await failedRefresh(), '回合结束后页面应发出至少一次历史请求(被拦成 504)').toBe(true);
  await sleep(2_000);   // 给页面处理失败应答的时间,再核对"没有出现"
  expect(await page.getByText(TXT_TIMEOUT).count(), '已显示消息时后台刷新失败不应弹「超时」提示').toBe(0);
  expect(await page.getByText(TXT_FAILED).count(), '已显示消息时后台刷新失败不应弹「失败」提示').toBe(0);
  expect(await retryBtn(page).count(), '不应出现「重试」按钮').toBe(0);
  await expect(page.getByText(lastReplyOf(S.mark)).first(), '原有消息应照旧显示').toBeVisible();
});

test('T7 回合结束核对:发消息到回复结束后 5 秒内,页面对这个会话发的每个历史请求都带 limit;提问与回复各只出现一次', async ({ page }) => {
  const S = POOL.D;
  const gets = [];
  page.on('request', (req) => { if (req.method() === 'GET' && isHistoryUrl(S.sid, req.url())) gets.push({ t: Date.now(), url: req.url() }); });
  await boot(page);
  await openSessionBySearch(page, S.mark);
  await expect(page.getByText(lastReplyOf(S.mark)).first(), '前置:会话应已显示消息').toBeVisible({ timeout: 30_000 });
  clearTurnEnd(S.sid);
  const prompt = `${S.mark} 回合结束核对那一条消息`;
  const tSend = Date.now();
  await sendPrompt(page, prompt);
  const reply = `R207-REPLY-OK ${S.sid.slice(0, 8)} 收到:${prompt}`;
  await expect(page.getByText(reply).first(), '回复应出现在对话区').toBeVisible({ timeout: 40_000 });
  await waitTurnEnd(S.sid);
  await sleep(5_000);   // 回复结束后的 5 秒窗口
  const since = gets.filter((g) => g.t >= tSend);
  const noLimit = since.filter((g) => !new URL(g.url).searchParams.has('limit'));
  expect(noLimit.map((g) => g.url), `发消息之后页面对该会话发出的 ${since.length} 个历史请求里,不带 limit 的应为 0 个`).toEqual([]);
  expect(await page.locator('.chat-user-bubble').filter({ hasText: prompt }).count(), '这一轮的提问应恰好出现 1 次').toBe(1);
  expect(await page.getByText(reply).count(), '这一轮的回复应恰好出现 1 次').toBe(1);
});
