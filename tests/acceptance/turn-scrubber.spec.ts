import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  FIXTURE,
  chatScroll,
  openNamedSession,
  turnMarkerButtons,
  turnStroke,
} from './session-interactions.fixture';

async function box(locator: Locator) {
  const value = await locator.boundingBox();
  if (!value) throw new Error('turn marker is not measurable');
  return value;
}

async function moveTo(page: Page, marker: Locator, offsetY: number) {
  const markerBox = await box(marker);
  await page.mouse.move(markerBox.x + markerBox.width - 2, markerBox.y + markerBox.height / 2 + offsetY);
  await page.evaluate(() => new Promise(requestAnimationFrame));
}

test.describe('右侧回合波形', () => {
  test.beforeEach(async ({ page }) => {
    await openNamedSession(page, FIXTURE.turnWaveSession);
    await expect(turnMarkerButtons(page)).toHaveCount(9);
  });

  test('静止态只呈短横线而不是圆点或点线混合', async ({ page }) => {
    const markers = turnMarkerButtons(page);
    for (let index = 0; index < await markers.count(); index += 1) {
      const strokeBox = await box(turnStroke(markers.nth(index)));
      expect(strokeBox.width).toBeCloseTo(6, 0);
      expect(strokeBox.width / strokeBox.height).toBeGreaterThan(2.5);
    }
  });

  test('所有横线在静止和 hover 时右端始终对齐', async ({ page }) => {
    const markers = turnMarkerButtons(page);
    await moveTo(page, markers.nth(4), 0);
    const rightEdges: number[] = [];
    for (let index = 0; index < await markers.count(); index += 1) {
      const strokeBox = await box(turnStroke(markers.nth(index)));
      rightEdges.push(strokeBox.x + strokeBox.width);
    }
    expect(Math.max(...rightEdges) - Math.min(...rightEdges)).toBeLessThanOrEqual(1);
  });

  test('hover 长度符合距离公式且相邻 1px 采样连续变化', async ({ page }) => {
    const marker = turnMarkerButtons(page).nth(4);
    const widths: number[] = [];
    for (let distance = 0; distance <= 48; distance += 1) {
      await moveTo(page, marker, distance);
      const measured = (await box(turnStroke(marker))).width;
      const expected = 6 + 12 * Math.max(0, 1 - distance / 48) ** 2;
      expect(measured).toBeCloseTo(expected, 0);
      widths.push(measured);
    }
    for (let index = 1; index < widths.length; index += 1) {
      expect(widths[index - 1] - widths[index]).toBeGreaterThanOrEqual(-0.1);
      expect(Math.abs(widths[index] - widths[index - 1])).toBeLessThanOrEqual(0.6);
    }
  });

  test('鼠标离开后全部横线恢复 6px 静止态', async ({ page }) => {
    const markers = turnMarkerButtons(page);
    await moveTo(page, markers.nth(4), 0);
    await page.mouse.move(20, 20);
    await expect.poll(async () => (await box(turnStroke(markers.nth(4)))).width).toBeCloseTo(6, 0);
  });

  test('点击回合标记仍能导航且命中区大于视觉横线', async ({ page }) => {
    const marker = turnMarkerButtons(page).nth(2);
    const markerBox = await box(marker);
    const strokeBox = await box(turnStroke(marker));
    expect(markerBox.width).toBeGreaterThan(strokeBox.width);
    const before = await chatScroll(page).evaluate((element) => element.scrollTop);
    await marker.click();
    await expect(page.getByText('SYNTHETIC-TURN-03-TARGET', { exact: true })).toBeInViewport();
    await expect.poll(async () => chatScroll(page).evaluate((element) => element.scrollTop)).not.toBe(before);
  });
});
