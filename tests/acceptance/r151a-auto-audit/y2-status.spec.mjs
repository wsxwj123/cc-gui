// B 组:GET /api/auto-audit/status(INTERFACE Y.3.1)。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import {
  get, wsCollector, useProvider, useOfficial, useUnknownProvider, tpAutoOn, tpAutoOff, resetOverrides, settingsEnv, readText,
  snapshot, expectUnchanged, PREFS, OVERRIDES, SETTINGS, ACTIVE_PROVIDER, OFFICIAL_ID,
} from './helpers/api.mjs';
import { CUSTOM_PROVIDERS } from './helpers/fixtures.mjs';
import { provider, PROVIDERS } from './helpers/scenes.mjs';

const S = '/api/auto-audit/status';
const sorted = (a) => [...a].sort();
let saved = {};

test.beforeEach(async () => {
  saved = snapshot([SETTINGS(), OVERRIDES()]);
  await tpAutoOff();
  resetOverrides({});
});
test.afterEach(async () => {
  // 还原被用例写坏的文件
  for (const [p, c] of Object.entries(saved)) { if (c === null) { try { fs.rmSync(p); } catch { /* */ } } else fs.writeFileSync(p, c); }
});

function expectShape(body) {
  expect(body, '应答应是对象').not.toBeNull();
  expect(typeof body.official).toBe('boolean');
  expect(typeof body.enabled).toBe('boolean');
  expect(body.providerId === null || typeof body.providerId === 'string').toBe(true);
  expect(body.auditModel === null || typeof body.auditModel === 'string').toBe(true);
  expect([null, 'tier', 'default']).toContain(body.auditModelSource);
  expect(Array.isArray(body.models)).toBe(true);
  expect(Array.isArray(body.unusable)).toBe(true);
}

test('B1 官方 provider:official:true、auditModel:null、auditModelSource:null', async () => {
  await useOfficial();
  const r = await get(S);
  expect(r.status, r.text).toBe(200);
  expectShape(r.body);
  expect(r.body.official).toBe(true);
  expect(r.body.auditModel).toBeNull();
  expect(r.body.auditModelSource).toBeNull();
});

test('B1b 官方 provider:providerId 是内置官方 provider 的 id', async () => {
  await useOfficial();
  const r = await get(S);
  expect(r.status, r.text).toBe(200);
  expect(r.body.providerId).toBe(OFFICIAL_ID);
});

test('B2 第三方且显式设了 sonnet 档:auditModel = settings.json 的 ANTHROPIC_DEFAULT_SONNET_MODEL,auditModelSource:"tier"', async () => {
  const id = await provider('sonnet');
  await useProvider(id);
  const want = settingsEnv().ANTHROPIC_DEFAULT_SONNET_MODEL;
  expect(want, '前置:切换后 settings.json 应写出 sonnet 档').toBe('r151-reasoner');
  const r = await get(S);
  expect(r.status, r.text).toBe(200);
  expectShape(r.body);
  expect(r.body).toMatchObject({ official: false, providerId: id, auditModel: want, auditModelSource: 'tier' });
});

test('B2b 第三方:models 等于该 provider 的模型列表,unusable 为空', async () => {
  const id = await provider('main');
  await useProvider(id);
  const r = await get(S);
  expect(r.status, r.text).toBe(200);
  expect(sorted(r.body.models)).toEqual(sorted(PROVIDERS.main.models));
  expect(r.body.unusable).toEqual([]);
});

test('B3 第三方且没设 sonnet 档:auditModel = 默认模型(settings.json 里回退出来的值),auditModelSource:"default"', async () => {
  const id = await provider('main');
  await useProvider(id);
  const want = settingsEnv().ANTHROPIC_DEFAULT_SONNET_MODEL;
  expect(want, '前置:没设 sonnet 档时 settings.json 里回退为默认模型').toBe('r151-chat');
  const r = await get(S);
  expect(r.status, r.text).toBe(200);
  expect(r.body).toMatchObject({ official: false, providerId: id, auditModel: 'r151-chat', auditModelSource: 'default' });
});

