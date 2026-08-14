import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';

/**
 * 黑盒夹具约定：验收宿主在每条测试前重置这些合成项目/会话。
 * 测试只通过页面可见入口和公开 HTTP 接口访问它们，不读取应用存储或会话文件。
 */
export const FIXTURE = {
  nonGitProject: '验收-未初始化Git',
  turnWaveSession: '验收-回合波形',
  contextA: '验收-Context-A',
  contextB: '验收-Context-B',
  contextSplit: '验收-Context-A-B双窗格',
  contextCliError: '验收-Context-CLI失败',
  idleSession: '验收-空闲发送',
  busySession: '验收-流式并入',
  busySessionB: '验收-流式并入-B',
  reviewSession: '验收-needs-review',
  reviewUuidMatched: '验收-needs-review-UUID已命中',
  reviewUuidMissing: '验收-needs-review-UUID未命中',
  interruptedClaim: '验收-claiming中断恢复',
  twoSessionBarrier: '验收-双会话barrier',
  longMainSession: '验收-主会话长流',
  fullSubagentSession: '验收-完整子代理长流',
  multiPaneSession: '验收-同会话双窗格长流',
  multiPaneAgentSession: '验收-同子代理双窗格长流',
  contextAId: 'acceptance-context-a',
  contextBId: 'acceptance-context-b',
  contextCliErrorId: 'acceptance-context-cli-error',
  busySessionId: 'acceptance-busy-a',
  noActiveSessionId: 'acceptance-no-active-turn',
  throwingSessionId: 'acceptance-steer-throws',
} as const;

export const NEEDS_REVIEW_TEXT = '并入结果无法确认，已暂停后续队列';
export const CLAIM_WARNING = '原消息可能已被模型接收，再次发送可能重复。是否取回为新消息？';

export async function openNamedSession(page: Page, visibleName: string): Promise<void> {
  await page.goto('/');
  const entry = page.getByText(visibleName, { exact: true }).first();
  await expect(entry).toBeVisible();
  await entry.click();
}

export function composer(page: Page, index = 0): Locator {
  return page.getByRole('textbox').nth(index);
}

export function chatScroll(page: Page, index = 0): Locator {
  return page.locator('[data-chat-scroll]').nth(index);
}

export function subagentScroll(page: Page, index = 0): Locator {
  return page.locator('[data-subagent-scroll]').nth(index);
}

export function contextBadge(page: Page, index = 0): Locator {
  return page.getByText('Context', { exact: true }).nth(index);
}

export function contextDialog(page: Page): Locator {
  return page.getByRole('dialog');
}

export function turnMarkerButtons(page: Page): Locator {
  return page.getByRole('button', { name: /(?:回合|turn)/i });
}

export function turnStroke(markerButton: Locator): Locator {
  return markerButton.locator('[aria-hidden="true"]').last();
}

export async function openQueuePanel(page: Page): Promise<void> {
  if (await page.getByText(NEEDS_REVIEW_TEXT, { exact: true }).isVisible().catch(() => false)) return;
  await page.getByRole('button', { name: /队列/ }).click();
}

export async function confirmClaim(page: Page): Promise<void> {
  const warning = page.getByText(CLAIM_WARNING, { exact: true });
  await expect(warning).toBeVisible();
  const dialog = warning.locator('xpath=ancestor::*[@role="dialog"][1]');
  await dialog.getByRole('button', { name: /确认|继续取回/ }).click();
}

export async function bannerParts(page: Page): Promise<{
  banner: Locator;
  text: Locator;
  initialize: Locator;
  ignore: Locator;
}> {
  const text = page.getByText('本文件夹未git初始化', { exact: true });
  await expect(text).toBeVisible();
  const banner = text.locator(
    'xpath=ancestor::*[.//button[normalize-space()="立即初始化"] and .//button[normalize-space()="本会话忽略"]][1]',
  );
  return {
    banner,
    text,
    initialize: banner.getByRole('button', { name: '立即初始化', exact: true }),
    ignore: banner.getByRole('button', { name: '本会话忽略', exact: true }),
  };
}

export async function dragSidebar(page: Page, targetWidth: number): Promise<void> {
  const separator = page.getByRole('separator').first();
  await expect(separator).toBeVisible();
  const box = await separator.boundingBox();
  if (!box) throw new Error('sidebar separator has no bounding box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetWidth, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
}

export async function setUiZoom(page: Page, factor: number): Promise<void> {
  await page.evaluate((value) => {
    document.documentElement.style.zoom = String(value);
  }, factor);
}

export async function expectBannerFits(banner: Locator, text: Locator): Promise<void> {
  const result = await banner.evaluate((root, textElement) => {
    const rootBox = root.getBoundingClientRect();
    const descendants = [root, ...root.querySelectorAll<HTMLElement>('*')];
    const overflowed = descendants.some((element) => {
      const box = element.getBoundingClientRect();
      return element.scrollWidth > element.clientWidth + 1 || box.left < rootBox.left - 1 || box.right > rootBox.right + 1;
    });
    const target = textElement as HTMLElement;
    const textBox = target.getBoundingClientRect();
    const style = getComputedStyle(target);
    const fontSize = Number.parseFloat(style.fontSize);
    return {
      overflowed,
      writingMode: style.writingMode,
      textWidth: textBox.width,
      textHeight: textBox.height,
      fontSize,
    };
  }, await text.elementHandle());

  expect(result.overflowed).toBe(false);
  expect(result.writingMode).toMatch(/^horizontal/);
  expect(result.textWidth).toBeGreaterThan(result.fontSize * 6);
  expect(result.textHeight).toBeLessThan(result.fontSize * 3.2);
}

export async function scrollMetrics(container: Locator): Promise<{
  top: number;
  height: number;
  client: number;
  distanceFromBottom: number;
}> {
  return container.evaluate((element) => ({
    top: element.scrollTop,
    height: element.scrollHeight,
    client: element.clientHeight,
    distanceFromBottom: element.scrollHeight - element.clientHeight - element.scrollTop,
  }));
}

export async function waitForStreamGrowth(container: Locator, previousHeight: number): Promise<void> {
  await expect.poll(async () => (await scrollMetrics(container)).height).toBeGreaterThan(previousHeight);
}

export async function wheelUp(page: Page, container: Locator, deltaY = -24): Promise<void> {
  const box = await container.boundingBox();
  if (!box) throw new Error('scroll container has no bounding box');
  await container.hover();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, deltaY);
}

export async function postJson(request: APIRequestContext, path: string, body: unknown) {
  return request.post(path, { data: body });
}

export function syntheticMessage(label: string): string {
  return `SYNTHETIC-${label}-不含真实会话数据`;
}
