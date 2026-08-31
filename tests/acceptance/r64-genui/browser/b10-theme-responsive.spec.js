// B10 主题与响应式(INTERFACE §6)。本文件在 playwright 的两个 project 下各跑一遍:
//   desktop(1280x900) 跑主题相关;narrow(390x780) 跑窄屏相关。
import { test, expect, TID, bootUI, modelSays, fence } from './harness.js';

const CHART = { items: [{ type: 'chart', kind: 'bars', data: [
  { label: 'a', value: 3 }, { label: 'b', value: 5 }, { label: 'c', value: 2 }, { label: 'd', value: 8 }] }] };

/** 切主题:打开主题面板,按名字选。 */
async function useTheme(page, name) {
  await page.getByRole('button', { name: '主题' }).click();
  // 主题浮层分了几个 tab:深浅色在最外层,**主题家族(默认/Rosé Pine…)在「配色」tab 下**,
  // 默认没展开。名字当场找不到就先点「配色」再找。
  // 主题家族(默认/Rosé Pine…)在「配色」分区下,而且色板按钮可能只把名字放在
  // title/aria-label 里、正文没有文字 —— 三种找法都试一遍。
  const find = () => page.getByText(name, { exact: false })
    .or(page.locator(`[title*=${JSON.stringify(name)}]`))
    .or(page.locator(`[aria-label*=${JSON.stringify(name)}]`)).first();
  if (!(await find().count())) {
    for (const tab of ['配色', '主题']) {
      const t = page.getByText(tab, { exact: true });
      if (await t.count()) { await t.first().click({ timeout: 4000 }).catch(() => {}); await page.waitForTimeout(400); }
      if (await find().count()) break;
    }
  }
  const target = find();
  await target.click({ timeout: 8000 }).catch(() => {
    throw new Error(`主题浮层里找不到「${name}」(正文/title/aria-label 三种找法都试过)。\n`
      + '契约 §9 没给主题行的锚,只能按显示名找;主题浮层的结构一变本条就够不到。');
  });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
}
const cssOf = (loc, prop) => loc.evaluate((el, p) => getComputedStyle(el)[p], prop);
/** WCAG 相对亮度对比度。 */
async function contrast(page, c1, c2) {
  return page.evaluate(([a, b]) => {
    const lum = (c) => { const [r, g, bb] = c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number)
      .map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * r + 0.7152 * g + 0.0722 * bb; };
    const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
  }, [c1, c2]);
}

