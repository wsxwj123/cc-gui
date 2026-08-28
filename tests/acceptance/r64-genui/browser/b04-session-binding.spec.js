// B4 会话绑定(INTERFACE §3.4)。这一组是串扰高危区:历史上出过"异步回调读当前选中会话"的事故。
// 判据统一为:那条 action 消息出现在**点击时那条会话**里,而不是"点完之后当前是哪条"。
//
// ⚠️ 一个会让用例假绿的既有行为(契约 §9.3 末段):代码/预览停靠面板打开且处于分屏时,
// 界面只渲染**当前聚焦的那一个**窗格,此时 [data-testid="pane"] 只有 1 个 ——
// 那种状态下测"A 窗格点按钮别发到 B"根本不是分屏场景。所以每条分屏用例在点击前都
// 复核一次窗格数 ≥ 2;不满足就直接红,不允许悄悄过。
import { test, expect, TID, ctl, bootUI, modelSays, fence, splitPanes, paneCount, clickSafe, sessionAction } from './harness.js';

const marks = (scope) => scope.getByTestId(TID.actionMsg);
const BTN = { items: [{ type: 'button', label: '触发', action: 'go.here' }] };

// 会话列表的增删改在契约 §9 里**没有**给锚(§9.3 只覆盖设置、队列、窗格),
// 所以这三个动作一律按可访问名找,找不到就说人话,不自己造锚。
async function newSession(page) {
  await clickSafe(page, page.getByRole('button', { name: /^\+$|新建|新会话/ }).first());
  await page.locator('textarea').first().waitFor();
}
async function deleteCurrentSession(page) {
  // §9.7 两步入口:当前会话行已是选中态 → 操作按钮恒显 → 菜单 → session-actions-delete
  await sessionAction(page, 'delete');
  const confirm = page.getByRole('button', { name: /^删除$|^确定$|^确认$/ });
  if (await confirm.count()) await confirm.last().click({ timeout: 4000 }).catch(() => {});
}
async function forkCurrentSession(page) {
  await sessionAction(page, 'fork');
}

test('B44 分屏 A/B：在 A 窗格点按钮，消息进 A（与聚焦哪个窗格无关）', async ({ page, app }) => {
  const box = await bootUI(page, app);
  await modelSays(page, app, fence(BTN), { box, prompt: 'SESSION-A' });
  await splitPanes(page);
  const paneA = page.getByTestId(TID.pane).nth(0);
  const paneB = page.getByTestId(TID.pane).nth(1);
  expect(await paneCount(page), '点击前必须真的处于分屏(停靠面板打开时只渲染 1 个窗格,那样测的不是分屏)')
    .toBeGreaterThanOrEqual(2);
  await paneB.click();                                   // 焦点故意放在 B
  await paneA.getByRole('button', { name: '触发' }).click();
  await expect(marks(paneA)).toHaveCount(1, { timeout: 10_000 });
  await expect(marks(paneB), '消息不得跑进 B').toHaveCount(0);
});

test('B45 点完立刻切窗格再切回：消息仍在 A', async ({ page, app }) => {
  const box = await bootUI(page, app);
  await modelSays(page, app, fence(BTN), { box, prompt: 'SESSION-A' });
  await splitPanes(page);
  const [paneA, paneB] = [page.getByTestId(TID.pane).nth(0), page.getByTestId(TID.pane).nth(1)];
  expect(await paneCount(page), '点击前必须真的处于分屏').toBeGreaterThanOrEqual(2);
  await paneA.getByRole('button', { name: '触发' }).click();
  await paneB.click(); await page.waitForTimeout(200); await paneA.click();
  await expect(marks(paneA)).toHaveCount(1, { timeout: 10_000 });
  await expect(marks(paneB)).toHaveCount(0);
});

