#!/usr/bin/env node
// r16-2:额度探测循环 + /api/provider-quota 路由端到端。
// Run: node tests/unit/check-provider-quota-probe.mjs
//
// 探测语义(规格):按序请求候选,**第一个 HTTP 200 且字段能解析成功**的才采纳;
// 全失败不抛,回 {ok:false, reason}。解析失败必须静默降级(Kimi/opencode 的端点官方
// 文档都没收录,不能弹错误、不能打红)。
// 端到端:隔离 HOME 造 provider fixture,起后端只用 6703(check-permission-hook-bridge
// 绑死 6702,不去抢它),假上游挂在同一个端口上 —— **绝不打真实第三方 API**。
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeQuota } from '../../server/services/provider-quota.js';

const PORT = 6703; // 测试专用端口(6702 被 check-permission-hook-bridge 绑死且无重试,别抢)
const OK_MOONSHOT = { code: 0, data: { available_balance: 42 } };
const OK_DEEPSEEK = { balance_infos: [{ currency: 'CNY', total_balance: '7.00' }] };

// ── 探测顺序:第一条 404 → 落第二条 ───────────────────────────────────────
{
  const calls = [];
  const candidates = [
    { vendor: 'moonshot', auth: 'bearer', urls: ['https://a/one'], currency: 'CNY' },
    { vendor: 'deepseek', auth: 'bearer', urls: ['https://b/two'] },
  ];
  const r = await probeQuota(candidates, async (url) => {
    calls.push(url);
    return url === 'https://a/one' ? { status: 404, body: null } : { status: 200, body: OK_DEEPSEEK };
  });
  assert.deepEqual(calls, ['https://a/one', 'https://b/two'], '按声明顺序探测');
  assert.equal(r.ok, true);
  assert.equal(r.endpoint, 'deepseek', '采纳第二条');
  assert.equal(r.items[0].value, 7);
}

// ── 第一条 200 就停:不该再打第二条 ─────────────────────────────────────
{
  const calls = [];
  const r = await probeQuota([
    { vendor: 'moonshot', auth: 'bearer', urls: ['https://a/one'], currency: 'CNY' },
    { vendor: 'deepseek', auth: 'bearer', urls: ['https://b/two'] },
  ], async (url) => { calls.push(url); return { status: 200, body: OK_MOONSHOT }; });
  assert.deepEqual(calls, ['https://a/one'], '命中即停,不多打一次');
  assert.equal(r.endpoint, 'moonshot');
  assert.equal(r.currency, 'CNY');
}

// ── HTTP 200 但字段解析不出 → 继续下一条(判据是"200 且能解析") ────────────
{
  const calls = [];
  const r = await probeQuota([
    { vendor: 'moonshot', auth: 'bearer', urls: ['https://a/one'], currency: 'CNY' },
    { vendor: 'deepseek', auth: 'bearer', urls: ['https://b/two'] },
  ], async (url) => {
    calls.push(url);
    return url === 'https://a/one' ? { status: 200, body: { error: 'nope' } } : { status: 200, body: OK_DEEPSEEK };
  });
  assert.deepEqual(calls, ['https://a/one', 'https://b/two'], '200 但解析不出也要往下试');
  assert.equal(r.endpoint, 'deepseek');
}

// ── 两条都失败 → ok:false,不抛 ─────────────────────────────────────────
{
  const r = await probeQuota([
    { vendor: 'moonshot', auth: 'bearer', urls: ['https://a/one'], currency: 'CNY' },
    { vendor: 'deepseek', auth: 'bearer', urls: ['https://b/two'] },
  ], async () => ({ status: 404, body: null }));
  assert.deepEqual(r, { ok: false, reason: 'no-endpoint' }, '全 404 → no-endpoint');
  assert.equal((await probeQuota([], async () => ({ status: 200, body: {} }))).reason, 'no-endpoint', '没有候选也不抛');
}

// ── 失败原因:401/403=auth(且盖过后续的 404)、异常=network ────────────────
{
  const auth = await probeQuota([
    { vendor: 'moonshot', auth: 'bearer', urls: ['https://a/one'], currency: 'CNY' },
    { vendor: 'deepseek', auth: 'bearer', urls: ['https://b/two'] },
  ], async (url) => (url === 'https://a/one' ? { status: 401, body: null } : { status: 404, body: null }));
  assert.equal(auth.reason, 'auth', '401 的信息量高于 404,不该被后面的 404 冲掉');
  assert.equal((await probeQuota([{ vendor: 'moonshot', auth: 'bearer', urls: ['https://a'] }],
    async () => ({ status: 403, body: null }))).reason, 'auth');
  const net = await probeQuota([{ vendor: 'moonshot', auth: 'bearer', urls: ['https://a'], currency: 'CNY' }],
    async () => { throw new Error('ECONNREFUSED'); });
  assert.deepEqual(net, { ok: false, reason: 'network' }, '网络异常被吃掉,只留 reason');
}

