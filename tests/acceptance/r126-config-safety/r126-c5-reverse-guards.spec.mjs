// r126 · 反向守卫:文件不存在(首次使用)照旧(INTERFACE C5)+ 文件正常时读写结果与今天逐字一致(BRIEF Q5「既有行为零回归」)。
// 依据只有 .devflow/BRIEF-r126.md 与 .devflow/INTERFACE-r126.md;没看实现代码。
//   金样(G 组)= 2026-09-21 在修改前的代码上黑盒实测抓下来的落盘原样字节 / 接口返回形状(随机 id、保存路径用占位替换)。
//   这组今天就该全绿;修完之后仍须全绿 —— 任何一条变红就是回归(格式、字段、缩进、末尾换行都算)。
//   全部是接口用例:每条自起一个全新 HOME 的隔离实例。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { caseRoot, startInstance, stopAll } from './helpers/instance.mjs';
import { getProviders, getProviderModels, createCustomProvider, customBody, postCustom, putCustom, deleteCustom, putProviderModels, createImageProvider, newSaveDir, switchProvider, warningsOf, FAKE_KEY } from './helpers/api.mjs';
import { listAnyBackups } from './helpers/corrupt.mjs';
import { cfgPath } from './helpers/fixtures.mjs';

const short = (v) => JSON.stringify(v ?? null).slice(0, 300);
const textOf = (p) => fs.readFileSync(p, 'utf8');

// ═══════════════════════════ C5 文件不存在(首次使用)照旧 ═══════════════════════════
test.describe('C5 文件不存在照旧', () => {
  test.afterEach(async () => { await stopAll(); });

  test('C5-1 全新 HOME:GET /api/providers 200,warnings 不含 config-corrupt(缺文件不算损坏)', async () => {
    const h = await startInstance(caseRoot('c5-1-fresh-get'), {}, { label: 'c5-1' });
    const r = await getProviders(h.base);
    console.log(`[r126] C5-1 status=${r.status} warnings=${short(r.json?.warnings)}`);
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    expect(warningsOf(r.json, 'config-corrupt'), '文件不存在不该报 config-corrupt').toEqual([]);
  });

  test('C5-2 全新 HOME:POST /api/custom-providers 200 并创建 custom-providers.json,内容含新 provider', async () => {
    const h = await startInstance(caseRoot('c5-2-fresh-post'), {}, { label: 'c5-2' });
    const p = cfgPath(h.home, 'custom');
    expect(fs.existsSync(p), '前提:全新 HOME 里没有 custom-providers.json').toBe(false);
    const r = await postCustom(h.base, customBody({ name: 'r126 C5-2 首次' }));
    console.log(`[r126] C5-2 status=${r.status} body=${r.text.slice(0, 160)}`);
    expect(r.status, `首次使用 POST 应成功,实际 ${r.status} ${r.text.slice(0, 120)}`).toBe(200);
    expect(fs.existsSync(p), 'POST 后文件应被创建').toBe(true);
    expect(JSON.parse(textOf(p)).map((x) => x.id), '文件里应有新 provider').toContain(r.json?.id ?? r.json?.provider?.id);
  });

  test('C5-3 全新 HOME:PUT /api/provider-models/:id 200 并创建 provider-models.json', async () => {
    const h = await startInstance(caseRoot('c5-3-fresh-models'), {}, { label: 'c5-3' });
    const c = await createCustomProvider(h.base, { name: 'r126 C5-3' });
    const p = cfgPath(h.home, 'models');
    expect(fs.existsSync(p), '前提:还没有 provider-models.json').toBe(false);
    const r = await putProviderModels(h.base, c.id, ['r126-m1']);
    expect(r.status, `实际 ${r.status} ${r.text.slice(0, 120)}`).toBe(200);
    expect(fs.existsSync(p)).toBe(true);
    expect(JSON.parse(textOf(p))[c.id]).toEqual(['r126-m1']);
  });

  test('C5-4 全新 HOME:POST /api/image-providers 200 并创建 image-providers.json', async () => {
    const h = await startInstance(caseRoot('c5-4-fresh-image'), {}, { label: 'c5-4' });
    const p = cfgPath(h.home, 'image');
    expect(fs.existsSync(p), '前提:还没有 image-providers.json').toBe(false);
    const ip = await createImageProvider(h.base, h.home, { name: 'r126 C5-4' });
    expect(fs.existsSync(p)).toBe(true);
    expect(JSON.parse(textOf(p)).map((x) => x.id)).toContain(ip.id);
  });

  test('C5-5 全新 HOME:切换 provider 200 并创建 active-provider.json', async () => {
    const h = await startInstance(caseRoot('c5-5-fresh-switch'), {}, { label: 'c5-5' });
    const c = await createCustomProvider(h.base, { name: 'r126 C5-5' });
    const p = cfgPath(h.home, 'active');
    expect(fs.existsSync(p), '前提:还没有 active-provider.json').toBe(false);
    const r = await switchProvider(h.base, { id: c.id, model: 'r126-m1' });
    console.log(`[r126] C5-5 ${r.path} status=${r.status} body=${r.text.slice(0, 160)}`);
    expect(r.status, `实际 ${r.status} ${r.text.slice(0, 120)}`).toBe(200);
    expect(fs.existsSync(p)).toBe(true);
    expect(JSON.parse(textOf(p)).id).toBe(c.id);
  });

  test('C5-6 全新 HOME:一轮正常读写之后目录里没有任何 *.corrupt-* 备份,GET 仍不带 config-corrupt', async () => {
    const h = await startInstance(caseRoot('c5-6-no-backups'), {}, { label: 'c5-6' });
    const c = await createCustomProvider(h.base, { name: 'r126 C5-6' });
    await putProviderModels(h.base, c.id, ['r126-m1']);
    await createImageProvider(h.base, h.home, { name: 'r126 C5-6 img' });
    await switchProvider(h.base, { id: c.id, model: 'r126-m1' });
    const r = await getProviders(h.base);
    expect(listAnyBackups(h.home), '正常使用不该产生备份文件').toEqual([]);
    expect(warningsOf(r.json, 'config-corrupt')).toEqual([]);
  });
});