test('B4 第三方、settings.json 里没有 ANTHROPIC_DEFAULT_SONNET_MODEL:auditModel 与 auditModelSource 都是 null', async () => {
  const id = await provider('nodef');
  await useProvider(id);
  expect(settingsEnv().ANTHROPIC_DEFAULT_SONNET_MODEL, '前置:没有默认模型也没有档位时不写 sonnet 档').toBeUndefined();
  const r = await get(S);
  expect(r.status, r.text).toBe(200);
  expect(r.body).toMatchObject({ official: false, providerId: id, auditModel: null, auditModelSource: null });
});

test('B5 认不出当前 provider:providerId:null、models:[],official:false', async () => {
  useUnknownProvider();
  const r = await get(S);
  expect(r.status, r.text).toBe(200);
  expectShape(r.body);
  expect(r.body.official).toBe(false);
  expect(r.body.providerId).toBeNull();
  expect(r.body.models).toEqual([]);
});

test('B6 enabled 跟随总开关:打开后 status.enabled 为 true', async () => {
  const id = await provider('main');
  await useProvider(id);
  await tpAutoOn();
  const r = await get(S);
  expect(r.status, r.text).toBe(200);
  expect(r.body.enabled).toBe(true);
});

test('B6b enabled 跟随总开关:关着时 status.enabled 为 false', async () => {
  const id = await provider('main');
  await useProvider(id);
  const r = await get(S);
  expect(r.status, r.text).toBe(200);
  expect(r.body.enabled).toBe(false);
});

test('B7 unusable:列出 models 里转小写后等于或以 claude-sonnet-5-5 / claude-opus-5-5 开头的名字(大小写不敏感),近似名不算', async () => {
  const id = await provider('claude');
  await useProvider(id);
  const r = await get(S);
  expect(r.status, r.text).toBe(200);
  expect(sorted(r.body.unusable)).toEqual(sorted(['claude-sonnet-5-5', 'Claude-Opus-5-5-20261101']));
  for (const ok of ['claude-sonnet-5', 'claude-sonnet-4-6', 'r151-chat']) expect(r.body.unusable).not.toContain(ok);
});

test('B8 只读:调用前后 settings.json / provider-overrides.json / prefs.json / 自定义 provider / 当前 provider 记录都不变', async () => {
  const id = await provider('main');
  await useProvider(id);
  const before = snapshot([SETTINGS(), OVERRIDES(), PREFS(), CUSTOM_PROVIDERS(), ACTIVE_PROVIDER()]);
  const r = await get(S);
  expect(r.status, r.text).toBe(200);
  await get(S);
  expectUnchanged(before, 'GET status');
});

test('B9 settings.json 损坏:仍回 200,按"认不出"降级(providerId:null、models:[])', async () => {
  const id = await provider('main');
  await useProvider(id);
  fs.writeFileSync(SETTINGS(), '{ "env": { "ANTHROPIC_BASE_URL": <<损坏>> ');
  const r = await get(S);
  expect(r.status, r.text).toBe(200);
  expect(r.body.providerId).toBeNull();
  expect(r.body.models).toEqual([]);
});

test('B10 provider-overrides.json 损坏:仍回 200 且字段齐全(不回 5xx)', async () => {
  const id = await provider('main');
  await useProvider(id);
  fs.writeFileSync(OVERRIDES(), '{ "x": [[[ 损坏 ');
  const r = await get(S);
  expect(r.status, r.text).toBe(200);
  expectShape(r.body);
});

test('B11 当前 provider 的模型列表取不到(上游 500、配置为空):仍回 200,models:[]', async () => {
  const id = await provider('down');
  await useProvider(id);
  const r = await get(S);
  expect(r.status, r.text).toBe(200);
  expectShape(r.body);
  expect(r.body.models).toEqual([]);
});

test('B13 切换 provider 后广播一次 {type:"auto-audit", status},status 指向新 provider', async () => {
  const a = await provider('main');
  const b = await provider('other');
  await useProvider(a);
  const ws = await wsCollector();
  try {
    await useProvider(b);
    const msg = await ws.waitFor((m) => m.type === 'auto-audit', 6_000);
    expect(msg, '切换 provider 后应收到 auto-audit 广播').not.toBeNull();
    expect(msg.status.providerId).toBe(b);
    expect(msg.status.official).toBe(false);
  } finally { ws.close(); }
});

test('B12 读取不改写损坏的 settings.json(只读接口)', async () => {
  const broken = '{ "env": { 损坏';
  fs.writeFileSync(SETTINGS(), broken);
  await get(S);
  expect(readText(SETTINGS())).toBe(broken);
});
