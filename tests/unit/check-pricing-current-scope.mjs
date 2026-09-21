#!/usr/bin/env node
// 「刷新价格默认只刷当前 provider」(POST /api/pricing/refresh {scope:'current'})的范围判定单测。
// 隔离 HOME(mkdtemp),不联网、不碰真实 ~/.claude-gui。
// Run: node tests/unit/check-pricing-current-scope.mjs
//
// 覆盖:
//  ① baseURL → 预设 id:同 host 的多条预设一起给(共用一条采集器),不在预设表里给 null;
//  ② 当前 provider 的三处身份来源与优先级(自建 provider → 回环代理 marker → settings BASE_URL);
//  ③ marker 只在 settings 仍指向回环代理时可信(终端 cc switch 切走后不许拿旧 marker 认家);
//  ④ 三处都没有 BASE_URL = 官方 Anthropic;
//  ⑤ 判不出身份时 POST 400 PRICING_CURRENT_UNRESOLVED —— 不回落全预设、也不拿空数组去撞 400;
//  ⑥ scope:'current' 的刷新范围就是判出来的那几家,别家一条都不进这次刷新;
//  ⑦ 合同语义不回归:省略 presetIds/空数组/未知 id 的 400 判定原样。
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

let n = 0;
const ok = (value, message) => { assert.ok(value, message); n += 1; };

const home = await mkdtemp(join(tmpdir(), 'cgui-scope-'));
process.env.HOME = home;         // 必须先于 import:路径常量在模块加载期绑定
process.env.USERPROFILE = home;  // Windows 上 homedir() 读 %USERPROFILE%,不同设沙箱失效

const { PARSER_VERSION, COLLECTORS } = await import('../../server/services/pricing-sources.js');
const pricingModule = await import('../../server/routes/pricing.js');
const { presetIdsForBaseURL, resolveCurrentPriceScope } = pricingModule;
const express = (await import('express')).default;

const GUI = join(home, '.claude-gui');
const SETTINGS = join(home, '.claude', 'settings.json');
const writeJson = async (path, value) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
};
const drop = (path) => unlink(path).catch(() => {});

// 预置「所有采集器都是新鲜的」磁盘快照:GET /api/pricing 的 warmupIfStale() 据此认为无事可做,
// 整条单测因此零网络请求(否则它会真的去抓 17 个官方源)。
const fresh = new Date().toISOString();
await writeJson(join(GUI, 'pricing-catalog.json'), {
  version: 1,
  snapshots: Object.values(COLLECTORS).map((collector) => ({
    collectorId: collector.id, presetIds: collector.presetIds, status: 'fresh', errorCode: null,
    attemptedAt: fresh, fetchedAt: fresh, parserVersion: PARSER_VERSION, rawQuotes: [],
    modelCount: 0, unresolvedModels: [],
  })),
});

const resetIdentity = async () => {
  await drop(join(GUI, 'custom-providers.json'));
  await drop(join(GUI, 'active-provider.json'));
  await drop(join(GUI, 'anthropic-active.json'));
  await drop(SETTINGS);
};

// ── ① baseURL → 预设 id ──────────────────────────────────────────────────
assert.deepEqual(presetIdsForBaseURL('https://api.deepseek.com/anthropic'),
  ['deepseek-official', 'deepseek-anthropic'], 'deepseek 的两条协议入口同 host,必须一起给(同一次抓取)');
assert.deepEqual(presetIdsForBaseURL('https://api.deepseek.com'), ['deepseek-official', 'deepseek-anthropic'], '同家另一条 path 也是同一批');
assert.deepEqual(presetIdsForBaseURL('https://api.kimi.com/coding/v1'), ['kimi-code', 'kimi-code-anthropic'], 'Kimi Code 两条都算');
ok(presetIdsForBaseURL('https://ai.snaptokenflow.com/v1') === null, '不在 43 家预设里的自建/中转地址必须给 null(判不出身份)');
ok(presetIdsForBaseURL('') === null, '空 baseURL 给 null');
ok(presetIdsForBaseURL('not a url') === null, '非法 URL 给 null,不抛');
n += 3;

