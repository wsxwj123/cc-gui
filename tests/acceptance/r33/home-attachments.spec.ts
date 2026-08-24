import {
  addAttachments,
  attachment,
  choosePublicOption,
  expect,
  openScenario,
  publicControlValue,
  test,
  textFixture,
} from './public-host.fixture';

test.describe('r33 home attachments', () => {
  test('R33-ATTACH-001 one picker adds multiple files and each can be removed independently', async ({ page }) => {
    await openScenario(page, 'R33_HOME_ATTACHMENTS_URL');
    await addAttachments(page, [attachment('报告 甲.txt'), attachment('emoji-🧪.txt')]);

    const items = page.getByTestId('attachment-item');
    await expect(items).toHaveCount(2);
    await expect(items.filter({ hasText: '报告 甲.txt' })).toHaveCount(1);
    await expect(items.filter({ hasText: 'emoji-🧪.txt' })).toHaveCount(1);
    await items.filter({ hasText: 'emoji-🧪.txt' }).getByTestId('attachment-remove').click();
    await expect(page.getByTestId('attachment-item')).toHaveCount(1);
    await expect(page.getByTestId('attachment-item').filter({ hasText: '报告 甲.txt' })).toHaveCount(1);
    await expect(page.getByText('emoji-🧪.txt', { exact: true })).toHaveCount(0);
  });

  test('R33-ATTACH-002 an attachment-only first message is sent and rendered with the file', async ({ page }) => {
    await openScenario(page, 'R33_HOME_ATTACHMENTS_URL');
    await addAttachments(page, [attachment('only attachment.txt')]);
    await expect(page.getByTestId('home-send')).toBeEnabled();
    await page.getByTestId('home-send').click();

    const firstMessage = page.getByTestId('message-card').first();
    await expect(firstMessage).toBeVisible();
    await expect(firstMessage).toContainText('only attachment.txt');
  });

  test('R33-ATTACH-003 send remains disabled throughout an outstanding upload', async ({ page }) => {
    await openScenario(page, 'R33_DELAYED_UPLOAD_URL');
    await addAttachments(page, [attachment('delayed-upload.txt')]);

    await expect(page.getByTestId('attachment-item')).toHaveCount(1);
    await expect(page.getByTestId('home-send')).toBeDisabled();
    await expect(page.getByTestId('home-send')).toBeEnabled({ timeout: 30_000 });
  });

  test('R33-ATTACH-004 one failed upload is visible and does not discard the successful sibling', async ({ page }) => {
    await openScenario(page, 'R33_PARTIAL_UPLOAD_FAILURE_URL');
    await addAttachments(page, [attachment('accepted.txt'), attachment('fixture-fails.txt')]);

    await expect(page.getByTestId('attachment-error')).toBeVisible();
    await expect(page.getByTestId('attachment-item').filter({ hasText: 'accepted.txt' })).toHaveCount(1);
    const failedItem = page.getByTestId('attachment-item').filter({ hasText: 'fixture-fails.txt' });
    await expect(failedItem).toHaveCount(1);
    await failedItem.getByTestId('attachment-remove').click();
    await expect(page.getByTestId('attachment-item').filter({ hasText: 'accepted.txt' })).toHaveCount(1);
    await expect(page.getByTestId('home-send')).toBeEnabled();
  });

  test('R33-ATTACH-005 attachment use preserves chosen permission mode and project', async ({ page }) => {
    await openScenario(page, 'R33_HOME_SELECTIONS_URL');
    const permission = page.getByTestId('permission-mode-selector');
    const project = page.getByTestId('project-selector');
    await choosePublicOption(page, permission, textFixture('R33_PERMISSION_OPTION'));
    await choosePublicOption(page, project, textFixture('R33_PROJECT_OPTION'));
    const permissionBefore = await publicControlValue(permission);
    const projectBefore = await publicControlValue(project);

    await addAttachments(page, [attachment('selection-regression.txt')]);
    await expect.poll(() => publicControlValue(permission)).toBe(permissionBefore);
    await expect.poll(() => publicControlValue(project)).toBe(projectBefore);
    await expect(page.getByTestId('home-send')).toBeEnabled();
    await page.getByTestId('home-send').click();
    await expect(page.getByTestId('message-card').first()).toContainText('selection-regression.txt');
  });
});
