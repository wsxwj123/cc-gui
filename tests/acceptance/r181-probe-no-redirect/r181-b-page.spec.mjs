// r181 · 页面用例 23–24(端到端:页面操作 → 真后端 → 本机假上游;不在浏览器层拦截任何探测接口)。
// 共用 run.sh 起的那个共享隔离实例(R181_API_BASE),每条用例用唯一名字的条目,互不依赖。WebKit 与 Chromium 各跑一遍。
import { test, expect } from '@playwright/test';
import { startFake } from './helpers/fakes.mjs';
import { STORED_KEY, NEW_KEY, TEST_MSG, createText } from './helpers/common.mjs';
import { boot, openProviderManager, openTextProviderEdit, alertDialog } from './helpers/ui.mjs';

const API_BASE = process.env.R181_API_BASE || '';
const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

let closers = [];
const track = (fake) => { closers.push(() => fake.close()); return fake; };
test.beforeEach(() => { test.skip(!API_BASE || !process.env.R181_UI_BASE, '没有共享实例 / dev server(R181_API_ONLY=1)时跳过页面用例'); });
test.afterEach(async () => { const l = closers; closers = []; for (const f of l) { try { await f(); } catch { /* 尽力而为 */ } } });

const modelsBox = (page) => page.getByPlaceholder(/^模型\(每行一个/).first();

test('23 【复现】页面·编辑已保存 Provider,改 Base URL、Key 留空、点「测试连接」→ 结果区出现固定文案,不出现「连接成功」「✗ 连接失败」,A、C 0 次', async ({ page }) => {
  const A = track(await startFake());
  const C = track(await startFake());
  const name = `r181-测试连接-${uniq()}`;
  await createText(API_BASE, { name, type: 'openai', baseURL: A.url, apiKey: STORED_KEY, models: ['r181-model-1'] });
  await boot(page);
  const { addr, key } = await openTextProviderEdit(page, name, A.url);
  await addr.fill(C.url);
  await expect(key, 'Key 框应是空的').toHaveValue('');
  await modelsBox(page).fill('r181-model-1');
  await page.getByRole('button', { name: '测试连接', exact: true }).first().click();
  await expect(page.getByText(TEST_MSG).first(), '结果区应出现固定文案').toBeVisible({ timeout: 15_000 });
  const body = await page.locator('body').innerText();
  expect(body, '不应出现「连接成功」').not.toContain('连接成功');
  expect(body, '不应出现「连接失败」前缀(符号可能是 ✗ 也可能是 ✕,按文字判断)').not.toContain('连接失败');
  await page.waitForTimeout(500);
  expect(A.hits.length, 'A 应 0 次').toBe(0);
  expect(C.hits.length, 'C 应 0 次').toBe(0);
});

test('24 【复现】页面·新建 Provider,Base URL 填 A(A 跳转到 B),点「获取模型」→ 提示框含「重定向」「已拒绝跟随」,不含「常见原因」「这很正常」,B 0 次', async ({ page }) => {
  const A = track(await startFake());
  const B = track(await startFake());
  A.fallback({ status: 302, location: `${B.url}/v1/models` });
  await boot(page);
  const manager = await openProviderManager(page);
  await manager.getByRole('button', { name: '添加 Provider' }).first().click({ timeout: 8_000 });
  await page.getByPlaceholder(/^名称/).first().fill(`r181-获取模型-${uniq()}`);
  await page.getByPlaceholder(/^Base URL/).first().fill(A.url);
  await page.getByPlaceholder(/^API Key/).first().fill(NEW_KEY);
  await page.getByRole('button', { name: '获取模型', exact: true }).first().click();
  const dlg = alertDialog(page);
  await expect(dlg, '应弹出提示框').toBeVisible({ timeout: 15_000 });
  await expect(dlg, '提示框正文应含「重定向」').toContainText('重定向', { timeout: 15_000 });
  const text = await dlg.innerText();
  expect(text, '应含「已拒绝跟随」').toContain('已拒绝跟随');
  expect(text, '不应附「常见原因」那一段').not.toContain('常见原因');
  expect(text, '不应附「这很正常」那一段').not.toContain('这很正常');
  await page.waitForTimeout(500);
  expect(B.hits.length, 'B 应 0 次').toBe(0);
});
