#!/usr/bin/env node
// r16-4:provider 的可选「额度查询密钥」quotaKey。
// Run: node tests/unit/check-provider-quota-key.mjs
//
// 为什么要有这个字段:有几家的额度接口认的**不是推理 key**。
//   · OpenRouter:推理 key 只能打 /api/v1/key,读到的是「该 key 自己的花费上限」——
//     用户没给 key 设上限时 limit/limit_remaining 全 null,于是什么都读不到(被 r16-2
//     的降级规则正确地判成"查不到")。账户真实余额在 /api/v1/credits,只认 management key。
//   · MiniMax:token_plan/remains 可能要订阅密钥,按量 key 会 401。
// 所以做成"可选,填了才用":查额度时用 quotaKey || apiKey,OpenRouter 再按有无 quotaKey 换端点。
//
// 本文件守四件事:
//   ① OpenRouter 两条端点按有无 quotaKey 分流,且 /credits 的余额 = total_credits − total_usage
//   ② 字段缺失 → 降级成"查不到",**绝不拿 0 冒充余额**(会被读成欠费停机)
//   ③ 存储层与 apiKey 同标准:trim + 长度上限、任何 GET 只下发 hasQuotaKey 布尔、明文永不回传;
//      PUT 不传 = 保留,显式空串 = 清除
//   ④ 查额度时上游真正收到的是 quotaKey(没配才是 apiKey)—— 用本地假上游断言 Authorization
// 端到端只占 6703(check-permission-hook-bridge 绑死 6702,别抢),**绝不打真实第三方 API**。
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pickCandidates, parseQuota } from '../../server/services/provider-quota.js';

const PORT = 6703;
// 全是假值(仓库里不许出现真密钥);命名带 not-real 以免被误当成凭证。
const API_KEY = 'dummy-api-key-not-real';
const QUOTA_KEY = 'dummy-quota-key-not-real';

const one = (provider) => {
  const c = pickCandidates(provider);
  assert.equal(c.length, 1, `期望恰好一个候选:${provider.baseURL}`);
  return c[0];
};

// ── ① OpenRouter:有无 quotaKey 走两条不同端点 ─────────────────────────────
{
  const base = { baseURL: 'https://openrouter.ai/api/v1', type: 'openai' };

  const plain = one(base);
  assert.equal(plain.vendor, 'openrouter');
  assert.deepEqual(plain.urls, ['https://openrouter.ai/api/v1/key'],
    '没配 quotaKey → 维持推理 key 能打的 /api/v1/key(读该 key 的花费上限)');

  const mgmt = one({ ...base, quotaKey: QUOTA_KEY });
  assert.equal(mgmt.vendor, 'openrouter-credits');
  assert.deepEqual(mgmt.urls, ['https://openrouter.ai/api/v1/credits'],
    '配了 quotaKey → 改打 /api/v1/credits(账户真实余额,要 management key)');
  assert.equal(mgmt.currency, 'USD');
  assert.equal(mgmt.auth, 'bearer');

  // 空串/纯空白不算配置过 —— 否则会把一个空 key 送去打 /credits,401 后整卡变"查不到",
  // 反而比原来的 /api/v1/key 更糟。
  for (const blank of ['', '   ', null, undefined]) {
    assert.deepEqual(one({ ...base, quotaKey: blank }).urls, ['https://openrouter.ai/api/v1/key'],
      `quotaKey=${JSON.stringify(blank)} 视为未配置`);
  }

  // quotaKey 只换 OpenRouter 的端点,别家的端点与解析一律不动(规格:其余家只换用哪把 key)。
  assert.deepEqual(one({ baseURL: 'https://api.deepseek.com/anthropic', type: 'anthropic', quotaKey: QUOTA_KEY }).urls,
    ['https://api.deepseek.com/user/balance'], 'DeepSeek 端点不因 quotaKey 变化');
  assert.deepEqual(one({ baseURL: 'https://api.minimaxi.com/anthropic', type: 'anthropic', quotaKey: QUOTA_KEY }).urls,
    ['https://api.minimaxi.com/v1/token_plan/remains'], 'MiniMax 端点不因 quotaKey 变化');
  assert.deepEqual(one({ baseURL: 'https://my-relay.example.com/v1', type: 'openai', quotaKey: QUOTA_KEY }).urls, [
    'https://my-relay.example.com/v1/dashboard/billing/subscription',
    'https://my-relay.example.com/v1/dashboard/billing/usage',
  ], 'One-API 兜底端点不因 quotaKey 变化');
}

