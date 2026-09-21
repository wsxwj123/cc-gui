// r123 · B 组:网页响应识别、基址规范化、最终地址预览(INTERFACE-r123 §B)。
// 依据只有 .devflow/BRIEF-r123.md 与 .devflow/INTERFACE-r123.md;没看实现代码。
import { test, expect } from '@playwright/test';
import { req, createProvider, generate, waitTerminal, newSaveDir, cancelIfRunning, listProviders, FAKE_KEY } from './helpers/api.mjs';
import { createFakeUpstream } from './helpers/fake-upstream.mjs';
import { boot, openImagePanel, openNewProviderForm, baseInput, modelInput, protocolSelect, finalUrl, addV1Button } from './helpers/ui.mjs';

let up;
test.beforeAll(async () => { up = createFakeUpstream(); await up.listen(); });
test.afterAll(async () => { await up?.close(); });
const jobs = [];
test.afterEach(async () => { while (jobs.length) await cancelIfRunning(jobs.pop()); });
const show = (e) => JSON.stringify(e);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function failWith(baseURL, overrides = {}) {
  const p = await createProvider({ baseURL, savePath: newSaveDir('b'), ...overrides });
  const jobId = await generate(p.id);
  jobs.push(jobId);
  const e = await waitTerminal(jobId, 30_000);
  expect(e, `历史里应能找到任务 ${jobId}`).toBeTruthy();
  return e;
}
const HTML = '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>New API</title></head><body><div id="app">网站首页</div></body></html>';

// ───────────────────────── B1 网页响应 ─────────────────────────
test('B1-1 上游回 200 text/html 网页:error 含「网站页面」「/v1」与当前请求地址,且不含「上游响应不是 JSON」', async () => {
  const base = up.scenario('/b1a', () => ({ status: 200, type: 'text/html; charset=utf-8', body: HTML }));
  const e = await failWith(base);
  expect(e.status, show(e)).toBe('error');
  const err = e.error || '';
  expect(err, show(e)).toContain('网站页面');
  expect(err, show(e)).toContain('/v1');
  expect(err, '应给出当前请求地址').toContain(`${base}/images/generations`);
  expect(err).not.toContain('上游响应不是 JSON');
});

test('B1-2 content-type 是 json 但正文以 < 开头:同样按网页响应处理', async () => {
  const base = up.scenario('/b1b', () => ({ status: 200, type: 'application/json', body: HTML }));
  const e = await failWith(base);
  expect(e.status, show(e)).toBe('error');
  const err = e.error || '';
  expect(err, show(e)).toContain('网站页面');
  expect(err, show(e)).toContain('/v1');
  expect(err, '应给出当前请求地址').toContain(`${base}/images/generations`);
  expect(err).not.toContain('上游响应不是 JSON');
});

// ───────────────────────── B2 /v1 写重 ─────────────────────────
test('B2 基址多写一层 /v1:上游 404 Invalid URL (/v1/v1/…) → error 含「写重」与去掉一层后的建议基址', async () => {
  const suggested = `${up.base}/b2/v1`;
  const base = up.scenario('/b2/v1/v1', ({ method, path: p }) => (method === 'POST' && p === '/images/generations'
    ? { status: 404, body: { error: { message: 'Invalid URL (POST /v1/v1/images/generations)' } } } : null));
  const e = await failWith(base);
  expect(e.status, show(e)).toBe('error');
  const err = e.error || '';
  expect(err, show(e)).toContain('写重');
  // 建议基址要作为一个独立地址出现(后面不能紧跟 /v1…,否则只是请求地址的一截)
  expect(err, `应给出建议基址 ${suggested}(不是请求地址的一部分)`).toMatch(new RegExp(`${esc(suggested)}/?(?![\\w/])`));
});

// ───────────────────────── B3 保存时规范化 ─────────────────────────
async function echoOf(id) {
  const p = (await listProviders()).find((x) => x.id === id);
  expect(p, `GET /api/image-providers 里应有 ${id}`).toBeTruthy();
  return p;
}
const B3_POST = [
  ['B3-1 完整接口地址 …/v1/images/generations/ 当基址', 'https://api.example.com/v1/images/generations/', 'https://api.example.com/v1'],
  ['B3-2 首尾空白与末尾斜杠', ' https://api.example.com/v1/ ', 'https://api.example.com/v1'],
  ['B3-3 …/v1/chat/completions 当基址', 'https://api.example.com/v1/chat/completions', 'https://api.example.com/v1'],
  ['B3-4 …/v1/images/edits 当基址', 'https://api.example.com/v1/images/edits', 'https://api.example.com/v1'],
];
for (const [title, input, want] of B3_POST) {
  test(`${title} → POST 后 GET 回显 ${want}`, async () => {
    const p = await createProvider({ baseURL: input, savePath: newSaveDir('b3') });
    expect((await echoOf(p.id)).baseURL).toBe(want);
  });
}

test('B3-5 PUT 更新基址为 …/v1/images/generations/ → 回显 https://api.example.com/v1', async () => {
  const p = await createProvider({ baseURL: 'https://api.example.com/v1', savePath: newSaveDir('b3') });
  const before = await echoOf(p.id);
  const r = await req('PUT', `/api/image-providers/${p.id}`, { ...before, apiKey: FAKE_KEY, baseURL: 'https://api.example.com/v1/images/generations/' });
  expect(r.status, r.text).toBe(200);
  expect((await echoOf(p.id)).baseURL).toBe('https://api.example.com/v1');
});

