// r202-split-home-model 黑盒验收:分屏时聚焦「空窗格(新会话首页)」,顶栏的模型 / 思考强度选择器作用于这个首页,不再作用于最左格的会话。
// 只依据接口文件的行为清单 B1–B6;只通过页面(顶栏 title、窗格、侧栏、输入框)与假命令行的收信日志观测;假命令行见 helpers/fake-claude.mjs。
// 记号:D = settings 默认模型 claude-opus-4-6;X = sonnet;Y = haiku;E1 = 低(low);E2 = 高(high)。
import { test, expect } from '@playwright/test';
import { seedWorkspace, receivedMsgs, doneMsgs, D } from './helpers/fixtures.mjs';
import {
  openApp, reloadApp, openSplitWithS, openSingleHome, openWorkspaceGroup, clickRowWith, focusPane, panes, sendIn, homeBoxIn,
  topModel, topEffort, selectModel, selectEffort, waitReceived, waitDone, uniqueTag,
} from './helpers/runtime.mjs';

const X = 'sonnet';
const Y = 'haiku';
const ONE = (arr, what) => { expect(arr.length, `${what}:假命令行应收到恰好 1 条;实际 ${arr.length} 条`).toBe(1); return arr[0]; };

/** 右格(第 2 格,空)聚焦 → 顶栏选 X → 右格首页发 M;返回 M。B1/B2/B3 共用的前半段。 */
async function rightHomePickXAndSend(page, ctx, tag) {
  await openSplitWithS(page, ctx);
  await focusPane(page, 1);
  await expect(homeBoxIn(page, 1), '右格聚焦后应显示新会话首页输入框').toBeVisible({ timeout: 15_000 });
  await selectModel(page, X);
  expect(await topModel(page), `${tag}:在右格首页选 X 之后顶栏应显示 X`).toBe(X);
  const M = `R202-${tag}-${uniqueTag()} 你好`;
  await sendIn(page, 1, M);
  return M;
}

test('B1 【复现】分屏右格空首页聚焦:顶栏选 X,首页发 M,命令行收到 M 时用的模型 = X', async ({ page }) => {
  const ctx = seedWorkspace(uniqueTag('t'));
  const M = await rightHomePickXAndSend(page, ctx, 'B1');
  const got = await waitReceived(page, receivedMsgs, M, 20_000);
  const m = ONE(got, 'B1:M');
  expect(m.model, `B1:命令行收到 M 时用的模型应为 ${X};实际 ${m.model}`).toBe(X);
});

test('B2 【复现】接 B1:回合结束后右格仍聚焦,顶栏显示 X;刷新后点侧栏这条新会话,顶栏仍显示 X', async ({ page }) => {
  const ctx = seedWorkspace(uniqueTag('t'));
  const M = await rightHomePickXAndSend(page, ctx, 'B2');
  await waitReceived(page, receivedMsgs, M, 20_000);
  expect(await waitDone(page, doneMsgs, M, 20_000), 'B2:回合应结束(假命令行已回复)').toBeGreaterThanOrEqual(1);
  await expect(panes(page).nth(1), 'B2:右格应显示第一段回复(R202OK)').toContainText('R202OK', { timeout: 20_000 });
  await page.waitForTimeout(800);
  expect(await topModel(page), `B2:回合结束后右格仍聚焦,顶栏应显示 ${X}(不是 ${D})`).toBe(X);
  await reloadApp(page);
  await expect(panes(page), 'B2:刷新后仍是两格').toHaveCount(2, { timeout: 15_000 });
  await focusPane(page, 1);
  await openWorkspaceGroup(page, ctx);
  await clickRowWith(page, M);
  await expect(panes(page).nth(1), 'B2:点进新会话后右格应显示 M').toContainText('R202-B2', { timeout: 20_000 });
  await page.waitForTimeout(800);
  expect(await topModel(page), `B2:刷新后点进这条新会话,顶栏应显示 ${X}(不是 ${D})`).toBe(X);
});

