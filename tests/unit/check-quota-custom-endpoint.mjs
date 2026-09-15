#!/usr/bin/env node
// 自定义额度查询端点(手填通道)。用例清单 = INTERFACE-20260913-quota-endpoint §F
// (F.1 正用例 P1–P9 / F.2 反用例 N1–N13)+ §B.3 写入端错误表。
// Run: node tests/unit/check-quota-custom-endpoint.mjs
//
// 契约要点(抄错就红在这几条):
//   · 手填通道**独占**:配了就只打它,不再按 host/预设猜(P5);想回自动识别 = 清空该框。
//   · 读不到就如实说:路径取不到一律 ok:false + 人话,绝不填 0(I1/N2)。
//   · 密钥只进请求头,不进响应体 / note / error(N9)。
//   · SSRF 守卫一条不砍:写入端 400 + 探测前再解析一次(N5/N6)。
//
// 端口取 OS 临时口(listen(0)),假上游与路由同进程同端口 —— **绝不打真实 provider 的
// 余额接口**(那会带上用户的 key)。隔离 HOME 后跑完清干净。
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  pickCandidates, parseQuota, readByPath, checkQuotaConfig, customCandidateOf,
  customNote, pathHintsFor, quotaPathError, authHeaders, sameQuotaURL, sameHostURL,
} from '../../server/services/provider-quota.js';

// 全是假值(仓库里不许出现真密钥);命名带 not-real 以免被误当成凭证。
const API_KEY = 'dummy-api-key-not-real';
const QUOTA_KEY = 'dummy-quota-key-not-real';

let passed = 0;
const results = [];
const ok = (id, title) => { passed++; results.push(`✅ ${id} ${title}`); console.log(`✅ ${id} ${title}`); };