// ── 一个候选两条 URL(One-API 系):第二条挂 → 整条候选失败 ────────────────
{
  const calls = [];
  const r = await probeQuota([{ vendor: 'oneapi', auth: 'bearer', urls: ['https://a/sub', 'https://a/use'] }],
    async (url) => {
      calls.push(url);
      return url.endsWith('/sub') ? { status: 200, body: { hard_limit_usd: 100 } } : { status: 404, body: null };
    });
  assert.deepEqual(calls, ['https://a/sub', 'https://a/use'], '两条都要,第一条成功后继续第二条');
  assert.equal(r.ok, false, '第二条拿不到 → 不能拿 hard_limit 当余额显示');
}

// ── 变异验证:证明"顺序"断言真的咬得住 ───────────────────────────────────
{
  const calls = [];
  await probeQuota([
    { vendor: 'deepseek', auth: 'bearer', urls: ['https://b/two'] },
    { vendor: 'moonshot', auth: 'bearer', urls: ['https://a/one'], currency: 'CNY' },
  ], async (url) => { calls.push(url); return { status: 404, body: null }; });
  assert.deepEqual(calls, ['https://b/two', 'https://a/one'], '变异验证:候选顺序调换,调用顺序必须跟着换');
}

// ── 端到端:隔离 HOME + 真路由 + 本地假上游(同一个 6702 端口) ─────────────
const home = await mkdtemp(join(tmpdir(), 'cgui-quota-'));
process.env.HOME = home;
const guiDir = join(home, '.claude-gui');
await mkdir(guiDir, { recursive: true });
const PROVIDERS = [
  {
    id: 'relay-1', name: '测试中转', type: 'openai',
    baseURL: `http://127.0.0.1:${PORT}/relay/v1`, apiKey: 'dummy-not-a-real-key', models: ['gpt-x'],
  },
  {
    id: 'mimo-1', name: 'MiMo', type: 'openai',
    baseURL: 'https://api.xiaomimimo.com/v1', apiKey: 'dummy-not-a-real-key', models: ['mimo'],
  },
  {
    // SSRF:存量条目/DNS rebinding 能让 baseURL 指到内网。探测前必须再解析一次主机名。
    id: 'intranet-1', name: '内网', type: 'openai',
    baseURL: 'http://10.0.0.1/v1', apiKey: 'dummy-not-a-real-key', models: ['x'],
  },
];
await writeFile(join(guiDir, 'custom-providers.json'), JSON.stringify(PROVIDERS));

const { default: express } = await import('express');
const { default: quotaRouter, makeFetcher } = await import('../../server/routes/provider-quota.js');

