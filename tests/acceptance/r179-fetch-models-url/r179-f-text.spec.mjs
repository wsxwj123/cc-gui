// r179 · 文本接口 POST /api/custom-providers/fetch-models(行为清单 F1–F10)。
// 只通过 HTTP 接口 + 隔离家目录里的数据文件观察;两台本机假上游分别扮演「已保存地址」S 与「新地址」N。
import { test, expect } from '@playwright/test';
import { newCase, closeCase } from './helpers/case.mjs';
import { MSG, STORED_KEY, NEW_KEY, TEXT_FETCH, createText, findById, dataFile, readJsonFile, sleep } from './helpers/common.mjs';

test.afterEach(async () => { await closeCase(); });

const SAVED_MODEL = { id: 'saved-model-1', window: 111000 };
const NEW_MODEL = { id: 'new-model-1', window: 222000 };

/** 预置:一个已保存的文本 Provider(地址指向 S 的 /v1),再备一台新地址那台 N。 */
async function setup(slug, { type = 'openai', models } = {}) {
  const c = await newCase(slug);
  const S = await c.upstream({ kind: 'openai', models: [SAVED_MODEL] });
  const N = await c.upstream({ kind: 'openai', models: [NEW_MODEL] });
  const savedBase = `${S.url}/v1`;
  const newBase = `${N.url}/v1`;
  const id = await createText(c.inst.base, { type, baseURL: savedBase, apiKey: STORED_KEY, models: models || [SAVED_MODEL.id] });
  return { c, S, N, id, savedBase, newBase };
}

test('F1 【复现】编辑态填新Key且地址不同 → 请求发往新地址,带请求里的Key,已保存那台0次', async () => {
  const { c, S, N, id, newBase } = await setup('f1');
  const r = await c.req('POST', TEXT_FETCH, { id, type: 'openai', baseURL: newBase, apiKey: NEW_KEY });
  expect(r.status, r.text).toBe(200);
  expect(N.hits.length, '新地址那台应收到 1 次请求').toBe(1);
  expect(N.hits[0].path).toBe('/v1/models');
  expect(N.hits[0].auth, '新地址那台收到的鉴权头应是请求里的 Key').toBe(`Bearer ${NEW_KEY}`);
  expect(S.hits.length, '已保存那台应收到 0 次请求').toBe(0);
  expect(r.json.models, '返回的模型应是新地址那台的').toEqual([NEW_MODEL.id]);
});

test('F2 【守卫】窗口数据只写进「探测的就是已保存地址」那次拉到的,新地址那台的不写', async () => {
  const { c, S, N, id, savedBase, newBase } = await setup('f2', { models: [SAVED_MODEL.id, NEW_MODEL.id] });
  const file = dataFile(c.home, 'custom-providers.json');
  const windowsNow = () => findById(readJsonFile(file), id)?.modelWindows;
  const before = windowsNow();
  expect(before === undefined || Object.keys(before || {}).length === 0, `前置:预置条目起初不应有窗口数据,实际 ${JSON.stringify(before)}`).toBe(true);

  const r1 = await c.req('POST', TEXT_FETCH, { id, type: 'openai', baseURL: newBase, apiKey: NEW_KEY });
  expect(r1.status, r1.text).toBe(200);
  const r2 = await c.req('POST', TEXT_FETCH, { id, type: 'openai', baseURL: savedBase, apiKey: NEW_KEY });
  expect(r2.status, r2.text).toBe(200);
  expect(S.hits.length, '第二次(地址相同)应发往已保存那台').toBeGreaterThanOrEqual(1);

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && windowsNow()?.[SAVED_MODEL.id] !== SAVED_MODEL.window) await sleep(150);
  expect(windowsNow()?.[SAVED_MODEL.id], '已保存那台的模型窗口数据应落盘').toBe(SAVED_MODEL.window);
  await sleep(1200);   // 再等一下,让可能的错写(新地址那台的数据)有机会露出来
  const final = windowsNow();
  expect(final, 'modelWindows 里不应出现新地址那台的模型').not.toHaveProperty(NEW_MODEL.id);
  expect(Object.values(final), 'modelWindows 里不应出现新地址那台的数值').not.toContain(NEW_MODEL.window);
});