// ── 纯函数层(零 IO,不需要 HOME) ────────────────────────────────────────────
{
  // readByPath:点号分层 + [n] 下标;空 path = 整个响应体;取不到一律 undefined(不抛)
  assert.equal(readByPath({ data: { balance: 42.5 } }, 'data.balance'), 42.5);
  assert.equal(readByPath({ balance_infos: [{ total_balance: '7.00' }] }, 'balance_infos[0].total_balance'), '7.00');
  assert.equal(readByPath({ a: [[1, 2], [3]] }, 'a[1][0]'), 3);
  assert.equal(readByPath(42, ''), 42, '空 path = 整个响应体');
  assert.equal(readByPath({ a: 1 }, 'a.b.c'), undefined, '中途不是对象 → undefined');
  assert.equal(readByPath({ a: 1 }, 'nope'), undefined);
  assert.equal(readByPath({ a: 1 }, 'toString'), undefined, '不穿原型链(own property 才算)');
  assert.equal(readByPath({ a: 1 }, 'a.__proto__'), undefined);
  assert.equal(readByPath({ a: 1 }, 'eval'), undefined, '普通键名但不存在 = undefined(不求值)');
  assert.equal(readByPath(null, 'a'), undefined);
  ok('§D.1', 'readByPath:点号+下标、空 path、绝不求值/穿原型链');

  // 路径合法性(§B.3 的 400 判据)
  assert.equal(quotaPathError('data.balance'), null);
  assert.equal(quotaPathError('balance_infos[0].total_balance'), null);
  assert.equal(quotaPathError(''), null, '空串 = 取整个响应体');
  assert.ok(quotaPathError('__proto__.x'), '__proto__ 段必须拒');
  assert.ok(quotaPathError('a.constructor'), 'constructor 段必须拒');
  assert.ok(quotaPathError('prototype'), 'prototype 段必须拒');
  assert.ok(quotaPathError('a..b'), '空段必须拒');
  assert.ok(quotaPathError('a'.repeat(201)), '超 200 字符必须拒');
  assert.equal(quotaPathError('a'.repeat(200)), null);
  ok('§B.2', 'quotaPath 校验:拒绝 __proto__/constructor/prototype、空段、超长');

  // checkQuotaConfig:形态/长度/协议 + auth/currency 静默回落(§B.2/B.3)
  assert.equal(checkQuotaConfig({ quotaURL: 'not a url' }).error, '额度查询接口必须是 http(s) 地址');
  assert.equal(checkQuotaConfig({ quotaURL: 'ftp://x/y' }).error, '额度查询接口必须是 http(s) 地址');
  assert.equal(checkQuotaConfig({ quotaURL: `https://x/${'a'.repeat(2100)}` }).error, '额度查询接口地址过长（上限 2048 字符）');
  assert.equal(checkQuotaConfig({ quotaURL: 'https://x/y', quotaPath: '__proto__' }).error,
    '取值路径非法（上限 200 字符，不含 __proto__ / constructor / prototype）');
  const cfg = checkQuotaConfig({ quotaURL: '  https://x/y  ', quotaAuth: 'bogus', quotaCurrency: 'EUR' });
  assert.equal(cfg.url, 'https://x/y', 'trim');
  assert.equal(cfg.path, '');
  assert.equal(cfg.auth, 'bearer', '非法 auth 静默回落 bearer');
  assert.equal(cfg.currency, null, '非法 currency 静默回落"不指定"');
  ok('§B.2/B.3', 'checkQuotaConfig:协议/长度/路径错误串 + 枚举静默回落');

  // customCandidateOf:pending 文件被手改也不炸(URL 非法 = 视同未配置)
  assert.equal(customCandidateOf({}), null);
  assert.equal(customCandidateOf({ quotaURL: 'ftp://x' }), null);
  assert.equal(customCandidateOf({ quotaURL: 'javascript:alert(1)' }), null);
  assert.equal(customCandidateOf({ quotaURL: 'https://relay.xx/bal', quotaPath: 'd.v' }).vendor, 'custom');
  assert.deepEqual(customCandidateOf({ quotaURL: 'https://relay.xx/bal' }).urls, ['https://relay.xx/bal']);

  // 手填独占(P5 的纯函数半边):baseURL 命中既有识别也不看它
  const only = pickCandidates({ baseURL: 'https://api.deepseek.com/anthropic', type: 'anthropic', quotaURL: 'https://relay.xx/bal' });
  assert.equal(only.length, 1, '手填命中即独占,不再并上既有候选');
  assert.equal(only[0].vendor, 'custom');
  assert.deepEqual(only[0].urls, ['https://relay.xx/bal']);
  assert.equal(pickCandidates({ baseURL: 'https://api.deepseek.com' })[0].vendor, 'deepseek', '未配置时既有识别一字不变');
  ok('§D.1', 'pickCandidates:手填命中独占;未配置时既有分支不变');

  // parseQuota 的 custom 分支:取数后必须过 num()(字符串数字认,空串/null/布尔不认)
  const c = { vendor: 'custom', auth: 'bearer', urls: ['https://x'], path: 'data.balance', currency: 'CNY' };
  const p = parseQuota(c, [{ data: { balance: 42.5 } }]);
  assert.equal(p.kind, 'amount');
  assert.equal(p.currency, 'CNY');
  assert.equal(p.items[0].value, 42.5);
  assert.equal(p.items[0].direction, 'left');
  assert.equal(p.items[0].label, '余额');
  assert.equal(parseQuota(c, [{ data: {} }]), null, '取不到 → null,绝不填 0(I1)');
  assert.equal(parseQuota(c, [{ data: { balance: 0 } }]).items[0].value, 0, '上游真给 0 要如实显示(不填 ≠ 篡改)');
  assert.equal(parseQuota(c, [{ data: { balance: '' } }]), null, '空串不是 0');
  assert.equal(parseQuota(c, [{ data: { balance: true } }]), null, '布尔不是 0');
  assert.equal(parseQuota(c, [{ data: { balance: null } }]), null);
  assert.equal(parseQuota(c, [null]), null);
  assert.equal(parseQuota({ ...c, path: '' }, [42]).items[0].value, 42, '空路径取整个响应体');
  assert.equal(parseQuota({ ...c, path: '' }, [{ balance: 1 }]), null, '空路径拿到对象 → 不可用');
  assert.equal(parseQuota({ vendor: 'custom', urls: ['https://x'], path: 'x' }, [{ x: '7.00' }]).items[0].value, 7, '字符串数字');
  ok('§D.1', 'parseQuota(custom):过 num(),空路径取整体,取不到降级不填 0');

  // auth:三态。'none' 必须**完全不发** Authorization(发个空 Bearer 会被中间件当无效凭证)
  assert.equal(authHeaders('bearer', 'k').Authorization, 'Bearer k');
  assert.equal(authHeaders('raw', 'k').Authorization, 'k');
  assert.deepEqual(authHeaders('none', 'k'), {}, "'none' 不带认证头");
  assert.deepEqual(authHeaders('bearer', ''), {}, '没有密钥 = 不发头(不发一个空的 Bearer)');
  ok('P4', "authHeaders:'none'/空密钥 不产生 Authorization 头");

  // 同源判定(密钥边界的判据)。方向保守:解析不了当"不相等/不同源"
  assert.equal(sameQuotaURL('https://x/y', '  https://x/y  '), true, '前后空白归一');
  assert.equal(sameQuotaURL('https://X:443/y', 'https://x/y'), true, 'host 大小写 + 默认端口归一');
  assert.equal(sameQuotaURL('https://x/y', 'https://x/z'), false);
  assert.equal(sameQuotaURL('https://x/y', 'https://x/y?token=1'), false, 'query 不同就是另一个地址');
  assert.equal(sameQuotaURL('https://x/y', 'https://other/y'), false);
  assert.equal(sameQuotaURL('nonsense', ''), false, '解析不了 → 逐字比,不相等');
  assert.equal(sameHostURL('https://x:1/a', 'https://x:1/b'), true, '同 host 不同 path = 同源');
  assert.equal(sameHostURL('https://x:1/a', 'https://x:2/a'), false, '端口算进 host');
  assert.equal(sameHostURL('https://x/a', ''), false, '缺一边 = 不同源(保守)');
  ok('同源判据', 'sameQuotaURL/sameHostURL:归一形态 + 解析不了按"不同"处理');

  // 响应键名骨架(T7):**只有键名,绝不含值**;深度≤3、≤60 条、跳过超长键名与原型链
  const hints = pathHintsFor({ code: 0, msg: 'x', data: { balance: 42.5, deep: { a: { b: 1 } } } });
  assert.deepEqual(hints, ['code', 'msg', 'data', 'data.balance', 'data.deep', 'data.deep.a']);
  // 深度 3 = 最多三层键名(根的子键 = 1 层);再深的不列
  assert.equal(hints.includes('data.deep.a.b'), false, '深度上限 3');
  assert.ok(!JSON.stringify(hints).includes('42.5'), '骨架里不许出现任何值');
  assert.ok(!pathHintsFor({ ['t'.repeat(41)]: 1, keep: 1 }).includes('t'.repeat(41)), '超 40 字符的键名跳过(防 token 当键名)');
  assert.equal(pathHintsFor({ a: { b: { c: { d: 1 } } } }).length, 3);
  assert.ok(pathHintsFor({ __proto__: 1, a: 1 }).length === 1);
  ok('V4/T7', 'pathHintsFor:深度≤3、只有键名、跳过超长键名与原型链');

  // §E.5 卡片文案(handed 给 note 的四档)
  const cc = customCandidateOf({ quotaURL: 'https://relay.xx:8443/api/user/balance?token=SECRET', quotaPath: 'data.balance' });
  assert.equal(customNote('auth', cc), '自定义额度接口拒绝了当前密钥（HTTP 401/403）：relay.xx:8443');
  assert.equal(customNote('network', cc), '自定义额度接口请求失败（网络不可达或超时）：relay.xx:8443');
  assert.equal(customNote('blocked', cc), '自定义额度接口指向内网地址，已拒绝查询（SSRF 防护）：relay.xx:8443');
  assert.equal(customNote('no-endpoint', cc),
    '自定义额度接口未返回可读的余额：relay.xx:8443（请求失败，或响应中没有「data.balance」）');
  assert.equal(customNote('no-endpoint', customCandidateOf({ quotaURL: 'https://relay.xx', quotaPath: '' })),
    '自定义额度接口未返回可读的余额：relay.xx（请求失败，或响应不是可读的数字）');
  assert.ok(!customNote('auth', cc).includes('SECRET'), 'note 只回 host,不回 path/query(token 可能写在里面)');
  ok('§E.5', 'customNote:四档文案逐字,且只回 host');
}

