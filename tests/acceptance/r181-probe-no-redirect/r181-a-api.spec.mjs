// r181 · 接口用例(行为清单 1–22):四个探测接口遇到上游 3xx 时的统一规则。
// 只通过 HTTP 接口 + 隔离家目录里已保存的条目观察;A = 用户填的地址,B = 上游要求跳去的另一台,C = 表单里新填的另一个地址。
// 依据只有 .devflow/r181-probe-no-redirect-接口.md,没看实现代码。
import { test, expect } from '@playwright/test';
import { newCase, closeCase } from './helpers/case.mjs';
import { modelsBody } from './helpers/fakes.mjs';
import { STORED_KEY, NEW_KEY, TEST_MSG, TEXT_FETCH, TEXT_TEST, ITEM_FETCH, IMAGE_FETCH, createText, createImage, newSaveDir } from './helpers/common.mjs';

test.afterEach(async () => { await closeCase(); });

const KEY = NEW_KEY;
const BAD_TYPE_MSG = 'type 必须是 openai 或 anthropic';
const BAD_PROTOCOL_MSG = '协议必须是 openai / gemini / chat / mj / mj-proxy';
/** 响应里的报错文字(文本接口叫 error,生图叫 message,按条目拉模型叫 note)。 */
const errText = (r) => String(r.json?.error ?? r.json?.message ?? r.json?.note ?? '');
const redirect = (status, location) => ({ status, location });
const ok = (ids = ['m-a']) => ({ status: 200, body: modelsBody(ids) });

// ============================ 文本拉模型 ============================

test('1 【复现】文本拉模型·跨主机跳转(301/302/307/308)被拒:502 + UPSTREAM_REDIRECT,B 0 次,A 只收 1 次且不换鉴权头重试', async () => {
  const c = await newCase('t01');
  const A = await c.fake(); const B = await c.fake();
  for (const code of [301, 302, 307, 308]) {
    A.reset(); B.reset();
    A.on('GET', '/v1/models', redirect(code, `${B.url}/v1/models`));
    const r = await c.req('POST', TEXT_FETCH, { type: 'anthropic', baseURL: A.url, apiKey: KEY });
    const e = errText(r);
    expect(r.status, `anthropic·HTTP ${code}:${r.text}`).toBe(502);
    expect(r.json?.code, `anthropic·HTTP ${code}`).toBe('UPSTREAM_REDIRECT');
    expect(e, `anthropic·HTTP ${code}`).toContain('重定向');
    expect(e, `anthropic·HTTP ${code}`).toContain('已拒绝跟随');
    expect(e, `anthropic·HTTP ${code}`).toContain(`HTTP ${code}`);
    expect(e, `anthropic·HTTP ${code}`).toContain(B.host);
    expect(e, `anthropic·HTTP ${code}`).not.toContain('未提供模型列表接口');
    expect(B.hits.length, `anthropic·HTTP ${code}:B 应 0 次`).toBe(0);
    expect(A.hits.length, `anthropic·HTTP ${code}:A 应恰好 1 次(不换 Bearer 再试)`).toBe(1);
    expect(A.hits[0].xkey, `anthropic·HTTP ${code}`).toBe(KEY);
    expect(A.hits[0].auth, `anthropic·HTTP ${code}:不应带 Authorization`).toBe('');
  }
  A.reset(); B.reset();
  A.on('GET', '/v1/models', redirect(302, `${B.url}/v1/models`));
  const r = await c.req('POST', TEXT_FETCH, { type: 'openai', baseURL: A.url, apiKey: KEY });
  expect(r.status, `openai:${r.text}`).toBe(502);
  expect(r.json?.code, 'openai').toBe('UPSTREAM_REDIRECT');
  expect(errText(r), 'openai').toContain(B.host);
  expect(B.hits.length, 'openai:B 应 0 次').toBe(0);
  expect(A.hits.length, 'openai:A 应恰好 1 次').toBe(1);
  expect(A.hits[0].auth, 'openai').toBe(`Bearer ${KEY}`);
});

