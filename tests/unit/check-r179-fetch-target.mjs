#!/usr/bin/env node
// 单测:r179 拉取模型的取值规则(server/utils/fetch-target.js 纯函数白盒)。
// 规则:Key 是谁的,地址、协议、代理就跟谁走;借已保存 Key 时发出去的地址恒为 stored.baseURL 原值。
// Run: node tests/unit/check-r179-fetch-target.mjs
import assert from 'node:assert/strict';

const { resolveFetchTarget, KEY_URL_MISMATCH_MSG } = await import('../../server/utils/fetch-target.js');

assert.equal(
  KEY_URL_MISMATCH_MSG,
  '接口地址已改动，已保存的密钥只会发往已保存的地址。要按新地址拉取模型，请重新填写密钥，或先保存再拉取。',
  't0: 文案逐字(全角标点)',
);

const strip = (s) => String(s || '').trim().replace(/\/+$/, '');
const STORED = Object.freeze({
  baseURL: 'https://saved.example.com/v1', apiKey: 'sk-stored-secret-123456', protocol: 'anthropic', proxyUrl: 'http://127.0.0.1:7001',
});

// t1 stored=null:原样返回请求值,不规范化、不调用 normalize
{
  let called = 0;
  const req = { baseURL: '  https://new.example.com/v1/ ', apiKey: 123, protocol: 'openai', proxyUrl: 'http://127.0.0.1:7002' };
  const t = resolveFetchTarget(null, req, () => { called += 1; return ''; });
  assert.equal(called, 0, 't1: stored 为空时不调用 normalize');
  assert.equal(t.reject, false);
  assert.equal(t.borrowed, false);
  assert.equal(t.baseURL, req.baseURL, 't1: 地址原值,不规范化');
  assert.equal(t.apiKey, 123, 't1: Key 原值');
  assert.equal(t.protocol, 'openai');
  assert.deepEqual(t.proxy, { from: 'request', value: 'http://127.0.0.1:7002' });
  assert.equal(t.sameAsStored, false);
}

// t2 借用且地址相同(去首尾空白 + 结尾斜杠):返回 stored.baseURL 原值与已保存的 Key / 协议 / 代理
{
  const t = resolveFetchTarget(STORED, { baseURL: '  https://saved.example.com/v1/  ', apiKey: '', protocol: 'openai', proxyUrl: 'http://127.0.0.1:9999' }, strip);
  assert.equal(t.reject, false);
  assert.equal(t.borrowed, true);
  assert.equal(t.baseURL, STORED.baseURL, 't2: 发出去的是已保存地址原值');
  assert.equal(t.apiKey, STORED.apiKey);
  assert.equal(t.protocol, 'anthropic', 't2: 借用时协议用已保存的');
  assert.deepEqual(t.proxy, { from: 'stored', value: STORED.proxyUrl }, 't2: 借用时代理用已保存的,忽略请求里的');
  assert.equal(t.sameAsStored, true);
}

// t3 硬规则:normalize 永远判相同时,发出去的仍是 stored.baseURL 原值
{
  const t = resolveFetchTarget(STORED, { baseURL: 'http://evil.example.com/steal', apiKey: '   ' }, () => 'SAME');
  assert.equal(t.reject, false);
  assert.equal(t.borrowed, true);
  assert.equal(t.baseURL, STORED.baseURL, 't3: 比较写错也到不了请求里的地址');
  assert.equal(t.apiKey, STORED.apiKey);
}

// t4 借用且地址不同:拒绝
{
  for (const apiKey of [undefined, '', '   ', null]) {
    const t = resolveFetchTarget(STORED, { baseURL: 'https://new.example.com/v1', apiKey }, strip);
    assert.deepEqual(t, { reject: true }, `t4: Key=${JSON.stringify(apiKey)} 地址不同 → 拒绝`);
  }
}

// t5 非字符串的 apiKey 按借用处理
{
  for (const apiKey of [123, true, { k: 'sk-x' }, ['sk-x']]) {
    const rej = resolveFetchTarget(STORED, { baseURL: 'https://new.example.com/v1', apiKey }, strip);
    assert.deepEqual(rej, { reject: true }, `t5: apiKey=${JSON.stringify(apiKey)} 地址不同 → 拒绝`);
    const ok = resolveFetchTarget(STORED, { apiKey }, strip);
    assert.equal(ok.borrowed, true, `t5: apiKey=${JSON.stringify(apiKey)} 不带地址 → 借用`);
    assert.equal(ok.apiKey, STORED.apiKey);
    assert.equal(ok.baseURL, STORED.baseURL);
  }
}

