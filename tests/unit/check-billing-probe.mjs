// R5-b:没有本地"官方计费方式"记录时的一次性引导探测。
// Run: node tests/unit/check-billing-probe.mjs
//
// 【修的是什么】observeOfficialBilling 只在【当前 provider 恰好是官方】时才写记录。
// 新装机 / 清了 localStorage 且当前挂着第三方 provider 的用户根本不会有记录,于是订阅期
// 跑的 Claude 历史全按 API 单价重算 —— 判官在真实历史上实测合计 ¥166,204.71(有记录时
// ¥665.75),要用户手动切一次官方 provider 才自愈。
// 探测走 GET /api/subscription-usage?probe=1(Anthropic OAuth 用量端点,GUI 本来就在用):
// 能返回用量 = 这台机器存在官方订阅。客户端只看结果,不接触任何凭证。
// 【失败方向】超时 / 未登录 / official:false / 解析不出 / 任何异常一律不写记录,回落现有
// 行为(照常显示价格)。多显示,不多藏 —— 与 observeOfficialBilling 的"不知道就别记"同口径。
import assert from 'node:assert/strict';

const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = v; },
};

let calls = [];
let respond = async () => { throw new Error('未设置 mock'); };
globalThis.fetch = async (url) => { calls.push(url); return respond(url); };
const json = (obj) => ({ json: async () => obj });

const { probeOfficialBilling, isSubscriptionBilling, computeCost } =
  await import('../../client/src/utils/pricing.js');

const IO = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
const THIRD = { providerHint: 'deepseek', hasAuthKey: true };  // 当前挂着第三方 provider
const priced = () => computeCost('claude-opus-5', IO, THIRD);

// 模块 import 阶段不该发请求(node 下 window 未定义,自动探测被 typeof window 守卫挡掉)。
assert.equal(calls.length, 0, 'import 时不该自动探测(浏览器才自动探)');
// 起点:没有记录 → 维持原行为,第三方 provider 下 Claude 历史照常按单价显示。
assert.equal(isSubscriptionBilling(THIRD, 'claude-opus-5'), false);
assert.ok(priced(), '无记录时本该照常显示价格');

// ── 失败路径一律不写记录 ──────────────────────────────────────────
const failures = [
  ['网络异常/超时', async () => { throw new Error('Failed to fetch'); }],
  ['响应不是 JSON', async () => ({ json: async () => { throw new SyntaxError('bad json'); } })],
  ['official:false(当前 provider 非官方且服务端未放行探测)', async () => json({ official: false })],
  ['未登录官方账号', async () => json({ official: true, error: '未找到 Claude 登录凭证（请在 Claude Code 中登录）' })],
  ['接口限流且无旧数据', async () => json({ official: true, error: '接口限流中，显示上次数据（稍后自动恢复）' })],
  ['三档全解析不出', async () => json({ official: true, session: null, weekAll: null, weekScoped: null })],
  ['响应体为空', async () => json(null)],
];
for (const [name, impl] of failures) {
  respond = impl;
  const got = await probeOfficialBilling();
  assert.equal(got, null, `探测失败(${name})不该产生判据`);
  assert.equal(store['cgui-official-billing'], undefined, `探测失败(${name})不该写记录`);
  assert.equal(isSubscriptionBilling(THIRD, 'claude-opus-5'), false, `探测失败(${name})后应回落"照常显示"`);
  assert.ok(priced(), `探测失败(${name})后金额不该被藏`);
}
// 失败可重试:每次都真发了一次请求(否则一次网络抖动就永久失去自愈机会)。
assert.equal(calls.length, failures.length, `失败路径应逐次重试,实发 ${calls.length} 次`);
// 请求必须带 probe 参数 —— 服务端的 isOfficial() 门只对不带它的请求生效,
// 而"当前挂着第三方 provider"恰恰是本探测要覆盖的场景,不带就恒返回 official:false。
assert.ok(calls.every((u) => /[?&]probe=1\b/.test(String(u))), `探测请求必须带 probe=1:${calls[0]}`);

// ── 并发去重:同一 in-flight 只发一次请求 ───────────────────────────
calls = [];
let release;
respond = () => new Promise((r) => { release = () => r(json({ official: false })); });
const pair = Promise.all([probeOfficialBilling(), probeOfficialBilling()]);
release();
await pair;
assert.equal(calls.length, 1, `并发探测应共用同一 in-flight,实发 ${calls.length} 次`);

// ── 成功路径:拿到用量 = 这台机器存在官方订阅 ─────────────────────────
calls = [];
respond = async () => json({ official: true, session: { percent: 12, resetText: '8月4日 20:00' } });
assert.equal(await probeOfficialBilling(), 'oauth', '拿到用量应判为官方订阅');
assert.equal(store['cgui-official-billing'], 'oauth', '判据应持久化,下次启动免重探');
assert.equal(isSubscriptionBilling(THIRD, 'claude-opus-5'), true, '第三方 provider 下的订阅期 Claude 历史应按订阅口径');
assert.equal(priced(), null, '订阅口径下不该再按 API 单价算出天文数字');
// 降级响应(带 degraded/error 但仍有用量数据)同样算证据。
// 第三方模型的花费照常显示 —— 那是订阅之外真金白银付的。
assert.ok(computeCost('deepseek-v4-flash', IO, THIRD), '第三方模型的钱被一起藏了(P0)');
// R5-a:Bedrock / Vertex 的 claude-* 按 token 真实计费,探测结果不适用于它们。
for (const hint of ['bedrock', 'vertex']) {
  assert.ok(computeCost('claude-opus-5', IO, { providerHint: hint, hasAuthKey: true }),
    `${hint} 的 claude-* 被探测结果误藏`);
}

// ── 有记录就不再探测(记录是更强的证据,也避免每次启动打一次官方接口)──────
calls = [];
respond = async () => { throw new Error('不该再发请求'); };
assert.equal(await probeOfficialBilling(), 'oauth');
assert.equal(calls.length, 0, '已有判据时不该再探测');

// ── 在飞期间落地的直接观察不许被探测结果覆盖 ─────────────────────────
// observeOfficialBilling 读的是当前官方 provider 的**实际配置**(强证据);探测只是机器级
// 旁证。请求在飞的这段时间里用户切到官方 API key 档 → 记录必须保持 'apikey',否则按量付费
// 用户的 Claude 花费会被误藏。
// lastOfficialBilling 是模块级单向状态,复位不了 → 用带 query 的 specifier 拿一份全新实例。
delete store['cgui-official-billing'];
{
  const fresh = await import('../../client/src/utils/pricing.js?fresh=race');
  calls = [];
  respond = () => new Promise((r) => { release = () => r(json({ official: true, session: { percent: 3 } })); });
  const inflight = fresh.probeOfficialBilling();
  fresh.observeOfficialBilling({ providerHint: 'anthropic', hasAuthKey: true });  // 直接观察:按量付费
  release();
  await inflight;
  assert.equal(calls.length, 1, '这一轮应真发了一次探测');
  assert.equal(store['cgui-official-billing'], 'apikey', '在飞的探测覆盖了更强的直接观察');
  assert.equal(fresh.isSubscriptionBilling({ providerHint: 'anthropic', hasAuthKey: true }, 'claude-opus-5'), false);
  assert.ok(fresh.computeCost('claude-opus-5', IO, THIRD), '官方 API key 档被误判成订阅,金额被藏了');
}

console.log('check-billing-probe OK');