test('2 【守卫】文本拉模型·同一主机跳转(301 / 307)跟 1 次:200 拿到列表,目标路径收 1 次且鉴权头与第一次相同', async () => {
  const c = await newCase('t02');
  const A = await c.fake();
  for (const code of [301, 307]) {
    A.reset();
    A.on('GET', '/v1/models', redirect(code, `${A.url}/v1/models/`));
    A.on('GET', '/v1/models/', ok(['m-follow']));
    const r = await c.req('POST', TEXT_FETCH, { type: 'anthropic', baseURL: A.url, apiKey: KEY });
    expect(r.status, `HTTP ${code}:${r.text}`).toBe(200);
    expect(r.json?.models, `HTTP ${code}`).toEqual(['m-follow']);
    const first = A.at('GET', '/v1/models');
    const second = A.at('GET', '/v1/models/');
    expect(second.length, `HTTP ${code}:/v1/models/ 应收 1 次`).toBe(1);
    expect(second[0].xkey, `HTTP ${code}`).toBe(first[0].xkey);
    expect(second[0].auth, `HTTP ${code}`).toBe(first[0].auth);
    expect(second[0].xkey, `HTTP ${code}:带的是请求里的 Key`).toBe(KEY);
  }
});

test('3 【复现】文本拉模型·同一主机内第二次还是跳转:502,报错含「同一主机」「已停止」,第三跳 0 次', async () => {
  const c = await newCase('t03');
  const A = await c.fake();
  A.on('GET', '/v1/models', redirect(302, `${A.url}/x`));
  A.on('GET', '/x', redirect(302, `${A.url}/y`));
  A.on('GET', '/y', ok());
  const r = await c.req('POST', TEXT_FETCH, { type: 'openai', baseURL: A.url, apiKey: KEY });
  const e = errText(r);
  expect(r.status, r.text).toBe(502);
  expect(e).toContain('同一主机');
  expect(e).toContain('已停止');
  expect(A.hits.filter((h) => h.path === '/y').length, '/y 应 0 次(任何方法)').toBe(0);
});

test('4 【复现】文本拉模型·Location 是同一主机同端口的 https:502,报错含「https」与「同一主机」,A 总共只收 1 次', async () => {
  const c = await newCase('t04');
  const A = await c.fake();
  A.on('GET', '/v1/models', redirect(302, `https://127.0.0.1:${A.port}/v1/models`));
  const r = await c.req('POST', TEXT_FETCH, { type: 'openai', baseURL: A.url, apiKey: KEY });
  const e = errText(r);
  expect(r.status, r.text).toBe(502);
  expect(e).toContain('https');
  expect(e).toContain('同一主机');
  expect(A.hits.length, 'A 总共应只收 1 次').toBe(1);
});

test('5 【复现】文本拉模型·重定向报错不泄露 Location 的路径 / 查询串 / 片段 / Key,也不泄露请求地址里的查询串与超长路径段', async () => {
  const c = await newCase('t05');
  const A = await c.fake(); const B = await c.fake();
  const forbidden = [`http://127.0.0.1:${B.port}`, `https://127.0.0.1:${B.port}`, 'secret-path-123', 'key=', 'frag', KEY, 'token=abc', 'abcdefghijklmnopqrstuvwxyz0123'];
  const loc = `${B.url}/secret-path-123?key=${KEY}#frag`;
  const check = (label, r) => {
    const e = errText(r);
    expect(r.status, `${label}:${r.text}`).toBe(502);
    expect(e, `${label}:应含 B 的 主机:端口`).toContain(B.host);
    for (const s of forbidden) expect(e, `${label}:不应含 ${s}`).not.toContain(s);
  };
  A.on('GET', '/v1/models', redirect(302, loc));
  check('(i) Location 带路径 / 查询串 / 片段', await c.req('POST', TEXT_FETCH, { type: 'openai', baseURL: A.url, apiKey: KEY }));
  A.clearRoutes(); A.reset();
  A.fallback(redirect(302, loc));
  check('(ii) 请求地址带超长路径段与查询串', await c.req('POST', TEXT_FETCH, { type: 'openai', baseURL: `${A.url}/abcdefghijklmnopqrstuvwxyz0123/v1?token=abc`, apiKey: KEY }));
  expect(B.hits.length, 'B 应始终 0 次').toBe(0);
});