// t6 借用、请求里的地址不是非空字符串 → 当作没带地址
{
  for (const baseURL of [undefined, null, '', '   ', ['https://new.example.com/v1'], { u: 'https://new.example.com/v1' }]) {
    const t = resolveFetchTarget(STORED, { baseURL, apiKey: '' }, strip);
    assert.equal(t.reject, false, `t6: baseURL=${JSON.stringify(baseURL)} 不拒绝`);
    assert.equal(t.baseURL, STORED.baseURL);
    assert.equal(t.apiKey, STORED.apiKey);
  }
}

// t7 自带 Key 带地址(不同):地址取请求值,sameAsStored=false,Key 不读已保存的
{
  const t = resolveFetchTarget(STORED, { baseURL: 'https://new.example.com/v1', apiKey: ' sk-own-key ', protocol: 'openai' }, strip);
  assert.equal(t.reject, false);
  assert.equal(t.borrowed, false);
  assert.equal(t.baseURL, 'https://new.example.com/v1');
  assert.equal(t.apiKey, 'sk-own-key', 't7: 自带 Key(去首尾空白)');
  assert.notEqual(t.apiKey, STORED.apiKey);
  assert.equal(t.protocol, 'openai', 't7: 自带 Key 时协议请求优先');
  assert.equal(t.sameAsStored, false);
}

// t8 自带 Key 带地址(相同):sameAsStored=true,地址是请求值
{
  const t = resolveFetchTarget(STORED, { baseURL: 'https://saved.example.com/v1/', apiKey: 'sk-own-key' }, strip);
  assert.equal(t.baseURL, 'https://saved.example.com/v1/');
  assert.equal(t.sameAsStored, true);
  assert.equal(t.protocol, 'anthropic', 't8: 请求没带协议 → 回落已保存的');
}

// t9 自带 Key 不带地址:回落已保存地址,sameAsStored=true
{
  const t = resolveFetchTarget(STORED, { apiKey: 'sk-own-key', protocol: '' }, strip);
  assert.equal(t.baseURL, STORED.baseURL);
  assert.equal(t.apiKey, 'sk-own-key');
  assert.equal(t.protocol, 'anthropic');
  assert.equal(t.sameAsStored, true);
}

// t10 代理三态
{
  const req = (proxyUrl) => ({ baseURL: 'https://new.example.com/v1', apiKey: 'sk-own-key', proxyUrl });
  assert.deepEqual(resolveFetchTarget(STORED, req('http://127.0.0.1:7003'), strip).proxy,
    { from: 'request', value: 'http://127.0.0.1:7003' }, 't10: 自带 Key 且带代理 → 请求值');
  assert.deepEqual(resolveFetchTarget(STORED, req(''), strip).proxy,
    { from: 'request', value: '' }, 't10: 空串也算带了(明确直连)');
  assert.deepEqual(resolveFetchTarget(STORED, req(undefined), strip).proxy,
    { from: 'stored', value: STORED.proxyUrl }, 't10: 没带 → 回落已保存');
  assert.deepEqual(resolveFetchTarget(STORED, req(null), strip).proxy,
    { from: 'stored', value: STORED.proxyUrl }, 't10: null 视为没带');
  const noProxy = { ...STORED, proxyUrl: undefined };
  assert.deepEqual(resolveFetchTarget(noProxy, req(undefined), strip).proxy,
    { from: 'stored', value: '' }, 't10: 已保存没有代理 → 空串');
  assert.deepEqual(resolveFetchTarget(noProxy, { apiKey: '' }, strip).proxy,
    { from: 'stored', value: '' }, 't10: 借用、已保存没有代理 → 空串');
}

