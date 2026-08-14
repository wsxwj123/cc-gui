import { expect, test } from '@playwright/test';
import {
  FIXTURE,
  contextBadge,
  contextDialog,
  openNamedSession,
} from './session-interactions.fixture';

const exactContext = (model: string, sampledAt = '2026-08-14T08:00:00.000Z') => ({
  source: 'sdk',
  sampledAt,
  model,
  totalTokens: 1200,
  windowTokens: 200000,
  pct: 0.6,
  categories: [{ name: 'synthetic', tokens: 1200, pct: 0.6 }],
  mcpServers: [{ server: 'synthetic-local', tokens: 0 }],
});

test.describe('Context 徽章与公开接口', () => {
  test('首次点击在 200ms 内打开本地状态，不等待精确请求', async ({ page }) => {
    await openNamedSession(page, FIXTURE.contextA);
    const startedAt = Date.now();
    await contextBadge(page).click();
    await expect(contextDialog(page)).toBeVisible({ timeout: 200 });
    expect(Date.now() - startedAt).toBeLessThan(200);
    await expect(contextDialog(page).getByText(/本地统计|正在精确计算/)).toBeVisible();
  });

  test('同 canonical key 双击精确计算只发出一个请求', async ({ page }) => {
    let requestCount = 0;
    await page.route('**/api/context/**', async (route) => {
      requestCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(exactContext('synthetic-a')) });
    });
    await openNamedSession(page, FIXTURE.contextA);
    await contextBadge(page).click();
    const refresh = contextDialog(page).getByRole('button', { name: '精确计算上下文', exact: true });
    await refresh.dblclick();
    await expect.poll(() => requestCount).toBe(1);
  });

  test('A 请求晚到时不得覆盖已切换到的 B 会话', async ({ page }) => {
    await page.route(`**/api/context/${FIXTURE.contextAId}**`, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 700));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(exactContext('synthetic-model-a')) });
    });
    await openNamedSession(page, FIXTURE.contextA);
    await contextBadge(page).click();
    await contextDialog(page).getByRole('button', { name: '精确计算上下文' }).click();
    await page.keyboard.press('Escape');
    await page.getByText(FIXTURE.contextB, { exact: true }).first().click();
    await contextBadge(page).click();
    await expect(contextDialog(page)).not.toContainText('synthetic-model-a');
  });

  test('关闭会取消旧消费者，重新打开后可发起新请求', async ({ page }) => {
    let requestCount = 0;
    await page.route('**/api/context/**', async (route) => {
      requestCount += 1;
      if (requestCount === 1) await new Promise((resolve) => setTimeout(resolve, 700));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(exactContext('synthetic-reopened', '2026-08-14T08:00:01.000Z')),
      });
    });
    await openNamedSession(page, FIXTURE.contextA);
    await contextBadge(page).click();
    await contextDialog(page).getByRole('button', { name: '精确计算上下文' }).click();
    await page.keyboard.press('Escape');
    await contextBadge(page).click();
    await contextDialog(page).getByRole('button', { name: '精确计算上下文' }).click();
    await expect(contextDialog(page)).toContainText('synthetic-reopened');
    expect(requestCount).toBe(2);
  });

  test('不可信 session hint 被 409 拒绝并返回固定结构', async ({ page, request }) => {
    await openNamedSession(page, FIXTURE.contextA);
    const response = await request.get(
      `/api/context/${FIXTURE.contextAId}?projectHash=definitely-mismatched&cwd=%2Fsynthetic%2Fwrong&model=synthetic-wrong`,
    );
    expect(response.status()).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      code: 'context-session-mismatch',
      error: '上下文请求与会话不匹配',
    });
  });

  test('内部失败只返回结构化脱敏错误', async ({ page, request }) => {
    await openNamedSession(page, FIXTURE.contextCliError);
    const response = await request.get(`/api/context/${FIXTURE.contextCliErrorId}`);
    expect(response.status()).toBe(500);
    const body = await response.json();
    expect(body).toEqual({ ok: false, code: 'context-cli-unavailable', error: '无法启动上下文计算' });
    expect(JSON.stringify(body)).not.toMatch(/SYNTHETIC_SECRET|\/Users\/|provider|raw|stack/i);
  });

  test('非法 200 整体拒绝、保留本地统计并显示可重试错误', async ({ page }) => {
    await page.route('**/api/context/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...exactContext('synthetic-invalid'), totalTokens: -1, raw: 'SYNTHETIC_SECRET' }),
      }),
    );
    await openNamedSession(page, FIXTURE.contextA);
    await contextBadge(page).click();
    const dialog = contextDialog(page);
    await dialog.getByRole('button', { name: '精确计算上下文' }).click();
    await expect(dialog.getByText('本地统计', { exact: true })).toBeVisible();
    await expect(dialog.getByText(/精确计算失败：.+当前仍显示已有统计。/)).toBeVisible();
    await expect(dialog).not.toContainText('SYNTHETIC_SECRET');
  });
});
