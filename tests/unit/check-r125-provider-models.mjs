#!/usr/bin/env node
// r125 单测:Provider 与模型列表三问题(BRIEF-r125 P1 / P2 / P3)的纯逻辑与服务端降级。
//  ① replaceModelLines:以勾选为准的写回集合(目录内按勾选增删、目录外既有 id 即用户手填的原样保留);
//  ② providerListFetch:同一时刻只一个在途请求(并发调用复用同一 Promise)、最近一次成功结果缓存、
//     失败(非 2xx / 形状不对 / 超时)一律 reject 且不清缓存、invalidate 后重拉;
//  ③ GET /api/providers 逐段降级:cc-switch 库不存在 / 损坏、custom-providers.json 半写 → 仍 200 + 官方行 +
//     非空 warning;全部正常时不带 warning 字段;readCustomProvidersDetailed 的三态;
//  ④ applyProviderModelSelection:有选择只留选择 + 当前模型 + 别名并补上目录外的选择 id;无选择 / 中转 /
//     自定义 provider 原样不动。
// 隔离:HOME/USERPROFILE 指向 mktemp 目录(真实 ~/.claude-gui 一个字节不碰);端口取 OS 临时口(listen(0))。
// Run: node tests/unit/check-r125-provider-models.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'cgui-r125-home-'));
process.env.HOME = HOME; // 必须先于 import:settings.js 的路径常量在模块加载期绑定
process.env.USERPROFILE = HOME;

let n = 0;
const ok = (v, m) => { assert.ok(v, m); n += 1; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); n += 1; };

// ─────────────────── ① replaceModelLines ───────────────────
const { replaceModelLines, mergeModelLines } = await import('../../client/src/utils/modelPick.js');
{
  const catalog = ['old-a', 'old-b', 'new-c', 'new-d', 'zz'];
  eq(replaceModelLines(['old-a', 'old-b'], catalog, ['old-b', 'new-c']), ['old-b', 'new-c'],
    't1【以勾选为准】勾掉的 old-a 移除、新勾的 new-c 加入、仍勾着的 old-b 保留');
  eq(replaceModelLines(['old-a', 'manual-x', 'old-b'], catalog, ['old-b', 'new-c']), ['manual-x', 'old-b', 'new-c'],
    't1【保留手填】不在目录里的 manual-x 原样保留且保持原行序');
  eq(replaceModelLines(['old-a', 'old-b'], catalog, ['manual-y', 'old-a']), ['old-a', 'manual-y'],
    't1: 勾选集里带回的目录外 id(弹窗把 existing 全部初始勾上时会这样)不重复、不丢');
  eq(replaceModelLines(['old-a', 'old-b'], catalog, []), [],
    't1: 全部弃选(且没有手填)→ 空(调用方按"确认按钮 disabled"挡住,这里只保证函数语义)');
  eq(replaceModelLines(['manual-x'], catalog, []), ['manual-x'], 't1: 全部弃选但有手填 → 只剩手填');
  eq(replaceModelLines([' old-a ', '', 'old-b'], catalog, ['old-b', ' new-c ', 'new-c']), ['old-b', 'new-c'],
    't1: 逐条 trim、空行丢弃、勾选集内部去重');
  eq(replaceModelLines(undefined, undefined, undefined), [], 't1: 缺参不炸');
  const existing = ['old-a']; const checked = ['old-a', 'new-c']; const cat = ['old-a', 'new-c'];
  replaceModelLines(existing, cat, checked);
  eq([existing, checked, cat], [['old-a'], ['old-a', 'new-c'], ['old-a', 'new-c']], 't1: 不就地改任何入参数组');
  // 与旧的合并语义对照:merge 绝不删,replace 会删 —— 两者都在,调用方按场景选。
  eq(mergeModelLines(['old-a', 'old-b'], ['new-c']), ['old-a', 'old-b', 'new-c'], 't1: mergeModelLines 仍是只增不减(保留给单测与旧调用方)');
}