// ═══════════════════════════ G 文件正常时读写逐字不变(金样) ═══════════════════════════
test.describe('G 正常文件读写金样', () => {
  test.afterEach(async () => { await stopAll(); });

  /** custom-providers.json 落盘金样(2 空格缩进、字段顺序 id/name/type/baseURL/apiKey/models、末尾无换行)。 */
  const goldenCustom = (entries) => `[\n${entries.map(({ id, name, models }) => `  {\n    "id": "${id}",\n    "name": "${name}",\n    "type": "openai",\n    "baseURL": "http://127.0.0.1:9/v1",\n    "apiKey": "${FAKE_KEY}",\n    "models": [\n${models.map((m) => `      "${m}"`).join(',\n')}\n    ]\n  }`).join(',\n')}\n]`;
  /** image-providers.json 落盘金样(建项时的默认字段与顺序)。 */
  const goldenImage = (id, name, savePath) => `[\n  {\n    "id": "${id}",\n    "i2iMode": "edits",\n    "mjVersion": "",\n    "mjSpeed": "",\n    "mjParams": {},\n    "mjRefMode": "",\n    "dialect": "openai",\n    "resolution": "",\n    "quality": "",\n    "outputFormat": "",\n    "background": "",\n    "moderation": "",\n    "n": "",\n    "nsfwCheck": false,\n    "name": "${name}",\n    "protocol": "openai",\n    "baseURL": "http://127.0.0.1:9/v1",\n    "model": "r126-img-a",\n    "size": "1024x1024",\n    "savePath": ${JSON.stringify(savePath)},\n    "extra": null,\n    "models": [\n      "r126-img-a",\n      "r126-img-b"\n    ],\n    "apiKey": "${FAKE_KEY}"\n  }\n]`;

  test('G-1 POST 一个自定义 provider 后,custom-providers.json 原样字节 = 金样', async () => {
    const h = await startInstance(caseRoot('g-1-post'), {}, { label: 'g-1' });
    const c = await createCustomProvider(h.base, { name: 'r126 golden' });
    expect(textOf(cfgPath(h.home, 'custom'))).toBe(goldenCustom([{ id: c.id, name: 'r126 golden', models: ['r126-m1', 'r126-m2'] }]));
  });

  test('G-2 PUT(改名 + 改模型)后,custom-providers.json 原样字节 = 金样', async () => {
    const h = await startInstance(caseRoot('g-2-put'), {}, { label: 'g-2' });
    const c = await createCustomProvider(h.base, { name: 'r126 golden' });
    const r = await putCustom(h.base, c.id, customBody({ name: 'r126 golden 改', models: ['r126-m1', 'r126-m9'] }));
    expect(r.status, `前提:PUT 成功,实际 ${r.status} ${r.text.slice(0, 120)}`).toBe(200);
    expect(textOf(cfgPath(h.home, 'custom'))).toBe(goldenCustom([{ id: c.id, name: 'r126 golden 改', models: ['r126-m1', 'r126-m9'] }]));
  });

  test('G-3 建 2 条、删第 2 条后,custom-providers.json 原样字节 = 只剩第 1 条的金样', async () => {
    const h = await startInstance(caseRoot('g-3-delete'), {}, { label: 'g-3' });
    const c1 = await createCustomProvider(h.base, { name: 'r126 golden' });
    const c2 = await createCustomProvider(h.base, { name: 'r126 second' });
    expect(textOf(cfgPath(h.home, 'custom')), '前提:两条都在').toBe(goldenCustom([{ id: c1.id, name: 'r126 golden', models: ['r126-m1', 'r126-m2'] }, { id: c2.id, name: 'r126 second', models: ['r126-m1', 'r126-m2'] }]));
    const r = await deleteCustom(h.base, c2.id);
    expect(r.status, `前提:DELETE 成功,实际 ${r.status}`).toBe(200);
    expect(textOf(cfgPath(h.home, 'custom'))).toBe(goldenCustom([{ id: c1.id, name: 'r126 golden', models: ['r126-m1', 'r126-m2'] }]));
  });

  test('G-4 PUT provider-models 后,provider-models.json 原样字节 = 金样', async () => {
    const h = await startInstance(caseRoot('g-4-models'), {}, { label: 'g-4' });
    const c = await createCustomProvider(h.base, { name: 'r126 golden' });
    const r = await putProviderModels(h.base, c.id, ['r126-m1', 'r126-m3']);
    expect(r.status, `前提:PUT 成功,实际 ${r.status}`).toBe(200);
    expect(textOf(cfgPath(h.home, 'models'))).toBe(`{\n  "${c.id}": [\n    "r126-m1",\n    "r126-m3"\n  ]\n}`);
  });

  test('G-5 切换到自定义 provider 后,active-provider.json 原样字节 = {"id":"<id>"}', async () => {
    const h = await startInstance(caseRoot('g-5-active'), {}, { label: 'g-5' });
    const c = await createCustomProvider(h.base, { name: 'r126 golden' });
    const r = await switchProvider(h.base, { id: c.id, model: 'r126-m1' });
    expect(r.status, `前提:切换成功(${r.path}),实际 ${r.status} ${r.text.slice(0, 120)}`).toBe(200);
    expect(textOf(cfgPath(h.home, 'active'))).toBe(`{"id":"${c.id}"}`);
  });

  test('G-6 POST 一个生图 provider 后,image-providers.json 原样字节 = 金样', async () => {
    const h = await startInstance(caseRoot('g-6-image'), {}, { label: 'g-6' });
    const savePath = newSaveDir(h.home, 'golden');
    const ip = await createImageProvider(h.base, h.home, { name: 'r126 golden img', savePath });
    expect(textOf(cfgPath(h.home, 'image'))).toBe(goldenImage(ip.id, 'r126 golden img', savePath));
  });

  test('G-7 GET /api/providers 里自定义 provider 条目的形状 = 今天的形状(字段与值逐个相等,不泄露 apiKey)', async () => {
    const h = await startInstance(caseRoot('g-7-read'), {}, { label: 'g-7' });
    const c = await createCustomProvider(h.base, { name: 'r126 golden' });
    const r = await getProviders(h.base);
    const entry = (r.json?.customProviders ?? []).find((x) => x.id === c.id);
    expect(entry).toEqual({
      id: c.id, name: 'r126 golden', type: 'openai', baseURL: 'http://127.0.0.1:9/v1', models: ['r126-m1', 'r126-m2'],
      defaultModel: '', tierModels: null, contextWindow: null, modelPrices: null, modelMeta: null,
      avatar: '', quotaURL: '', quotaPath: '', quotaAuth: 'bearer', quotaCurrency: '',
      hasKey: true, hasQuotaKey: false, isCustom: true, isCurrent: false,
    });
    expect(r.text.includes(FAKE_KEY), '返回体不该带明文 apiKey').toBe(false);
  });

  test('G-8 GET /api/provider-models 返回 { selections: { <id>: [...] } }(读路径形状不变)', async () => {
    const h = await startInstance(caseRoot('g-8-read-models'), {}, { label: 'g-8' });
    const c = await createCustomProvider(h.base, { name: 'r126 golden' });
    await putProviderModels(h.base, c.id, ['r126-m1', 'r126-m3']);
    const r = await getProviderModels(h.base);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ selections: { [c.id]: ['r126-m1', 'r126-m3'] } });
  });
});
