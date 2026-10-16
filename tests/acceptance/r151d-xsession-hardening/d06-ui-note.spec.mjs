// r151d 行为清单 6:设置 → 会话 → 跨会话块里的本地接口说明。共享实例(run.sh 起的,dev server 代理到它)。
// 总开关用 PUT /api/xsession/config 切,切完重新进应用再打开设置页,看页面上的元素。
import { test, expect } from '@playwright/test';
import { xs } from '../r151b-xsession-p1/helpers/api.mjs';
import { boot, openSessionSettings } from '../r151b-xsession-p1/helpers/ui.mjs';
import { NOTE_TEXT } from './helpers/d.mjs';

test.describe.configure({ timeout: 180_000 });
const api = xs();

async function openXsSection(page) {
  await boot(page);
  await openSessionSettings(page);
  const section = page.getByTestId('xsession-settings-section');
  await section.scrollIntoViewIfNeeded().catch(() => {});
  await expect(section, '前置:设置 → 会话里有跨会话块').toBeVisible({ timeout: 15_000 });
  return section;
}

test('D06 总开关开:跨会话块里显示 xsession-local-api-note,文字逐字为定稿文案', async ({ page }) => {
  await api.on();
  const section = await openXsSection(page);
  const note = section.getByTestId('xsession-local-api-note');
  await expect(note, '说明在跨会话块里、可见').toBeVisible({ timeout: 10_000 });
  await expect(note).toHaveText(NOTE_TEXT);
  expect(await note.evaluate((e) => e.textContent), '文字逐字一致(不多不少)').toBe(NOTE_TEXT);
  expect(await page.getByTestId('xsession-local-api-note').count(), '整页只有这一处').toBe(1);
});

test('D06b 总开关关:页面上没有 xsession-local-api-note', async ({ page }) => {
  await api.off();
  const r = await api.config();
  expect(r.body && r.body.enabled, '前置:总开关已关').toBe(false);
  await openXsSection(page);
  await page.waitForTimeout(1_000);
  expect(await page.getByTestId('xsession-local-api-note').count(), '开关关时整页没有这个元素').toBe(0);
});