// ─────────────────── ② providerListFetch(在途复用 / 缓存 / 失败不清缓存) ───────────────────
{
  const mod = await import('../../client/src/utils/providerListFetch.js');
  const { fetchProviderList, getCachedProviderList, invalidateProviderList, _resetProviderListForTests } = mod;
  let calls = 0;
  let responder = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => { calls += 1; return responder(url, opts); };
  const jsonRes = (status, body, { badJson = false } = {}) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => { if (badJson) throw new Error('bad json'); return body; },
  });
  const GOOD = { providers: [{ id: 'builtin-official', name: 'Claude 官方' }], openaiProviders: [], customProviders: [{ id: 'c1' }], overrides: {} };
  try {
    _resetProviderListForTests();
    // 并发调用 → 一个请求、同一个 Promise
    let release;
    responder = () => new Promise((res) => { release = () => res(jsonRes(200, GOOD)); });
    const p1 = fetchProviderList();
    const p2 = fetchProviderList();
    ok(p1 === p2, 't2【在途复用】并发调用拿到同一个 Promise');
    eq(calls, 1, 't2【在途复用】只发了一个请求');
    eq(getCachedProviderList(), null, 't2: 尚未成功 → 没有缓存');
    release();
    const [d1, d2] = await Promise.all([p1, p2]);
    ok(d1 === d2 && d1.providers[0].id === 'builtin-official', 't2: 两个调用方拿到同一份返回体');
    eq(getCachedProviderList(), GOOD, 't2【缓存】成功后缓存 = 返回体');
    // 完成后再调 → 新请求
    responder = async () => jsonRes(200, GOOD);
    await fetchProviderList();
    eq(calls, 2, 't2: 在途结束后再调会发新请求(不是永久缓存)');
    // 500 {error} → reject,缓存保留
    responder = async () => jsonRes(500, { error: 'r125 桩 500' });
    await assert.rejects(fetchProviderList(), /r125 桩 500/, 't2【失败】500 → reject 且带服务端 error 文案');
    n += 1;
    eq(getCachedProviderList(), GOOD, 't2【失败不清缓存】500 后缓存仍是上一次成功结果');
    // 200 {} → reject(缺 providers 数组)
    responder = async () => jsonRes(200, {});
    await assert.rejects(fetchProviderList(), /providers/, 't2【形状】200 但缺 providers 数组 → reject');
    n += 1;
    eq(getCachedProviderList(), GOOD, 't2【失败不清缓存】形状不对后缓存仍在');
    // 非 JSON 正文 → reject
    responder = async () => jsonRes(200, null, { badJson: true });
    await assert.rejects(fetchProviderList(), /providers/, 't2【形状】非 JSON 正文 → reject');
    n += 1;
    // 超时(AbortError)→ 文案含「超时」
    responder = () => Promise.reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
    await assert.rejects(fetchProviderList(), /超时/, 't2【超时】AbortError 映射成含「超时」的文案');
    n += 1;
    // invalidate:在途期间作废 → 下一次调用发新请求
    calls = 0;
    const releases = []; // 两个在飞的底层请求各自的放行钩子(作废后旧请求仍在飞,必须都放行)
    responder = () => new Promise((res) => { releases.push(() => res(jsonRes(200, GOOD))); });
    const q1 = fetchProviderList();
    invalidateProviderList();
    const q2 = fetchProviderList();
    ok(q1 !== q2, 't2【作废】invalidate 后的调用拿到新 Promise');
    eq(calls, 2, 't2【作废】invalidate 后确实发了新请求');
    eq(releases.length, 2, 't2【作废】两个底层请求都在飞');
    for (const release of releases) release();
    await Promise.all([q1, q2]);
  } finally {
    globalThis.fetch = realFetch;
    _resetProviderListForTests();
  }
}

// ─────────────────── ③ GET /api/providers 逐段降级 + readCustomProvidersDetailed ───────────────────
const express = (await import('express')).default;
const settings = await import('../../server/routes/settings.js');
const settingsRoutes = settings.default;
const { readCustomProvidersDetailed, applyProviderModelSelection } = settings;

const app = express();
app.use(express.json());
app.use('/api', settingsRoutes);
const server = await new Promise((res, rej) => { const s = app.listen(0, '127.0.0.1', () => res(s)); s.once('error', rej); });
const BASE = `http://127.0.0.1:${server.address().port}`;
const get = async (path) => { const r = await fetch(BASE + path); const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {} return { status: r.status, json, text }; };
const GUI_DIR = join(HOME, '.claude-gui');
const CUSTOM = join(GUI_DIR, 'custom-providers.json');
const CC_DB = join(HOME, '.cc-switch', 'cc-switch.db');
mkdirSync(GUI_DIR, { recursive: true });

