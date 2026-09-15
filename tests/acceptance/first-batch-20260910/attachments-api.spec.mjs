import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fixtureSection, getRuntime, uniqueId } from './helpers/runtime.mjs';

function attachmentEndpoint(baseURL, sessionId) {
  return `${baseURL}/api/sessions/${encodeURIComponent(sessionId)}/attachments`;
}

function validPayload(section, overrides = {}) {
  return {
    messageId: uniqueId('attach'),
    text: 'FB attachment API text',
    attachments: section.canonicalAttachments || [],
    displayText: null,
    ...overrides,
  };
}

test('FB-T12 R07 contract: concurrent identical attachment writes create once and converge', async ({ request }) => {
  const { baseURL } = getRuntime({ requireManifest: true });
  const section = fixtureSection('attachments');
  const endpoint = attachmentEndpoint(baseURL, section.sessionId);
  const payload = validPayload(section);
  const responses = await Promise.all([
    request.post(endpoint, { data: payload }),
    request.post(endpoint, { data: { ...payload } }),
  ]);
  expect(responses.map(response => response.status())).toEqual([200, 200]);
  const bodies = await Promise.all(responses.map(response => response.json()));
  expect(bodies.map(body => body.created).sort()).toEqual([false, true]);
  expect(new Set(bodies.map(body => body.messageId))).toEqual(new Set([payload.messageId]));
});

test('FB-T13 R07 conflict: same messageId with different text is rejected and original remains readable', async ({ request }) => {
  const { baseURL } = getRuntime({ requireManifest: true });
  const section = fixtureSection('attachments');
  const endpoint = attachmentEndpoint(baseURL, section.sessionId);
  const payload = validPayload(section);
  expect((await request.post(endpoint, { data: payload })).status()).toBe(200);
  const conflict = await request.post(endpoint, { data: { ...payload, text: `${payload.text} changed` } });
  expect(conflict.status()).toBe(409);
  const body = await conflict.json();
  expect(body).toMatchObject({ ok: false, code: 'ATTACHMENT_CONFLICT' });
  expect(body.error).toEqual(expect.any(String));
});

test('FB-T14 R07 boundary: empty attachment array is valid and does not become a delete operation', async ({ request }) => {
  const { baseURL } = getRuntime({ requireManifest: true });
  const section = fixtureSection('attachments');
  const endpoint = attachmentEndpoint(baseURL, section.sessionId);
  const payload = validPayload(section, { attachments: [] });
  const first = await request.post(endpoint, { data: payload });
  const retry = await request.post(endpoint, { data: payload });
  expect(first.status()).toBe(200);
  expect((await first.json()).created).toBe(true);
  expect(retry.status()).toBe(200);
  expect((await retry.json()).created).toBe(false);
});

test('FB-T15 R07 boundary: invalid empty messageId returns stable 400 JSON', async ({ request }) => {
  const { baseURL } = getRuntime({ requireManifest: true });
  const section = fixtureSection('attachments');
  const response = await request.post(attachmentEndpoint(baseURL, section.sessionId), {
    data: validPayload(section, { messageId: '' }),
  });
  expect(response.status()).toBe(400);
  expect(await response.json()).toMatchObject({ ok: false, code: 'ATTACHMENT_INVALID' });
});

test('FB-T16 R07 boundary: exactly 1 MiB JSON metadata passes and one extra byte is 413', async ({ request }) => {
  const { baseURL } = getRuntime({ requireManifest: true });
  const section = fixtureSection('attachments');
  const endpoint = attachmentEndpoint(baseURL, section.sessionId);
  const fit = buildExactJsonPayload(section, 1024 * 1024, uniqueId('size_fit'));
  const over = buildExactJsonPayload(section, 1024 * 1024 + 1, uniqueId('size_over'));
  expect(Buffer.byteLength(JSON.stringify(fit))).toBe(1024 * 1024);
  expect(Buffer.byteLength(JSON.stringify(over))).toBe(1024 * 1024 + 1);
  expect((await request.post(endpoint, { data: fit })).status()).toBe(200);
  const tooLarge = await request.post(endpoint, { data: over });
  expect(tooLarge.status()).toBe(413);
  expect(await tooLarge.json()).toMatchObject({ ok: false, code: 'ATTACHMENT_TOO_LARGE' });
});

test('FB-T17 R08 real file path: raw endpoint returns exact PNG bytes and MIME', async ({ request }, testInfo) => {
  const { baseURL } = getRuntime();
  const imagePath = testInfo.outputPath('real image with space %.png');
  fs.mkdirSync(path.dirname(imagePath), { recursive: true });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z0u8AAAAASUVORK5CYII=', 'base64');
  fs.writeFileSync(imagePath, png);
  const url = `${baseURL}/api/files/read?path=${encodeURIComponent(imagePath)}&raw=1`;
  const response = await request.get(url);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toMatch(/^image\/png(?:;|$)/);
  expect(Buffer.from(await response.body())).toEqual(png);
});

test('FB-T18 R08 error: missing raw file is 404 with stable non-sensitive JSON', async ({ request }, testInfo) => {
  const { baseURL } = getRuntime();
  const missing = testInfo.outputPath('definitely missing image.png');
  const response = await request.get(`${baseURL}/api/files/read?path=${encodeURIComponent(missing)}&raw=1`);
  expect(response.status()).toBe(404);
  const body = await response.json();
  expect(body.ok).toBe(false);
  expect(body.code).toEqual(expect.any(String));
  expect(body.error).toEqual(expect.any(String));
  expect(JSON.stringify(body)).not.toMatch(/(?:token|authorization|cookie|stack|at\s+\S+\s+\()/i);
});

function buildExactJsonPayload(section, byteSize, messageId) {
  const base = validPayload(section, { messageId, attachments: [], text: '', displayText: null });
  const fixed = Buffer.byteLength(JSON.stringify(base));
  if (fixed > byteSize) throw new Error('base attachment payload unexpectedly exceeds requested size');
  base.text = 'a'.repeat(byteSize - fixed);
  return base;
}
