// B3 action 触发与消息呈现(INTERFACE §3.1 / §3.2)。
import { test, expect, TID, COPY, openFence, messageCount } from './harness.js';

const marks = (page) => page.getByTestId(TID.actionMsg);
/** 展开那行"界面操作"标记，拿到完整消息文本。 */
async function markerBody(page, i = 0) {
  const m = marks(page).nth(i);
  await m.getByTestId(TID.actionMsgToggle).click();
  return (await m.getByTestId(TID.actionMsgBody).innerText());
}

for (const [name, spec, act] of [
  ['button', { type: 'button', label: '刷新', action: 'go.btn' }, (b) => b.getByRole('button', { name: '刷新' }).click()],
  ['checkbox', { type: 'checkbox', label: '同意', action: 'go.chk' }, (b) => b.getByRole('checkbox').click()],
  ['switch', { type: 'switch', label: '开关', action: 'go.sw' }, (b) => b.getByRole('switch').click()],
]) {
  test(`B30 点击触发：${name}`, async ({ page, app }) => {
    const { block } = await openFence(page, app, { items: [spec] });
    await act(block);
    await expect(marks(page)).toHaveCount(1, { timeout: 10_000 });
    await expect(marks(page).first()).toContainText(spec.action);
  });
}

test('B31 选中触发：下拉', async ({ page, app }) => {
  const { block } = await openFence(page, app, { items: [{ type: 'select', label: '选', options: ['甲', '乙'], action: 'pick.sel' }] });
  await block.getByRole('combobox').first().selectOption({ label: '乙' });
  await expect(marks(page)).toHaveCount(1, { timeout: 10_000 });
  expect(await markerBody(page)).toContain('乙');
});

test('B31 选中触发：不带 group 的单选', async ({ page, app }) => {
  const { block } = await openFence(page, app, { items: [{ type: 'radio', label: '选', options: ['甲', '乙'], action: 'pick.radio' }] });
  await block.getByText('乙', { exact: true }).click();
  await expect(marks(page)).toHaveCount(1, { timeout: 10_000 });
});

test('B32 【反向】输入框失焦但值没变：不发消息', async ({ page, app }) => {
  const { block } = await openFence(page, app, {
    items: [{ type: 'input', label: '名字', value: '原值', action: 'save.name' }, { type: 'text', content: '别处' }],
  });
  const before = await messageCount(page);
  await block.getByRole('textbox').first().click();
  await block.getByText('别处').click();          // 失焦，但一个字都没改
  await page.waitForTimeout(1200);
  await expect(marks(page), '值没变就不该发消息').toHaveCount(0);
  expect(await messageCount(page)).toBe(before);
});

test('B32 输入框失焦且值有变化：发消息', async ({ page, app }) => {
  const { block } = await openFence(page, app, {
    items: [{ type: 'input', label: '名字', action: 'save.name' }, { type: 'text', content: '别处' }],
  });
  await block.getByRole('textbox').first().fill('改过了');
  await block.getByText('别处').click();
  await expect(marks(page)).toHaveCount(1, { timeout: 10_000 });
  expect(await markerBody(page)).toContain('改过了');
});

test('B33 输入框回车：发消息且数据带 submit:true', async ({ page, app }) => {
  const { block } = await openFence(page, app, { items: [{ type: 'input', label: '名字', action: 'save.name', id: 'f1' }] });
  await block.getByRole('textbox').first().fill('回车值');
  await block.getByRole('textbox').first().press('Enter');
  await expect(marks(page)).toHaveCount(1, { timeout: 10_000 });
  const body = await markerBody(page);
  expect(body).toContain('"submit":true');
  expect(body).toContain('回车值');
});

test('B34 多行输入 Cmd/Ctrl+Enter 发送', async ({ page, app }) => {
  const { block } = await openFence(page, app, { items: [{ type: 'textarea', label: '备注', action: 'save.note' }] });
  const ta = block.getByRole('textbox').first();
  await ta.fill('多行内容');
  await ta.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
  await expect(marks(page)).toHaveCount(1, { timeout: 10_000 });
});

