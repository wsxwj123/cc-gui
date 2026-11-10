// r165-default-speed：加载动画「转速」的默认值由「慢」改成「标准」。
// 只影响没存过转速、或存的值不合法的人；选过慢 / 标准 / 快的人原样不变（也不被 r164 的「升级后第一次打开重置样式」牵连）。
// 判据只看页面上用户能看到的东西与 localStorage 键（cgui-loading-speed）：不读源码、不读 React state、不 import 应用内部模块。
//
// 「旧版留下的存储」用 seedOnce 在这个标签页【第一次导航前】写入，刷新时不再写（做法同 r164-style-reset.spec.mjs）。
import { test, expect } from '@playwright/test';
import { openApp } from './helpers/runtime.mjs';
import {
  IND, lsGet, openAllGates, prepareLive, sendRound, reloadApp, openInterfaceTab, closeThemePopover,
} from './helpers/ui.mjs';

// 用例失败时直播回合会停在半路（假命令行在等放行文件）：把所有闸门都放了，让它自己收尾，别拖累下一条。
test.afterEach(async () => { try { openAllGates(); } catch { /* 忽略 */ } });

const SPEED = 'cgui-loading-speed';
const STYLE = 'cgui-loading-style';

async function seedOnce(page, seeds) {
  await page.addInitScript((s) => {
    try {
      localStorage.setItem('cgui-tour-seen', '1');
      if (sessionStorage.getItem('__r165_seeded')) return;
      sessionStorage.setItem('__r165_seeded', '1');
      for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v);
    } catch { /* 忽略 */ }
  }, seeds);
}

const speedBtn = (page, id) => page.locator(`[data-loading-speed="${id}"]`);

async function expectSpeedChecked(page, which, why) {
  for (const id of ['slow', 'normal', 'fast']) {
    await expect(speedBtn(page, id), `${why}：转速「${id}」格应${id === which ? '' : '不'}是选中态`).toHaveAttribute('aria-checked', id === which ? 'true' : 'false');
  }
}

test('V1 旧版选过「慢」的人保持「慢」：存储里转速仍是 slow、「慢」格选中、生成中指示器 data-speed 是 slow（同时样式按 r164 被重置成随机，转速不牵连）', async ({ page }) => {
  test.setTimeout(120_000);
  await seedOnce(page, { [STYLE]: 'orbit3', [SPEED]: 'slow' });
  await prepareLive(page, { key: 'd2', scenario: { events: [{ kind: 'thinking', text: 'V1 思考。' }] } });
  expect(await lsGet(page, SPEED), '旧版选过慢：localStorage["cgui-loading-speed"] 应仍是 slow').toBe('slow');
  expect(await lsGet(page, STYLE), '同一次打开里样式按 r164 被重置成 random').toBe('random');
  await openInterfaceTab(page);
  await expectSpeedChecked(page, 'slow', '旧版选过慢');
  await closeThemePopover(page);
  await sendRound(page);
  const ind = page.locator(IND).first();
  await expect(ind, '生成中：状态行里应出现指示器').toBeVisible({ timeout: 30_000 });
  await expect(ind, '选过慢的人，生成中指示器的 data-speed 应是 slow').toHaveAttribute('data-speed', 'slow');
});

test('V2 全新环境（什么都没存过）：转速「标准」选中，「慢」「快」不选中', async ({ page }) => {
  await seedOnce(page, {});
  await openApp(page);
  expect(await lsGet(page, SPEED), '应用自己不把默认转速写进存储：全新环境打开后 localStorage["cgui-loading-speed"] 仍应没有（null）').toBeNull();
  await openInterfaceTab(page);
  await expectSpeedChecked(page, 'normal', '全新环境');
  expect(await lsGet(page, SPEED), '打开主题弹窗看一眼转速也不该写存储（只有点选才写）').toBeNull();
});

test('V3 存的转速不合法（turbo）：回落到默认「标准」选中', async ({ page }) => {
  await seedOnce(page, { [SPEED]: 'turbo' });
  await openApp(page);
  await openInterfaceTab(page);
  await expectSpeedChecked(page, 'normal', '转速存成 turbo');
});

test('V4 用户自己改选的转速不被默认值顶掉：全新环境 → 改选「快」→ 刷新 → 仍是「快」；再改回「标准」→ 刷新 → 仍是「标准」', async ({ page }) => {
  await seedOnce(page, {});
  await openApp(page);
  await openInterfaceTab(page);
  await speedBtn(page, 'fast').click();
  await expect.poll(() => lsGet(page, SPEED), { timeout: 5_000, message: '点「快」后 localStorage["cgui-loading-speed"] 应为 fast' }).toBe('fast');
  await reloadApp(page);
  expect(await lsGet(page, SPEED), '刷新后转速仍应是 fast').toBe('fast');
  await openInterfaceTab(page);
  await expectSpeedChecked(page, 'fast', '改选快后刷新');
  await speedBtn(page, 'normal').click();
  await expect.poll(() => lsGet(page, SPEED), { timeout: 5_000, message: '点「标准」后 localStorage["cgui-loading-speed"] 应为 normal' }).toBe('normal');
  await reloadApp(page);
  expect(await lsGet(page, SPEED), '刷新后转速仍应是 normal').toBe('normal');
  await openInterfaceTab(page);
  await expectSpeedChecked(page, 'normal', '改回标准后刷新');
});
