// B5 流式期排队(INTERFACE §3.5)。判据是"会话忙不忙",不是"这条消息还在不在写"。
import { test, expect, TID, COPY, ctl, bootUI, modelSays, fence, queueCount, messageCount } from './harness.js';

const BTN = fence({ items: [{ type: 'button', label: '触发', action: 'go' }] });
const marks = (page) => page.getByTestId(TID.actionMsg);
const feedback = (page) => page.getByTestId(TID.feedback).first();

/** 起一个"正在写、且不结束"的回合,围栏已经渲染出来。用 ctl.release(app) 收尾。 */
async function busyTurnWithFence(page, app, body = BTN) {
  const box = await bootUI(page, app);
  await modelSays(page, app, body, { box, hold: true });
  await page.getByTestId(TID.block).first().waitFor({ timeout: 20_000 });
  // §9.1「必须不存在」:流式期的半截 JSON 不得出现说明条(要断言它不在 DOM,不是文字为空)
  await expect(page.getByTestId(TID.notice), '流式期不得出现说明条').toHaveCount(0);
  return box;
}

test('B57+B58+B59 流式中点按钮：立即“已排队”、队列 +1、不打断当前回合', async ({ page, app }) => {
  await busyTurnWithFence(page, app);
  const before = await queueCount(page);
  await page.getByRole('button', { name: '触发' }).click();
  await expect(feedback(page)).toContainText(COPY.queued, { timeout: 3000 });
  expect(await queueCount(page)).toBe(before + 1);
  await expect(marks(page), '排队期间不该已经发出去').toHaveCount(0);
  ctl.release(app);
  await expect(marks(page)).toHaveCount(1, { timeout: 20_000 });
});

test('B60 回合结束：队列里那条自动发出，用户不用再点', async ({ page, app }) => {
  await busyTurnWithFence(page, app);
  await page.getByRole('button', { name: '触发' }).click();
  await expect(feedback(page)).toContainText(COPY.queued);
  ctl.release(app);
  await expect(marks(page)).toHaveCount(1, { timeout: 20_000 });
  expect(await queueCount(page)).toBe(0);
  // §9.3:没有可见排队条目时整条 queue-bar 不存在
  await expect(page.getByTestId(TID.queueBar), '队列空了整条就不该在').toHaveCount(0);
});

test('B61 排队中从队列里删掉：这条不再发出', async ({ page, app }) => {
  await busyTurnWithFence(page, app);
  await page.getByRole('button', { name: '触发' }).click();
  await expect(feedback(page)).toContainText(COPY.queued);
  await page.getByTestId(TID.queueItem).first().getByTestId(TID.queueItemDelete).click();
  ctl.release(app);
  await page.waitForTimeout(3000);
  await expect(marks(page), '删掉的消息不得发出').toHaveCount(0);
});

test('B62 入队失败（本地存储配额满）：显示“发送失败”而不是“已排队”，组件仍可交互', async ({ page, app }) => {
  await busyTurnWithFence(page, app);
  // 把 localStorage 撑满,让入队写盘失败
  await page.evaluate(() => {
    const chunk = 'x'.repeat(512 * 1024);
    try { for (let i = 0; i < 200; i++) localStorage.setItem('__fill_' + i, chunk); } catch { /* 撑满即可 */ }
  });
  const btn = page.getByRole('button', { name: '触发' });
  await btn.click();
  await expect(feedback(page)).toContainText(COPY.sendFailed, { timeout: 5000 });
  await expect(feedback(page)).not.toContainText(COPY.queued);
  await expect(btn, '失败后组件必须保持可交互(不得静默丢弃)').toBeEnabled();
  ctl.release(app);
});

test('B63 排队期间回合结束：“已排队”反馈在发出之前仍然可见', async ({ page, app }) => {
  await busyTurnWithFence(page, app);
  await page.getByRole('button', { name: '触发' }).click();
  await expect(feedback(page)).toContainText(COPY.queued);
  await expect(feedback(page)).toContainText(COPY.queued);   // 回合还没结束,反馈得一直在
});

test('B64 【硬断言】点击后 300ms 内回合结束：消息必须仍然发出', async ({ page, app }) => {
  await busyTurnWithFence(page, app);
  await page.getByRole('button', { name: '触发' }).click();
  await page.waitForTimeout(120);          // 卡在"界面正要因回合定稿而重建"的窗口里
  ctl.release(app);
  await expect(marks(page), '这一刻的消息绝不能被吞掉').toHaveCount(1, { timeout: 20_000 });
});

test('B65 消息真的发出去之后：“已排队”反馈消失', async ({ page, app }) => {
  await busyTurnWithFence(page, app);
  await page.getByRole('button', { name: '触发' }).click();
  await expect(feedback(page)).toContainText(COPY.queued);
  ctl.release(app);
  await expect(marks(page)).toHaveCount(1, { timeout: 20_000 });
  await expect(page.getByTestId(TID.feedback)).toHaveCount(0);
});

test('B66 从队列条里删掉：“已排队”反馈消失', async ({ page, app }) => {
  await busyTurnWithFence(page, app);
  await page.getByRole('button', { name: '触发' }).click();
  await expect(feedback(page)).toContainText(COPY.queued);
  await page.getByTestId(TID.queueItem).first().getByTestId(TID.queueItemDelete).click();
  await expect(page.getByTestId(TID.feedback)).toHaveCount(0);
  ctl.release(app);
});

test('B67 排队期间刷新页面：队列还在，“已排队”反馈也重新出现', async ({ page, app }) => {
  await busyTurnWithFence(page, app);
  await page.getByRole('button', { name: '触发' }).click();
  await expect(feedback(page)).toContainText(COPY.queued);
  await page.reload();
  await expect(page.getByTestId(TID.queueItem)).toHaveCount(1, { timeout: 20_000 });
  await expect(feedback(page)).toContainText(COPY.queued);
  ctl.release(app);
});

test('B68 会话忙但这条围栏早已定稿：仍然显示“已排队”（判据是忙不忙）', async ({ page, app }) => {
  const box = await bootUI(page, app);
  await modelSays(page, app, BTN, { box });                 // 第一回合正常结束,围栏已定稿
  await page.getByTestId(TID.block).first().waitFor();
  ctl.script(app, '第二回合正文'); ctl.hold(app);            // 再起一个不结束的回合
  await box.fill('第二问'); await box.press('Enter');
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: '触发' }).click();
  await expect(feedback(page)).toContainText(COPY.queued, { timeout: 5000 });
  ctl.release(app);
});

test('B69 会话空闲：显示“已发送”，消息立即发出', async ({ page, app }) => {
  const box = await bootUI(page, app);
  await modelSays(page, app, BTN, { box });
  await page.getByTestId(TID.block).first().waitFor();
  const before = await messageCount(page);
  await page.getByRole('button', { name: '触发' }).click();
  await expect(feedback(page)).toContainText(COPY.sent, { timeout: 5000 });
  await expect(marks(page)).toHaveCount(1, { timeout: 10_000 });
  expect(await messageCount(page)).toBeGreaterThan(before);
});