test('6 【复现】文本拉模型·/anthropic 地址的候选逐个试:(i) 第一个候选被拒、第二个成功 → 200 且 B 0 次;(ii) 第二个 404 → 502 重定向报错', async () => {
  const c = await newCase('t06');
  const A = await c.fake(); const B = await c.fake();
  const base = `${A.url}/anthropic`;
  A.on('GET', '/anthropic/v1/models', redirect(302, `${B.url}/v1/models`));
  A.on('GET', '/v1/models', ok(['m-second']));
  const r1 = await c.req('POST', TEXT_FETCH, { type: 'openai', baseURL: base, apiKey: KEY });
  expect(r1.status, `(i) ${r1.text}`).toBe(200);
  expect(r1.json?.models, '(i)').toEqual(['m-second']);
  expect(B.hits.length, '(i) B 应 0 次').toBe(0);

  A.clearRoutes(); A.reset();
  A.on('GET', '/anthropic/v1/models', redirect(302, `${B.url}/v1/models`));
  A.on('GET', '/v1/models', { status: 404, body: { error: 'nope' } });
  const r2 = await c.req('POST', TEXT_FETCH, { type: 'openai', baseURL: base, apiKey: KEY });
  const e = errText(r2);
  expect(r2.status, `(ii) ${r2.text}`).toBe(502);
  expect(e, '(ii)').toContain('已拒绝跟随');
  expect(e, '(ii)').not.toContain('未提供模型列表接口');
  expect(B.hits.length, '(ii) B 应 0 次').toBe(0);
});

test('7 【守卫】文本拉模型·鉴权失败的提示优先于重定向:候选一被拒、候选二 401 → 含「鉴权失败」;单候选直接 401 → 同样含「鉴权失败」', async () => {
  const c = await newCase('t07');
  const A = await c.fake(); const B = await c.fake();
  A.on('GET', '/anthropic/v1/models', redirect(302, `${B.url}/v1/models`));
  A.on('GET', '/v1/models', { status: 401, body: { error: 'unauthorized' } });
  const r1 = await c.req('POST', TEXT_FETCH, { type: 'openai', baseURL: `${A.url}/anthropic`, apiKey: KEY });
  expect(errText(r1), `两个候选:${r1.text}`).toContain('鉴权失败');
  A.clearRoutes(); A.reset();
  A.on('GET', '/v1/models', { status: 401, body: { error: 'unauthorized' } });
  const r2 = await c.req('POST', TEXT_FETCH, { type: 'openai', baseURL: A.url, apiKey: KEY });
  expect(errText(r2), `单候选:${r2.text}`).toContain('鉴权失败');
});

test('8 【守卫】文本拉模型·上游正常 200:接口 200,models 就是 A 给的列表', async () => {
  const c = await newCase('t08');
  const A = await c.fake();
  A.on('GET', '/v1/models', ok(['m-one', 'm-two']));
  const r = await c.req('POST', TEXT_FETCH, { type: 'openai', baseURL: A.url, apiKey: KEY });
  expect(r.status, r.text).toBe(200);
  expect(r.json?.models).toEqual(['m-one', 'm-two']);
});

test('9 【复现】按条目拉模型·(i) 上游跳转被拒 → 200 + MODELS_UNAVAILABLE + note 含「重定向」,B 0 次;(ii) 401 回显 Key → note 不含已保存 Key', async () => {
  const c = await newCase('t09');
  const A = await c.fake(); const B = await c.fake();
  const id = await createText(c.inst.base, { type: 'openai', baseURL: A.url, apiKey: STORED_KEY });
  A.fallback(redirect(302, `${B.url}/v1/models`));
  const r1 = await c.req('POST', ITEM_FETCH, { id });
  expect(r1.status, `(i) ${r1.text}`).toBe(200);
  expect(r1.json?.code, '(i)').toBe('MODELS_UNAVAILABLE');
  expect(String(r1.json?.note), '(i)').toContain('重定向');
  expect(B.hits.length, '(i) B 应 0 次').toBe(0);

  A.clearRoutes(); A.reset();
  A.fallback((hit) => ({ status: 401, body: { error: { message: `invalid credentials: authorization=${hit.auth} x-api-key=${hit.xkey}` } } }));
  const r2 = await c.req('POST', ITEM_FETCH, { id });
  expect(A.hits.length, '(ii) 前置:A 应收到过请求').toBeGreaterThanOrEqual(1);
  expect(A.hits.some((h) => h.auth === `Bearer ${STORED_KEY}` || h.xkey === STORED_KEY), '(ii) 前置:A 收到的是已保存的 Key').toBe(true);
  expect(typeof r2.json?.note, `(ii) note 应是字符串:${r2.text}`).toBe('string');
  expect(r2.json.note, '(ii) note 不应含已保存的 Key 原文').not.toContain(STORED_KEY);
});

