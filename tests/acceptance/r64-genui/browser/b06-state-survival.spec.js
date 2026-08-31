// B6 交互状态的存活期(INTERFACE §3.6)。B71(回合结束那一刻)是本轮点名的重点修复项。
//
// ── B71 的判据是怎么设计的(为什么它能把两种情况分开)────────────────────────
// 只断言"值还在"是能被糊弄的:实现完全可以在回合定稿时把组件整个重挂一遍,
// 再从存储里把值填回去 —— 看起来一模一样,但那不是"保留"。所以这里用三个信号:
//
//  信号①【DOM 节点身份】给块和输入框的**真实 DOM 元素**打一个 expando 印记。
//        expando 挂在 DOM 对象上,存储里没有、也没人会去恢复它。
//        React 一旦卸载重建(或 key 变化),节点是新的,印记必然消失。
//        → 印记还在 = 真的没重挂;印记没了 = 重挂过(哪怕值被恢复得一模一样)。
//  信号②【光标位置】把光标放在文本中间。重挂后即使从存储恢复了 value,
//        selectionStart 也回不来(没人存光标)。→ 光标还在 = 连"重建"都没发生。
//  信号③【无 id 输入框的值】契约说只有**带 id** 的输入值才进持久化。
//        所以没有 id 的那一格,存储里根本没有可恢复的东西。
//        → 它的值还在 = 状态确实是"活着"的,不是被读回来的。
// 三个信号里②③是契约层面的(值必须在),①是更严的机械判据(不许重挂)。
// 分成两条用例:B71a 红 = 真丢状态;只有 B71b 红 = 状态没丢但组件被重建了,属设计取舍讨论。
import { test, expect, TID, ctl, bootUI, modelSays, fence, waitTurnEnd, splitPanes } from './harness.js';

const RICH = {
  items: [
    { type: 'input', label: '有 id 的格', id: 'kept' },
    { type: 'input', label: '没有 id 的格' },
    { type: 'textarea', label: '多行' },
    { type: 'table', columns: ['名称'], rows: [['b'], ['a'], ['c']] },
    { type: 'file-tree', items: [{ name: 'src', type: 'dir', children: [{ name: 'deep.txt', type: 'file' }] }] },
    { type: 'radio', label: '题', group: 'q1', options: ['甲', '乙'], answer: '甲' },
  ],
};
const boxes = (block) => block.getByRole('textbox');

/** 做满一屏交互:两个输入、光标、排序、折叠、选答案。 */
async function interact(page, block) {
  await boxes(block).nth(0).fill('WITH-ID-VALUE');
  await boxes(block).nth(1).fill('NO-ID-VALUE');
  await boxes(block).nth(2).fill('0123456789');
  await boxes(block).nth(2).evaluate((el) => el.setSelectionRange(4, 4));
  await block.getByRole('columnheader', { name: '名称' }).click();      // 排序
  await block.getByText('src').click();                                  // 折叠目录
  await block.getByText('乙', { exact: true }).click();                  // 选答案
}

/** 交互都还在吗(契约层面的"保留")。 */
async function expectPreserved(page, block, { withId = true } = {}) {
  if (withId) await expect(boxes(block).nth(0)).toHaveValue('WITH-ID-VALUE');
  await expect(boxes(block).nth(1), '没有 id 的格也必须保留(§3.6 回合结束那一行写的是"全部保留")')
    .toHaveValue('NO-ID-VALUE');
  await expect(block.getByRole('row').locator('td:first-child').first()).toHaveText('a');
  await expect(block.getByText('deep.txt')).toBeHidden();
  await expect(block.getByRole('radio', { checked: true })).toHaveCount(1);
}