test('F3 【守卫】编辑态Key没填(空串 / 纯空格)、地址=已保存地址+结尾斜杠+首尾空格 → 发往已保存地址,带已保存的Key', async () => {
  const { c, S, N, id, savedBase } = await setup('f3');
  const sloppy = `  ${savedBase}/  `;
  const r1 = await c.req('POST', TEXT_FETCH, { id, type: 'openai', baseURL: sloppy, apiKey: '' });
  expect(r1.status, `Key 为空串:${r1.text}`).toBe(200);
  expect(S.hits.length, '空串那次:已保存那台应收到 1 次').toBe(1);
  expect(S.hits[0].auth).toBe(`Bearer ${STORED_KEY}`);
  const r2 = await c.req('POST', TEXT_FETCH, { id, type: 'openai', baseURL: sloppy, apiKey: '   ' });
  expect(r2.status, `Key 为纯空格:${r2.text}`).toBe(200);
  expect(S.hits.length, '纯空格那次:已保存那台累计应收到 2 次').toBe(2);
  expect(S.hits[1].auth).toBe(`Bearer ${STORED_KEY}`);
  expect(N.hits.length, '新地址那台应 0 次').toBe(0);
});

test('F4a 【复现】编辑态Key没填、地址不同 → 400 + STORED_KEY_URL_MISMATCH + 固定文案,两台都0次', async () => {
  const { c, S, N, id, newBase } = await setup('f4a');
  const r = await c.req('POST', TEXT_FETCH, { id, type: 'openai', baseURL: newBase });
  expect(r.status, r.text).toBe(400);
  expect(r.json).toEqual({ error: MSG, code: 'STORED_KEY_URL_MISMATCH' });
  expect(S.hits.length, '已保存那台应 0 次').toBe(0);
  expect(N.hits.length, '新地址那台应 0 次').toBe(0);
});

test('F4b 【守卫】地址传成数组 / 对象 → 当作没带地址,走已保存地址和已保存的Key', async () => {
  const { c, S, N, id, newBase } = await setup('f4b');
  const r1 = await c.req('POST', TEXT_FETCH, { id, type: 'openai', baseURL: [newBase] });
  expect(r1.status, `数组:${r1.text}`).toBe(200);
  expect(S.hits.length, '数组那次:已保存那台应收到 1 次').toBe(1);
  expect(S.hits[0].auth).toBe(`Bearer ${STORED_KEY}`);
  const r2 = await c.req('POST', TEXT_FETCH, { id, type: 'openai', baseURL: { baseURL: newBase } });
  expect(r2.status, `对象:${r2.text}`).toBe(200);
  expect(S.hits.length, '对象那次:已保存那台累计应收到 2 次').toBe(2);
  expect(S.hits[1].auth).toBe(`Bearer ${STORED_KEY}`);
  expect(N.hits.length, '新地址那台应 0 次').toBe(0);
});

test('F5 【守卫】编辑态Key没填、不带地址 → 发往已保存地址,带已保存的Key', async () => {
  const { c, S, N, id } = await setup('f5');
  const r = await c.req('POST', TEXT_FETCH, { id, type: 'openai' });
  expect(r.status, r.text).toBe(200);
  expect(S.hits.length).toBe(1);
  expect(S.hits[0].path).toBe('/v1/models');
  expect(S.hits[0].auth).toBe(`Bearer ${STORED_KEY}`);
  expect(N.hits.length).toBe(0);
});

test('F6 【守卫】编辑态Key非空、不带地址 → 发往已保存地址,带请求里的Key', async () => {
  const { c, S, N, id } = await setup('f6');
  const r = await c.req('POST', TEXT_FETCH, { id, type: 'openai', apiKey: NEW_KEY });
  expect(r.status, r.text).toBe(200);
  expect(S.hits.length).toBe(1);
  expect(S.hits[0].auth).toBe(`Bearer ${NEW_KEY}`);
  expect(N.hits.length).toBe(0);
});

test('F7 【守卫】新建态(不带id) → 请求里的地址收到请求,带请求里的Key', async () => {
  const { c, S, N, newBase } = await setup('f7');
  const r = await c.req('POST', TEXT_FETCH, { type: 'openai', baseURL: newBase, apiKey: NEW_KEY });
  expect(r.status, r.text).toBe(200);
  expect(N.hits.length).toBe(1);
  expect(N.hits[0].auth).toBe(`Bearer ${NEW_KEY}`);
  expect(S.hits.length).toBe(0);
  expect(r.json.models).toEqual([NEW_MODEL.id]);
});