// ============================ 生图拉模型 ============================

test('10 【复现】生图拉模型·openai 协议新建态,A 跳转到 B → 502 + type=redirect + message 含「重定向」,B 0 次', async () => {
  const c = await newCase('t10');
  const A = await c.fake(); const B = await c.fake();
  A.fallback(redirect(302, `${B.url}/v1/models`));
  const r = await c.req('POST', IMAGE_FETCH, { protocol: 'openai', baseURL: `${A.url}/v1`, apiKey: KEY });
  expect(r.status, r.text).toBe(502);
  expect(r.json?.ok).toBe(false);
  expect(r.json?.type).toBe('redirect');
  expect(String(r.json?.message)).toContain('重定向');
  expect(B.hits.length, 'B 应 0 次').toBe(0);
});

test('11 【复现】生图拉模型·gemini 协议新建态:(i) 跳到 B → 502 + type=redirect;(ii) 同一主机 307 → 跟 1 次,200 拿到列表', async () => {
  const c = await newCase('t11');
  const A = await c.fake(); const B = await c.fake();
  const base = `${A.url}/v1beta`;
  A.on('GET', '/v1beta/models', redirect(302, `${B.url}/v1beta/models`));
  const r1 = await c.req('POST', IMAGE_FETCH, { protocol: 'gemini', baseURL: base, apiKey: KEY });
  expect(r1.status, `(i) ${r1.text}`).toBe(502);
  expect(r1.json?.type, '(i)').toBe('redirect');
  expect(B.hits.length, '(i) B 应 0 次').toBe(0);

  A.clearRoutes(); A.reset();
  A.on('GET', '/v1beta/models', redirect(307, `${A.url}/v1beta/models/`));
  A.on('GET', '/v1beta/models/', ok(['gemini-r181-listed']));
  const r2 = await c.req('POST', IMAGE_FETCH, { protocol: 'gemini', baseURL: base, apiKey: KEY });
  expect(r2.status, `(ii) ${r2.text}`).toBe(200);
  expect(r2.json?.ok, '(ii)').toBe(true);
  expect(JSON.stringify(r2.json?.models), '(ii) 列表里应有 A 给的模型').toContain('gemini-r181-listed');
  expect(A.count('GET', '/v1beta/models/'), '(ii) 跳转目标应收 1 次').toBe(1);
});

test('12 【复现】生图拉模型·借用已保存 Key 时协议按请求:已保存 openai、请求 gemini → 第一次请求带 Bearer 已保存 Key,不带 x-api-key', async () => {
  const c = await newCase('t12');
  const S = await c.fake(); const D = await c.fake();
  S.on('GET', '/v1/models', ok(['gemini-r181-saved']));
  const id = await createImage(c.inst.base, { protocol: 'openai', baseURL: `${S.url}/v1`, apiKey: STORED_KEY, savePath: newSaveDir(c.home) });
  await c.req('POST', IMAGE_FETCH, { id, protocol: 'gemini', baseURL: `${S.url}/v1` });
  expect(S.hits.length, 'S 应收到请求').toBeGreaterThanOrEqual(1);
  expect(`${S.hits[0].method} ${S.hits[0].path}`).toBe('GET /v1/models');
  expect(S.hits[0].auth, '第一次请求应带 Bearer <已保存的 Key>').toBe(`Bearer ${STORED_KEY}`);
  expect(S.hits[0].xkey, '第一次请求不应带 x-api-key').toBe('');
  expect(D.hits.length, '其它假上游应 0 次').toBe(0);
});

// ============================ 协议校验与打码 ============================