let upstreamHits = 0;
let sawAuthHeader = false;
const app = express();
app.use('/api', quotaRouter);
// 假上游:One-API 系的两条 dashboard 端点。挂在同一个 app 上,全程只占 6702 一个端口。
app.get('/relay/v1/dashboard/billing/subscription', (req, res) => {
  upstreamHits++;
  sawAuthHeader = req.headers.authorization === 'Bearer dummy-not-a-real-key';
  res.json({ object: 'billing_subscription', hard_limit_usd: 100 });
});
app.get('/relay/v1/dashboard/billing/usage', (_req, res) => {
  upstreamHits++;
  res.json({ object: 'list', total_usage: 9500 }); // 已用 ×100 → 95 → 余额 5
});
// 端口是几个测试共用的(隔壁跑完可能还没完全放手)
// → listen 失败就退让重试,不让批量跑批出现假失败。
const listen = async () => {
  for (let i = 0; ; i++) {
    try {
      return await new Promise((resolve, reject) => {
        const s = app.listen(PORT, '127.0.0.1', () => resolve(s));
        s.once('error', reject);
      });
    } catch (e) {
      if (i >= 20 || e.code !== 'EADDRINUSE') throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
};
// 认证头回显 + 超大响应体,给 makeFetcher 的直测用(智谱的裸 token 与响应上限
// 在纯函数层测不到,只能打真的 HTTP)。
let seenAuth = null;
app.get('/echo-auth', (req, res) => { seenAuth = req.headers.authorization ?? null; res.json({ ok: true }); });
app.get('/huge', (_req, res) => res.type('application/json').send(`{"pad":"${'x'.repeat(1_200_000)}"}`));
// 重定向不跟随的探针:302 指回本机另一个端点,跟随了就会拿到 200。
app.get('/redir', (_req, res) => res.redirect(302, `http://127.0.0.1:${PORT}/echo-auth`));
const server = await listen();
const get = async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/provider-quota`);
  return { status: r.status, body: await r.json() };
};

try {
  // ① 没有 active-provider.json + 没有 settings.json → 判官方 → 整卡不渲染
  const official = await get();
  assert.equal(official.body.official, true, '官方/未配置时交给订阅额度卡');

  // ② 先激活"明确没有额度接口"的 provider:明写原因,且一个请求都不发
  await writeFile(join(guiDir, 'active-provider.json'), JSON.stringify({ id: 'mimo-1' }));
  const none = await get();
  assert.equal(none.body.ok, false);
  assert.equal(none.body.reason, 'no-endpoint');
  assert.equal(none.body.note, '该 provider 不提供额度接口', '不留空白,明写原因');
  assert.equal(upstreamHits, 0, '无候选时零请求');

  // ③ 紧接着切到中转 provider:失败冷却是按 provider id 记的,**不能**把 mimo 的失败
  //    扣在它头上(那会让刚切过去的 provider 一分钟查不出东西)。
  await writeFile(join(guiDir, 'prefs.json'), JSON.stringify({ quotaThresholds: { leftPercent: 1 } }));
  await writeFile(join(guiDir, 'active-provider.json'), JSON.stringify({ id: 'relay-1' }));
  // 顺带钉死请求合并:三处订阅者(卡片/顶栏红点/切换列表)会同时打进来。
  const [ok, b, c] = await Promise.all([get(), get(), get()]);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true, JSON.stringify(ok.body));
  assert.equal(upstreamHits, 2, '换了 provider 必须真探测(两条端点各一次),不吃上一家的冷却;并发三份只探一次');
  assert.deepEqual([b.body.ok, c.body.ok], [true, true], '并发的另外两份拿到同一结果');
  assert.equal(ok.body.providerName, '测试中转');
  assert.equal(ok.body.kind, 'amount');
  assert.equal(ok.body.currency, null, 'One-API 单位不可靠 → 不给货币符号');
  assert.equal(ok.body.items[0].value, 5, '100 − 9500/100 = 5');
  assert.equal(ok.body.items[0].direction, 'left');
  assert.equal(ok.body.low, false, 'prefs.json 的 leftPercent=1 被读到并生效(默认 10% 时剩余 5% 会亮红点)');
  assert.equal(sawAuthHeader, true, 'Bearer 头送到了上游');
  // 密钥绝不出现在响应里
  assert.ok(!JSON.stringify(ok.body).includes('dummy-not-a-real-key'), 'apiKey 绝不进响应体');

  // ④ 60s 缓存:再请求一次不该打上游
  const again = await get();
  assert.equal(upstreamHits, 2, '缓存命中,不重复打上游');
  assert.deepEqual(again.body, ok.body, '缓存回放同一份数据');

  // ⑤ 激活一个不在 GUI 列表里的 id → 也要给人话原因(此处 settings.json 缺失判官方)
  await writeFile(join(guiDir, 'active-provider.json'), JSON.stringify({ id: 'ghost' }));
  assert.equal((await get()).body.official, true, '未知 id + 无 settings.json → 回落官方');
  await mkdir(join(home, '.claude'), { recursive: true });
  await writeFile(join(home, '.claude', 'settings.json'),
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://relay.example.com/anthropic' } }));
  const ghost = await get();
  assert.equal(ghost.body.ok, false);
  assert.match(ghost.body.note, /未找到当前 provider 的配置/, '非官方但查不到配置 → 明写原因');

  // ⑥ baseURL 指向内网 → 探测前就拦下(SSRF 守卫),一个请求都不发
  await writeFile(join(guiDir, 'active-provider.json'), JSON.stringify({ id: 'intranet-1' }));
  const blocked = await get();
  assert.equal(blocked.body.ok, false);
  assert.equal(blocked.body.reason, 'blocked', '私网地址必须被拒(存量条目/DNS rebinding 绕过写入端守卫)');
  assert.match(blocked.body.note, /SSRF/, '明写原因,不假装成"没有额度接口"');
  assert.equal(upstreamHits, 2, 'SSRF 被拒时零请求');

  // ⑦ 路由把 candidate.auth 原样传下去:智谱是裸 token,写错就是 401 —— 纯函数层测不到这一位
  const fetcher = makeFetcher('dummy-not-a-real-key');
  await fetcher(`http://127.0.0.1:${PORT}/echo-auth`, { auth: 'raw' });
  assert.equal(seenAuth, 'dummy-not-a-real-key', 'auth=raw → 裸 token,不许加 Bearer');
  await fetcher(`http://127.0.0.1:${PORT}/echo-auth`, { auth: 'bearer' });
  assert.equal(seenAuth, 'Bearer dummy-not-a-real-key', 'auth=bearer → 带 Bearer 前缀');

  // ⑧ 不跟随重定向:守卫只解析了 baseURL 主机名,跟随 302 等于把内网探测面还回去
  const red = await fetcher(`http://127.0.0.1:${PORT}/redir`, { auth: 'bearer' });
  assert.equal(red.status, 302, '3xx 原样返回(跟随了就会是 200)→ 当作非 200 失败');
  assert.equal(red.body, null);

  // ⑨ 响应体上限:host 是用户自填的,不能让它往内存灌任意大小
  const huge = await fetcher(`http://127.0.0.1:${PORT}/huge`, { auth: 'bearer' });
  assert.equal(huge.status, 200);
  assert.equal(huge.body, null, '超过 1MB 的响应直接判失败,不进内存也不解析');
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(home, { recursive: true, force: true });
}

console.log('✅ check-provider-quota-probe 通过');