test('B3 【复现】接 B1:点回左格 S,顶栏显示 D(不是 X);在 S 里发 N,命令行收到 N 时用的模型 = D', async ({ page }) => {
  const ctx = seedWorkspace(uniqueTag('t'));
  const M = await rightHomePickXAndSend(page, ctx, 'B3');
  await waitReceived(page, receivedMsgs, M, 20_000);
  await waitDone(page, doneMsgs, M, 20_000);
  await focusPane(page, 0);
  await page.waitForTimeout(500);
  expect(await topModel(page), `B3:聚焦左格 S 后顶栏应显示 ${D}(不是 ${X})`).toBe(D);
  const N = `R202-B3N-${uniqueTag()} 你好`;
  await sendIn(page, 0, N);
  const n = ONE(await waitReceived(page, receivedMsgs, N, 20_000), 'B3:N');
  expect(n.model, `B3:命令行收到 N 时用的模型应为 ${D};实际 ${n.model}`).toBe(D);
});

test('B4 【复现】左格 S 聚焦:顶栏选 Y,S 里发 N 用 Y;再聚焦右格空首页,顶栏显示 D(不是 Y)', async ({ page }) => {
  const ctx = seedWorkspace(uniqueTag('t'));
  await openSplitWithS(page, ctx);
  await focusPane(page, 0);
  await selectModel(page, Y);
  const N = `R202-B4N-${uniqueTag()} 你好`;
  await sendIn(page, 0, N);
  const n = ONE(await waitReceived(page, receivedMsgs, N, 20_000), 'B4:N');
  expect(n.model, `B4:命令行收到 N 时用的模型应为 ${Y};实际 ${n.model}`).toBe(Y);
  await focusPane(page, 1);
  await expect(homeBoxIn(page, 1), 'B4:右格聚焦后应显示新会话首页输入框').toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(500);
  expect(await topModel(page), `B4:聚焦右格空首页后顶栏应显示 ${D}(不是 ${Y})`).toBe(D);
});

test('B5 【复现】左格 S 设强度 E1(低),右格空首页设 E2(高);回左格顶栏仍显示 E1,S 里发 N 的进程强度 = E1(low)', async ({ page }) => {
  const ctx = seedWorkspace(uniqueTag('t'));
  await openSplitWithS(page, ctx);
  await focusPane(page, 0);
  await selectEffort(page, '低');
  await focusPane(page, 1);
  await expect(homeBoxIn(page, 1), 'B5:右格聚焦后应显示新会话首页输入框').toBeVisible({ timeout: 15_000 });
  await selectEffort(page, '高');
  await focusPane(page, 0);
  await page.waitForTimeout(500);
  expect(await topEffort(page), 'B5:回到左格 S 后顶栏思考强度应显示「低」(不是「高」)').toBe('低');
  const N = `R202-B5N-${uniqueTag()} 你好`;
  await sendIn(page, 0, N);
  const n = ONE(await waitReceived(page, receivedMsgs, N, 20_000), 'B5:N');
  expect(n.effort, `B5:收到 N 的进程强度应为 low;实际 ${n.effort}`).toBe('low');
});

test('B6 【相邻回归】单栏:S 里点「新建会话」,顶栏选 X,首页发 M 用 X;回合结束后顶栏显示 X', async ({ page }) => {
  const ctx = seedWorkspace(uniqueTag('t'));
  await openSingleHome(page, ctx);
  await selectModel(page, X);
  const M = `R202-B6-${uniqueTag()} 你好`;
  await sendIn(page, null, M);
  const m = ONE(await waitReceived(page, receivedMsgs, M, 20_000), 'B6:M');
  expect(m.model, `B6:命令行收到 M 时用的模型应为 ${X};实际 ${m.model}`).toBe(X);
  expect(await waitDone(page, doneMsgs, M, 20_000), 'B6:回合应结束(假命令行已回复)').toBeGreaterThanOrEqual(1);
  await expect(page.locator('[data-cgui="message-list"]'), 'B6:应显示第一段回复(R202OK)').toContainText('R202OK', { timeout: 20_000 });
  await page.waitForTimeout(800);
  expect(await topModel(page), `B6:回合结束后顶栏应显示 ${X}`).toBe(X);
});
