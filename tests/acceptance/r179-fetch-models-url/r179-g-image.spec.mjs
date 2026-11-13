// r179 · 生图接口 POST /api/image-providers/fetch-models(行为清单 G1–G9)。
// 只通过 HTTP 接口 + 隔离家目录里的数据文件观察;假上游 S(已保存地址)/ N(新地址),gemini 用例再加假代理 PA(已保存的)/ PB(请求里的)。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { newCase, closeCase } from './helpers/case.mjs';
import { MSG, STORED_KEY, NEW_KEY, IMAGE_FETCH, createImage, newSaveDir, findById, dataFile, readJsonFile } from './helpers/common.mjs';

test.afterEach(async () => { await closeCase(); });

const SAVED_MODEL = 'gpt-image-saved';
const NEW_MODEL = 'gpt-image-new';

/** openai 协议预置:已保存条目贴的是完整接口地址 S/v1/images/generations(保存后应只剩 S/v1)。 */
async function setupOpenai(slug, { protocol = 'openai', pastedSuffix = '/v1/images/generations' } = {}) {
  const c = await newCase(slug);
  const S = await c.upstream({ kind: 'openai', models: [{ id: SAVED_MODEL }] });
  const N = await c.upstream({ kind: 'openai', models: [{ id: NEW_MODEL }] });
  const id = await createImage(c.inst.base, { protocol, baseURL: `${S.url}${pastedSuffix}`, apiKey: STORED_KEY, savePath: newSaveDir(c.home) });
  return { c, S, N, id };
}

/** gemini 协议预置:已保存条目配了代理 PA。 */
async function setupGemini(slug) {
  const c = await newCase(slug);
  const S = await c.upstream({ kind: 'gemini', models: [{ id: 'gemini-3-pro-image-saved' }] });
  const N = await c.upstream({ kind: 'gemini', models: [{ id: 'gemini-3-pro-image-new' }] });
  const PA = await c.proxy();
  const PB = await c.proxy();
  const savedBase = `${S.url}/v1beta`;
  const id = await createImage(c.inst.base, { protocol: 'gemini', baseURL: savedBase, apiKey: STORED_KEY, model: 'gemini-3-pro-image-saved', savePath: newSaveDir(c.home), proxyUrl: PA.url });
  return { c, S, N, PA, PB, id, savedBase, newBase: `${N.url}/v1beta` };
}

test('G1 【复现】编辑态填新Key且地址不同 → 新地址那台收到请求并带请求里的Key,已保存那台0次', async () => {
  const { c, S, N, id } = await setupOpenai('g1');
  const r = await c.req('POST', IMAGE_FETCH, { id, protocol: 'openai', baseURL: `${N.url}/v1`, apiKey: NEW_KEY });
  expect(r.status, r.text).toBe(200);
  expect(r.json.ok).toBe(true);
  expect(r.json.models, '返回的模型应是新地址那台的').toContain(NEW_MODEL);
  expect(N.hits.length, '新地址那台应收到 1 次请求').toBe(1);
  expect(N.allCarry(NEW_KEY), '新地址那台收到的应是请求里的 Key').toBe(true);
  expect(S.hits.length, '已保存那台应 0 次').toBe(0);
});

test('G2 【守卫】已保存地址…/v1(贴的是…/v1/images/generations)、Key没填、请求里仍是…/v1/images/generations/ → 不拒绝,发往已保存地址带已保存Key', async () => {
  const { c, S, N, id } = await setupOpenai('g2');
  const listed = await c.req('GET', '/api/image-providers');
  expect(findById(listed.json, id)?.baseURL, '前置:保存后地址应已被规整为 …/v1').toBe(`${S.url}/v1`);
  const r = await c.req('POST', IMAGE_FETCH, { id, protocol: 'openai', baseURL: `${S.url}/v1/images/generations/` });
  expect(r.status, r.text).toBe(200);
  expect(r.json.ok).toBe(true);
  expect(S.hits.length, '已保存那台应收到 1 次请求').toBe(1);
  expect(S.allCarry(STORED_KEY), '带的应是已保存的 Key').toBe(true);
  expect(N.hits.length).toBe(0);
});