// t11 协议:借用时已保存值优先(已保存为空才用请求的)
{
  const noProto = { ...STORED, protocol: '' };
  assert.equal(resolveFetchTarget(noProto, { apiKey: '', protocol: 'openai' }, strip).protocol, 'openai', 't11: 已保存为空 → 请求值');
  assert.equal(resolveFetchTarget(STORED, { apiKey: '', protocol: 'openai' }, strip).protocol, 'anthropic', 't11: 借用 → 已保存值');
}

// t13 源码:两个路由都从共用模块导入,文案只有一份
{
  const { readFileSync } = await import('node:fs');
  const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
  for (const p of ['server/routes/settings.js', 'server/routes/image.js']) {
    const src = read(p);
    assert.ok(!src.includes(KEY_URL_MISMATCH_MSG), `t13: ${p} 不另写文案字面量`);
    assert.match(src, /import \{ resolveFetchTarget, KEY_URL_MISMATCH_MSG \} from '\.\.\/utils\/fetch-target\.js'/, `t13: ${p} 从 fetch-target.js 导入`);
    assert.match(src, /resolveFetchTarget\(/, `t13: ${p} 调用 resolveFetchTarget`);
  }
}

// ─────────── t12 normalizeSavedImageBaseURL:与保存接口回显逐字同口径 ───────────
// 隔离:HOME/USERPROFILE 指向 mktemp 目录,import 路由前设好;保存不联网。
const { mkdtempSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const TMP_HOME = mkdtempSync(join(tmpdir(), 'cgui-r179-home-'));
const SAVE_DIR = mkdtempSync(join(tmpdir(), 'cgui-r179-save-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;

const { normalizeSavedImageBaseURL } = await import('../../server/utils/image-url.js');
const SAMPLES = [
  ['openai', 'http://127.0.0.1:6799/v1/images/generations/', 'http://127.0.0.1:6799/v1'],
  ['openai', 'http://127.0.0.1:6799/v1/', 'http://127.0.0.1:6799/v1'],
  ['openai', '  http://127.0.0.1:6799/v1/images/edits  ', 'http://127.0.0.1:6799/v1'],
  ['chat', 'http://127.0.0.1:6799/v1/chat/completions', 'http://127.0.0.1:6799/v1'],
  ['gemini', 'http://127.0.0.1:6799/v1beta/', 'http://127.0.0.1:6799/v1beta'],
  ['mj-proxy', 'http://127.0.0.1:6799/mj/', 'http://127.0.0.1:6799'],
  ['mj-proxy', 'http://127.0.0.1:6799/mj', 'http://127.0.0.1:6799'],
];
for (const [protocol, input, expected] of SAMPLES) {
  assert.equal(normalizeSavedImageBaseURL(protocol, input), expected, `t12: ${protocol} ${input} → ${expected}`);
}
assert.equal(normalizeSavedImageBaseURL('openai', undefined), '', 't12: 非字符串回空串');

const express = (await import('express')).default;
const imageRouter = (await import('../../server/routes/image.js')).default;
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/api', imageRouter);
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const BASE = `http://127.0.0.1:${server.address().port}`;
let failure = null;
try {
  for (const [protocol, input] of SAMPLES) {
    const r = await fetch(`${BASE}/api/image-providers`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `r179-${protocol}`, protocol, baseURL: input, apiKey: 'sk-r179-sample-000000', model: 'm', savePath: SAVE_DIR }),
    });
    const text = await r.text();
    assert.equal(r.status, 200, `t12: 保存 ${protocol} ${input}(${text})`);
    const { id } = JSON.parse(text);
    const list = await (await fetch(`${BASE}/api/image-providers`)).json();
    const arr = Array.isArray(list) ? list : (list.providers || []);
    const saved = arr.find((p) => p.id === id);
    assert.ok(saved, `t12: 列表里找得到刚保存的 ${id}`);
    assert.equal(normalizeSavedImageBaseURL(protocol, input), saved.baseURL, `t12: ${protocol} ${input} 与保存回显一致`);
    await fetch(`${BASE}/api/image-providers/${id}`, { method: 'DELETE' });
  }
} catch (e) {
  failure = e;
} finally {
  server.closeAllConnections?.();
  server.close();
  await new Promise((r) => server.once('close', r));
  for (const d of [TMP_HOME, SAVE_DIR]) rmSync(d, { recursive: true, force: true });
}
if (failure) throw failure;

console.log('✓ check-r179-fetch-target: 取值规则全部通过');