test('13 【复现】协议校验:生图 / 文本拉模型 / 测试连接 的协议是 foo 或没带 → 400 + 固定文案,假上游 0 次', async () => {
  const c = await newCase('t13');
  const A = await c.fake();
  A.fallback(ok());
  const img = `${A.url}/v1`;
  const steps = [
    ['(i) 生图 protocol=foo', IMAGE_FETCH, { protocol: 'foo', baseURL: img, apiKey: KEY }, { ok: false, type: 'unsupported', message: BAD_PROTOCOL_MSG }],
    ['(ii) 生图新建态不带 protocol', IMAGE_FETCH, { baseURL: img, apiKey: KEY }, { ok: false, type: 'unsupported', message: BAD_PROTOCOL_MSG }],
    ['(iii) 文本拉模型 type=foo', TEXT_FETCH, { type: 'foo', baseURL: A.url, apiKey: KEY }, { error: BAD_TYPE_MSG }],
    ['(iv) 文本拉模型新建态不带 type', TEXT_FETCH, { baseURL: A.url, apiKey: KEY }, { error: BAD_TYPE_MSG }],
    ['(v) 测试连接 type=foo', TEXT_TEST, { type: 'foo', baseURL: A.url, apiKey: KEY, model: 'm1' }, { ok: false, error: BAD_TYPE_MSG }],
    ['(vi) 测试连接新建态不带 type', TEXT_TEST, { baseURL: A.url, apiKey: KEY, model: 'm1' }, { ok: false, error: BAD_TYPE_MSG }],
  ];
  for (const [label, url, body, expected] of steps) {
    const before = A.hits.length;
    const r = await c.req('POST', url, body);
    expect.soft(r.status, `${label}:${r.text}`).toBe(400);
    expect.soft(r.json, `${label}`).toMatchObject(expected);
    expect.soft(A.hits.length - before, `${label}:假上游应 0 次`).toBe(0);
  }
});

test('14 【复现】测试连接·上游 400 回显 Key → 返回的 error 不含 Key 原文,含 ***', async () => {
  const c = await newCase('t14');
  const A = await c.fake();
  A.on('POST', '/v1/messages', (hit) => ({ status: 400, body: { error: { message: `invalid x-api-key: ${hit.xkey}` } } }));
  const r = await c.req('POST', TEXT_TEST, { type: 'anthropic', baseURL: A.url, apiKey: KEY, model: 'm1' });
  expect(A.hits[0]?.xkey, '前置:A 收到的是请求里的 Key').toBe(KEY);
  expect(r.status, r.text).toBe(200);
  expect(r.json?.ok).toBe(false);
  expect(String(r.json?.error), 'error 不应含 Key 原文').not.toContain(KEY);
  expect(String(r.json?.error), 'error 应含 ***').toContain('***');
});

// ============================ 测试连接 ============================

test('15 【复现】测试连接·跨主机跳转(301/302/307/308)被拒:200 + ok=false + status=那个 3xx + error 含「重定向」,B 0 次', async () => {
  const c = await newCase('t15');
  const A = await c.fake(); const B = await c.fake();
  for (const code of [301, 302, 307, 308]) {
    A.reset(); B.reset();
    A.on('POST', '/v1/messages', redirect(code, `${B.url}/v1/messages`));
    const r = await c.req('POST', TEXT_TEST, { type: 'anthropic', baseURL: A.url, apiKey: KEY, model: 'm1' });
    expect(r.status, `HTTP ${code}:${r.text}`).toBe(200);
    expect(r.json?.ok, `HTTP ${code}`).toBe(false);
    expect(r.json?.status, `HTTP ${code}`).toBe(code);
    expect(String(r.json?.error), `HTTP ${code}`).toContain('重定向');
    expect(B.hits.length, `HTTP ${code}:B 应 0 次`).toBe(0);
  }
});