// ── 端到端:隔离 HOME + 真路由 + 本机假上游(同一个临时口) ────────────────────
const home = await mkdtemp(join(tmpdir(), 'cgui-quotacustom-'));
process.env.HOME = home; // 必须在 import 路由之前:路径常量在模块加载期就绑好了
process.env.USERPROFILE = home; // Windows 上 homedir() 读 %USERPROFILE%,不设沙箱失效
await mkdir(join(home, '.claude-gui'), { recursive: true });

const { default: express } = await import('express');
const { default: settingsRouter } = await import('../../server/routes/settings.js');
const { default: quotaRouter } = await import('../../server/routes/provider-quota.js');

const PROVIDERS_FILE = join(home, '.claude-gui', 'custom-providers.json');
const onDisk = async (id) => JSON.parse(await readFile(PROVIDERS_FILE, 'utf-8')).find((p) => p.id === id);

const hits = {}; // 每个假上游端点的命中数
const lastAuth = { };// 最近一次收到的 Authorization(/up/auth)
const lastAuth2 = { }; // 同上(/up/auth2)
const seenText = []; // 所有响应原文(N9 明文检查用)
const bump = (k) => { hits[k] = (hits[k] || 0) + 1; return hits[k] || 0; };
const h = (k) => hits[k] || 0;
// 假上游:300 也贴在同一个 app 上,全程只占一个端口、**只在本机**。
const sendJSON = (k, body) => (_req, res) => { bump(k); res.json(body); };
const app = express();
app.use(express.json());
app.use('/api', settingsRouter);
app.use('/api', quotaRouter);
app.get('/up/bal', (_req, res) => { bump('bal'); res.json({ code: 0, data: { balance: 42.5 } }); });
app.get('/up/str', (_req, res) => { bump('str'); res.json({ balance_infos: [{ currency: 'CNY', total_balance: '7.00' }] }); });
app.get('/up/raw', (_req, res) => { bump('raw'); res.type('application/json').send('42'); });
app.get('/up/auth', (req, res) => { bump('auth'); lastAuth.value = req.headers.authorization ?? null; res.json({ balance: 5 }); });
// 第二个记录点:同源闸的正用例要"换了地址但仍带调用方自己那把 key",得有另一个地址也记头。
app.get('/up/auth2', (req, res) => { bump('auth2'); lastAuth2.value = req.headers.authorization ?? null; res.json({ balance: 6 }); });
app.get('/up/404', (_req, res) => { bump('e404'); res.status(404).json({ error: 'nope' }); });
app.get('/up/401', (_req, res) => { bump('e401'); res.status(401).json({ error: 'bad key' }); });
app.get('/up/nopath', (_req, res) => { bump('nopath'); res.json({ code: 0, message: 'ok', data: { other: 1 } }); });
app.get('/up/redir', (_req, res) => { bump('redir'); res.redirect(302, `/up/redir-target`); });
app.get('/up/redir-target', (_req, res) => { bump('redirTarget'); res.json({ balance: 999 }); });
app.get('/up/huge', (_req, res) => { bump('huge'); res.type('application/json').send(`{"pad":"${'x'.repeat(1_200_000)}"}`); });
app.get('/up/a', sendJSON('a', { balance: 11 }));
app.get('/up/b', sendJSON('b', { balance: 22 }));
app.get('/up/pt', sendJSON('pt', { balance: 33 }));
app.get('/oneapi/v1/dashboard/billing/subscription', (_req, res) => { bump('oneapiSub'); res.json({ hard_limit_usd: 100 }); });
app.get('/oneapi/v1/dashboard/billing/usage', (_req, res) => { bump('oneapiUse'); res.json({ total_usage: 2500 }); });

const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;
const UP = (p) => `${BASE}/up/${p}`;