test.describe('主题', () => {
  test('B117 切换深浅色：组件的背景、文字、边框跟着变', async ({ page, app }) => {
    const box = await bootUI(page, app);
    await modelSays(page, app, fence({ items: [{ type: 'card', title: '卡片', items: [{ type: 'text', content: 'T' }] }] }), { box });
    const block = page.getByTestId(TID.block).first();
    await block.waitFor({ timeout: 20_000 });
    const before = { bg: await cssOf(block, 'backgroundColor'), fg: await cssOf(block, 'color') };
    await useTheme(page, 'dark');
    const after = { bg: await cssOf(block, 'backgroundColor'), fg: await cssOf(block, 'color') };
    expect(after, '换主题后组件配色必须跟着变').not.toEqual(before);
  });

  test('B118 切主题后图表的坐标轴/文字/网格线跟着变', async ({ page, app }) => {
    const box = await bootUI(page, app);
    await modelSays(page, app, fence(CHART), { box });
    const chart = page.getByTestId(TID.node('chart'));
    await chart.waitFor({ timeout: 20_000 });
    const axisColor = () => chart.evaluate((el) => {
      const a = el.querySelector('[class*=axis],[data-axis],line,text');
      return a ? getComputedStyle(a).color + '|' + getComputedStyle(a).stroke : 'none';
    });
    const before = await axisColor();
    await useTheme(page, 'dark');
    expect(await axisColor(), '图表外框(轴/文字/网格)必须逐主题跟着变').not.toBe(before);
  });

  // 注:B119 / B120 都刻意用 type:"chart"。§9.4 写明 echart 是 canvas、不提供 genui-series,
  // 拿 echart 来读逐序列颜色会写出一条永远失败的用例。
  test('B119 【反向】数据序列色不随主题家族变（default-dark 与 rosepine 应当相同）', async ({ page, app }) => {
    const box = await bootUI(page, app);
    await modelSays(page, app, fence(CHART), { box });
    const series = page.getByTestId(TID.series);
    await series.first().waitFor({ timeout: 20_000 });
    const colors = () => series.evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundColor + getComputedStyle(e).fill));
    // 主题按**界面显示名**选,不是内部 id:列表里写的是「默认」「Rosé Pine」,
    // 拿 'default-dark' / 'rosepine' 去 getByText 一个都点不到,后面的颜色断言压根没执行。
    // 两次都在当前这套深浅色下切换(换主题家族不改深浅),正好是本条要比的"同深浅、不同家族"。
    await useTheme(page, '默认');
    const a = await colors();
    await useTheme(page, 'Rosé Pine');
    expect(await colors(), '序列色只随浅/深翻转,不随主题家族变——这是设计如此').toEqual(a);
  });

  test('B120-pre 【契约反向】echart 不提供 genui-series（它是 canvas，别去找）', async ({ page, app }) => {
    const box = await bootUI(page, app);
    await modelSays(page, app, fence({ items: [{ type: 'echart', preset: 'bar',
      data: [{ label: 'a', value: 1 }, { label: 'b', value: 2 }] }] }), { box });
    const node = page.getByTestId(TID.node('echart'));
    await node.waitFor({ timeout: 25_000 });
    // §9.4:echart 画在 canvas 上,没有逐序列的 DOM 元素。
    // 序列色相关的断言只能对 chart / plot 做;对 echart 只断言"它渲染出来了"。
    await expect(node.getByTestId(TID.series),
      'echart 不该提供 genui-series(§9.4);要断言它的序列色只能取像素').toHaveCount(0);
  });

  test('B120 多序列图（chart）：各序列色两两不同，且与画布对比度 ≥ 3:1', async ({ page, app }) => {
    const box = await bootUI(page, app);
    await modelSays(page, app, fence(CHART), { box });
    const series = page.getByTestId(TID.series);
    await series.first().waitFor({ timeout: 20_000 });
    const colors = await series.evaluateAll((els) => els.map((e) => {
      const s = getComputedStyle(e);
      return s.backgroundColor !== 'rgba(0, 0, 0, 0)' ? s.backgroundColor : s.fill;
    }));
    expect(colors.length, '应当有多条序列').toBeGreaterThan(1);
    expect(new Set(colors).size, `序列色塌成了同一个:${colors.join(',')}`).toBe(colors.length);
    const canvasBg = await page.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor);
    for (const c of colors) {
      expect(await contrast(page, c, canvasBg), `序列色 ${c} 与画布对比度不足 3:1`).toBeGreaterThanOrEqual(3);
    }
  });

  test('B121 切到深色后 mermaid 跟着变；切换之前就已渲染的图也要变', async ({ page, app }) => {
    const box = await bootUI(page, app);
    await modelSays(page, app, fence({ items: [{ type: 'mermaid', code: 'flowchart TD\n  A-->B' }] }), { box });
    const svg = page.getByTestId(TID.node('mermaid')).locator('svg');
    await svg.waitFor({ timeout: 25_000 });
    const before = await svg.innerHTML();
    await useTheme(page, 'dark');
    await expect.poll(async () => (await svg.innerHTML()) !== before, { timeout: 10_000 })
      .toBe(true);   // 已经画好的图也要跟着重绘,不能停在旧主题等刷新
  });

  test('B122 导入/切换皮肤后配色同样跟着变', async ({ page, app }) => {
    const box = await bootUI(page, app);
    await modelSays(page, app, fence({ items: [{ type: 'card', title: 'C', items: [{ type: 'text', content: 'T' }] }] }), { box });
    const block = page.getByTestId(TID.block).first();
    await block.waitFor({ timeout: 20_000 });
    const before = await cssOf(block, 'backgroundColor');
    await page.getByRole('button', { name: '主题' }).click();
    const skins = page.getByRole('button', { name: /皮肤|导入/ });
    await skins.first().click();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
    expect(await cssOf(block, 'backgroundColor')).not.toBe(before);
  });

  test('B123 浅色 accent 主题下，accent 底上的文字仍然可读（不得写死白字）', async ({ page, app }) => {
    const box = await bootUI(page, app);
    await modelSays(page, app, fence({ items: [{ type: 'button', label: '主按钮', tone: 'primary', action: 'go' }] }), { box });
    const btn = page.getByTestId(TID.block).first().getByRole('button', { name: '主按钮' });
    await btn.waitFor({ timeout: 20_000 });
    await useTheme(page, 'light');
    const [fg, bg] = [await cssOf(btn, 'color'), await cssOf(btn, 'backgroundColor')];
    expect(await contrast(page, fg, bg), `accent 底上的字看不清(${fg} on ${bg})`).toBeGreaterThanOrEqual(4.5);
  });

  test('B128 开启 prefers-reduced-motion：入场与自动播放动画停止', async ({ page, app }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const box = await bootUI(page, app);
    await modelSays(page, app, fence({ items: [
      { type: 'plot', series: [{ expr: 'a*sin(x)', params: [{ name: 'a', value: 1, min: 0, max: 2, animateTo: 2, durationMs: 3000, loop: true }] }] }] }), { box });
    const block = page.getByTestId(TID.block).first();
    await block.waitFor({ timeout: 20_000 });
    const moving = await block.evaluate((el) => [...el.querySelectorAll('*')]
      .some((n) => { const s = getComputedStyle(n); return (s.animationName !== 'none' && s.animationPlayState === 'running') || s.transitionDuration !== '0s'; }));
    expect(moving, '开了减少动效之后不该还有正在跑的动画').toBe(false);
  });
});