test('16 【守卫】测试连接·同一主机 POST 307 / 308 跟 1 次:ok=true,目标收 1 次 POST,x-api-key 与请求体和第一次相同', async () => {
  const c = await newCase('t16');
  const A = await c.fake();
  for (const code of [307, 308]) {
    A.reset();
    A.on('POST', '/v1/messages', redirect(code, `${A.url}/v1/messages/`));
    A.on('POST', '/v1/messages/', { status: 200, body: { id: 'msg_1' } });
    const r = await c.req('POST', TEXT_TEST, { type: 'anthropic', baseURL: A.url, apiKey: KEY, model: 'm1' });
    expect(r.status, `HTTP ${code}:${r.text}`).toBe(200);
    expect(r.json?.ok, `HTTP ${code}`).toBe(true);
    const first = A.at('POST', '/v1/messages');
    const second = A.at('POST', '/v1/messages/');
    expect(second.length, `HTTP ${code}:/v1/messages/ 应收 1 次 POST`).toBe(1);
    expect(second[0].xkey, `HTTP ${code}`).toBe(first[0].xkey);
    expect(second[0].xkey, `HTTP ${code}`).toBe(KEY);
    expect(second[0].body.length, `HTTP ${code}:请求体不应为空`).toBeGreaterThan(0);
    expect(second[0].bodyHash, `HTTP ${code}:请求体应原样重发`).toBe(first[0].bodyHash);
  }
});

test('17 【复现】测试连接·POST 遇到同一主机的 301 / 302 / 303 不跟:ok=false,error 含「同一主机」「已停止」,目标 0 次', async () => {
  const c = await newCase('t17');
  const A = await c.fake();
  for (const code of [302, 301, 303]) {
    A.reset();
    A.on('POST', '/v1/chat/completions', redirect(code, `${A.url}/v1/chat/completions/`));
    A.on('POST', '/v1/chat/completions/', { status: 200, body: {} });
    const r = await c.req('POST', TEXT_TEST, { type: 'openai', baseURL: A.url, apiKey: KEY, model: 'm1' });
    expect(r.status, `HTTP ${code}:${r.text}`).toBe(200);
    expect(r.json?.ok, `HTTP ${code}`).toBe(false);
    expect(String(r.json?.error), `HTTP ${code}`).toContain('同一主机');
    expect(String(r.json?.error), `HTTP ${code}`).toContain('已停止');
    expect(A.hits.filter((h) => h.path === '/v1/chat/completions/').length, `HTTP ${code}:目标应 0 次(任何方法)`).toBe(0);
  }
});

test('18 【复现】测试连接·带 id、Key 没填、地址与已保存不同 → 400 + STORED_KEY_URL_MISMATCH + 固定文案,A、C 都 0 次', async () => {
  const c = await newCase('t18');
  const A = await c.fake(); const C = await c.fake();
  const id = await createText(c.inst.base, { type: 'anthropic', baseURL: A.url, apiKey: STORED_KEY });
  const r = await c.req('POST', TEXT_TEST, { id, type: 'anthropic', baseURL: C.url, model: 'm1' });
  expect(r.status, r.text).toBe(400);
  expect(r.json).toEqual({ ok: false, code: 'STORED_KEY_URL_MISMATCH', error: TEST_MSG });
  expect(A.hits.length, 'A 应 0 次').toBe(0);
  expect(C.hits.length, 'C 应 0 次').toBe(0);
});

test('19 【守卫】测试连接·借用且地址相同(已保存地址加结尾斜杠和首尾空格 / 空串 / 全空格)→ A 收到请求,带已保存的 Key,ok=true', async () => {
  const c = await newCase('t19');
  const A = await c.fake();
  A.on('POST', '/v1/chat/completions', { status: 200, body: {} });
  const id = await createText(c.inst.base, { type: 'openai', baseURL: A.url, apiKey: STORED_KEY });
  const variants = [['结尾斜杠加首尾空格', `  ${A.url}/  `], ['空串', ''], ['全空格', '   ']];
  for (const [i, [label, baseURL]] of variants.entries()) {
    const r = await c.req('POST', TEXT_TEST, { id, type: 'openai', baseURL, model: 'm1' });
    expect(r.status, `${label}:${r.text}`).toBe(200);
    expect(r.json?.ok, label).toBe(true);
    expect(A.hits.length, `${label}:A 累计应收 ${i + 1} 次`).toBe(i + 1);
    expect(A.hits[i].auth, label).toBe(`Bearer ${STORED_KEY}`);
  }
});