test('B3-6【反向】不自动补 /v1:传 https://api.example.com 回显仍是 https://api.example.com', async () => {
  const p = await createProvider({ baseURL: 'https://api.example.com', savePath: newSaveDir('b3') });
  expect((await echoOf(p.id)).baseURL).toBe('https://api.example.com');
});

test('B3-7【反向】已规范的基址原样保留:https://api.example.com/v1 → 不变', async () => {
  const p = await createProvider({ baseURL: 'https://api.example.com/v1', savePath: newSaveDir('b3') });
  expect((await echoOf(p.id)).baseURL).toBe('https://api.example.com/v1');
});

// ───────────────────────── B4 预览与一键补 /v1(界面) ─────────────────────────
test.describe('B4 预览与一键补 /v1', () => {
  test.skip(!process.env.R123_UI_BASE, '没有 dev server(R123_API_ONLY=1)');
  test.beforeEach(async ({ page }) => { await boot(page); await openImagePanel(page); await openNewProviderForm(page); });

  test('B4-1 openai 协议:基址输入框下方 image-final-url 显示 {base}/images/generations', async ({ page }) => {
    await protocolSelect(page).selectOption('openai');
    await baseInput(page).fill('https://api.example.com/v1');
    await expect(finalUrl(page)).toHaveText('https://api.example.com/v1/images/generations');
  });

  test('B4-2 切到 chat 协议:预览即时变成 {base}/chat/completions', async ({ page }) => {
    await baseInput(page).fill('https://api.example.com/v1');
    await protocolSelect(page).selectOption('chat');
    await expect(finalUrl(page)).toHaveText('https://api.example.com/v1/chat/completions');
  });

  test('B4-3 gemini 协议:预览为 {base}/models/{model}:generateContent,改模型即时跟着变', async ({ page }) => {
    await baseInput(page).fill('https://g.example.com/v1beta');
    await protocolSelect(page).selectOption('gemini');
    await modelInput(page).fill('gemini-2.5-flash-image');
    await expect(finalUrl(page)).toHaveText('https://g.example.com/v1beta/models/gemini-2.5-flash-image:generateContent');
    await modelInput(page).fill('imagen-4');
    await expect(finalUrl(page)).toHaveText('https://g.example.com/v1beta/models/imagen-4:generateContent');
  });

  test('B4-4 改基址预览即时变化:先 a.example 后 b.example', async ({ page }) => {
    await protocolSelect(page).selectOption('openai');
    await baseInput(page).fill('https://a.example.com/v1');
    await expect(finalUrl(page)).toHaveText('https://a.example.com/v1/images/generations');
    await baseInput(page).fill('https://b.example.com/v2');
    await expect(finalUrl(page)).toHaveText('https://b.example.com/v2/images/generations');
  });

  test('B4-5 openai + 基址无 /v数字 段:出现「补 /v1」按钮,点击后输入框值末尾追加 /v1、按钮消失、预览跟着变', async ({ page }) => {
    await protocolSelect(page).selectOption('openai');
    await baseInput(page).fill('https://api.example.com');
    await expect(addV1Button(page)).toBeVisible();
    await addV1Button(page).click();
    await expect(baseInput(page)).toHaveValue('https://api.example.com/v1');
    await expect(addV1Button(page)).toHaveCount(0);
    await expect(finalUrl(page)).toHaveText('https://api.example.com/v1/images/generations');
  });

  test('B4-6 chat + 基址无 /v数字 段:也出现「补 /v1」按钮', async ({ page }) => {
    await protocolSelect(page).selectOption('chat');
    await baseInput(page).fill('https://api.example.com');
    await expect(addV1Button(page)).toBeVisible();
  });

  test('B4-7【反向】基址已含 /v1:不出现「补 /v1」按钮', async ({ page }) => {
    await protocolSelect(page).selectOption('openai');
    await baseInput(page).fill('https://api.example.com/v1');
    await expect(finalUrl(page)).toHaveText('https://api.example.com/v1/images/generations');
    await expect(addV1Button(page)).toHaveCount(0);
  });

  test('B4-8【反向】基址已含 /v1beta:不出现「补 /v1」按钮', async ({ page }) => {
    await protocolSelect(page).selectOption('openai');
    await baseInput(page).fill('https://api.example.com/v1beta');
    await expect(finalUrl(page)).toHaveText('https://api.example.com/v1beta/images/generations');
    await expect(addV1Button(page)).toHaveCount(0);
  });

  test('B4-9【反向】「补 /v1」不静默改写:没点按钮时输入框值保持用户输入', async ({ page }) => {
    await protocolSelect(page).selectOption('openai');
    await baseInput(page).fill('https://api.example.com');
    await expect(addV1Button(page)).toBeVisible();
    await page.waitForTimeout(800);
    await expect(baseInput(page)).toHaveValue('https://api.example.com');
    await expect(finalUrl(page)).toHaveText('https://api.example.com/images/generations');
  });
});
