// B1 就地渲染与既有围栏并存(INTERFACE §1.1 / §1.2)。
import { test, expect, TID, openFence, bootUI, modelSays, fence } from './harness.js';

const HELLO = { items: [{ type: 'text', content: 'BLOCK-HELLO' }] };

test('B01 围栏就地渲染，前后正文照常穿插', async ({ page, app }) => {
  const { block } = await openFence(page, app, HELLO, { before: '前面这段话', after: '后面这段话' });
  await expect(block).toBeVisible();
  await expect(block).toContainText('BLOCK-HELLO');
  await expect(page.getByText('前面这段话')).toBeVisible();
  await expect(page.getByText('后面这段话')).toBeVisible();
  // 反向:围栏原文不该同时以代码块形式留在页面上
  await expect(page.getByTestId(TID.source)).toHaveCount(0);
});

test('B02 行内 `cgui-ui` 只是普通行内代码，不触发渲染', async ({ page, app }) => {
  const box = await bootUI(page, app);
  await modelSays(page, app, '这里提到一个语言标记 `cgui-ui`，只是行内代码。', { box });
  await expect(page.getByText('只是行内代码')).toBeVisible();
  await expect(page.getByTestId(TID.block)).toHaveCount(0);
});

for (const [lang, body] of [
  ['html', '<b>hello-html</b>'],
  ['svg', '<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>'],
  ['mermaid', 'flowchart TD\n  A-->B'],
]) {
  test(`B0${{ html: 3, svg: 4, mermaid: 5 }[lang]} ${lang} 围栏不被 genui 接管，既有渲染照常`, async ({ page, app }) => {
    const box = await bootUI(page, app);
    await modelSays(page, app, fence(body, lang), { box });
    await page.waitForTimeout(2500);
    // 这条断言刻意不去点"代码/预览"按钮:那些按钮的文案会变,写死就成了脆弱测试。
    // 真正要守的回归是"genui 没把这三种围栏吃掉",这一点用 testid 判定最稳。
    await expect(page.getByTestId(TID.block), `${lang} 围栏不该被 genui 接管`).toHaveCount(0);
    await expect(page.getByTestId(TID.source), `${lang} 围栏不该走 genui 的降级代码块`).toHaveCount(0);
    await expect(page.getByTestId(TID.notice), `${lang} 围栏不该出现 genui 的说明条`).toHaveCount(0);
    expect(page.__logs.join('\n'), `渲染 ${lang} 围栏时不该报错`).not.toMatch(/pageerror/i);
  });
}

test('B06 一条消息里三个围栏各自独立渲染', async ({ page, app }) => {
  const box = await bootUI(page, app);
  const text = [1, 2, 3]
    .map((n) => fence({ items: [{ type: 'text', content: `BLK-${n}` }] }))
    .join('\n\n中间穿插的正文\n\n');
  await modelSays(page, app, text, { box });
  await expect(page.getByTestId(TID.block)).toHaveCount(3, { timeout: 15_000 });
  for (const n of [1, 2, 3]) await expect(page.getByText(`BLK-${n}`)).toBeVisible();
});

test('B07 三个围栏中间那个 JSON 写坏：坏的退回代码块+红条，另外两个照常', async ({ page, app }) => {
  const box = await bootUI(page, app);
  const text = [
    fence({ items: [{ type: 'text', content: 'OK-1' }] }),
    fence('这不是 JSON，只是一段中文'),
    fence({ items: [{ type: 'text', content: 'OK-2' }] }),
  ].join('\n\n');
  await modelSays(page, app, text, { box });
  await expect(page.getByTestId(TID.block)).toHaveCount(2, { timeout: 15_000 });
  await expect(page.getByText('OK-1')).toBeVisible();
  await expect(page.getByText('OK-2')).toBeVisible();
  await expect(page.getByTestId(TID.source)).toHaveCount(1);
  await expect(page.getByTestId(TID.notice)).toContainText('cgui-ui 围栏 JSON 解析失败');
});