let failure = null;
try {
  // A. 全新 HOME:没有 cc-switch 库 → 200 + 官方行 + 非空 warning(说明 cc-switch 部分没读到)
  {
    const r = await get('/api/providers');
    eq(r.status, 200, `t3A: 库不存在仍 200(${r.text.slice(0, 120)})`);
    ok((r.json.providers || []).some((p) => p.id === 'builtin-official'), 't3A: providers 含内置官方');
    ok(typeof r.json.warning === 'string' && /cc-switch/.test(r.json.warning), `t3A【warning】说明 cc-switch 没读到:${r.json.warning}`);
    ok(Array.isArray(r.json.customProviders) && Array.isArray(r.json.openaiProviders), 't3A: 两个数组仍是数组');
  }
  // B. cc-switch 库文件损坏 → 200 + warning(损坏 / sqlite3 不可用 二者之一,取决于机器上有没有 sqlite3)
  {
    mkdirSync(join(HOME, '.cc-switch'), { recursive: true });
    writeFileSync(CC_DB, 'THIS IS NOT A SQLITE FILE\n');
    const r = await get('/api/providers');
    eq(r.status, 200, 't3B: 库损坏仍 200(不整体 500)');
    ok((r.json.providers || []).some((p) => p.id === 'builtin-official'), 't3B: 仍含内置官方');
    ok(typeof r.json.warning === 'string' && /(损坏|sqlite3|cc-switch)/.test(r.json.warning), `t3B【warning】损坏原因可读:${r.json.warning}`);
    ok(!/settings_config|apiKey|sk-/.test(r.json.warning), 't3B: warning 里不含配置内容 / 密钥字样');
    unlinkSync(CC_DB);
  }
  // C. custom-providers.json 半写(截断 JSON)→ 200 + 官方行 + customProviders 为空 + warning 点名该文件(不再静默)
  {
    writeFileSync(CUSTOM, '[{"id":"half","name":"半写"');
    const r = await get('/api/providers');
    eq(r.status, 200, 't3C: 半写 json 仍 200');
    ok((r.json.providers || []).some((p) => p.id === 'builtin-official'), 't3C: 仍含内置官方');
    eq(r.json.customProviders, [], 't3C: 自定义段暂时为空(读不到)');
    ok(typeof r.json.warning === 'string' && /custom-providers\.json/.test(r.json.warning), `t3C【不再静默】warning 点名 custom-providers.json:${r.json.warning}`);
    const det = await readCustomProvidersDetailed();
    ok(det.list.length === 0 && /custom-providers\.json/.test(det.warning || ''), 't3C: readCustomProvidersDetailed 回 { list:[], warning }');
  }
  // D. 全部正常(合法 custom-providers.json + 已导入标记 → 不读 cc-switch 库)→ 不带 warning 字段,形状与此前一致
  {
    writeFileSync(CUSTOM, JSON.stringify([{ id: 'c1', name: 'c1', type: 'openai', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'sk-r125-not-real', models: ['m1', 'm2'] }]));
    writeFileSync(join(GUI_DIR, 'ccswitch-imported.flag'), new Date().toISOString());
    const r = await get('/api/providers');
    eq(r.status, 200, 't3D: 正常 200');
    ok(!('warning' in r.json), `t3D【形状不变】全部正常时不带 warning 字段(实际:${JSON.stringify(r.json.warning)})`);
    const c1 = (r.json.customProviders || []).find((p) => p.id === 'c1');
    eq(c1?.models, ['m1', 'm2'], 't3D: 自定义项正常下发');
    ok(!r.text.includes('sk-r125-not-real'), 't3D: 响应里一个字节都不含 apiKey');
    const det = await readCustomProvidersDetailed();
    ok(det.warning === null && det.list.length === 1, 't3D: readCustomProvidersDetailed 正常 → warning null');
    unlinkSync(CUSTOM);
    const gone = await readCustomProvidersDetailed();
    ok(gone.warning === null && gone.list.length === 0, 't3D: 文件不存在 = 正常的空,不算 warning');
  }

  // ─────────────────── ④ applyProviderModelSelection ───────────────────
  const PM = join(GUI_DIR, 'provider-models.json');
  const ACTIVE = join(GUI_DIR, 'active-provider.json');
  const row = (id, source = 'ANTHROPIC_MODEL') => ({ id, name: id, tier: '', context1m: false, source });
  const official = () => ({
    provider: 'Anthropic', current: 'claude-opus-4-6',
    models: [row('claude-opus-4-6'), row('claude-sonnet-4-6', 'ANTHROPIC_DEFAULT_SONNET_MODEL'), row('claude-haiku-4-5', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'), row('sonnet', 'cli-alias'), row('opus', 'cli-alias')],
  });
  const ids = (d) => d.models.map((m) => m.id);
  {
    // 无任何选择 → 原样(同一引用)
    writeFileSync(PM, '{}');
    const d = official();
    ok((await applyProviderModelSelection(d)) === d, 't4: 没有任何选择 → 原样返回(同一引用,逐字不变)');
    // 官方有选择:只留选择 + 当前模型 + 别名,并补上目录外的选择 id
    writeFileSync(PM, JSON.stringify({ 'builtin-official': ['claude-sonnet-4-6', 'r125-new'] }));
    const out = await applyProviderModelSelection(official());
    eq(ids(out), ['claude-opus-4-6', 'claude-sonnet-4-6', 'sonnet', 'opus', 'r125-new'],
      't4【收窄】haiku 被收掉;当前模型 opus 保留;别名保留;选择里 env 没枚举的 r125-new 补成行');
    eq(out.models.find((m) => m.id === 'r125-new').source, 'provider-selection', 't4: 补上的行 source = provider-selection');
    eq(out.selectionKey, 'builtin-official', 't4: 官方的选择键 = builtin-official');
    // 选择里带 [1m] 后缀按裸 id 匹配
    writeFileSync(PM, JSON.stringify({ 'builtin-official': ['claude-sonnet-4-6[1m]'] }));
    ok(ids(await applyProviderModelSelection(official())).includes('claude-sonnet-4-6'), 't4: 选择带 [1m] 也按裸 id 命中 env 行');
    // 中转 provider(provider 名不是 Anthropic、没有 GUI 激活标记)→ 不套官方选择
    writeFileSync(PM, JSON.stringify({ 'builtin-official': ['claude-sonnet-4-6'] }));
    const relay = { provider: 'DeepSeek', current: 'deepseek-chat', models: [row('deepseek-chat'), row('deepseek-reasoner')] };
    eq(ids(await applyProviderModelSelection(relay)), ['deepseek-chat', 'deepseek-reasoner'], 't4: 中转 provider 不受官方选择影响');
    // 导入项(非自定义)按自己的 id 收窄,当前模型保留
    writeFileSync(ACTIVE, JSON.stringify({ id: 'oa1' }));
    writeFileSync(PM, JSON.stringify({ oa1: ['m-keep'] }));
    const oa = { provider: 'Relay', current: 'm-cur', models: [row('m-keep'), row('m-drop'), row('m-cur')] };
    eq(ids(await applyProviderModelSelection(oa)), ['m-keep', 'm-cur'], 't4【导入项】按 id 收窄,当前模型不被挤掉,m-drop 收掉');
    // 自定义 provider 激活:即使存储里有同 id 的陈旧选择也不套(白名单本身就是 available)
    writeFileSync(CUSTOM, JSON.stringify([{ id: 'c1', name: 'c1', type: 'openai', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'sk-r125-not-real', models: ['m1', 'm2'] }]));
    writeFileSync(ACTIVE, JSON.stringify({ id: 'c1' }));
    writeFileSync(PM, JSON.stringify({ c1: ['m1'] }));
    const cust = { provider: 'c1', current: 'm1', models: [row('m1'), row('m2')] };
    eq(ids(await applyProviderModelSelection(cust)), ['m1', 'm2'], 't4【自定义】不套选择存储(陈旧条目不会把白名单收窄)');
    // 存储损坏 → 原样(这条路径只做收窄,绝不让 /api/model 失败)
    writeFileSync(PM, '{not json');
    const d2 = official();
    ok((await applyProviderModelSelection(d2)) === d2, 't4: provider-models.json 损坏 → 原样返回');
  }
} catch (e) {
  failure = e;
} finally {
  server.closeAllConnections?.();
  server.close();
  await new Promise((r) => server.once('close', r));
  rmSync(HOME, { recursive: true, force: true });
}
if (failure) throw failure;

console.log(`✓ check-r125-provider-models: ${n} 条断言通过(replaceModelLines / providerListFetch 在途复用与缓存 / GET providers 逐段降级 warning / applyProviderModelSelection)`);