test.describe('窄屏', () => {
  test('B124 grid 多列转单列', async ({ page, app }) => {
    const box = await bootUI(page, app);
    await modelSays(page, app, fence({ items: [{ type: 'grid', cols: 4, items: [
      { type: 'text', content: 'G1' }, { type: 'text', content: 'G2' },
      { type: 'text', content: 'G3' }, { type: 'text', content: 'G4' }] }] }), { box });
    const grid = page.getByTestId(TID.node('grid'));
    await grid.waitFor({ timeout: 20_000 });
    const tops = await grid.evaluate((el) => [...el.children].map((c) => Math.round(c.getBoundingClientRect().top)));
    expect(new Set(tops).size, `窄屏下 4 格应当各占一行,实际排成了 ${new Set(tops).size} 行`).toBe(tops.length);
  });

  test('B125 表格可横向滚动，且页面本身不出现横向滚动条', async ({ page, app }) => {
    const box = await bootUI(page, app);
    const cols = Array.from({ length: 12 }, (_, i) => `列名${i}`);
    await modelSays(page, app, fence({ items: [{ type: 'table', columns: cols,
      rows: [cols.map((_, i) => `值${i}`)] }] }), { box });
    const table = page.getByTestId(TID.node('table'));
    await table.waitFor({ timeout: 20_000 });
    const canScroll = await table.evaluate((el) => {
      const s = el.scrollWidth > el.clientWidth ? el : [...el.querySelectorAll('*')].find((n) => n.scrollWidth > n.clientWidth + 4);
      if (!s) return false;
      s.scrollLeft = 200;
      return s.scrollLeft > 0;
    });
    expect(canScroll, '表格自己要能横向滚动').toBe(true);
    const pageOverflow = await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    expect(pageOverflow, '页面本身不该出现横向滚动条').toBe(false);
  });

  test('B126 图表与 3D 不溢出容器、高度自适应', async ({ page, app }) => {
    const box = await bootUI(page, app);
    await modelSays(page, app, fence({ items: [
      { type: 'chart', data: [{ label: 'a', value: 1 }, { label: 'b', value: 2 }] },
      { type: 'scene3d', meshes: [{ shape: 'box' }] }] }), { box });
    const block = page.getByTestId(TID.block).first();
    await block.waitFor({ timeout: 20_000 });
    const outer = (await block.boundingBox()).width;
    for (const t of ['chart', 'scene3d']) {
      const b = await block.getByTestId(TID.node(t)).boundingBox();
      expect(b.width, `${t} 宽度溢出了容器(${b.width} > ${outer})`).toBeLessThanOrEqual(outer + 1);
      expect(b.height, `${t} 在窄屏下高度不合理:${b.height}`).toBeGreaterThan(60);
    }
    expect(await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)).toBe(false);
  });

  test('B127 按钮、输入框、滑块达到可触控尺寸（≥ 40px 高）', async ({ page, app }) => {
    const box = await bootUI(page, app);
    await modelSays(page, app, fence({ items: [
      { type: 'button', label: '按钮', action: 'go' },
      { type: 'input', label: '输入' },
      { type: 'slider', label: '滑块', min: 0, max: 10, value: 5 }] }), { box });
    const block = page.getByTestId(TID.block).first();
    await block.waitFor({ timeout: 20_000 });
    for (const [name, loc] of [
      ['按钮', block.getByRole('button', { name: '按钮' })],
      ['输入框', block.getByRole('textbox').first()],
      ['滑块', block.getByRole('slider').first()],
    ]) {
      const b = await loc.boundingBox();
      expect(b.height, `${name}在窄屏下只有 ${b.height}px 高,手指点不准`).toBeGreaterThanOrEqual(40);
    }
  });
});
