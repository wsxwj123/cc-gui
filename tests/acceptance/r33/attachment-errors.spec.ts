import { addAttachments, attachment, expect, openScenario, test } from './public-host.fixture';

test.describe('r33 attachment failure and queue recovery', () => {
  test('R33-ERROR-001 a total upload failure stays visible and removable without sending', async ({ page }) => {
    await openScenario(page, 'R33_UPLOAD_FAILURE_URL');
    await addAttachments(page, [attachment('cannot-upload.txt')]);

    await expect(page.getByTestId('attachment-error')).toBeVisible();
    const failedItem = page.getByTestId('attachment-item').filter({ hasText: 'cannot-upload.txt' });
    await expect(failedItem).toHaveCount(1);
    await expect(page.getByTestId('message-card')).toHaveCount(0);
    await failedItem.getByTestId('attachment-remove').click();
    await expect(failedItem).toHaveCount(0);
  });

  test('R33-ERROR-002 quota failure keeps attachments and does not send text-only or claim queue success', async ({ page }) => {
    await openScenario(page, 'R33_QUEUE_QUOTA_URL');
    await addAttachments(page, [attachment('must-survive-quota.txt')]);
    await expect(page.getByTestId('home-send')).toBeEnabled();
    const messagesBefore = await page.getByTestId('message-card').count();
    await page.getByTestId('home-send').click();

    await expect(page.getByTestId('attachment-error')).toBeVisible();
    await expect(page.getByTestId('attachment-item').filter({ hasText: 'must-survive-quota.txt' })).toHaveCount(1);
    await expect(page.getByTestId('message-card')).toHaveCount(messagesBefore);
  });

  test('R33-ERROR-003 a queued attachment message persists the public envelope and renders its first card', async ({ page }) => {
    await openScenario(page, 'R33_QUEUE_SUCCESS_URL');
    await addAttachments(page, [attachment('queued-meta.txt')]);
    await expect(page.getByTestId('home-send')).toBeEnabled();
    await page.getByTestId('home-send').click();

    const envelopes = await page.evaluate(() => {
      const rawQueue = localStorage.getItem('cgui-message-queue');
      if (rawQueue === null) return [];
      try {
        const queuesBySession: unknown = JSON.parse(rawQueue);
        if (
          !queuesBySession
          || typeof queuesBySession !== 'object'
          || Array.isArray(queuesBySession)
        ) {
          return [];
        }
        return Object.values(queuesBySession).flatMap((sessionQueue) => (
          Array.isArray(sessionQueue) ? sessionQueue : []
        ));
      } catch {
        return [];
      }
    });
    const queued = envelopes.find((candidate) => {
      if (!candidate || typeof candidate !== 'object') return false;
      const value = candidate as {
        text?: unknown;
        queuedAt?: unknown;
        opts?: {
          meta?: {
            attachments?: unknown;
            displayText?: unknown;
          } | null;
        } | null;
      };
      const meta = value.opts?.meta;
      return typeof value.text === 'string'
        && value.text.length > 0
        && typeof value.queuedAt === 'number'
        && Number.isFinite(value.queuedAt)
        && value.queuedAt > 0
        && meta !== null
        && typeof meta === 'object'
        && !Array.isArray(meta)
        && Array.isArray(meta.attachments)
        && meta.attachments.some((item) => (
          !!item
          && typeof item === 'object'
          && (item as { name?: unknown }).name === 'queued-meta.txt'
        ))
        && meta.displayText === '';
    });
    expect(queued).toEqual(expect.objectContaining({
      text: expect.any(String),
      queuedAt: expect.any(Number),
      opts: expect.objectContaining({
        meta: expect.objectContaining({
          attachments: expect.arrayContaining([
            expect.objectContaining({ name: 'queued-meta.txt' }),
          ]),
          displayText: '',
        }),
      }),
    }));
    await expect(page.getByTestId('message-card').first()).toContainText('queued-meta.txt');
  });

});
