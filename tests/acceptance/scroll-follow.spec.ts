import { expect, test, type Locator } from '@playwright/test';
import {
  FIXTURE,
  chatScroll,
  openNamedSession,
  scrollMetrics,
  subagentScroll,
  waitForStreamGrowth,
  wheelUp,
} from './session-interactions.fixture';

function returnToBottomButton(container: Locator): Locator {
  const scope = container.locator('xpath=ancestor::*[.//button[contains(normalize-space(), "回到底部")]][1]');
  return scope.getByRole('button', { name: /回到底部/ });
}

async function expectReadingPositionStable(container: Locator, previousTop: number, previousHeight: number) {
  await waitForStreamGrowth(container, previousHeight);
  await expect.poll(async () => (await scrollMetrics(container)).top).toBeCloseTo(previousTop, 0);
}

test.describe('流式滚动意图与容器隔离', () => {
  test('主会话首次上滚即停止吸底，点击回底后恢复跟随', async ({ page }) => {
    await openNamedSession(page, FIXTURE.longMainSession);
    const container = chatScroll(page);
    const initial = await scrollMetrics(container);
    await waitForStreamGrowth(container, initial.height);
    await expect.poll(async () => (await scrollMetrics(container)).distanceFromBottom).toBeLessThanOrEqual(40);
    await wheelUp(page, container);
    const reading = await scrollMetrics(container);
    await expectReadingPositionStable(container, reading.top, reading.height);
    const button = returnToBottomButton(container);
    await expect(button).toBeVisible();
    await button.click();
    await expect.poll(async () => (await scrollMetrics(container)).distanceFromBottom).toBeLessThanOrEqual(1);
    const restored = await scrollMetrics(container);
    await waitForStreamGrowth(container, restored.height);
    await expect.poll(async () => (await scrollMetrics(container)).distanceFromBottom).toBeLessThanOrEqual(40);
  });

  test('完整子代理上滚与回底只操作自己的滚动容器', async ({ page }) => {
    await openNamedSession(page, FIXTURE.fullSubagentSession);
    const main = chatScroll(page);
    const agent = subagentScroll(page);
    const mainBefore = await scrollMetrics(main);
    await wheelUp(page, agent);
    const agentReading = await scrollMetrics(agent);
    await expectReadingPositionStable(agent, agentReading.top, agentReading.height);
    await returnToBottomButton(agent).click();
    await expect.poll(async () => (await scrollMetrics(agent)).distanceFromBottom).toBeLessThanOrEqual(1);
    expect((await scrollMetrics(main)).top).toBeCloseTo(mainBefore.top, 0);
  });

  for (const fixtureName of [FIXTURE.multiPaneSession, FIXTURE.multiPaneAgentSession]) {
    test(`${fixtureName} 的两个 pane 不共享 reading/following 状态`, async ({ page }) => {
      await openNamedSession(page, fixtureName);
      const containers = fixtureName === FIXTURE.multiPaneSession
        ? [chatScroll(page, 0), chatScroll(page, 1)]
        : [subagentScroll(page, 0), subagentScroll(page, 1)];
      await wheelUp(page, containers[0]);
      const firstReading = await scrollMetrics(containers[0]);
      const secondBefore = await scrollMetrics(containers[1]);
      await expectReadingPositionStable(containers[0], firstReading.top, firstReading.height);
      await waitForStreamGrowth(containers[1], secondBefore.height);
      await expect.poll(async () => (await scrollMetrics(containers[1])).distanceFromBottom).toBeLessThanOrEqual(40);
      await expect(returnToBottomButton(containers[0])).toBeVisible();
      await expect(returnToBottomButton(containers[1])).toBeHidden();
    });
  }
});