test('B35 滑块连续拖动三秒：只发一条（防抖合并，不是每帧一条）', async ({ page, app }) => {
  const { block } = await openFence(page, app, {
    items: [{ type: 'slider', label: '数量', min: 0, max: 100, value: 10, action: 'set.qty', id: 's1' }],
  });
  const slider = block.getByRole('slider').first();
  await slider.focus();
  for (let i = 0; i < 30; i++) { await slider.press('ArrowRight'); await page.waitForTimeout(60); }
  await page.waitForTimeout(1500);
  await expect(marks(page), '拖动过程不得每一步发一条').toHaveCount(1);
});

test('B37 300ms 内连点同一个按钮 5 次：只发最后一次', async ({ page, app }) => {
  const { block } = await openFence(page, app, { items: [{ type: 'button', label: '刷新', action: 'go' }] });
  const btn = block.getByRole('button', { name: '刷新' });
  for (let i = 0; i < 5; i++) { await btn.click(); await page.waitForTimeout(30); }
  await page.waitForTimeout(1500);
  await expect(marks(page)).toHaveCount(1);
});

test('B38+B39 消息渲染成一行可展开小标记：默认折叠、显示动作名、展开可见全文', async ({ page, app }) => {
  const { block } = await openFence(page, app, { items: [{ type: 'button', label: '刷新数据', action: 'reload.data' }] });
  await block.getByRole('button', { name: '刷新数据' }).click();
  const m = marks(page).first();
  await expect(m).toBeVisible({ timeout: 10_000 });
  await expect(m).toContainText('reload.data');
  // §9.2 收紧:收起态下 body **不得存在于 DOM**(隐藏不算,否则"默认折叠"无法证伪)
  await expect(m.getByTestId(TID.actionMsgBody), '收起态下展开区必须不存在于页面结构中,不是隐藏')
    .toHaveCount(0);
  const body = await markerBody(page);
  expect(body).toContain('[genui-action]');
  expect(body).toContain('并用 cgui-ui 输出更新后的界面');
  expect(body, '模型撰写的 label 不得出现在外发消息里').not.toContain('刷新数据');
});

test('B40+B41 关掉再重开会话：标记仍在、仍可见、仍是折叠形态', async ({ page, app }) => {
  const { block } = await openFence(page, app, { items: [{ type: 'button', label: '刷新', action: 'reload.data' }] });
  await block.getByRole('button', { name: '刷新' }).click();
  await expect(marks(page)).toHaveCount(1, { timeout: 10_000 });
  await markerBody(page);                                   // 先展开
  await page.reload();
  await expect(marks(page).first()).toBeVisible({ timeout: 20_000 });
  await expect(marks(page).first()).toContainText('reload.data');
  await expect(marks(page).first().getByTestId(TID.actionMsgBody),
    '历史回读应回到折叠形态,且展开区不得存在于 DOM').toHaveCount(0);
});

test('B42 提交超 8 KB 的大表单：界面上标注“数据已截断”', async ({ page, app }) => {
  const fields = Array.from({ length: 40 }, (_, i) => ({
    type: 'input', label: `字段${i}`, id: `f${i}`, value: 'x'.repeat(300),
  }));
  const { block } = await openFence(page, app, { items: [...fields, { type: 'submit', label: '提交', action: 'form.submit' }] });
  await block.getByRole('button', { name: '提交' }).click();
  await expect(marks(page)).toHaveCount(1, { timeout: 10_000 });
  await expect(page.getByText(COPY.truncated)).toBeVisible();
});

test('B43 端到端：点按钮 → 模型收到并回了新消息', async ({ page, app }) => {
  const { block } = await openFence(page, app, { items: [{ type: 'button', label: '再来一个', action: 'again' }] });
  const before = await messageCount(page);
  await block.getByRole('button', { name: '再来一个' }).click();
  await expect(marks(page)).toHaveCount(1, { timeout: 10_000 });
  // 假 CLI 会把本回合脚本再吐一遍,所以消息数至少要比点击前多两条(用户 action + 助手回复)
  await expect.poll(async () => await messageCount(page), { timeout: 20_000 }).toBeGreaterThan(before + 1);
});
