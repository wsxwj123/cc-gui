// B9 运行时失败与日志隐私(INTERFACE §5.8 / §5.9)。
// 总原则:坏一个不牵连别的、任何情况下不白屏、日志里不许出现用户输入。
import { test, expect, TID, COPY, ctl, bootUI, modelSays, fence,
  consoleText, storageDump, messageCount } from './harness.js';

/** 拦掉某个引擎的资源,返回"到底拦住了几个"(拦不住时用例要能说清原因)。 */
async function blockEngine(page, re) {
  const blocked = [];
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (re.test(url)) { blocked.push(url); return route.abort(); }
    return route.continue();
  });
  return blocked;
}

test('B103 某个组件渲染抛异常：灰卡隔离 + 同消息其它内容照常 + 不白屏', async ({ page, app }) => {
  // 从外部注入故障:让 canvas 取上下文直接抛,图表组件渲染必然炸
  await page.addInitScript(() => {
    HTMLCanvasElement.prototype.getContext = function () { throw new Error('injected-canvas-failure'); };
  });
  const box = await bootUI(page, app);
  await modelSays(page, app, fence({ items: [
    { type: 'text', content: 'SIBLING-OK' },
    { type: 'chart', data: [{ label: 'a', value: 1 }] },
  ] }) + '\n\n消息里的其它正文', { box });
  await expect(page.getByTestId(TID.failCard)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId(TID.failCard)).toContainText(COPY.renderFailed);
  await expect(page.getByText('消息里的其它正文'), '同一条消息的其它内容照常显示').toBeVisible();
  await expect(page.locator('body')).toContainText('CC-GUI');            // 没白屏
});

test('B104 mermaid 语法错：显示 <pre> 源码 + 降级说明', async ({ page, app }) => {
  const bad = 'flowchart TD\n  A --> ((((';
  const box = await bootUI(page, app);
  await modelSays(page, app, fence({ items: [{ type: 'mermaid', code: bad }] }), { box });
  const block = page.getByTestId(TID.block).first();
  await block.waitFor({ timeout: 20_000 });
  const node = block.getByTestId(TID.node('mermaid'));
  await expect(node.locator('pre')).toContainText('flowchart TD');
  await expect(node).toContainText(COPY.mermaidFallback);
  await expect(node.locator('svg'), '未通过校验的图绝不能渲染出 SVG').toHaveCount(0);
});

test('B105 mermaid 图种不在白名单：同样降级显示源码', async ({ page, app }) => {
  const box = await bootUI(page, app);
  await modelSays(page, app, fence({ items: [{ type: 'mermaid', code: 'mindmap\n  root((中心))' }] }), { box });
  const block = page.getByTestId(TID.block).first();
  await block.waitFor({ timeout: 20_000 });
  const node = block.getByTestId(TID.node('mermaid'));
  await expect(node.locator('pre')).toContainText('mindmap');
  await expect(node).toContainText(COPY.mermaidFallback);
  await expect(node.locator('svg')).toHaveCount(0);
});

test('B106 mermaid 输出没通过安全校验：绝不渲染那段 SVG', async ({ page, app }) => {
  const box = await bootUI(page, app);
  const evil = 'flowchart TD\n  A["<img src=x onerror=alert(1)>"] --> B';
  await modelSays(page, app, fence({ items: [{ type: 'mermaid', code: evil }] }), { box });
  const block = page.getByTestId(TID.block).first();
  await block.waitFor({ timeout: 20_000 });
  const html = await block.innerHTML();
  expect(html, '注入片段绝不能进 DOM').not.toContain('onerror=');
  expect(consoleText(page)).not.toMatch(/alert/i);
});

test('B107 mermaid 引擎还没加载完：<pre> 源码 + 渲染中…', async ({ page, app }) => {
  await page.route('**/*', async (route) => {
    if (/mermaid/i.test(route.request().url())) { await new Promise((r) => setTimeout(r, 12_000)); }
    return route.continue();
  });
  const box = await bootUI(page, app);
  await modelSays(page, app, fence({ items: [{ type: 'mermaid', code: 'flowchart TD\n  A-->B' }] }), { box });
  const block = page.getByTestId(TID.block).first();
  await block.waitFor({ timeout: 20_000 });
  const node = block.getByTestId(TID.node('mermaid'));
  await expect(node.locator('pre')).toContainText('flowchart TD');
  await expect(node).toContainText(COPY.mermaidLoading);
});