// ── ② /credits 解析:余额 = total_credits − total_usage;缺字段一律降级 ──────
{
  const c = one({ baseURL: 'https://openrouter.ai/api/v1', type: 'openai', quotaKey: QUOTA_KEY });
  const parse = (body) => parseQuota(c, [body]);

  const r = parse({ data: { total_credits: 25, total_usage: 7.35 } });
  assert.equal(r.kind, 'amount');
  assert.equal(r.currency, 'USD');
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].value, 17.65, '余额 = total_credits − total_usage(25 − 7.35)');
  assert.equal(r.items[0].direction, 'left', '方向读反会在余额充足时天天报警');
  assert.equal(r.items[0].label, '余额');
  assert.equal(r.items[0].unlimited, false);

  // 浮点毛刺要收口:10 − 3.3 在 JS 里是 6.699999999999999,不能原样显示出来。
  assert.equal(parse({ data: { total_credits: 10, total_usage: 3.3 } }).items[0].value, 6.7);

  // 缺字段 = 查不到,**不是余额 0**。0 会被读成"欠费停机",比明写查不到坏得多。
  assert.equal(parse({ data: { total_credits: 25 } }), null, '缺 total_usage → 降级');
  assert.equal(parse({ data: { total_usage: 7 } }), null, '缺 total_credits → 降级');
  assert.equal(parse({ data: {} }), null, '两个字段都没有 → 绝不能算出 0 − 0 = 0');
  assert.equal(parse({}), null, '没有 data → 降级');
  assert.equal(parse(null), null, '响应不是对象 → 降级');
  assert.equal(parse({ data: { total_credits: 'abc', total_usage: 1 } }), null, '非有限数 → 降级');
  assert.equal(parse({ data: { total_credits: '', total_usage: '' } }), null, '空串不是 0');
  // 字符串数字仍要认(别家的金额就有字符串形态,收口在同一个 num())
  assert.equal(parse({ data: { total_credits: '25.00', total_usage: '7.35' } }).items[0].value, 17.65);
}

// ── 端到端:隔离 HOME + 真路由 + 本地假上游(只占 6703) ────────────────────
const home = await mkdtemp(join(tmpdir(), 'cgui-quotakey-'));
process.env.HOME = home; // 必须在 import 路由之前:两个路径常量在模块加载期就绑好了
await mkdir(join(home, '.claude-gui'), { recursive: true });

const { default: express } = await import('express');
const { default: settingsRouter } = await import('../../server/routes/settings.js');
const { default: quotaRouter } = await import('../../server/routes/provider-quota.js');

const PROVIDERS_FILE = join(home, '.claude-gui', 'custom-providers.json');
const onDisk = async (id) => JSON.parse(await readFile(PROVIDERS_FILE, 'utf-8')).find((p) => p.id === id);

const app = express();
app.use(express.json());
app.use('/api', settingsRouter);
app.use('/api', quotaRouter);

// 假上游:One-API 系的两条 dashboard 端点,按 provider 挂不同前缀,记下收到的 Authorization。
const seen = {}; // { [prefix]: authorization }
for (const prefix of ['with-quota-key', 'no-quota-key']) {
  app.get(`/${prefix}/v1/dashboard/billing/subscription`, (req, res) => {
    seen[prefix] = req.headers.authorization ?? null;
    res.json({ object: 'billing_subscription', hard_limit_usd: 100 });
  });
  app.get(`/${prefix}/v1/dashboard/billing/usage`, (_req, res) => res.json({ object: 'list', total_usage: 2500 }));
}

// 端口是几个测试共用的(隔壁跑完可能还没完全放手)→ 撞了就退让重试,不制造假失败。
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
const server = await listen();

const api = async (method, path, body) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await r.text();
  return { status: r.status, text, body: JSON.parse(text) };
};
// 明文泄漏是按【整段响应文本】查的:换个字段名/嵌进别的对象照样会被抓住。
const assertNoPlaintext = (text, where) => {
  assert.ok(!text.includes(QUOTA_KEY), `${where}:quotaKey 明文绝不进响应体`);
  assert.ok(!text.includes(API_KEY), `${where}:apiKey 明文绝不进响应体`);
};

