// B2 组件真的画出来 + 本地交互零往返(INTERFACE §2 / §3.3)。
import { test, expect, TID, COPY, openFence, messageCount } from './harness.js';
import { SAMPLES, ALL_TYPES } from './samples.js';

// B08:44 种各一条独立用例,哪种画不出来一眼就看出来
for (const type of ALL_TYPES) {
  test(`B08 组件可渲染：${type}`, async ({ page, app }) => {
    const { block } = await openFence(page, app, { items: [SAMPLES[type]] });
    const node = block.getByTestId(TID.node(type));
    // spacer 是零内容的透明占位:flex:1 在非 flex 父容器里算出来高度就是 0,
    // 浏览器判它"不可见"是物理事实、与实现无关,拿可见性当判据对它恒假。
    // 这条用例的本意是"该类型渲染得出来、锚落在对的位置",所以只对 spacer 验存在。
    // 其余 43 种照旧验可见(不放宽)。
    if (type === 'spacer') await expect(node).toHaveCount(1);
    else await expect(node).toBeVisible();
    await expect(block.getByTestId(TID.ignored)).toHaveCount(0);
  });
}

/** 本地交互的统一判据:操作前后消息数不变、队列不变、且没有发往后端的写请求。 */
async function expectNoRoundTrip(page, action) {
  const before = await messageCount(page);
  const marks = page.__requests.length;
  await action();
  await page.waitForTimeout(800);
  expect(await messageCount(page), '本地交互不得产生新消息').toBe(before);
  const posted = page.__requests.slice(marks).filter((r) => r.method !== 'GET');
  expect(posted.map((r) => r.url), '本地交互不得发出任何写请求').toEqual([]);
  await expect(page.getByTestId(TID.actionMsg)).toHaveCount(0);
}

test('B09+B20 表格点表头排序三态，且零往返', async ({ page, app }) => {
  const { block } = await openFence(page, app, {
    items: [{ type: 'table', columns: ['名称', '值'], rows: [['b', '2'], ['a', '1'], ['c', '3']] }],
  });
  const head = block.getByRole('columnheader', { name: '名称' });
  const col = () => block.getByRole('row').locator('td:first-child');
  const before = await col().allInnerTexts();
  await expectNoRoundTrip(page, async () => { await head.click(); });
  await expect(col().first()).toHaveText('a');                       // 升序
  await expectNoRoundTrip(page, async () => { await head.click(); });
  await expect(col().first()).toHaveText('c');                       // 降序
  await expectNoRoundTrip(page, async () => { await head.click(); });
  expect(await col().allInnerTexts(), '第三次点击应还原原始顺序').toEqual(before);
});

test('B10+B20 文件树目录折叠展开，零往返', async ({ page, app }) => {
  const { block } = await openFence(page, app, {
    items: [{ type: 'file-tree', items: [{ name: 'src', type: 'dir', children: [{ name: 'deep.txt', type: 'file' }] }] }],
  });
  await expect(block.getByText('deep.txt')).toBeVisible();
  await expectNoRoundTrip(page, async () => { await block.getByText('src').click(); });
  await expect(block.getByText('deep.txt')).toBeHidden();
  await block.getByText('src').click();
  await expect(block.getByText('deep.txt')).toBeVisible();
});

test('B11+B20 标签页切换，零往返', async ({ page, app }) => {
  const { block } = await openFence(page, app, {
    items: [{ type: 'tabs', tabs: [
      { label: '一', items: [{ type: 'text', content: 'TAB-ONE' }] },
      { label: '二', items: [{ type: 'text', content: 'TAB-TWO' }] }] }],
  });
  await expect(block.getByText('TAB-ONE')).toBeVisible();
  await expectNoRoundTrip(page, async () => { await block.getByText('二', { exact: true }).click(); });
  await expect(block.getByText('TAB-TWO')).toBeVisible();
});

test('B12+B20 手风琴展开收起，零往返', async ({ page, app }) => {
  const { block } = await openFence(page, app, {
    items: [{ type: 'accordion', items: [{ title: '折叠项', items: [{ type: 'text', content: 'ACC-BODY' }] }] }],
  });
  await expectNoRoundTrip(page, async () => { await block.getByText('折叠项').click(); });
  await expect(block.getByText('ACC-BODY')).toBeVisible();
});

test('B13+B20 带 group 的单选只本地记录，零往返', async ({ page, app }) => {
  const { block } = await openFence(page, app, {
    items: [{ type: 'radio', label: '第一题', group: 'q1', options: ['甲', '乙'], answer: '甲' }],
  });
  await expectNoRoundTrip(page, async () => { await block.getByText('乙', { exact: true }).click(); });
  await expect(block.getByRole('radio', { checked: true })).toHaveCount(1);
});