test('B46 点完立刻删掉该会话：静默丢弃，不进任何其它会话', async ({ page, app }) => {
  const box = await bootUI(page, app);
  await modelSays(page, app, fence(BTN), { box, prompt: 'SESSION-DOOMED' });
  await page.getByRole('button', { name: '触发' }).click();
  await deleteCurrentSession(page);
  await newSession(page);
  await page.waitForTimeout(1500);
  await expect(marks(page), '不得漏进新会话').toHaveCount(0);
  expect(page.__logs.join('\n'), '静默丢弃,不该报错').not.toMatch(/uncaught|pageerror/i);
});

test('B47 【最常见的串扰形态】同窗格点完立刻切到另一条会话：消息进点击时那条', async ({ page, app }) => {
  const box = await bootUI(page, app);
  await modelSays(page, app, fence(BTN), { box, prompt: 'SESSION-ONE' });
  ctl.hold(app);                                          // 让第一条会话保持忙,消息会进它自己的队列
  await page.getByRole('button', { name: '触发' }).click();
  await newSession(page);                                 // 立刻切到另一条会话
  await page.waitForTimeout(1000);
  await expect(marks(page), '绝不能进新会话').toHaveCount(0);
  await expect(page.getByTestId(TID.queueCount), '新会话的队列也不该有东西').toHaveCount(0);
  await page.getByText('SESSION-ONE').first().click();    // 切回点击时那条
  await expect(page.getByTestId(TID.queueItem), '应当在它自己的队列条里').toHaveCount(1, { timeout: 10_000 });
  ctl.release(app);
  await expect(marks(page)).toHaveCount(1, { timeout: 20_000 });
});

test('B48 在 fork 出来的会话里点历史消息上的按钮：进当前这个 fork 会话', async ({ page, app }) => {
  const box = await bootUI(page, app);
  await modelSays(page, app, fence(BTN), { box, prompt: 'SESSION-ORIGIN' });
  await forkCurrentSession(page);
  await expect(page.locator('textarea').first()).toBeVisible();
  await page.getByRole('button', { name: '触发' }).click();
  await expect(marks(page)).toHaveCount(1, { timeout: 10_000 });
  await page.getByText('SESSION-ORIGIN').first().click();
  await expect(marks(page), '原会话里不该多出这条').toHaveCount(0);
});

test('B49 点完 300ms 内删掉会话：静默丢弃', async ({ page, app }) => {
  const box = await bootUI(page, app);
  await modelSays(page, app, fence(BTN), { box, prompt: 'SESSION-RACE' });
  ctl.hold(app);
  await page.getByRole('button', { name: '触发' }).click();
  await page.waitForTimeout(150);
  await deleteCurrentSession(page);
  ctl.release(app);
  await page.waitForTimeout(2000);
  expect(page.__logs.join('\n')).not.toMatch(/pageerror/i);
});

// ── B50–B56 只读面(§3.4 的显式清单)────────────────────────────────────────
// 契约:这七处渲染出来的围栏**组件只读** —— 带 action 的控件画得出来但不可触发(禁用态),
// 点了不发任何消息、也不报错。这是一份显式清单,不是"碰巧拿不到能力"。
const READONLY_FENCE = fence({ items: [{ type: 'button', label: '只读按钮', action: 'ro.go' }] });

/**
 * 只读面的统一判据(§3.4 末行 + §9.2 收紧的一条):
 * 控件画得出来、但禁用、点了**既不发消息、也不出反馈徽章**、不报错。
 * 注意:契约 §9 没有给这七处只读面各自的锚,所以这里不去找"面"的锚,
 * 直接找面里那个 genui-block —— 块的锚是契约保证的。
 */