test('F8a 【复现】已保存那台回显鉴权头并报401;Key没填 → 响应里不含已保存的Key,含 ***', async () => {
  const c = await newCase('f8a');
  const S = await c.upstream({ kind: 'openai', mode: 'echo401', models: [SAVED_MODEL] });
  const savedBase = `${S.url}/v1`;
  const id = await createText(c.inst.base, { type: 'openai', baseURL: savedBase, apiKey: STORED_KEY });
  const r = await c.req('POST', TEXT_FETCH, { id, type: 'openai', baseURL: savedBase });
  expect(S.hits.length, '前置:上游应真的收到过请求(才谈得上回显)').toBeGreaterThanOrEqual(1);
  expect(S.hits[0].auth, '前置:上游收到的是已保存的 Key').toBe(`Bearer ${STORED_KEY}`);
  expect(r.status, r.text).toBe(401);
  expect(r.text, '响应正文不应含已保存的 Key').not.toContain(STORED_KEY);
  expect(r.text, '响应正文里的 Key 应被打码成 ***').toContain('***');
});

test('F8b 【守卫】F1/F3/F4/F5/F6 五种情形的响应正文都不含已保存的Key', async () => {
  const { c, id, savedBase, newBase } = await setup('f8b');
  const scenarios = [
    ['F1', { id, type: 'openai', baseURL: newBase, apiKey: NEW_KEY }],
    ['F3', { id, type: 'openai', baseURL: `  ${savedBase}/  `, apiKey: '' }],
    ['F4', { id, type: 'openai', baseURL: newBase }],
    ['F5', { id, type: 'openai' }],
    ['F6', { id, type: 'openai', apiKey: NEW_KEY }],
  ];
  for (const [name, body] of scenarios) {
    const r = await c.req('POST', TEXT_FETCH, body);
    expect.soft(r.text, `${name} 响应正文不应含已保存的 Key`).not.toContain(STORED_KEY);
  }
});

test('F9 【守卫】带一个不存在的id + 地址 + Key → 按新建态处理:请求里的地址收到1次,200', async () => {
  const { c, S, N, newBase } = await setup('f9');
  const r = await c.req('POST', TEXT_FETCH, { id: 'no-such-provider-r179', type: 'openai', baseURL: newBase, apiKey: NEW_KEY });
  expect(r.status, r.text).toBe(200);
  expect(N.hits.length).toBe(1);
  expect(N.hits[0].auth).toBe(`Bearer ${NEW_KEY}`);
  expect(S.hits.length).toBe(0);
  expect(r.json.models).toEqual([NEW_MODEL.id]);
});

test('F10a 【守卫】已保存协议anthropic、Key没填、请求里type=openai → 按已保存协议:第一次请求带 x-api-key', async () => {
  const { c, S, id, savedBase } = await setup('f10a', { type: 'anthropic' });
  const r = await c.req('POST', TEXT_FETCH, { id, type: 'openai', baseURL: savedBase });
  expect(r.status, r.text).toBe(200);
  expect(S.hits.length, '已保存那台应收到请求').toBeGreaterThanOrEqual(1);
  expect(S.hits[0].xkey, '第一次请求应带 x-api-key=已保存的 Key').toBe(STORED_KEY);
});

test('F10b 【复现】已保存协议anthropic、Key非空、type=openai、地址不同 → 新地址那台只收到 Bearer,没有 x-api-key', async () => {
  const { c, S, N, id, newBase } = await setup('f10b', { type: 'anthropic' });
  const r = await c.req('POST', TEXT_FETCH, { id, type: 'openai', baseURL: newBase, apiKey: NEW_KEY });
  expect(r.status, r.text).toBe(200);
  expect(N.hits.length, '新地址那台应收到 1 次请求').toBe(1);
  expect(N.hits[0].auth, '鉴权头应是 Bearer <请求里的 Key>').toBe(`Bearer ${NEW_KEY}`);
  expect(N.hits.map((h) => h.xkey), '新地址那台收到的请求都不应带 x-api-key').toEqual(['']);
  expect(S.hits.length).toBe(0);
});