test('B14+B20 交卷判卷：得分、逐题对错、解析、锁定，全程零往返', async ({ page, app }) => {
  const { block } = await openFence(page, app, {
    items: [
      { type: 'radio', label: '1+1', group: 'q1', options: ['2', '3'], answer: '2', explanation: '显然' },
      { type: 'radio', label: '2+2', group: 'q2', options: ['4', '5'], answer: '4' },
      { type: 'submit', label: '交卷' },
    ],
  });
  await block.getByText('2', { exact: true }).first().click();
  await block.getByText('5', { exact: true }).first().click();
  await expectNoRoundTrip(page, async () => { await block.getByRole('button', { name: '交卷' }).click(); });
  await expect(block).toContainText('1');                 // 得分(1/2)
  await expect(block).toContainText('显然');               // 解析
  await expect(block.getByRole('button', { name: '交卷' })).toBeDisabled(); // 锁定
});

test('B15 重新作答重置；配了 resetAction 时另发一条 action', async ({ page, app }) => {
  const { block } = await openFence(page, app, {
    items: [
      { type: 'radio', label: '题', group: 'q1', options: ['对', '错'], answer: '对' },
      { type: 'submit', label: '交卷', resetAction: 'quiz.reset' },
    ],
  });
  await block.getByText('对', { exact: true }).click();
  await block.getByRole('button', { name: '交卷' }).click();
  const before = await page.getByTestId(TID.actionMsg).count();
  await page.getByRole('button', { name: '重新作答' }).click();
  await expect(page.getByTestId(TID.actionMsg)).toHaveCount(before + 1);
  await expect(block.getByRole('button', { name: '交卷' })).toBeEnabled();
});

test('B16+B20 判题组件点选即判、可重试，零往返', async ({ page, app }) => {
  const { block } = await openFence(page, app, {
    items: [{ type: 'quiz', question: '天空什么色', options: [
      { label: '蓝', correct: true, feedback: '对了' }, { label: '绿', feedback: '再想想' }] }],
  });
  await expectNoRoundTrip(page, async () => { await block.getByText('绿', { exact: true }).click(); });
  await expect(block).toContainText('再想想');
  await block.getByRole('button', { name: /重试|再来/ }).click();
  await expectNoRoundTrip(page, async () => { await block.getByText('蓝', { exact: true }).click(); });
  await expect(block).toContainText('对了');
});

test('B17+B20 函数图拖滑块重绘 / 滚轮缩放，零往返', async ({ page, app }) => {
  const { block } = await openFence(page, app, {
    items: [{ type: 'plot', series: [{ expr: 'a*sin(x)', params: [{ name: 'a', value: 1, min: 0, max: 3 }] }] }],
  });
  const canvasBox = await block.getByTestId(TID.node('plot')).boundingBox();
  const before = await block.getByTestId(TID.node('plot')).innerHTML();
  await expectNoRoundTrip(page, async () => {
    const slider = block.getByRole('slider').first();
    await slider.focus();
    for (let i = 0; i < 5; i++) await slider.press('ArrowRight');
    await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
    await page.mouse.wheel(0, -240);
  });
  expect(await block.getByTestId(TID.node('plot')).innerHTML(), '曲线应当重绘').not.toBe(before);
});

test('B18+B20 3D 拖拽旋转 / 滚轮缩放，零往返', async ({ page, app }) => {
  const { block } = await openFence(page, app, { items: [{ type: 'scene3d', meshes: [{ shape: 'box' }] }] });
  const node = block.getByTestId(TID.node('scene3d'));
  await expect(node).toBeVisible();
  const b = await node.boundingBox();
  await expectNoRoundTrip(page, async () => {
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down(); await page.mouse.move(b.x + b.width / 2 + 60, b.y + b.height / 2 + 30); await page.mouse.up();
    await page.mouse.wheel(0, -200);
  });
});