try {
  // ③-a 创建:填了 quotaKey(带前后空白)→ 落盘 trim 过,响应只给布尔
  const created = await api('POST', '/custom-providers', {
    name: '带额度密钥的中转', type: 'openai', baseURL: `http://127.0.0.1:${PORT}/with-quota-key/v1`,
    apiKey: API_KEY, quotaKey: `  ${QUOTA_KEY}  `, models: ['gpt-x'],
  });
  assert.equal(created.status, 200, created.text);
  assertNoPlaintext(created.text, 'POST 响应');
  const withKeyId = created.body.id;
  assert.equal((await onDisk(withKeyId)).quotaKey, QUOTA_KEY, '落盘前 trim(与 apiKey 同标准)');

  // ③-b 没填 quotaKey → 压根不写这个键(缺该字段 = 未配置,存量条目零影响)
  const plain = await api('POST', '/custom-providers', {
    name: '只有推理密钥的中转', type: 'openai', baseURL: `http://127.0.0.1:${PORT}/no-quota-key/v1`,
    apiKey: API_KEY, models: ['gpt-x'],
  });
  assert.equal(plain.status, 200, plain.text);
  const plainId = plain.body.id;
  assert.equal('quotaKey' in (await onDisk(plainId)), false, '没填就不写这个键');

  // ③-c 两个 GET 都只下发 hasQuotaKey 布尔(provider 编辑器读的是 /api/providers 那份)
  const list = await api('GET', '/custom-providers');
  assertNoPlaintext(list.text, 'GET /custom-providers');
  const byId = (payload, key) => payload.body[key].find((p) => p.id === withKeyId);
  assert.equal(byId(list, 'providers').hasQuotaKey, true);
  assert.equal(list.body.providers.find((p) => p.id === plainId).hasQuotaKey, false);

  const merged = await api('GET', '/providers');
  assert.equal(merged.status, 200, merged.text);
  assertNoPlaintext(merged.text, 'GET /providers');
  assert.equal(byId(merged, 'customProviders').hasQuotaKey, true,
    'provider 编辑器读的是这份 —— 不下发 hasQuotaKey 就永远显示不出"已保存"');
  assert.equal(merged.body.customProviders.find((p) => p.id === plainId).hasQuotaKey, false);

  // ③-d PUT 不传 quotaKey = 保留(表单留空 = 不修改,客户端从不持有明文)
  const keepBody = { name: '改个名字', type: 'openai', baseURL: `http://127.0.0.1:${PORT}/with-quota-key/v1`, models: ['gpt-x'] };
  const kept = await api('PUT', `/custom-providers/${withKeyId}`, keepBody);
  assert.equal(kept.status, 200, kept.text);
  assertNoPlaintext(kept.text, 'PUT 响应');
  assert.equal((await onDisk(withKeyId)).quotaKey, QUOTA_KEY, '不传 quotaKey → 保留原值(留空不该把密钥抹掉)');
  assert.equal((await onDisk(withKeyId)).apiKey, API_KEY, '顺带确认 apiKey 的同语义没被改坏');

  // ③-e PUT 传新值 = 覆盖;长度上限照 apiKey 同标准(4096)
  await api('PUT', `/custom-providers/${withKeyId}`, { ...keepBody, quotaKey: `${QUOTA_KEY}-v2` });
  assert.equal((await onDisk(withKeyId)).quotaKey, `${QUOTA_KEY}-v2`, '传了新值就覆盖');
  // r16-4b(判官建议2):超长不再静默截断 —— 截断后的密钥只会永远 401 且不给用户线索。
  // 改成 400 明确拒绝,且【磁盘上的旧值必须原样保留】(拒绝的写入不能半途改坏已有配置)。
  const tooLong = await api('PUT', `/custom-providers/${withKeyId}`, { ...keepBody, quotaKey: 'z'.repeat(5000) });
  assert.equal(tooLong.status, 400, '超长 → 400 明确拒绝,不静默截断');
  assert.match(tooLong.body?.error || '', /过长/, '错误文案说明原因');
  assert.equal((await onDisk(withKeyId)).quotaKey, `${QUOTA_KEY}-v2`, '被拒的写入不得改坏磁盘上的旧值');

  // ③-f PUT 显式传空串 = 清除(填错了得删得掉);纯空白同理
  await api('PUT', `/custom-providers/${withKeyId}`, { ...keepBody, quotaKey: '   ' });
  assert.equal('quotaKey' in (await onDisk(withKeyId)), false, '显式空串/纯空白 → 清除,不留空字符串残留');
  assert.equal((await api('GET', '/custom-providers')).body.providers.find((p) => p.id === withKeyId).hasQuotaKey, false);

  // ④ 查额度时上游收到的是哪把 key。两个 provider 各打一次,断言 Authorization。
  //    先把 quotaKey 装回去(③-f 刚清掉)。
  await api('PUT', `/custom-providers/${withKeyId}`, { ...keepBody, quotaKey: QUOTA_KEY });
  // 直接写 active-provider.json(与 check-provider-quota-probe 同法):走 /provider/switch
  // 会连带改 settings.json、起代理进程,那是切换路径的事,与本文件要守的东西无关。
  const activate = (id) => writeFile(join(home, '.claude-gui', 'active-provider.json'), JSON.stringify({ id }));

  await activate(withKeyId);
  const q1 = await api('GET', '/provider-quota');
  assert.equal(q1.body.ok, true, q1.text);
  assert.equal(q1.body.items[0].value, 75, '端到端解析没坏(100 − 2500/100)');
  assertNoPlaintext(q1.text, 'GET /provider-quota');
  assert.equal(seen['with-quota-key'], `Bearer ${QUOTA_KEY}`,
    '配了 quotaKey 就必须用它查额度(用推理 key 打 OpenRouter/MiniMax 的额度接口只会 401 或读到空)');

  await activate(plainId);
  const q2 = await api('GET', '/provider-quota');
  assert.equal(q2.body.ok, true, q2.text);
  assertNoPlaintext(q2.text, 'GET /provider-quota(未配 quotaKey)');
  assert.equal(seen['no-quota-key'], `Bearer ${API_KEY}`,
    '没配 quotaKey → 回落 apiKey,维持 r16-2 的现状');
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(home, { recursive: true, force: true });
}

console.log('✅ check-provider-quota-key 通过');