const api = async (method, path, body) => {
  const r = await fetch(`${BASE}/api${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await r.text();
  seenText.push(text);
  return { status: r.status, text, body: JSON.parse(text) };
};
const quota = () => api('GET', '/provider-quota');
const activate = (id) => writeFile(join(home, '.claude-gui', 'active-provider.json'), JSON.stringify({ id }));
// 每例一个独立 provider id:路由的缓存/冷却按槽位分键,复用同 id 会互相干扰。
const mk = async (id, extra = {}, type = 'openai') => {
  const r = await api('POST', '/custom-providers', {
    name: id, type, baseURL: `${BASE}/oneapi/v1`, apiKey: API_KEY, models: ['m1'], ...extra,
  });
  assert.equal(r.status, 200, `POST ${id}: ${r.text}`);
  return r.body.id;
};

try {
  // ── P1 手填通道读到余额 ────────────────────────────────────────────────
  {
    const id = await mk('p1', { quotaURL: UP('bal'), quotaPath: 'data.balance' });
    await activate(id);
    const r = await quota();
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true, r.text);
    assert.equal(h('bal'), 1, '上游命中 1 次');
    assert.equal(h('oneapiSub'), 0, '手填独占:既有识别端点 0 次');
    assert.equal(r.body.items[0].value, 42.5);
    assert.equal(r.body.items[0].direction, 'left');
    assert.equal(r.body.items[0].label, '余额');
    assert.equal(r.body.kind, 'amount');
    assert.equal(r.body.currency, null, '没填币种 = 不指定');
    assert.equal(r.body.official, false);
    assert.equal(typeof r.body.fetchedAt, 'number');
    ok('P1', '手填通道读到余额(独占,既有识别端点 0 次)');
  }

  // ── P2 字符串数字 + 数组下标路径 ────────────────────────────────────────
  {
    const id = await mk('p2', { quotaURL: UP('str'), quotaPath: 'balance_infos[0].total_balance' });
    await activate(id);
    const r = await quota();
    assert.equal(r.body.ok, true, r.text);
    assert.equal(r.body.items[0].value, 7, '"7.00" → 7');
    assert.equal(r.body.currency, null, '币种只认用户那格(上游 balance_infos[].currency 不参与口径)');
    ok('P2', '字符串数字 + balance_infos[0].total_balance 路径');
  }

  // ── P3 币种 ────────────────────────────────────────────────────────────
  {
    const y = await mk('p3cny', { quotaURL: UP('bal'), quotaPath: 'data.balance', quotaCurrency: 'CNY' });
    await activate(y);
    assert.equal((await quota()).body.currency, 'CNY');
    const n = await mk('p3none', { quotaURL: UP('bal'), quotaPath: 'data.balance' });
    await activate(n);
    assert.equal((await quota()).body.currency, null);
    ok('P3', 'quotaCurrency:CNY → currency CNY;不填 → null');
  }

  // ── P4 认证三态(上游真收到什么) ────────────────────────────────────────
  {
    for (const [auth, want] of [['bearer', `Bearer ${QUOTA_KEY}`], ['raw', QUOTA_KEY], ['none', null]]) {
      const id = await mk(`p4-${auth}`, { quotaURL: UP('auth'), quotaPath: 'balance', quotaAuth: auth, quotaKey: QUOTA_KEY });
      await activate(id);
      const r = await quota();
      assert.equal(r.body.ok, true, `${auth}: ${r.text}`);
      assert.equal(lastAuth.value, want, `auth=${auth} 时上游收到的 Authorization`);
    }
    ok('P4', '认证三态:bearer/raw/none 上游收到的头各自正确');
  }

  // ── P5 手填独占(baseURL 命中既有识别) ──────────────────────────────────
  {
    const id = await mk('p5', { quotaURL: UP('bal'), quotaPath: 'data.balance' });
    await activate(id);
    const beforeSub = h('oneapiSub');
    const beforeUse = h('oneapiUse');
    const r = await quota();
    assert.equal(r.body.ok, true, r.text);
    assert.equal(h('oneapiSub'), beforeSub, '既有识别端点命中 0 次');
    assert.equal(h('oneapiUse'), beforeUse, '既有识别端点命中 0 次');
    assert.equal(r.body.items[0].value, 42.5, '只有自定义地址命中');
    ok('P5', '手填独占:既有识别端点一次都没打');
  }

  // ── P6 配置改完立即生效(不吃 60s 缓存) ─────────────────────────────────
  {
    const id = await mk('p6', { quotaURL: UP('a'), quotaPath: 'balance' });
    await activate(id);
    assert.equal((await quota()).body.items[0].value, 11, '端点 A 读到 11');
    assert.equal(h('a'), 1);
    const put = await api('PUT', `/custom-providers/${id}`, {
      name: 'p6', type: 'openai', baseURL: `${BASE}/oneapi/v1`, quotaURL: UP('b'), quotaPath: 'balance',
    });
    assert.equal(put.status, 200, put.text);
    const after = await quota();
    assert.equal(after.body.ok, true, after.text);
    assert.equal(after.body.items[0].value, 22, '改完立刻打新端点,不吃旧缓存');
    assert.equal(h('b'), 1);
    assert.equal(h('a'), 1, '端点 A 不再被多打一次');
    ok('P6', '改 quotaURL 立即生效(槽位指纹进 slotKey)');
  }

  // ── P7 quota-test 对非激活 provider 有效 + 不写缓存 ─────────────────────
  {
    const a = await mk('p7a', { quotaURL: UP('a'), quotaPath: 'balance' });
    const b = await mk('p7b', { quotaURL: UP('pt'), quotaPath: 'balance' });
    await activate(a);
    const before = h('pt');
    const t1 = await api('POST', '/custom-providers/quota-test', { id: b, quotaURL: UP('pt'), quotaPath: 'balance', quotaKey: QUOTA_KEY });
    assert.equal(t1.status, 200, t1.text);
    assert.equal(t1.body.ok, true, `测试口对非激活 provider 也要能返回结果: ${t1.text}`);
    assert.equal(t1.body.value, 33);
    const t2 = await api('POST', '/custom-providers/quota-test', { id: b, quotaURL: UP('pt'), quotaPath: 'balance', quotaKey: QUOTA_KEY });
    assert.equal(t2.body.value, 33);
    assert.equal(h('pt') - before, 2, '连续两次必须真打上游两次(不写缓存)');
    assert.equal((await quota()).body.providerId, a, '测试不影响当前激活 provider 的卡片');
    ok('P7', 'quota-test 对非激活 provider 有效且不写缓存');
  }

  // ── P8 空路径 + 裸数字响应 ─────────────────────────────────────────────
  {
    const id = await mk('p8', { quotaURL: UP('raw'), quotaPath: '' });
    await activate(id);
    const r = await quota();
    assert.equal(r.body.ok, true, r.text);
    assert.equal(r.body.items[0].value, 42, '空路径 = 整个响应体当值');
    const t = await api('POST', '/custom-providers/quota-test', { quotaURL: UP('raw'), quotaPath: '' });
    assert.equal(t.body.ok, true, t.text);
    assert.equal(t.body.value, 42);
    assert.equal(t.body.path, '');
    ok('P8', '空路径取整个响应体(裸数字 42)');
  }

  // ── P9 回环放行 ────────────────────────────────────────────────────────
  {
    const id = await mk('p9', { quotaURL: `http://127.0.0.1:${PORT}/up/bal`, quotaPath: 'data.balance' });
    await activate(id);
    const r = await quota();
    assert.equal(r.body.ok, true, `http 回环必须放行(本机中转是合法场景): ${r.text}`);
    assert.equal(r.body.items[0].value, 42.5);
    ok('P9', 'http://127.0.0.1 回环放行(保存成功 + 探测成功)');
  }

  // ── N1/N2 路径取不到:如实说,绝不填 0 ───────────────────────────────────
  {
    const id = await mk('n1', { quotaURL: UP('nopath'), quotaPath: 'data.balance' });
    await activate(id);
    const r = await quota();
    assert.equal(r.body.ok, false);
    assert.equal(r.body.reason, 'no-endpoint', 'reason 沿用既有四值枚举,不新增值');
    assert.ok(r.body.note.includes('data.balance'), `note 要点名用户填的路径: ${r.body.note}`);
    assert.ok(r.body.note.includes('自定义额度接口'), 'N3:必须是自定义文案,不是「未登记额度接口」');
    assert.ok(!r.body.note.includes('未登记额度接口'), '不许落进"该 provider 未登记额度接口"');
    assert.equal(r.body.items, undefined);
    assert.ok(!/"value"|"percent"|"max"/.test(r.text), `N2:响应里不许出现任何金额字段(绝不填 0): ${r.text}`);
    ok('N1/N2', '路径取不到 → ok:false + 自定义文案 + 响应无金额字段');
  }

  // ── E.6 测试用哪个 key:本次输入 → 回落存储(quotaKey → apiKey) → 都没有也不拦 ──
  {
    const id = await mk('keyfb', { quotaURL: UP('auth'), quotaPath: 'balance', quotaKey: QUOTA_KEY });
    lastAuth.value = 'unset';
    const r = await api('POST', '/custom-providers/quota-test', { id, quotaURL: UP('auth'), quotaPath: 'balance' });
    assert.equal(r.body.ok, true, r.text);
    assert.equal(lastAuth.value, `Bearer ${QUOTA_KEY}`, '不传 quotaKey 时按 id 读存储的 quotaKey');
    lastAuth.value = 'unset';
    const fresh = await api('POST', '/custom-providers/quota-test', { quotaURL: UP('auth'), quotaPath: 'balance' });
    assert.equal(fresh.body.ok, true, '新增态且没填任何 key 也不拦(让上游回 401,用户看到真实原因)');
    assert.ok(!String(lastAuth.value).includes(QUOTA_KEY) && !String(lastAuth.value).includes(API_KEY),
      '没有 id 也没有本次输入时,不许凭空拿别的 provider 的密钥');
    ok('E.6', '测试口密钥来源:本次输入 → 存储回落 → 都没有也放行');
  }

  // ── 同源闸(测试口):存储密钥只发往**存储的**额度地址(安全评估实测的外传路径) ──
  {
    const id = await mk('origin', { quotaURL: UP('auth'), quotaPath: 'balance', quotaKey: QUOTA_KEY });
    // 反:调用方指定别的地址又不给 quotaKey → 挡下,且一个请求都不发
    lastAuth.value = 'unset';
    const before = h('auth');
    const other = await api('POST', '/custom-providers/quota-test', { id, quotaURL: UP('auth2'), quotaPath: 'balance' });
    assert.equal(other.status, 200, `业务失败仍是 200(前端读 body.ok): ${other.text}`);
    assert.equal(other.body.ok, false, other.text);
    assert.equal(h('auth'), before, '新地址一个请求都不许发');
    assert.equal(lastAuth2.value, undefined, '更不许把存储密钥带过去');
    assert.ok(!other.text.includes(QUOTA_KEY) && !other.text.includes(API_KEY), '提示文案里也不许出现明文');
    assert.ok(other.body.error.includes('额度查询密钥'), `提示要说清"要填密钥": ${other.body.error}`);
    // 正①:地址与存储值一致 → 存储密钥照常回落(不许把功能修死)
    lastAuth.value = 'unset';
    const same = await api('POST', '/custom-providers/quota-test', { id, quotaURL: UP('auth'), quotaPath: 'balance' });
    assert.equal(same.body.ok, true, same.text);
    assert.equal(lastAuth.value, `Bearer ${QUOTA_KEY}`, '地址没变时仍回落存储密钥');
    // 正②:前后空白 = 规范化后相等,不算"换了地址"
    const padded = await api('POST', '/custom-providers/quota-test', { id, quotaURL: `  ${UP('auth')}  `, quotaPath: 'balance' });
    assert.equal(padded.body.ok, true, `规范化后相等就不该挡: ${padded.text}`);
    // 正③:换了地址但自带 quotaKey → 放行,发的是调用方那把
    lastAuth2.value = 'unset';
    const own = await api('POST', '/custom-providers/quota-test', { id, quotaURL: UP('auth2'), quotaPath: 'balance', quotaKey: API_KEY });
    assert.equal(own.body.ok, true, own.text);
    assert.equal(lastAuth2.value, `Bearer ${API_KEY}`, '自带 key 时发自带的那把');
    assert.equal(h('auth2'), 1, '换了地址 + 自带 key 必须真打上游');
    ok('同源闸', '测试口:换地址不带 key 挡下(0 请求);地址未变/自带 key 照常');
  }

  // ── 密钥同源(探测口):跨 host 的手填额度端点不许拿 apiKey 去填 ─────────────
  //    API 站与面板站分离是合法场景(§4.1),但 apiKey 是**推理密钥**,它的归属是 baseURL;
  //    跨 host 把 apiKey 带过去 = 手改文件 / 经本地口的 PUT 能把密钥送去任意地址。
  //    跨 host 只有用户为该端点单独配的 quotaKey 能跟过去。
  {
    const seen2 = [];
    const app2 = express();
    app2.get('/bal', (req, res) => { seen2.push(req.headers.authorization ?? null); res.json({ data: { balance: 7 } }); });
    const s2 = await new Promise((r) => { const s = app2.listen(0, '127.0.0.1', () => r(s)); });
    const OTHER = `http://127.0.0.1:${s2.address().port}/bal`; // 与 BASE 不同端口 = 不同 host
    try {
      const id = await mk('xhost', { quotaURL: OTHER, quotaPath: 'data.balance' }); // 只带 apiKey,没 quotaKey
      await activate(id);
      const r1 = await quota();
      assert.equal(r1.body.ok, true, `跨 host 的额度站仍要能查(不带认证头而已): ${r1.text}`);
      assert.equal(seen2.length, 1, '真打了那个 host');
      assert.equal(seen2[0], null, 'apiKey 不许跟到别的 host(推理密钥只同源)');
      // 用户为该端点单独配 quotaKey → 这是显式配对,才允许发过去
      const put = await api('PUT', `/custom-providers/${id}`, {
        name: 'xhost', type: 'openai', baseURL: `${BASE}/oneapi/v1`, models: ['m1'],
        quotaURL: OTHER, quotaPath: 'data.balance', quotaKey: QUOTA_KEY,
      });
      assert.equal(put.status, 200, put.text);
      await activate(id);
      const r2 = await quota();
      assert.equal(r2.body.ok, true, r2.text);
      assert.equal(seen2[1], `Bearer ${QUOTA_KEY}`, '配了 quotaKey 才发密钥,发的是 quotaKey');
    } finally {
      s2.closeAllConnections?.();
      await new Promise((r) => s2.close(() => r()));
    }
    ok('密钥同源', '探测口:跨 host 端点不带 apiKey;配了 quotaKey 才发密钥');
  }

  // ── N3 404 ────────────────────────────────────────────────────────────
  {
    const id = await mk('n3', { quotaURL: UP('404'), quotaPath: 'balance' });
    await activate(id);
    const r = await quota();
    assert.equal(r.body.ok, false);
    assert.ok(r.body.note.startsWith('自定义额度接口未返回可读的余额：'), r.body.note);
    assert.ok(!r.body.note.includes('未登记额度接口'), '不是第③类"未登记"串');
    ok('N3', '上游 404 → 自定义文案(不是"该 provider 未登记额度接口")');
  }

  // ── N4 401 ────────────────────────────────────────────────────────────
  {
    const id = await mk('n4', { quotaURL: UP('401'), quotaPath: 'balance' });
    await activate(id);
    const r = await quota();
    assert.equal(r.body.ok, false);
    assert.equal(r.body.reason, 'auth');
    assert.equal(r.body.note, `自定义额度接口拒绝了当前密钥（HTTP 401/403）：127.0.0.1:${PORT}`);
    assert.ok(r.body.note.includes('401'));
    ok('N4', '上游 401 → reason auth + §E.5 auth 文案');
  }

  // ── N5 SSRF-写入(§B.3 的 400 表) ───────────────────────────────────────
  {
    const bad = async (quotaURL) => api('POST', '/custom-providers', {
      name: 'ssrf', type: 'openai', baseURL: `${BASE}/oneapi/v1`, apiKey: API_KEY, models: ['m'], quotaURL,
    });
    const pri = await bad('https://10.0.0.1/x');
    assert.equal(pri.status, 400, pri.text);
    assert.equal(pri.body.error, '额度查询接口指向内网/环回地址，已拒绝（SSRF 防护）');
    const pub = await bad('http://example.com/x');
    assert.equal(pub.status, 400, `公网 http 必须拒: ${pub.text}`);
    assert.ok(pub.body.error.includes('额度查询接口'), pub.body.error);
    const ip = await bad('http://169.254.169.254/latest/meta-data/');
    assert.equal(ip.status, 400, `云元数据地址必须拒: ${ip.text}`);
    const noProto = await bad('ftp://relay.xx/bal');
    assert.equal(noProto.status, 400);
    assert.equal(noProto.body.error, '额度查询接口必须是 http(s) 地址');
    const long = await bad(`https://relay.xx/${'a'.repeat(2100)}`);
    assert.equal(long.status, 400);
    assert.equal(long.body.error, '额度查询接口地址过长（上限 2048 字符）');
    const badPath = await bad(`https://127.0.0.1:1/x`);
    assert.equal(badPath.status, 200, `回环放行(https + 字面回环): ${badPath.text}`);
    const proto = await api('POST', '/custom-providers', {
      name: 'ssrf2', type: 'openai', baseURL: `${BASE}/oneapi/v1`, apiKey: API_KEY, models: ['m'],
      quotaURL: UP('bal'), quotaPath: '__proto__.x',
    });
    assert.equal(proto.status, 400);
    assert.equal(proto.body.error, '取值路径非法（上限 200 字符，不含 __proto__ / constructor / prototype）');
    ok('N5', 'SSRF-写入:私网/公网 http/云元数据 400,回环放行;非法路径 400');
  }

  // ── N6 SSRF-探测(存量条目/手改文件) ────────────────────────────────────
  {
    const list = JSON.parse(await readFile(PROVIDERS_FILE, 'utf-8'));
    list.push({
      id: 'n6', name: 'n6', type: 'openai', baseURL: `${BASE}/oneapi/v1`, apiKey: API_KEY, models: ['m'],
      quotaURL: 'http://10.0.0.1/x', quotaPath: 'balance', // 直接写盘 = 绕过写入端校验
    });
    await writeFile(PROVIDERS_FILE, JSON.stringify(list));
    await activate('n6');
    const before = h('bal') + h('oneapiSub') + h('oneapiUse');
    const r = await quota();
    assert.equal(r.body.ok, false);
    assert.equal(r.body.reason, 'blocked');
    assert.ok(r.body.note.includes('SSRF'), r.body.note);
    assert.equal(h('bal') + h('oneapiSub') + h('oneapiUse'), before, '被拦时一个请求都不许发');
    ok('N6', '存量条目指私网 → blocked + SSRF 文案 + 零上游请求');
  }

  // ── N7 不跟随重定向 ────────────────────────────────────────────────────
  {
    const id = await mk('n7', { quotaURL: UP('redir'), quotaPath: 'balance' });
    await activate(id);
    const before = h('redirTarget');
    const r = await quota();
    assert.equal(r.body.ok, false, '302 当非 200 失败,不跟随');
    assert.equal(h('redirTarget'), before, '重定向目标端点命中 0 次');
    ok('N7', '302 不跟随(redirect: manual),目标端点 0 次');
  }

  // ── N8 响应超限(1MB) ──────────────────────────────────────────────────
  {
    const id = await mk('n8', { quotaURL: UP('huge'), quotaPath: 'pad' });
    await activate(id);
    const r = await quota();
    assert.equal(r.body.ok, false, '超限直接当失败,不解析');
    assert.equal(h('huge'), 1);
    ok('N8', '响应 >1MB → 当失败');
  }

  // ── N9 密钥不外泄(响应体 / note / error 三层) ───────────────────────────
  {
    for (const t of seenText) {
      assert.ok(!t.includes(QUOTA_KEY), 'quotaKey 明文绝不进任何响应');
      assert.ok(!t.includes(API_KEY), 'apiKey 明文绝不进任何响应');
    }
    const t = await api('POST', '/custom-providers/quota-test', {
      quotaURL: UP('401'), quotaPath: 'balance', quotaKey: QUOTA_KEY, id: 'whatever',
    });
    assert.equal(t.body.ok, false);
    assert.ok(!t.text.includes(QUOTA_KEY) && !t.text.includes(API_KEY), '失败路径同样不许泄明文');
    const hints = await api('POST', '/custom-providers/quota-test', { quotaURL: UP('nopath'), quotaPath: 'data.balance' });
    assert.ok(!hints.text.includes(QUOTA_KEY), 'pathHints 里只有键名');
    ok('N9', '密钥边界:响应体/note/error/pathHints 全无明文');
  }

  // ── N10 未配置零影响 ───────────────────────────────────────────────────
  {
    const id = await mk('n10'); // 没有 quotaURL
    await activate(id);
    const r = await quota();
    assert.equal(r.body.ok, true, r.text);
    assert.equal(h('oneapiSub') > 0 && h('oneapiUse') > 0, true, '未配置 → 走既有自动识别通道');
    assert.equal(r.body.items[0].value, 75, 'hard_limit 100 − total_usage 2500/100 = 75(既有口径一字不变)');
    assert.equal(r.body.currency, null);
    ok('N10', '未配置 provider 走既有通道(结果与既有 probe 用例一致)');
  }

  // ── N11 向后兼容(旧客户端 PUT) ────────────────────────────────────────
  {
    const id = await mk('n11', { quotaURL: UP('bal'), quotaPath: 'data.balance', quotaAuth: 'raw', quotaCurrency: 'USD' });
    // 旧前端:不带四键 → 已存值保留
    const keep = await api('PUT', `/custom-providers/${id}`, { name: 'n11', type: 'openai', baseURL: `${BASE}/oneapi/v1` });
    assert.equal(keep.status, 200, keep.text);
    let disk = await onDisk(id);
    assert.equal(disk.quotaURL, UP('bal'), '不带四键 = 保留');
    assert.equal(disk.quotaAuth, 'raw');
    // 显式空串 → 四键**全部**消失(不只是 quotaURL,否则留下孤儿路径)
    const clear = await api('PUT', `/custom-providers/${id}`, {
      name: 'n11', type: 'openai', baseURL: `${BASE}/oneapi/v1`, quotaURL: '',
    });
    assert.equal(clear.status, 200, clear.text);
    disk = await onDisk(id);
    for (const k of ['quotaURL', 'quotaPath', 'quotaAuth', 'quotaCurrency']) {
      assert.equal(k in disk, false, `清除必须连 ${k} 一起删(原子)`);
    }
    assert.equal(disk.quotaKey, undefined);
    ok('N11', '旧客户端 PUT 保留已存值;quotaURL:\'\' 四键一起消失');
  }

  // ── N12 零 console(源码级断言,既有套件同款) ───────────────────────────
  {
    const src = (await readFile(new URL('../../server/services/provider-quota.js', import.meta.url), 'utf8'))
      + (await readFile(new URL('../../server/routes/provider-quota.js', import.meta.url), 'utf8'));
    assert.ok(!/console\.log|console\.error|console\.warn/.test(src), '这两个文件不许有任何 console 输出(key 会漏)');
    assert.match(src, /const ZHIPU_BALANCE_URL = 'https:\/\/www\.bigmodel\.cn\//, '余额 URL 必须继续是常量');
    ok('N12', '两文件零 console + ZHIPU_BALANCE_URL 仍是常量');
  }

  // ── N13 落盘往返 + 两个下发口齐 ────────────────────────────────────────
  {
    const id = await mk('n13');
    const put = await api('PUT', `/custom-providers/${id}`, {
      name: 'n13', type: 'openai', baseURL: `${BASE}/oneapi/v1`, models: ['m1'],
      quotaURL: UP('bal'), quotaPath: 'data.balance', quotaAuth: 'raw', quotaCurrency: 'CNY', quotaKey: QUOTA_KEY,
    });
    assert.equal(put.status, 200, put.text);
    const disk = await onDisk(id);
    assert.equal(disk.quotaURL, UP('bal'));
    assert.equal(disk.quotaPath, 'data.balance');
    assert.equal(disk.quotaAuth, 'raw');
    assert.equal(disk.quotaCurrency, 'CNY');
    const g1 = await api('GET', '/custom-providers');
    const row1 = g1.body.providers.find((p) => p.id === id);
    assert.equal(row1.quotaURL, UP('bal'), 'GET /custom-providers 必须下发四键(表单回填)');
    assert.equal(row1.quotaPath, 'data.balance');
    assert.equal(row1.quotaAuth, 'raw');
    assert.equal(row1.quotaCurrency, 'CNY');
    assert.equal(row1.hasQuotaKey, true);
    const g2 = await api('GET', '/providers');
    const row2 = g2.body.customProviders.find((p) => p.id === id);
    assert.equal(row2.quotaURL, UP('bal'), '第二个下发口 GET /providers 也必须齐(avatar 踩过)');
    assert.equal(row2.quotaAuth, 'raw');
    assert.equal(row2.quotaCurrency, 'CNY');
    assert.ok(!g1.text.includes(QUOTA_KEY) && !g1.text.includes(API_KEY), 'GET 不下发明文');
    assert.ok(!g2.text.includes(QUOTA_KEY) && !g2.text.includes(API_KEY), 'GET /providers 不下发明文');
    // 缺省值不落盘(文件干净):auth 缺省 bearer / currency 不指定 → 两个键不写
    const id2 = await mk('n13b', { quotaURL: UP('bal') });
    const d2 = await onDisk(id2);
    assert.equal('quotaAuth' in d2, false, '缺省 bearer 不落盘');
    assert.equal('quotaCurrency' in d2, false, '不指定币种不落盘');
    assert.equal(d2.quotaPath, '', 'quotaPath 与 quotaURL 一起写入');
    ok('N13', '四键落盘往返 + 两个下发口齐 + 缺省不落盘');
  }

  // ── 测试口文案与前缀(§E.4 / §C.3) ──────────────────────────────────────
  {
    const empty = await api('POST', '/custom-providers/quota-test', { quotaURL: '' });
    assert.equal(empty.status, 400);
    const blocked = await api('POST', '/custom-providers/quota-test', { quotaURL: 'https://10.0.0.1/x' });
    assert.equal(blocked.status, 400);
    assert.equal(blocked.body.error, '该地址指向内网，已拒绝（SSRF 防护）。仅允许公网地址与本机回环地址。');
    const nf = await api('POST', '/custom-providers/quota-test', { quotaURL: UP('404') });
    assert.equal(nf.status, 200, '业务失败仍是 HTTP 200(前端读 body.ok)');
    assert.equal(nf.body.ok, false);
    assert.equal(nf.body.error, '请求失败（HTTP 404）。请检查地址与取值路径。');
    assert.equal(nf.body.httpStatus, 404);
    const nopath = await api('POST', '/custom-providers/quota-test', { quotaURL: UP('nopath'), quotaPath: 'data.balance' });
    assert.equal(nopath.body.ok, false);
    assert.equal(nopath.body.error, '响应里没有「data.balance」这个路径。');
    assert.deepEqual(nopath.body.pathHints, ['code', 'message', 'data', 'data.other']);
    assert.ok(!JSON.stringify(nopath.body.pathHints).includes('1'), '骨架里没有值');
    assert.equal(nopath.body.httpStatus, undefined, '2xx 不给 httpStatus');
    const netFail = await api('POST', '/custom-providers/quota-test', { quotaURL: `http://127.0.0.1:1/x` });
    assert.equal(netFail.body.ok, false);
    assert.equal(netFail.body.error, '请求失败（网络不可达或超时）。');
    assert.equal(netFail.body.httpStatus, undefined, '网络失败不给 httpStatus');
    const badKey = await api('POST', '/custom-providers/quota-test', { quotaURL: UP('401') });
    assert.equal(badKey.body.error, '接口拒绝了当前密钥（HTTP 401）。可在上方填写额度查询密钥。');
    assert.equal(badKey.body.httpStatus, 401);
    ok('§C.3/§E.4', 'quota-test:400 表 + 404/401/路径取不到/网络失败的文案与字段');
  }

  // ── 清空 = 回自动识别(用户说的"恢复默认") ──────────────────────────────
  {
    const id = await mk('back', { quotaURL: UP('bal'), quotaPath: 'data.balance' });
    await activate(id);
    assert.equal((await quota()).body.items[0].value, 42.5, '先走手填通道');
    await api('PUT', `/custom-providers/${id}`, { name: 'back', type: 'openai', baseURL: `${BASE}/oneapi/v1`, quotaURL: '' });
    const r = await quota();
    assert.equal(r.body.ok, true, r.text);
    assert.equal(r.body.items[0].value, 75, '清空额度接口 = 回到按 provider 地址自动识别');
    ok('§4.4', '清空 quotaURL → 立即回自动识别通道(一步恢复默认)');
  }
} finally {
  // fetch 的 keep-alive 连接会让 server.close() 的回调迟迟不触发 → 先掐连接,再给 close 封顶 1s,
  // 保证失败路径也能干净退出(不把"测试红了"变成"测试挂着")。
  server.closeAllConnections?.();
  await new Promise((r) => { server.close(() => r()); setTimeout(r, 1000).unref?.(); });
  await rm(home, { recursive: true, force: true });
}

console.log(`\n✅ check-quota-custom-endpoint 通过（${passed} 组断言）`);
// 跑完进程不自然退出:路由的 provider 切换会起本机代理监听(8788/8789),那些句柄不归本测试管。
// 既有套件同款收尾(见 check-billing-probe / check-mode-switch-rollback)。
process.exit(0);
