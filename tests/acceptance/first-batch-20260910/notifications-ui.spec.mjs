import { test, expect } from '@playwright/test';
import { EnvironmentBlocked, fixtureSection, openFixtureSession } from './helpers/runtime.mjs';

// 夹具载体与制备前提（本套件不用会话级 URL：产品任何路径都渲染首页，夹具一律经公开 UI 点选打开，
// 导航实现见 helpers/runtime.mjs 的 openFixtureSession，细节见 README「夹具导航」）：
// 导航 = 侧栏搜索框输入 manifest.notifications.sessionSearchMarker → 点搜索结果行 → 打开夹具会话。
//
// 该夹具会话必须由公开真实任务动作产生（不得私改会话存储），并含以下标记：
//   - manualXmlMarker：操作者手动发送的一条人类 XML 讨论（任意人工消息即可，无模型也能造）；
//   - terminalStatusMarker：真实任务终态更新（completed/failed/killed）文本；
//   - modelNotificationMarker：真实模型通知文本。
//
// 当前隔离实例无模型登录态：需要“真实任务终态 / 真实模型通知”的两个标记（FB-T34、FB-T35）不可制备——
// 操作者必须提供一次性低额度 CLI/model 账户，在隔离实例里真正跑出一次任务生命周期与模型通知。
// 这两条按 FB-T22/T25 同一模式带守卫：未设 FIRST_BATCH_ALLOW_MODEL=1 时抛 ENVIRONMENT_BLOCKED
// （环境阻断，不是产品失败），且必须先完成 README「夹具导航/夹具制备」所述制备；FB-T33、FB-T37 不受阻断。
async function openNotificationFixture(page) {
  const section = fixtureSection('notifications');
  await openFixtureSession(page, section);
  return section;
}

test('FB-T33 R10 adjacent regression: human-authored XML discussion remains visible', async ({ page }) => {
  const section = await openNotificationFixture(page);
  await expect(page.getByText(section.manualXmlMarker, { exact: false })).toBeVisible();
});

test('FB-T34 R10 adjacent regression: terminal status notification remains visible and complete', async ({ page }) => {
  if (process.env.FIRST_BATCH_ALLOW_MODEL !== '1') {
    throw new EnvironmentBlocked(
      'FB-T34 needs the isolated real-task terminal-state notification fixture and FIRST_BATCH_ALLOW_MODEL=1',
    );
  }
  const section = await openNotificationFixture(page);
  await expect(page.getByText(section.terminalStatusMarker, { exact: false })).toBeVisible();
});

test('FB-T35 R10 adjacent regression: model notification remains visible and complete', async ({ page }) => {
  if (process.env.FIRST_BATCH_ALLOW_MODEL !== '1') {
    throw new EnvironmentBlocked(
      'FB-T35 needs the isolated real-model notification fixture and FIRST_BATCH_ALLOW_MODEL=1',
    );
  }
  const section = await openNotificationFixture(page);
  await expect(page.getByText(section.modelNotificationMarker, { exact: false })).toBeVisible();
});

test('FB-T37 R10/R29 contract: rendered session exposes non-secret message identities', async ({ page }) => {
  await openNotificationFixture(page);
  const messages = page.locator('[data-message-id]');
  expect(await messages.count()).toBeGreaterThan(0);
  for (const value of await messages.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-message-id')))) {
    expect(value).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
  }
});
