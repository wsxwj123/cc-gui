import { expect, test } from '@playwright/test';

test('UI build version 与公开 health 均为本机构建版本', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByText('0.2.290-beta', { exact: true }).first()).toBeVisible();

  const response = await request.get('/api/health');
  expect(response.status()).toBe(200);
  const health = await response.json();
  expect(health.version).toBe('0.2.290-beta');
  expect(health.localBuild).toBe(true);
});
