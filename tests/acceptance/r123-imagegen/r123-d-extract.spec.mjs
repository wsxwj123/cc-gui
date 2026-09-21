// r123 · D 组:两处补读(INTERFACE-r123 §D)——chat 协议 message.images[].image_url.url;openai 协议 b64_json + media_type。
// 依据只有 .devflow/BRIEF-r123.md 与 .devflow/INTERFACE-r123.md;没看实现代码。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { createProvider, generate, waitTerminal, newSaveDir, cancelIfRunning } from './helpers/api.mjs';
import { createFakeUpstream } from './helpers/fake-upstream.mjs';
import { PNG, WEBP, PNG_B64, WEBP_B64, PNG_DATA_URL } from './helpers/images.mjs';

let up;
test.beforeAll(async () => { up = createFakeUpstream(); await up.listen(); });
test.afterAll(async () => { await up?.close(); });
const jobs = [];
test.afterEach(async () => { while (jobs.length) await cancelIfRunning(jobs.pop()); });
const show = (e) => JSON.stringify(e);
const filesOf = (e) => (Array.isArray(e?.files) && e.files.length ? e.files : (e?.file ? [e.file] : []));

async function runJob(baseURL, overrides = {}) {
  const p = await createProvider({ baseURL, savePath: newSaveDir('d'), ...overrides });
  const jobId = await generate(p.id);
  jobs.push(jobId);
  const e = await waitTerminal(jobId, 30_000);
  expect(e, `历史里应能找到任务 ${jobId}`).toBeTruthy();
  return e;
}
const chatImages = (prefix, url) => up.scenario(prefix, ({ method, path: p }) => (method === 'POST' && p === '/chat/completions'
  ? { body: { choices: [{ message: { content: '', images: [{ type: 'image_url', image_url: { url } }] } }] } } : null));
const openaiB64 = (prefix, item) => up.scenario(prefix, ({ method, path: p }) => (method === 'POST' && p === '/images/generations'
  ? { body: { created: 1, data: [item] } } : null));

// ───────────────────────── D1 chat 协议补读 ─────────────────────────
test('D1-1 chat:choices[0].message.images[].image_url.url 是 data:image/png → done,落盘一张 png 且字节与原图一致', async () => {
  const e = await runJob(chatImages('/d1a/v1', PNG_DATA_URL), { protocol: 'chat' });
  expect(e.status, show(e)).toBe('done');
  const [f] = filesOf(e);
  expect(f, show(e)).toMatch(/\.png$/);
  expect(fs.readFileSync(f).equals(PNG), '落盘字节应与原 png 一致').toBe(true);
});

test('D1-2 chat:image_url.url 是 http 链接 → 下载落盘,图片口收到过这次下载', async () => {
  const e = await runJob(chatImages('/d1b/v1', up.img('d1b')), { protocol: 'chat' });
  expect(e.status, show(e)).toBe('done');
  const [f] = filesOf(e);
  expect(fs.readFileSync(f).equals(PNG), '落盘字节应与原 png 一致').toBe(true);
  const dl = (await up.imageRequests()).filter((r) => r.path === '/__img/d1b.png');
  expect(dl.length, '应真的去图片链接下载过').toBeGreaterThanOrEqual(1);
});

// ───────────────────────── D2 openai 协议 media_type ─────────────────────────
test('D2-1 openai:data[].b64_json 配 media_type=image/webp → 落盘扩展名 .webp,字节与原 webp 一致', async () => {
  const e = await runJob(openaiB64('/d2a/v1', { b64_json: WEBP_B64, media_type: 'image/webp' }));
  expect(e.status, show(e)).toBe('done');
  const [f] = filesOf(e);
  expect(f, show(e)).toMatch(/\.webp$/);
  expect(fs.readFileSync(f).equals(WEBP), '落盘字节应与原 webp 一致').toBe(true);
});

test('D2-2【反向】media_type=image/png 时仍是 .png(不因新字段破坏默认)', async () => {
  const e = await runJob(openaiB64('/d2b/v1', { b64_json: PNG_B64, media_type: 'image/png' }));
  expect(e.status, show(e)).toBe('done');
  const [f] = filesOf(e);
  expect(f, show(e)).toMatch(/\.png$/);
  expect(fs.readFileSync(f).equals(PNG)).toBe(true);
});
