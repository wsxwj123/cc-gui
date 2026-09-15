import { test, expect } from '@playwright/test';
import { EnvironmentBlocked, fixtureSection, openFixtureSession } from './helpers/runtime.mjs';

// FB-T31（R10 用户复现）：普通 user 形态 task-notification 不得显示为"你/已并入"的用户气泡，
// 也不得制造空的人工回合。
// FB-T32（R10 用户复现）：queued_command 形态通知同样不得成为人工/并入气泡。
//
// 夹具载体与制备前提（本套件不用会话级 URL：产品任何路径都渲染首页；导航实现见
// helpers/runtime.mjs 的 openFixtureSession）：侧栏搜索 manifest.notifications.sessionSearchMarker
// → 点搜索结果行 → 打开夹具会话。两类通知必须由公开真实任务动作产生（发起一次真实任务/在运行中
// 排队一条命令），不得私改会话存储。**当前隔离实例无模型登录态：该夹具不可制备** ——
// 操作者需提供一次性低额度 CLI/model 账户并在隔离实例里真正跑出普通 user 与 queued_command
// 两类通知，之后这两条测试按原样断言。未设开关时按设计报 ENVIRONMENT_BLOCKED（环境阻断，
// 不是产品失败），与 FB-T22/T25 同一模式。
//
// 使用的黑盒合同句柄：会话 UI 导航（夹具）、data-message-id（INTERFACE.md 锁定的 DOM 观测属性）、
// "你"/"已并入"（合同点名文案，白名单明确其仅用于否定断言）、页面文本定位。
//
// 断言逻辑：
// - 原始标记可见：通知内容不被丢弃/截断（合同：任务终态更新及模型通知不被截断）。
// - 合同保证"消息提供 data-message-id"。若通知被渲染成用户/并入气泡，它必然位于某个
//   data-message-id 消息元素内；对该元素断言不含"你"、不含"已并入"。
// - 标记恰好落在一条消息元素内：若通知被拆成"气泡 + 内容"两条渲染（空人工回合的形态），
//   计数会大于 1 或落入带"你"标签的元素。
//
// 合同模糊点（详见交付报告）：合同未锁定"已确认通知"在 UI 中的具体呈现形态（消息体还是系统提示行）。
// 若实现把它渲染成不带 data-message-id 的非消息行，上述否定断言按构造依然成立
// （用户气泡必是消息元素），故对消息元素计数采用"存在才收紧"的策略。

async function expectNotificationNotRenderedAsUserBubble(page, rawMarker) {
  await openFixtureSession(page, fixtureSection('notifications'));

  // 通知原始标记文本可见：内容保留、未被截断
  await expect(page.getByText(rawMarker)).toBeVisible();

  // 承载该标记的消息元素（若有）：恰好一条，且不是"你"/"已并入"的人工气泡
  const message = page.locator('[data-message-id]', { hasText: rawMarker });
  const messageCount = await message.count();
  if (messageCount > 0) {
    await expect(message).toHaveCount(1);
    await expect(message.getByText('你', { exact: true })).toHaveCount(0);
    await expect(message.getByText('已并入', { exact: true })).toHaveCount(0);
  }
}

test('FB-T31 普通user形态task-notification不显示为你或已并入的用户气泡且不制造空人工回合', async ({ page }) => {
  if (process.env.FIRST_BATCH_ALLOW_MODEL !== '1') {
    throw new EnvironmentBlocked(
      'FB-T31 needs the isolated real-task notification fixture (ordinary user form) and FIRST_BATCH_ALLOW_MODEL=1',
    );
  }
  const notifications = fixtureSection('notifications');
  await expectNotificationNotRenderedAsUserBubble(page, notifications.ordinaryRawMarker);
});

test('FB-T32 queued_command形态通知不显示为你或已并入的用户气泡且不制造空人工回合', async ({ page }) => {
  if (process.env.FIRST_BATCH_ALLOW_MODEL !== '1') {
    throw new EnvironmentBlocked(
      'FB-T32 needs the isolated real-task notification fixture (queued_command form) and FIRST_BATCH_ALLOW_MODEL=1',
    );
  }
  const notifications = fixtureSection('notifications');
  await expectNotificationNotRenderedAsUserBubble(page, notifications.queuedRawMarker);
});