test('G2b 【守卫】已保存的值本身带结尾斜杠(直接改数据文件预置)、Key没填、地址原样带回 → 不拒绝,发往已保存地址', async () => {
  const { c, S, id } = await setupOpenai('g2b');
  await c.inst.stop();
  const file = dataFile(c.home, 'image-providers.json');
  const data = readJsonFile(file);
  const entry = findById(data, id);
  expect(entry, '前置:数据文件里应能按 id 找到这一条').toBeTruthy();
  entry.baseURL = `${entry.baseURL}/`;
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  const inst2 = await c.restart();
  const r = await (await fetch(`${inst2.base}${IMAGE_FETCH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, protocol: 'openai', baseURL: entry.baseURL }) })).json();
  expect(r.ok, JSON.stringify(r)).toBe(true);
  expect(S.hits.length, '已保存那台应收到 1 次请求').toBe(1);
  expect(S.allCarry(STORED_KEY), '带的应是已保存的 Key').toBe(true);
});

test('G2c 【守卫】mj-proxy 条目(贴的地址带 /mj)、Key没填、请求里仍带 /mj → 不拒绝,发往已保存地址', async () => {
  const { c, S, id } = await setupOpenai('g2c', { protocol: 'mj-proxy', pastedSuffix: '/mj' });
  const r = await c.req('POST', IMAGE_FETCH, { id, protocol: 'mj-proxy', baseURL: `${S.url}/mj` });
  expect(r.status, r.text).toBe(200);
  expect(r.json.ok).toBe(true);
  expect(S.hits.length, '已保存那台应收到请求').toBeGreaterThanOrEqual(1);
  expect(S.sawKey(STORED_KEY), '带的应是已保存的 Key').toBe(true);
});

test('G3 【复现】编辑态Key没填、地址不同 → 400 + needs_key + 固定文案,两台都0次,正文不含已保存Key', async () => {
  const { c, S, N, id } = await setupOpenai('g3');
  const r = await c.req('POST', IMAGE_FETCH, { id, protocol: 'openai', baseURL: `${N.url}/v1` });
  expect(r.status, r.text).toBe(400);
  expect(r.json).toEqual({ ok: false, type: 'needs_key', message: MSG });
  expect(S.hits.length, '已保存那台应 0 次').toBe(0);
  expect(N.hits.length, '新地址那台应 0 次').toBe(0);
  expect(r.text).not.toContain(STORED_KEY);
});

test('G5 【守卫】编辑态Key非空、不带地址 → 发往已保存地址,带请求里的Key', async () => {
  const { c, S, N, id } = await setupOpenai('g5');
  const r = await c.req('POST', IMAGE_FETCH, { id, apiKey: NEW_KEY });
  expect(r.status, r.text).toBe(200);
  expect(S.hits.length, '已保存那台应收到 1 次请求').toBe(1);
  expect(S.allCarry(NEW_KEY), '带的应是请求里的 Key').toBe(true);
  expect(N.hits.length).toBe(0);
});

test('G6a 【复现】gemini 编辑态填新Key + 新地址 + 新代理 → 请求经新代理到达新地址', async () => {
  const { c, S, N, PA, PB, id, newBase } = await setupGemini('g6a');
  const r = await c.req('POST', IMAGE_FETCH, { id, protocol: 'gemini', baseURL: newBase, apiKey: NEW_KEY, proxyUrl: PB.url });
  expect(r.status, r.text).toBe(200);
  expect(r.json.ok).toBe(true);
  expect(PB.reached(N), `新代理应记到 CONNECT 新地址那台,实际记录 ${JSON.stringify(PB.targets)}`).toBe(true);
  expect(N.sawKey(NEW_KEY), '新地址那台应收到请求里的 Key').toBe(true);
  expect(PA.targets, '已保存的代理应 0 次').toEqual([]);
  expect(S.hits.length, '已保存那台应 0 次').toBe(0);
});

test('G6b 【复现】gemini 编辑态代理地址带账号密码 → 400 unsupported,message 与新建态同样非法代理那句相同,上游与代理都0次', async () => {
  const { c, S, N, PA, PB, id, newBase } = await setupGemini('g6b');
  const badProxy = `http://user:secret@127.0.0.1:${PB.port}`;
  const fresh = await c.req('POST', IMAGE_FETCH, { protocol: 'gemini', baseURL: newBase, apiKey: NEW_KEY, proxyUrl: badProxy });
  expect(fresh.status, `新建态基准:${fresh.text}`).toBe(400);
  expect(fresh.json.type).toBe('unsupported');
  expect(typeof fresh.json.message).toBe('string');
  expect(fresh.json.message.length).toBeGreaterThan(0);
  const edit = await c.req('POST', IMAGE_FETCH, { id, protocol: 'gemini', baseURL: newBase, apiKey: NEW_KEY, proxyUrl: badProxy });
  expect(edit.status, edit.text).toBe(400);
  expect(edit.json.ok).toBe(false);
  expect(edit.json.type).toBe('unsupported');
  expect(edit.json.message, '编辑态的 message 应与新建态那句相同').toBe(fresh.json.message);
  expect(S.hits.length + N.hits.length, '两台上游都应 0 次').toBe(0);
  expect(PA.targets.length + PB.targets.length, '两个代理都应 0 次').toBe(0);
});

test('G7 【守卫】gemini 编辑态Key没填、地址没改、请求里带了另一个代理 → 仍经已保存的代理,请求里那个代理0次', async () => {
  const { c, S, PA, PB, id, savedBase } = await setupGemini('g7');
  const r = await c.req('POST', IMAGE_FETCH, { id, protocol: 'gemini', baseURL: savedBase, proxyUrl: PB.url });
  expect(r.status, r.text).toBe(200);
  expect(r.json.ok).toBe(true);
  expect(PA.reached(S), `已保存的代理应记到 CONNECT 已保存那台,实际记录 ${JSON.stringify(PA.targets)}`).toBe(true);
  expect(S.sawKey(STORED_KEY), '已保存那台应收到已保存的 Key').toBe(true);
  expect(PB.targets, '请求里那个代理应 0 次').toEqual([]);
});

test('G9 【复现】openai 协议、地址是「新地址+/v1/images/generations」:编辑态(Key非空)与新建态都应请求 /v1/models', async () => {
  const { c, N, id } = await setupOpenai('g9');
  const pasted = `${N.url}/v1/images/generations`;
  const edit = await c.req('POST', IMAGE_FETCH, { id, protocol: 'openai', baseURL: pasted, apiKey: NEW_KEY });
  expect.soft(N.hits.map((h) => h.path), `编辑态收到的路径(响应 ${edit.text})`).toEqual(['/v1/models']);
  N.reset();
  const fresh = await c.req('POST', IMAGE_FETCH, { protocol: 'openai', baseURL: pasted, apiKey: NEW_KEY });
  expect.soft(N.hits.map((h) => h.path), `新建态收到的路径(响应 ${fresh.text})`).toEqual(['/v1/models']);
});