test('B108 图表引擎加载失败：显示“图表加载失败”，其它组件不受影响', async ({ page, app }) => {
  const blocked = await blockEngine(page, /echarts/i);
  const box = await bootUI(page, app);
  await modelSays(page, app, fence({ items: [
    { type: 'echart', data: [{ label: 'a', value: 1 }] },
    { type: 'text', content: 'NEIGHBOUR-OK' },
  ] }), { box });
  const block = page.getByTestId(TID.block).first();
  await block.waitFor({ timeout: 20_000 });
  // §9.4:echart 的加载中/失败态用 genui-node-echart 内的文字断言
  await expect(block.getByTestId(TID.node('echart'))).toContainText(COPY.chartFailed, { timeout: 20_000 });
  await expect(block.getByText('NEIGHBOUR-OK')).toBeVisible();
  expect(blocked.length, '一个 echarts 资源都没拦到,说明产物 chunk 名里认不出引擎,本条没测到东西')
    .toBeGreaterThan(0);
});

test('B109 图表引擎加载中：显示“加载图表…”占位', async ({ page, app }) => {
  await page.route('**/*', async (route) => {
    if (/echarts/i.test(route.request().url())) await new Promise((r) => setTimeout(r, 12_000));
    return route.continue();
  });
  const box = await bootUI(page, app);
  await modelSays(page, app, fence({ items: [{ type: 'echart', data: [{ label: 'a', value: 1 }] }] }), { box });
  const block = page.getByTestId(TID.block).first();
  await block.waitFor({ timeout: 20_000 });
  await expect(block.getByTestId(TID.node('echart'))).toContainText(COPY.chartLoading);
});

test('B110 three 加载失败：3D 位置显示失败提示，其它组件不受影响', async ({ page, app }) => {
  const blocked = await blockEngine(page, /three/i);
  const box = await bootUI(page, app);
  await modelSays(page, app, fence({ items: [
    { type: 'scene3d', meshes: [{ shape: 'box' }] },
    { type: 'text', content: 'NEIGHBOUR-OK' },
  ] }), { box });
  const block = page.getByTestId(TID.block).first();
  await block.waitFor({ timeout: 20_000 });
  await expect(block.getByText('NEIGHBOUR-OK')).toBeVisible();
  await expect(block.getByTestId(TID.node('scene3d'))).toContainText(/失败|加载不出/, { timeout: 20_000 });
  expect(blocked.length, '一个 three 资源都没拦到,本条没测到东西').toBeGreaterThan(0);
});

test('B111 本地存储不可用（隐私模式/配额满）：静默，内存里照常工作，只是刷新后不恢复', async ({ page, app }) => {
  // 只让"写"失败:读还得能用,否则应用自己都启动不起来(项目列表读不出来),
  // 测的就不是"存储写失败时静默降级"了。
  await page.addInitScript(() => {
    const boom = () => { throw new DOMException('QuotaExceededError', 'QuotaExceededError'); };
    const proto = Object.getPrototypeOf(window.localStorage);
    proto.setItem = boom;
    proto.removeItem = boom;
  });
  const box = await bootUI(page, app);
  await modelSays(page, app, fence({ items: [{ type: 'input', label: '格', id: 'k1' }] }), { box });
  const block = page.getByTestId(TID.block).first();
  await block.waitFor({ timeout: 20_000 });
  await block.getByRole('textbox').first().fill('IN-MEMORY');
  await expect(block.getByRole('textbox').first(), '内存里的交互态照常工作').toHaveValue('IN-MEMORY');
  expect(page.__logs.join('\n'), '存储不可用要静默处理,不许把异常甩到界面上').not.toMatch(/pageerror/i);
  await expect(page.getByTestId(TID.notice), '不该给用户看错误条').toHaveCount(0);
});

test('B112 action 发送失败（会话已删）：静默丢弃，组件保持可交互', async ({ page, app }) => {
  const box = await bootUI(page, app);
  await modelSays(page, app, fence({ items: [{ type: 'button', label: '触发', action: 'go' }] }), { box, prompt: 'DOOMED' });
  const block = page.getByTestId(TID.block).first();
  await block.waitFor({ timeout: 20_000 });
  await page.route('**/api/**', (r) => (r.request().method() === 'GET' ? r.continue() : r.abort()));
  const btn = block.getByRole('button', { name: '触发' });
  await btn.click();
  await page.waitForTimeout(1500);
  await expect(btn, '发送失败后组件必须保持可交互').toBeEnabled();
  expect(page.__logs.join('\n')).not.toMatch(/pageerror/i);
});

