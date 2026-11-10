// r164-style-reset：升级后第一次打开，「加载动画」被重置为「随机」（只此一次，不管旧版选过什么）；
// 之后用户自己选的样式不再被动。
// 判据只看页面上用户能看到的东西与 localStorage 键（cgui-loading-style / cgui-loading-style-epoch / cgui-loading-speed）：
// 不读源码、不读 React state、不 import 应用内部模块。
//
// 「旧版留下的存储」用 seedOnce 在这个标签页【第一次导航前】写入，刷新时不再写——
// 这样刷新后看到的是应用自己留下的结果，和真实升级、再重启一次的过程一致。
// （其它套件的 primeOverlays 每次导航都重写预置，不适合测这条。）
// 升级标记的当前档位 '1' 在 U1 / U2 / U3 / U5 里是写死的（验收不 import 应用内部模块）：产品以后把
// client/src/utils/loadingPrefs.js 的 LOADING_STYLE_EPOCH 加档时，这几处的 '1' 要同步改，否则会红。
import { test, expect } from '@playwright/test';
import { openApp } from './helpers/runtime.mjs';
import {
  IND, lsGet, openAllGates, prepareLive, sendRound, reloadApp, openInterfaceTab, closeThemePopover,
} from './helpers/ui.mjs';

// 用例失败时直播回合会停在半路（假命令行在等放行文件）：把所有闸门都放了，让它自己收尾，别拖累下一条。
test.afterEach(async () => { try { openAllGates(); } catch { /* 忽略 */ } });

const STYLE = 'cgui-loading-style';
const EPOCH = 'cgui-loading-style-epoch';
const SPEED = 'cgui-loading-speed';

async function seedOnce(page, seeds) {
  await page.addInitScript((s) => {
    try {
      localStorage.setItem('cgui-tour-seen', '1');
      if (sessionStorage.getItem('__r164_seeded')) return;
      sessionStorage.setItem('__r164_seeded', '1');
      for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v);
    } catch { /* 忽略 */ }
  }, seeds);
}

const option = (page, id) => page.locator(`[data-loading-option="${id}"]`);

test('U1 旧版选过「三体旋转」（没有升级标记）：升级后第一次打开就是「随机」——存储里样式 random、标记 1，「随机」格选中，生成中指示器是随机模式', async ({ page }) => {
  test.setTimeout(120_000);
  await seedOnce(page, { [STYLE]: 'orbit3' });
  await prepareLive(page, { key: 'd1', scenario: { events: [{ kind: 'thinking', text: 'U1 思考。' }] } });
  expect(await lsGet(page, STYLE), '升级后第一次打开：localStorage["cgui-loading-style"] 应被重置为 random').toBe('random');
  expect(await lsGet(page, EPOCH), '升级标记 localStorage["cgui-loading-style-epoch"] 应写成 1').toBe('1');
  await openInterfaceTab(page);
  await expect(option(page, 'random'), '「随机」格应是选中态').toHaveAttribute('aria-checked', 'true');
  await expect(option(page, 'orbit3'), '「三体旋转」格不应再是选中态').toHaveAttribute('aria-checked', 'false');
  await closeThemePopover(page);
  await sendRound(page);
  const ind = page.locator(IND).first();
  await expect(ind, '生成中：状态行里应出现指示器').toBeVisible({ timeout: 30_000 });
  await expect(ind, '生成中指示器的 data-loading-mode 应为 random（旧版选过的 orbit3 已被重置）').toHaveAttribute('data-loading-mode', 'random');
});

test('U2 重置之后用户自己改选的样式不会再被改回：旧版 orbit3 → 升级后打开（random）→ 改选 ring → 刷新 → 仍是 ring，标记仍是 1', async ({ page }) => {
  await seedOnce(page, { [STYLE]: 'orbit3' });
  await openApp(page);
  expect(await lsGet(page, STYLE), '前置：升级后第一次打开已重置为 random').toBe('random');
  await openInterfaceTab(page);
  await option(page, 'ring').click();
  await expect.poll(() => lsGet(page, STYLE), { timeout: 5_000, message: '点 ring 后 localStorage["cgui-loading-style"] 应为 ring' }).toBe('ring');
  await reloadApp(page);
  expect(await lsGet(page, STYLE), '刷新后样式仍应是 ring（不能被再次重置）').toBe('ring');
  expect(await lsGet(page, EPOCH), '刷新后升级标记仍是 1').toBe('1');
  await openInterfaceTab(page);
  await expect(option(page, 'ring'), '刷新后「Ring」格仍是选中态').toHaveAttribute('aria-checked', 'true');
  await expect(option(page, 'random'), '刷新后「随机」格不是选中态').toHaveAttribute('aria-checked', 'false');
});

test('U3 已经重置过的环境（标记 = 1）里选的样式原样保留：预置 orbit4 + 标记 1 → 打开后仍是 orbit4、「四体旋转」格选中', async ({ page }) => {
  await seedOnce(page, { [STYLE]: 'orbit4', [EPOCH]: '1' });
  await openApp(page);
  expect(await lsGet(page, STYLE), '已重置过的环境：样式应保持 orbit4').toBe('orbit4');
  expect(await lsGet(page, EPOCH), '标记保持 1').toBe('1');
  await openInterfaceTab(page);
  await expect(option(page, 'orbit4'), '「四体旋转」格应是选中态').toHaveAttribute('aria-checked', 'true');
  await expect(option(page, 'random'), '「随机」格不应是选中态').toHaveAttribute('aria-checked', 'false');
});

test('U4 只重置样式、转速不动：预置 orbit3 + 转速 fast（无标记）→ 样式变 random，转速仍是 fast 且「快」格选中', async ({ page }) => {
  await seedOnce(page, { [STYLE]: 'orbit3', [SPEED]: 'fast' });
  await openApp(page);
  expect(await lsGet(page, STYLE), '样式应被重置为 random').toBe('random');
  expect(await lsGet(page, SPEED), '转速不该被动：仍是 fast').toBe('fast');
  await openInterfaceTab(page);
  await expect(page.locator('[data-loading-speed="fast"]'), '转速「快」格应是选中态').toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('[data-loading-speed="slow"]'), '转速「慢」格不应是选中态').toHaveAttribute('aria-checked', 'false');
});

test('U5 全新环境（什么都没存过）：打开后「随机」选中、标记写成 1；改选 CLI 再刷新 → 仍是 cli（标记不会把用户的选择顶掉）', async ({ page }) => {
  await seedOnce(page, {});
  await openApp(page);
  expect(await lsGet(page, EPOCH), '全新环境打开后升级标记应写成 1').toBe('1');
  await openInterfaceTab(page);
  await expect(option(page, 'random'), '全新环境「随机」格应是选中态').toHaveAttribute('aria-checked', 'true');
  await option(page, 'cli').click();
  await expect.poll(() => lsGet(page, STYLE), { timeout: 5_000, message: '点 CLI 后 localStorage["cgui-loading-style"] 应为 cli' }).toBe('cli');
  await reloadApp(page);
  expect(await lsGet(page, STYLE), '刷新后样式仍应是 cli').toBe('cli');
  await openInterfaceTab(page);
  await expect(option(page, 'cli'), '刷新后「CLI」格仍是选中态').toHaveAttribute('aria-checked', 'true');
});