test('B19+B20+B36 复制进剪贴板、显示字符数，且不发消息', async ({ page, app, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const { block } = await openFence(page, app, { items: [{ type: 'copy', text: 'COPY-ME-1234', label: '复制' }] });
  await expect(block).toContainText('12');   // 将复制的字符数
  await expectNoRoundTrip(page, async () => { await block.getByRole('button', { name: /复制/ }).click(); });
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('COPY-ME-1234');
});

test('B21 按钮没写 action：呈禁用态，点了没有任何反应', async ({ page, app }) => {
  const { block } = await openFence(page, app, { items: [{ type: 'button', label: '只是展示' }] });
  const btn = block.getByRole('button', { name: '只是展示' });
  await expect(btn).toBeDisabled();
  await expectNoRoundTrip(page, async () => { await btn.click({ force: true }); });
});

test('B22 下拉没写 selected：显示占位，不静默预选第一项', async ({ page, app }) => {
  const { block } = await openFence(page, app, { items: [{ type: 'select', label: '选一个', options: ['甲', '乙'], action: 'pick' }] });
  const sel = block.getByRole('combobox').first();
  const value = await sel.inputValue().catch(() => sel.innerText());
  expect(value === '' || !['甲', '乙'].includes(String(value).trim()),
    `不得静默预选第一项，实际选中：${value}`).toBeTruthy();
  await expect(page.getByTestId(TID.actionMsg)).toHaveCount(0);
});

test('B23 音视频不自动播放', async ({ page, app }) => {
  const { block } = await openFence(page, app, {
    items: [{ type: 'audio', src: '/a.mp3' }, { type: 'video', src: '/a.mp4' }],
  });
  await expect(block.getByTestId(TID.node('audio'))).toBeVisible();
  const auto = await block.evaluate((el) => [...el.querySelectorAll('audio,video')].map((m) => ({ autoplay: m.autoplay, paused: m.paused })));
  expect(auto.length, '应当渲染出播放器').toBeGreaterThan(0);
  for (const m of auto) { expect(m.autoplay, '不得设 autoplay').toBe(false); expect(m.paused, '初始应处于暂停').toBe(true); }
});

test('B24 涨跌配色：- 开头显红、+ 开头显绿', async ({ page, app }) => {
  const { block } = await openFence(page, app, {
    items: [{ type: 'stat', label: '下跌', value: '10', delta: '-3' }, { type: 'stat', label: '上涨', value: '10', delta: '+3' }],
  });
  const colorOf = (t) => block.getByText(t, { exact: true }).evaluate((el) => getComputedStyle(el).color);
  const [down, up] = [await colorOf('-3'), await colorOf('+3')];
  expect(down, '涨跌两色不得相同').not.toBe(up);
  const rgb = (c) => c.match(/\d+/g).map(Number);
  expect(rgb(down)[0], '下跌应偏红').toBeGreaterThan(rgb(down)[1]);
  expect(rgb(up)[1], '上涨应偏绿').toBeGreaterThan(rgb(up)[0]);
});

test('B25 字符串按纯文本渲染：<b>x</b> 显示为字面量而不是加粗', async ({ page, app }) => {
  const { block } = await openFence(page, app, { items: [{ type: 'text', content: '<b>NOT-BOLD</b>' }] });
  await expect(block).toContainText('<b>NOT-BOLD</b>');
  expect(await block.locator('b').count(), '不得把标签解释成真的 <b>').toBe(0);
});

test('B26 已忽略灰字真的显示出来', async ({ page, app }) => {
  const { block } = await openFence(page, app, {
    items: [{ type: 'script' }, { type: 'iframe' }, { type: 'text', content: 'KEEP' }],
  });
  await expect(block.getByTestId(TID.ignored)).toContainText('2');
  await expect(block.getByTestId(TID.ignored)).toContainText(COPY.ignoredSuffix);
  // §9.1「必须不存在」:被丢弃的节点不得留下任何锚
  await expect(page.getByTestId(TID.node('script')), '被丢弃的节点不得留下锚').toHaveCount(0);
  await expect(page.getByTestId(TID.node('iframe'))).toHaveCount(0);
  await expect(block.getByTestId(TID.node('text')), '合法兄弟照常留锚').toHaveCount(1);
});

test('B27 解析失败：红条显示出来，原始代码块还在（不让用户对着空白）', async ({ page, app }) => {
  await openFence(page, app, '{items: 这不是 JSON}', { expectNoBlock: true });
  await expect(page.getByTestId(TID.notice)).toContainText(COPY.parseFail);
  await expect(page.getByTestId(TID.notice)).toContainText(COPY.parseFailTail);
  await expect(page.getByTestId(TID.source)).toBeVisible();
  await expect(page.getByTestId(TID.source)).toContainText('这不是 JSON');
});

test('B28 超大围栏：代码块 + 界面规格过大说明', async ({ page, app }) => {
  const big = '{"items":[{"type":"text","content":"' + 'x'.repeat(140 * 1024) + '"}]}';
  await openFence(page, app, big, { expectNoBlock: true });
  await expect(page.getByTestId(TID.notice)).toContainText(COPY.oversize);
  await expect(page.getByTestId(TID.notice)).toContainText(COPY.oversizeTail);
  await expect(page.getByTestId(TID.source)).toBeVisible();
});

test('B29 每个块带始终可见、不可关闭的“模型生成界面”标识', async ({ page, app }) => {
  const { block } = await openFence(page, app, { items: [{ type: 'text', content: 'x' }] });
  const badge = block.getByTestId(TID.badge);
  await expect(badge).toBeVisible();
  expect(await badge.getByRole('button').count(), '标识不该带关闭按钮').toBe(0);
  await block.getByText('x').click();
  await expect(badge, '任何交互之后标识都必须还在').toBeVisible();
});