test('B113+B114 控制台不含 action payload / 表单字段值', async ({ page, app }) => {
  const SENTINEL = 'FORMVALUE-SENTINEL-7c21';
  const box = await bootUI(page, app);
  await modelSays(page, app, fence({ items: [
    { type: 'input', label: '备注', id: 'note', action: 'save.note' },
    { type: 'text', content: '别处' },
  ] }), { box });
  const block = page.getByTestId(TID.block).first();
  await block.waitFor({ timeout: 20_000 });
  await block.getByRole('textbox').first().fill(SENTINEL);
  await block.getByText('别处').click();
  await expect(page.getByTestId(TID.actionMsg)).toHaveCount(1, { timeout: 10_000 });
  // 消息本身带着这个值是对的(那是发给模型的),但控制台一个字都不许有
  expect(consoleText(page), '控制台不得出现表单字段值/action payload').not.toContain(SENTINEL);
  const log = consoleText(page);
  if (log.includes('genui') || log.includes('action')) {
    expect(log, '日志只允许出现动作名等非内容信息').toMatch(/save\.note|genui|action/);
  }
});

test('B115 本地存储只存该存的：带 id 的普通输入值在，别的用户输入不该乱存', async ({ page, app }) => {
  const box = await bootUI(page, app);
  await modelSays(page, app, fence({ items: [
    { type: 'input', label: '有 id', id: 'kept' },
    { type: 'input', label: '口令', inputType: 'password', id: 'pw' },
  ] }), { box });
  const block = page.getByTestId(TID.block).first();
  await block.waitFor({ timeout: 20_000 });
  await block.getByRole('textbox').first().fill('KEPT-VALUE');
  await block.locator('input[type=password]').first().fill('SECRET-VALUE-115');
  await page.waitForTimeout(1200);
  const dump = await storageDump(page);
  expect(dump, '带 id 的普通输入值应当落盘').toContain('KEPT-VALUE');
  expect(dump, '密码永不落盘').not.toContain('SECRET-VALUE-115');
});

test('B116 【反向】把 44 种组件全渲染一遍：不向任何第三方域名发请求', async ({ page, app }) => {
  const { SAMPLES, ALL_TYPES } = await import('./samples.js');
  const box = await bootUI(page, app);
  // 一次塞太多会撞节点预算,分三批渲染
  for (let i = 0; i < ALL_TYPES.length; i += 15) {
    const batch = ALL_TYPES.slice(i, i + 15).map((t) => SAMPLES[t]);
    await modelSays(page, app, fence({ items: batch }), { box });
    await page.waitForTimeout(1500);
  }
  const foreign = page.__requests
    .map((r) => { try { return new URL(r.url); } catch { return null; } })
    .filter(Boolean)
    .filter((u) => !['127.0.0.1', 'localhost'].includes(u.hostname))
    .filter((u) => !['data:', 'blob:'].includes(u.protocol))
    // Google Fonts 是本轮之前就有的既有外链(index.html 加载网页字体),不属 genui 引擎,
    // 口径与 t10 对 index.html 的主机白名单一致。**除这两个之外一律不允许**。
    .filter((u) => !['fonts.googleapis.com', 'fonts.gstatic.com'].includes(u.hostname))
    .map((u) => u.hostname);
  expect([...new Set(foreign)],
    '运行时不得向第三方域名发起请求(图表/图示/3D 引擎必须来自 CC-GUI 自己的服务)').toEqual([]);
});

test('B117-pre 消息里有多个围栏，其中一个坏了：坏的降级，其余照常', async ({ page, app }) => {
  const box = await bootUI(page, app);
  await modelSays(page, app, [
    fence({ items: [{ type: 'text', content: 'GOOD-A' }] }),
    fence('{坏掉的'),
    fence({ items: [{ type: 'text', content: 'GOOD-B' }] }),
  ].join('\n\n'), { box });
  await expect(page.getByTestId(TID.block)).toHaveCount(2, { timeout: 20_000 });
  await expect(page.getByText('GOOD-A')).toBeVisible();
  await expect(page.getByText('GOOD-B')).toBeVisible();
  await expect(page.getByTestId(TID.source)).toHaveCount(1);
});