test('20 【守卫】测试连接·借用时协议按请求:已保存 anthropic,请求 type=openai → POST /v1/chat/completions 带 Bearer;不带 type → POST /v1/messages 带 x-api-key', async () => {
  const c = await newCase('t20');
  const A = await c.fake();
  A.on('POST', '/v1/chat/completions', { status: 200, body: {} });
  A.on('POST', '/v1/messages', { status: 200, body: {} });
  const id = await createText(c.inst.base, { type: 'anthropic', baseURL: A.url, apiKey: STORED_KEY });
  const r1 = await c.req('POST', TEXT_TEST, { id, type: 'openai', baseURL: A.url, model: 'm1' });
  expect(r1.status, r1.text).toBe(200);
  expect(`${A.hits[0]?.method} ${A.hits[0]?.path}`, '请求 type=openai').toBe('POST /v1/chat/completions');
  expect(A.hits[0].auth).toBe(`Bearer ${STORED_KEY}`);
  expect(A.hits[0].xkey, '不应带 x-api-key').toBe('');
  const r2 = await c.req('POST', TEXT_TEST, { id, baseURL: A.url, model: 'm1' });
  expect(r2.status, r2.text).toBe(200);
  expect(`${A.hits[1]?.method} ${A.hits[1]?.path}`, '请求不带 type').toBe('POST /v1/messages');
  expect(A.hits[1].xkey).toBe(STORED_KEY);
});

test('21 【复现】测试连接·apiKey 是数字 12345 当作没填:地址相同 → A 收到已保存 Key 正常返回;地址是 C → 400 STORED_KEY_URL_MISMATCH,A、C 0 次', async () => {
  const c = await newCase('t21');
  const A = await c.fake(); const C = await c.fake();
  A.on('POST', '/v1/chat/completions', { status: 200, body: {} });
  const id = await createText(c.inst.base, { type: 'openai', baseURL: A.url, apiKey: STORED_KEY });
  const r1 = await c.req('POST', TEXT_TEST, { id, type: 'openai', baseURL: A.url, apiKey: 12345, model: 'm1' });
  expect(r1.status, `地址相同:${r1.text}`).toBe(200);
  expect(r1.json?.ok).toBe(true);
  expect(A.hits.length).toBe(1);
  expect(A.hits[0].auth).toBe(`Bearer ${STORED_KEY}`);

  A.reset();
  const r2 = await c.req('POST', TEXT_TEST, { id, type: 'openai', baseURL: C.url, apiKey: 12345, model: 'm1' });
  expect(r2.status, `地址是 C:${r2.text}`).toBe(400);
  expect(r2.json?.code).toBe('STORED_KEY_URL_MISMATCH');
  expect(A.hits.length, 'A 应 0 次').toBe(0);
  expect(C.hits.length, 'C 应 0 次').toBe(0);
});

test('22 【守卫】测试连接·自带 Key 去掉首尾空白再用(C 收到 sk-r181-new,A 0 次);新建态 A 回 200 → {ok:true,status:200}', async () => {
  const c = await newCase('t22');
  const A = await c.fake(); const C = await c.fake(); const D = await c.fake();
  C.on('POST', '/v1/messages', { status: 200, body: {} });
  D.on('POST', '/v1/messages', { status: 200, body: {} });
  const id = await createText(c.inst.base, { type: 'anthropic', baseURL: A.url, apiKey: STORED_KEY });
  const r1 = await c.req('POST', TEXT_TEST, { id, type: 'anthropic', baseURL: C.url, apiKey: '  sk-r181-new  ', model: 'm1' });
  expect(r1.status, r1.text).toBe(200);
  expect(C.hits.length, 'C 应收 1 次').toBe(1);
  expect(C.hits[0].xkey, 'C 收到的 x-api-key 应已去掉首尾空白').toBe('sk-r181-new');
  expect(A.hits.length, 'A 应 0 次').toBe(0);

  const r2 = await c.req('POST', TEXT_TEST, { type: 'anthropic', baseURL: D.url, apiKey: KEY, model: 'm1' });
  expect(r2.status, r2.text).toBe(200);
  expect(r2.json).toEqual({ ok: true, status: 200 });
});
