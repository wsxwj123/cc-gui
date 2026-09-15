// R25 —— 历史操作结果里的「查看备份」入口（UI 面）
//
// 合同来源：.devflow/INTERFACE.md 历史变换段最后一段：「backupRef …为与原会话同权限的不透明引用…
// UI历史操作结果有“查看备份”入口，按backupRef只读展示该副本原文，取消关闭视图，无恢复/覆盖副作用」。
//
// 合同固定了结果入口的文案与语义，但**没有固定**发起历史操作本身的 UI 入口；因此发起方式由夹具
// （historyUi.opEntryName，可选 confirmNames）提供，缺失即 ENVIRONMENT_BLOCKED，不猜控件名。
import { test, expect } from '@playwright/test';
import * as rt from './helpers/r2528-runtime.mjs';

async function triggerHistoryOperation(page, ui) {
  const opEntry = rt.requireField(ui, 'opEntryName');
  const entry = page.getByRole('button', { name: opEntry }).first();
  await expect(entry, `夹具声明的历史操作入口「${opEntry}」必须存在（合同未固定该控件名）`).toBeVisible();
  await rt.clickThroughOverlays(page, entry);
  for (const name of ui.confirmNames || []) {
    const confirm = page.getByRole('button', { name, exact: true }).first();
    if (await confirm.count()) await rt.clickThroughOverlays(page, confirm).catch(() => {});
  }
}

test.describe('R25 历史操作 UI', () => {
  test('R25-26 历史操作结果提供「查看备份」入口', async ({ page, request }) => {
    const baseURL = rt.getRuntime({ requireManifest: true }).baseURL;
    const session = rt.fixtureSection('historySession');
    const ui = rt.fixtureSection('historyUi');
    const backupText = ui.backupEntryText || '查看备份';

    await rt.openFixtureSession(page, session);
    await triggerHistoryOperation(page, ui);

    const before = await rt.sessionSnapshot(
      request, baseURL,
      rt.requireField(session, 'sessionId'), rt.requireField(session, 'projectHash'),
    );

    const entry = page.getByText(backupText).first();
    await expect(entry, `操作结果必须提供「${backupText}」入口`).toBeVisible({ timeout: 15_000 });

    // 反向：仅显示入口不得改写会话。
    const after = await rt.sessionSnapshot(
      request, baseURL,
      rt.requireField(session, 'sessionId'), rt.requireField(session, 'projectHash'),
    );
    rt.expectNoSessionWrite(before, after, 'R25-26 展示查看备份入口');
  });

  test('R25-27 备份视图只读、取消关闭且无恢复/覆盖副作用', async ({ page, request }) => {
    const baseURL = rt.getRuntime({ requireManifest: true }).baseURL;
    const session = rt.fixtureSection('historySession');
    const ui = rt.fixtureSection('historyUi');
    const sessionId = rt.requireField(session, 'sessionId');
    const projectHash = rt.requireField(session, 'projectHash');

    await rt.openFixtureSession(page, session);
    const before = await rt.sessionSnapshot(request, baseURL, sessionId, projectHash);
    await triggerHistoryOperation(page, ui);
    await rt.clickThroughOverlays(page, page.getByText(ui.backupEntryText || '查看备份').first());

    const view = page.getByRole('dialog').first();
    await expect(view, '查看备份必须打开一个只读视图').toBeVisible({ timeout: 15_000 });
    await expect(view, '备份视图必须展示副本原文（不得为空视图）').not.toBeEmpty();
    for (const forbidden of ['恢复', '覆盖', '应用到此会话', '回滚']) {
      expect(await view.getByRole('button', { name: forbidden }).count(),
        `R25-27 备份视图不得提供「${forbidden}」副作用入口`).toBe(0);
    }

    await page.keyboard.press('Escape');
    await expect(view, '取消/关闭后备份视图必须消失').toBeHidden({ timeout: 10_000 });
    const after = await rt.sessionSnapshot(request, baseURL, sessionId, projectHash);
    rt.expectNoSessionWrite(before, after, 'R25-27 查看备份');
  });
});