// ── ② 自建 provider 优先 ─────────────────────────────────────────────────
const DEEPSEEK = { id: 'p-ds', name: 'DeepSeek', type: 'anthropic', baseURL: 'https://api.deepseek.com/anthropic', models: ['deepseek-chat'] };
await resetIdentity();
await writeJson(join(GUI, 'custom-providers.json'), [DEEPSEEK]);
await writeJson(join(GUI, 'active-provider.json'), { id: 'p-ds' });
await writeJson(SETTINGS, { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8799' } }); // 回环代理:前端拿到它也匹配不上预设
let scope = await resolveCurrentPriceScope();
ok(scope.resolved, '自建 provider 能判出身份');
assert.deepEqual(scope.presetIds, ['deepseek-official', 'deepseek-anthropic'], '范围 = 该家全部预设,不是全部 43 家');
assert.equal(scope.label, 'DeepSeek', '范围行要显示人话名字');

// ── ③ 回环代理 + marker(走中转时 settings 里是回环地址,真实上游在 marker 里)──────
await resetIdentity();
await writeJson(SETTINGS, { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8799' } });
await writeJson(join(GUI, 'anthropic-active.json'), { providerId: 'cc-ds', name: 'DeepSeek 中转', baseURL: 'https://api.deepseek.com/anthropic' });
scope = await resolveCurrentPriceScope();
assert.deepEqual(scope.presetIds, ['deepseek-official', 'deepseek-anthropic'], '回环代理下用 marker 里的真实上游');
assert.equal(scope.label, 'DeepSeek 中转');

// 终端 cc switch 切走后 settings 不再是回环 + marker 仍是旧的:不许拿旧 marker 认家。
await writeJson(SETTINGS, { env: { ANTHROPIC_BASE_URL: 'https://api.kimi.com/coding' } });
scope = await resolveCurrentPriceScope();
assert.deepEqual(scope.presetIds, ['kimi-code', 'kimi-code-anthropic'], 'settings 已直连他处时,旧 marker 不得再代表当前 provider');

// ── ④ 没有 BASE_URL = 官方 Anthropic ────────────────────────────────────
await resetIdentity();
await writeJson(SETTINGS, { env: {} });
scope = await resolveCurrentPriceScope();
ok(scope.resolved, '官方(无 BASE_URL)也是可判的身份');
assert.deepEqual(scope.presetIds, ['anthropic-official'], '官方 = 只刷 anthropic-official');

// ── ⑤ 判不出身份 ────────────────────────────────────────────────────────
await resetIdentity();
await writeJson(join(GUI, 'custom-providers.json'), [{ id: 'p-x', name: 'Maoshu', type: 'openai', baseURL: 'https://ai.snaptokenflow.com/v1', models: [] }]);
await writeJson(join(GUI, 'active-provider.json'), { id: 'p-x' });
await writeJson(SETTINGS, { env: {} });
scope = await resolveCurrentPriceScope();
ok(!scope.resolved, '不在预设表里的中转地址判不出价目身份');
// 2026-09-21 r122 补两家中转站预设(dmxapi、yunwu):预设家数 43 → 45(reason 里的家数取自 registry 长度)。
ok(scope.reason.includes('ai.snaptokenflow.com') && scope.reason.includes('45'), `原因里要有 host 与预设家数: ${scope.reason}`);
assert.deepEqual(scope.presetIds, [], '判不出身份时不编造范围');

// ── ⑥ 端点:scope:'current' 的范围与错误码 ───────────────────────────────
const app = express();
app.use(express.json());
app.use('/api', pricingModule.default);
const server = await new Promise((resolve, reject) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
  s.once('error', reject);
});
const base = `http://127.0.0.1:${server.address().port}`;
const post = (body) => fetch(`${base}/api/pricing/refresh`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

try {
  let r = await post({ scope: 'current' });
  assert.equal(r.status, 400, `判不出身份时只能是 400,不能悄悄刷全量(实际 ${r.status})`);
  assert.equal(r.body.code, 'PRICING_CURRENT_UNRESOLVED', '错误码要能前端分支');
  assert.equal(r.body.ok, false, '错误信封 {ok:false,code,error}');
  n += 3;

  // 用套餐类预设:显式名单同样不发网络请求(单测不许打官方站点)。
  r = await post({ scope: 'current', presetIds: ['kimi-code'] });
  assert.equal(r.status, 202, '显式 presetIds 优先于 scope(不把两套范围混着算)');
  assert.ok(r.body.refreshId, '显式范围仍照常返回 refreshId');
  n += 2;

  // 套餐类(无采集器):范围 = 该家两条预设,且不发任何网络请求就立即终态。
  await resetIdentity();
  await writeJson(join(GUI, 'custom-providers.json'), [{ id: 'p-kimi', name: 'Kimi Code', type: 'openai', baseURL: 'https://api.kimi.com/coding/v1', models: [] }]);
  await writeJson(join(GUI, 'active-provider.json'), { id: 'p-kimi' });
  await writeJson(SETTINGS, { env: {} });
  r = await post({ scope: 'current' });
  assert.equal(r.status, 202, `scope:'current' 合法请求 202(实际 ${r.status}: ${JSON.stringify(r.body)})`);
  const view = await fetch(`${base}/api/pricing?refreshId=${encodeURIComponent(r.body.refreshId)}`).then((x) => x.json());
  const ids = view.refresh.providers.map((entry) => entry.presetId);
  assert.deepEqual(ids, ['kimi-code', 'kimi-code-anthropic'], `刷新范围必须只有判出来的那几家,实际 ${ids.join(',')}`);
  assert.equal(view.refresh.status, 'completed', '套餐类当场终态(没有可抓的官方源)');
  ok(view.refresh.providers.every((entry) => entry.status === 'not-token-priced'), '套餐类逐家如实标 not-token-priced');
  // 身份走单开的端点:GET /api/pricing 的顶层键集合是合同锁死的 7 个键(PA-401 逐字断言),
  // 身份字段塞进去就会红 —— 这条断言就是钉住"别塞回去"。
  const scopeNow = await fetch(`${base}/api/pricing/current`).then((x) => x.json());
  assert.equal(scopeNow.label, 'Kimi Code', 'GET /api/pricing/current 要带当前 provider 身份');
  assert.deepEqual(scopeNow.presetIds, ['kimi-code', 'kimi-code-anthropic'], '身份端点与刷新范围同源');
  assert.deepEqual(Object.keys(view).sort(), ['fetchedAt', 'prices', 'providers', 'quotes', 'refresh', 'schemaVersion', 'source'],
    'GET /api/pricing 顶层键集合不得增减(合同 7 键)');
  n += 3;

  // ── ⑦ 合同语义不回归(省略/空数组/未知 id 仍是原来的 400/202 形态)────────
  for (const [body, label] of [[{ presetIds: [] }, '空数组'], [{ presetIds: 'openai' }, '非数组'], [{ presetIds: ['nope'] }, '未知 id'], [{ scope: 'everything' }, '非法 scope']]) {
    const bad = await post(body);
    assert.equal(bad.status, 400, `${label} 必须 400`);
    assert.equal(bad.body.code, 'PRICING_INVALID_PROVIDER', `${label} 的错误码不变`);
    n += 2;
  }
} finally {
  server.close();
}

console.log(`check-pricing-current-scope: ${n} 项通过`);