test('B71a 回合结束那一刻：选择/输入/排序/折叠全部保留（含没有 id 的输入格与光标）', async ({ page, app }) => {
  const box = await bootUI(page, app);
  await modelSays(page, app, fence(RICH), { box, hold: true });
  const block = page.getByTestId(TID.block).first();
  await block.waitFor({ timeout: 20_000 });
  await interact(page, block);
  ctl.release(app);
  await waitTurnEnd(page);
  await expectPreserved(page, block);
  // 信号②:光标位置。重挂后从存储恢复 value 也补不回光标。
  expect(await boxes(block).nth(2).evaluate((el) => el.selectionStart),
    '光标位置没保住 = 组件被重建过(值可以恢复,光标恢复不了)').toBe(4);
});

test('B71b 回合结束那一刻：组件根本没有被重挂（DOM 节点身份判据，比契约更严）', async ({ page, app }) => {
  const box = await bootUI(page, app);
  await modelSays(page, app, fence(RICH), { box, hold: true });
  const block = page.getByTestId(TID.block).first();
  await block.waitFor({ timeout: 20_000 });
  await interact(page, block);
  // 信号①:给真实 DOM 元素打印记。存储里没有它,没人会恢复它。
  await block.evaluate((el) => { el.__r64Stamp = 'BLOCK-STAMP'; });
  await boxes(block).nth(1).evaluate((el) => { el.__r64Stamp = 'INPUT-STAMP'; });
  ctl.release(app);
  await waitTurnEnd(page);
  const blockAlive = await block.evaluate((el) => el.__r64Stamp === 'BLOCK-STAMP');
  const inputAlive = await boxes(block).nth(1).evaluate((el) => el.__r64Stamp === 'INPUT-STAMP');
  const valueLooksFine = await boxes(block).nth(1).inputValue() === 'NO-ID-VALUE';
  expect(blockAlive && inputAlive,
    valueLooksFine
      ? '值看着还在,但 DOM 印记没了 —— 组件是被**重挂后恢复**成一样的,不是"保留"。'
        + '这正是本条要区分的两种情况(重挂会丢掉光标、丢掉一切没进存储的东西)。'
      : '组件在回合结束时被重挂了,而且状态也丢了。').toBe(true);
});

test('B70 模型继续往下写正文：已做的交互全部保留', async ({ page, app }) => {
  const box = await bootUI(page, app);
  // 围栏先写完,后面还有一长段正文要继续吐
  await modelSays(page, app, fence(RICH) + '\n\n' + '后续正文。'.repeat(200), { box, hold: true });
  const block = page.getByTestId(TID.block).first();
  await block.waitFor({ timeout: 20_000 });
  await interact(page, block);
  await block.evaluate((el) => { el.__r64Stamp = 'S'; });
  await page.waitForTimeout(2500);                     // 让模型继续写一会儿
  await expectPreserved(page, block);
  expect(await block.evaluate((el) => el.__r64Stamp === 'S'), '边写边渲染不该把块重挂').toBe(true);
  ctl.release(app);
});

test('B72 ⚡ 引导注入导致消息分段：交互全部保留', async ({ page, app }) => {
  const box = await bootUI(page, app);
  await modelSays(page, app, fence(RICH) + '\n\n正文继续', { box, hold: true });
  const block = page.getByTestId(TID.block).first();
  await block.waitFor({ timeout: 20_000 });
  await interact(page, block);
  const steer = page.getByRole('button', { name: /引导|⚡/ });
  await steer.first().click();
  await page.locator('textarea').last().fill('顺带补一句');
  await page.locator('textarea').last().press('Enter');
  await page.waitForTimeout(2000);
  await expectPreserved(page, block);
  ctl.release(app);
});

test('B73 关掉重开会话 + 刷新应用：答案、锁定、带 id 的输入值都还在', async ({ page, app }) => {
  const box = await bootUI(page, app);
  await modelSays(page, app, fence(RICH), { box, prompt: 'KEEP-SESSION' });
  const block = page.getByTestId(TID.block).first();
  await block.waitFor({ timeout: 20_000 });
  await interact(page, block);
  await page.reload();
  const after = page.getByTestId(TID.block).first();
  await after.waitFor({ timeout: 20_000 });
  await expect(after.getByRole('textbox').nth(0)).toHaveValue('WITH-ID-VALUE');
  await expect(after.getByRole('radio', { checked: true })).toHaveCount(1);
  await expect(after.getByRole('row').locator('td:first-child').first()).toHaveText('a');
});

