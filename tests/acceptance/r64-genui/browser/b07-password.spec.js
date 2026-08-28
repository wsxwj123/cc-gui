// B7 密码字段的四条出口(INTERFACE §5.6)。硬契约:inputType:"password" 的值
// **没有任何一条出口**通向模型、日志或磁盘。用一个独一无二的哨兵串,任何地方搜到它都算破。
import { test, expect, TID, COPY, ctl, bootUI, modelSays, fence, waitTurnEnd,
  consoleText, requestBodies, storageDump, messageCount } from './harness.js';

const SECRET = 'P4ss-SENTINEL-9f3a71';
const FORM = {
  items: [
    { type: 'input', label: '账号', id: 'user' },
    { type: 'input', label: '口令', inputType: 'password', id: 'pw', action: 'save.pw' },
    { type: 'submit', label: '提交', action: 'form.submit' },
    { type: 'text', content: '别处' },
  ],
};
const pwBox = (block) => block.getByRole('textbox').nth(1).or(block.locator('input[type=password]').first());

/** 哨兵串一个字都不许出现在:控制台、外发请求、本地存储、消息流。 */
async function expectNoLeak(page, where = '') {
  expect(consoleText(page), `控制台泄漏了密码 ${where}`).not.toContain(SECRET);
  expect(requestBodies(page), `外发请求里带上了密码 ${where}`).not.toContain(SECRET);
  expect(await storageDump(page), `本地存储里落了密码 ${where}`).not.toContain(SECRET);
  expect(await page.locator('body').innerText(), `密码被明文显示在页面上 ${where}`).not.toContain(SECRET);
}

test('B79 密码框渲染成掩码输入框', async ({ page, app }) => {
  const box = await bootUI(page, app);
  await modelSays(page, app, fence(FORM), { box });
  const block = page.getByTestId(TID.block).first();
  await block.waitFor({ timeout: 20_000 });
  const pw = block.locator('input[type=password]');
  await expect(pw, '必须是 type=password 的掩码输入框').toHaveCount(1);
});

test('B80 输入后失焦：不发送任何消息（即使带 action）', async ({ page, app }) => {
  const box = await bootUI(page, app);
  await modelSays(page, app, fence(FORM), { box });
  const block = page.getByTestId(TID.block).first();
  await block.waitFor({ timeout: 20_000 });
  const before = await messageCount(page);
  await pwBox(block).fill(SECRET);
  await block.getByText('别处').click();                 // 失焦
  await page.waitForTimeout(1500);
  await expect(page.getByTestId(TID.actionMsg), '密码框失焦绝不能发消息').toHaveCount(0);
  expect(await messageCount(page)).toBe(before);
  await expectNoLeak(page, '(失焦路径)');
});

test('B81 输入后按回车：不发送任何消息', async ({ page, app }) => {
  const box = await bootUI(page, app);
  await modelSays(page, app, fence(FORM), { box });
  const block = page.getByTestId(TID.block).first();
  await block.waitFor({ timeout: 20_000 });
  const before = await messageCount(page);
  await pwBox(block).fill(SECRET);
  await pwBox(block).press('Enter');
  await page.waitForTimeout(1500);
  await expect(page.getByTestId(TID.actionMsg), '密码框回车绝不能发消息').toHaveCount(0);
  expect(await messageCount(page)).toBe(before);
  await expectNoLeak(page, '(回车路径)');
});

test('B82 被 submit 聚合：不出现在 fields 里，其它字段照常', async ({ page, app }) => {
  const box = await bootUI(page, app);
  await modelSays(page, app, fence(FORM), { box });
  const block = page.getByTestId(TID.block).first();
  await block.waitFor({ timeout: 20_000 });
  await block.getByRole('textbox').first().fill('张三');
  await pwBox(block).fill(SECRET);
  await block.getByRole('button', { name: '提交' }).click();
  const mark = page.getByTestId(TID.actionMsg).first();
  await expect(mark).toBeVisible({ timeout: 10_000 });
  await mark.getByTestId(TID.actionMsgToggle).click();
  const body = await mark.getByTestId(TID.actionMsgBody).innerText();
  expect(body, '聚合提交里绝不能带密码').not.toContain(SECRET);
  expect(body, '不得出现密码字段的 id').not.toContain('"pw"');
  expect(body, '普通字段照常聚合').toContain('张三');
  await expectNoLeak(page, '(submit 聚合路径)');
});

test('B76+B83 刷新 / 回合结束后：密码值一律为空，不回填', async ({ page, app }) => {
  const box = await bootUI(page, app);
  await modelSays(page, app, fence(FORM), { box, hold: true });
  const block = page.getByTestId(TID.block).first();
  await block.waitFor({ timeout: 20_000 });
  await block.getByRole('textbox').first().fill('张三');
  await pwBox(block).fill(SECRET);
  ctl.release(app);
  await waitTurnEnd(page);
  await expect(pwBox(block), '回合结束后密码必须为空').toHaveValue('');
  await expect(block.getByRole('textbox').first(), '普通字段仍要保留').toHaveValue('张三');
  await page.reload();
  const after = page.getByTestId(TID.block).first();
  await after.waitFor({ timeout: 20_000 });
  await expect(after.locator('input[type=password]').first(), '刷新后密码必须为空').toHaveValue('');
  await expectNoLeak(page, '(刷新路径)');
});

test('B84 本地存储里搜不到密码值', async ({ page, app }) => {
  const box = await bootUI(page, app);
  await modelSays(page, app, fence(FORM), { box });
  const block = page.getByTestId(TID.block).first();
  await block.waitFor({ timeout: 20_000 });
  await pwBox(block).fill(SECRET);
  await block.getByText('别处').click();
  await page.waitForTimeout(1200);
  expect(await storageDump(page), '密码永不落盘').not.toContain(SECRET);
});

test('B85 密码框旁明确告知“此字段的值不会被发送”', async ({ page, app }) => {
  const box = await bootUI(page, app);
  await modelSays(page, app, fence(FORM), { box });
  const block = page.getByTestId(TID.block).first();
  await block.waitFor({ timeout: 20_000 });
  const hint = block.getByTestId(TID.passwordHint);
  await expect(hint).toBeVisible();
  await expect(hint).toContainText(COPY.passwordHint);
});
