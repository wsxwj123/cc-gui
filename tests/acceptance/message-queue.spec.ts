import { expect, test } from '@playwright/test';
import {
  CLAIM_WARNING,
  FIXTURE,
  NEEDS_REVIEW_TEXT,
  composer,
  confirmClaim,
  openNamedSession,
  openQueuePanel,
  postJson,
  syntheticMessage,
} from './session-interactions.fixture';

test.describe('发送、并入与队列', () => {
  test('忙碌态裸 Enter 只排入当前会话队列', async ({ page }) => {
    let steerCount = 0;
    await page.route('**/api/chat/steer', async (route) => {
      steerCount += 1;
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"accepted":true,"duplicate":false,"pid":"synthetic"}' });
    });
    await openNamedSession(page, FIXTURE.busySession);
    const message = syntheticMessage('BUSY-ENTER-QUEUE');
    await composer(page).fill(message);
    await composer(page).press('Enter');
    await expect(page.getByText(message, { exact: true })).toBeVisible();
    await expect(page.getByText(/已排队|等待当前回合|队列/).first()).toBeVisible();
    expect(steerCount).toBe(0);
  });

  test('忙碌态 Cmd+Enter 与 Ctrl+Enter 都走并入且立即清空输入', async ({ page }) => {
    const requests: Array<Record<string, unknown>> = [];
    await page.route('**/api/chat/steer', async (route) => {
      requests.push(route.request().postDataJSON());
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"accepted":true,"duplicate":false,"pid":"synthetic"}' });
    });
    await openNamedSession(page, FIXTURE.busySession);
    for (const [shortcut, label] of [['Meta+Enter', 'MAC'], ['Control+Enter', 'WINDOWS']] as const) {
      const message = syntheticMessage(`STEER-${label}`);
      await composer(page).fill(message);
      await composer(page).press(shortcut);
      await expect(composer(page)).toHaveValue('');
      await expect(page.getByText(/已接收|并入中|已并入/).last()).toBeVisible();
    }
    expect(requests).toHaveLength(2);
    expect(requests.map((item) => item.content)).toEqual([
      syntheticMessage('STEER-MAC'),
      syntheticMessage('STEER-WINDOWS'),
    ]);
  });

  test('Shift+Enter 与 IME composing Enter 都不触发发送', async ({ page }) => {
    let steerCount = 0;
    await page.route('**/api/chat/steer', async (route) => {
      steerCount += 1;
      await route.abort();
    });
    await openNamedSession(page, FIXTURE.busySession);
    const input = composer(page);
    await input.fill('第一行');
    await input.press('Shift+Enter');
    await expect(input).toHaveValue('第一行\n');
    await input.evaluate((element) => {
      element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '中' }));
      element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter', isComposing: true }));
      element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' }));
    });
    await expect(input).toHaveValue('第一行\n');
    expect(steerCount).toBe(0);
  });

  test('同 slot 同 UUID 同原文只接纳一次并返回 duplicate', async ({ page, request }) => {
    await openNamedSession(page, FIXTURE.busySession);
    const payload = {
      sessionId: FIXTURE.busySessionId,
      uuid: 'steer-acceptance-same-uuid',
      content: syntheticMessage('SAME-UUID'),
    };
    const first = await postJson(request, '/api/chat/steer', payload);
    const second = await postJson(request, '/api/chat/steer', payload);
    expect(first.status()).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, accepted: true, duplicate: false });
    expect(second.status()).toBe(200);
    expect(await second.json()).toMatchObject({ ok: true, accepted: true, duplicate: true });
  });

  test('模糊并入结果进入 needs-review 并阻断后续队列', async ({ page }) => {
    await page.route('**/api/chat/steer', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: '{"ok":false,"code":"steer-acceptance-unknown","error":"并入结果无法确认"}',
      }),
    );
    await openNamedSession(page, FIXTURE.busySession);
    await composer(page).fill(syntheticMessage('AMBIGUOUS-FIRST'));
    await composer(page).press('Meta+Enter');
    await expect(page.getByText(NEEDS_REVIEW_TEXT, { exact: true })).toBeVisible();
    await composer(page).fill(syntheticMessage('MUST-STAY-BEHIND-BARRIER'));
    await composer(page).press('Enter');
    const barrier = page.getByText(NEEDS_REVIEW_TEXT, { exact: true }).locator('xpath=ancestor::*[.//*[contains(normalize-space(), "MUST-STAY-BEHIND-BARRIER")]][1]');
    await expect(barrier.getByText(syntheticMessage('MUST-STAY-BEHIND-BARRIER'), { exact: true })).toBeVisible();
  });

  test('模糊并入在切换 slot 后也不会自动重投', async ({ page }) => {
    let requestCount = 0;
    await page.route('**/api/chat/steer', async (route) => {
      requestCount += 1;
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{"ok":false,"code":"steer-acceptance-unknown","error":"并入结果无法确认"}' });
    });
    await openNamedSession(page, FIXTURE.busySession);
    await composer(page).fill(syntheticMessage('NO-CROSS-SLOT-RETRY'));
    await composer(page).press('Meta+Enter');
    await page.getByText(FIXTURE.busySessionB, { exact: true }).first().click();
    await page.waitForTimeout(1200);
    expect(requestCount).toBe(1);
  });

  test('只有历史 UUID 正向命中才自动删除 needs-review 项', async ({ page }) => {
    await openNamedSession(page, FIXTURE.reviewUuidMatched);
    await openQueuePanel(page);
    await expect(page.getByText(NEEDS_REVIEW_TEXT, { exact: true })).toBeHidden();
    await expect(page.getByRole('button', { name: '取回为新消息', exact: true })).toBeHidden();
  });

  test('安全取回经确认后只生成唯一可恢复草稿且不自动发送', async ({ page }) => {
    const message = syntheticMessage('REVIEW-CLAIM');
    await openNamedSession(page, FIXTURE.reviewSession);
    await openQueuePanel(page);
    await page.getByRole('button', { name: '取回为新消息', exact: true }).click();
    await expect(page.getByText(CLAIM_WARNING, { exact: true })).toBeVisible();
    await confirmClaim(page);
    await expect(composer(page)).toHaveValue(message);
    await expect(page.getByText(NEEDS_REVIEW_TEXT, { exact: true })).toBeHidden();
    await page.reload();
    await page.getByText(FIXTURE.reviewSession, { exact: true }).first().click();
    await expect(composer(page)).toHaveValue(message);
    await expect(page.getByText(message, { exact: true })).toHaveCount(0);
  });
});