async function expectReadOnly(page, block) {
  await block.waitFor({ timeout: 20_000 }).catch(async () => {
    // 把两种红分清:整页一个块都没有 = 还没实现;别处有、这处没有 = 送进这处的路子不对。
    const anywhere = await page.getByTestId(TID.block).count();
    throw new Error(anywhere === 0
      ? '整个页面一个 genui 块都没有 —— genui 还没实现,本条属"等实现"的红。'
      : `别处渲染出了 ${anywhere} 个 genui 块,唯独这个只读面里没有 —— 是把围栏送进这处的路子(reach)要改。`);
  });
  const btn = block.getByRole('button', { name: '只读按钮' });
  await expect(btn, '只读面里控件仍要画出来(不是不渲染)').toBeVisible();
  await expect(btn, '只读面里带 action 的控件必须是禁用态').toBeDisabled();
  await btn.click({ force: true }).catch(() => {});
  await page.waitForTimeout(800);
  await expect(page.getByTestId(TID.actionMsg), '只读面点击不得发出任何消息').toHaveCount(0);
  await expect(page.getByTestId(TID.feedback),
    '只读面点击不得出现发送态徽章(§9.2「必须不存在」第 ② 条)').toHaveCount(0);
  expect(page.__logs.join('\n'), '点了也不该报错').not.toMatch(/pageerror/i);
}

const SURFACES = [
  ['B50 工具结果卡片', async (page, app, box) => {
    ctl.tools(app, [{ name: 'Read', input: { file_path: '/tmp/x' }, result: READONLY_FENCE }]);
    await modelSays(page, app, '看一下这个文件', { box, prompt: 'RO-TOOL' });
  }],
  ['B51 子代理结果', async (page, app, box) => {
    ctl.tools(app, [{ name: 'Task', input: { description: '子任务', prompt: 'x' }, result: READONLY_FENCE }]);
    await modelSays(page, app, '派个子代理', { box, prompt: 'RO-SUBAGENT' });
  }],
  ['B52 权限确认弹层', async (page, app, box) => {
    ctl.tools(app, [{ name: 'Bash', input: { command: 'echo hi', description: READONLY_FENCE }, result: 'ok' }]);
    await modelSays(page, app, '跑个命令', { box, prompt: 'RO-PERM' });
  }],
  ['B53 任务清单面板', async (page, app, box) => {
    ctl.tools(app, [{ name: 'TaskCreate', input: { todos: [{ content: READONLY_FENCE, status: 'pending' }] }, result: 'ok' }]);
    await modelSays(page, app, '列个计划', { box, prompt: 'RO-TODO' });
  }],
  ['B54 旁问浮窗', async (page, app, box) => {
    await modelSays(page, app, '正文', { box, prompt: 'RO-BTW' });
    ctl.script(app, READONLY_FENCE);
    await clickSafe(page, page.getByRole('button', { name: /旁问|顺便问/ }).first());
    await page.locator('textarea').last().fill('顺便问一句');
    await page.locator('textarea').last().press('Enter');
  }],
  ['B55 文件预览', async (page, app, box) => {
    ctl.tools(app, [{ name: 'Read', input: { file_path: '/tmp/ui.md' }, result: READONLY_FENCE }]);
    await modelSays(page, app, '预览文件', { box, prompt: 'RO-PREVIEW' });
    const open = page.getByRole('button', { name: /预览|打开/ });
    if (await open.count()) await open.first().click().catch(() => {});
  }],
  // B56 是唯一一处**黑盒注入不进去**的:发行说明的内容是应用作者写的,不是模型输出的,
  // 测试没有正当途径往里塞一个围栏。这里只能把面板打开;真要验它,需要实现方给一个
  // 注入钩子,或者留给人工过一遍。够不到时下面的报错会照实说。
  ['B56 发行说明', async (page) => {
    const entry = page.getByRole('button', { name: /本次更新|发行说明|更新说明/ });
    if (!(await entry.count())) {
      throw new Error('发行说明面板打不开:首启那次已被 dismissOverlays 关掉,之后也没找到重新打开的入口。\n'
        + '另外即使打开了,发行说明的内容由应用作者撰写、不经模型,黑盒没法往里塞围栏 —— '
        + '本条要么由实现方提供注入钩子,要么标为人工验收。');
    }
    await clickSafe(page, entry.first());
  }],
];

for (const [name, reach] of SURFACES) {
  test(`${name}里的围栏只读、点击既不发消息也不出反馈徽章`, async ({ page, app }) => {
    const box = await bootUI(page, app);
    await reach(page, app, box);
    await expectReadOnly(page, page.getByTestId(TID.block).first());
  });
}