test('B74 模型重新输出内容完全相同的围栏：状态保留', async ({ page, app }) => {
  const box = await bootUI(page, app);
  await modelSays(page, app, fence(RICH), { box });
  const block = page.getByTestId(TID.block).first();
  await block.waitFor({ timeout: 20_000 });
  await block.getByRole('textbox').nth(0).fill('WITH-ID-VALUE');
  await modelSays(page, app, fence(RICH), { box });           // 一字不差再来一遍
  const last = page.getByTestId(TID.block).last();
  await expect(last.getByRole('textbox').nth(0)).toHaveValue('WITH-ID-VALUE');
});

test('B75 模型输出内容不同的围栏：不保留，干净重来', async ({ page, app }) => {
  const box = await bootUI(page, app);
  await modelSays(page, app, fence(RICH), { box });
  const block = page.getByTestId(TID.block).first();
  await block.waitFor({ timeout: 20_000 });
  await block.getByRole('textbox').nth(0).fill('WITH-ID-VALUE');
  const changed = JSON.parse(JSON.stringify(RICH));
  changed.items[0].label = '换了个题面';                       // spec 变了
  await modelSays(page, app, fence(changed), { box });
  const last = page.getByTestId(TID.block).last();
  await expect(last.getByRole('textbox').nth(0), '换了 spec 就该干净重来').toHaveValue('');
});

test('B77 “已排队”不属于交互状态：发出去就消失，跟保留规则无关', async ({ page, app }) => {
  const box = await bootUI(page, app);
  await modelSays(page, app, fence({ items: [{ type: 'button', label: '触发', action: 'go' }] }), { box, hold: true });
  await page.getByTestId(TID.block).first().waitFor({ timeout: 20_000 });
  await page.getByTestId(TID.block).first().getByRole('button', { name: '触发' }).click();
  await expect(page.getByTestId(TID.feedback)).toBeVisible();
  ctl.release(app);
  await expect(page.getByTestId(TID.actionMsg)).toHaveCount(1, { timeout: 20_000 });
  await expect(page.getByTestId(TID.feedback), '发出去之后反馈就该消失').toHaveCount(0);
});

test('B78 两个窗格各开一个草稿会话：状态各存各的，不互相串', async ({ page, app }) => {
  const box = await bootUI(page, app);
  await modelSays(page, app, fence(RICH), { box, prompt: 'DRAFT-A' });
  await page.getByTestId(TID.block).first().waitFor({ timeout: 20_000 });
  await page.getByTestId(TID.block).first().getByRole('textbox').nth(0).fill('PANE-A-VALUE');
  await splitPanes(page);   // pane-split 单屏也在,不能拿它当分屏开关/判据(契约 §9.3)
  const paneB = page.getByTestId(TID.pane).nth(1);
  await expect(paneB, '停靠面板打开时分屏只渲染 1 个窗格,那样测不到"两个草稿互不串"').toBeVisible();
  await paneB.getByRole('button', { name: /^\+$|新建|新会话/ }).first().click();
  ctl.script(app, fence(RICH));
  await paneB.locator('textarea').first().fill('DRAFT-B');
  await paneB.locator('textarea').first().press('Enter');
  const blockB = paneB.getByTestId(TID.block).first();
  await blockB.waitFor({ timeout: 20_000 });
  await expect(blockB.getByRole('textbox').nth(0), 'B 窗格不该看到 A 窗格填的字').toHaveValue('');
  await expect(page.getByTestId(TID.pane).nth(0).getByTestId(TID.block).first().getByRole('textbox').nth(0))
    .toHaveValue('PANE-A-VALUE');
});
