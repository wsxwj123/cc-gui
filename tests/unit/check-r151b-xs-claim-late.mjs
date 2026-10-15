#!/usr/bin/env node
// r151b 审计 F1:会话正忙时点【处理】,前端只把"处理这条消息"(消息 id)排进既有队列,不提前认领;
// 排队与任何持久存储(localStorage)里都没有凭据;轮到它真正发出前才认领拿凭据,凭据只给那一次请求体。
// 白盒:真 import utils/xsession.js 与 stores/sessionStore.js(队列落 localStorage 的真实写法),服务端换成按路径应答的
// fetch 替身;App.jsx 的接缝(入队用 opts 浅拷贝、发出前认领、请求体只用局部变量)从源码钉住。
// node tests/unit/check-r151b-xs-claim-late.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── 浏览器全局的最小替身:localStorage 用一张表,事后能整表检查 ──
const mem = new Map();
globalThis.localStorage = {
  get length() { return mem.size; }, key: (i) => [...mem.keys()][i] ?? null,
  getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); }, clear: () => mem.clear(),
};
if (!globalThis.window) globalThis.window = globalThis;
if (!globalThis.addEventListener) { globalThis.addEventListener = () => {}; globalThis.removeEventListener = () => {}; }

const calls = [];
const routes = {};
globalThis.fetch = async (url, opts = {}) => {
  const method = (opts && opts.method) || 'GET';
  const u = new URL(url, 'http://127.0.0.1:6998');
  calls.push(`${method} ${u.pathname}`);
  const h = routes[`${method} ${u.pathname}`];
  const r = h ? h(u) : { status: 404, body: { ok: false } };
  return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async () => { for (let i = 0; i < 6; i += 1) await sleep(0); };
const count = (s) => calls.filter((c) => c === s).length;

const xs = await import('../../client/src/utils/xsession.js');
const { useStore } = await import('../../client/src/stores/sessionStore.js');

const B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const M1 = '11111111-0000-4000-8000-000000000001';
const M2 = '22222222-0000-4000-8000-000000000002';
const M3 = '33333333-0000-4000-8000-000000000003';
const TOKEN = 'cccccccc-0000-4000-8000-00000000000c';
const msg = (id, status) => ({
  id, createdAt: '2026-10-15T01:00:00.000Z', status, chainId: id, hop: 1,
  from: { kind: 'user', sessionId: null, title: '' }, to: { sessionId: B, title: '乙' },
  body: `正文-${id.slice(0, 2)}`, bodyBytes: 9, via: null,
  heldReason: status === 'pending' ? 'target-card' : null, heldText: status === 'pending' ? '等待你确认后处理' : null,
});
let serverMsgs = [msg(M1, 'pending'), msg(M2, 'pending'), msg(M3, 'pending')];
routes['GET /api/xsession/config'] = () => ({ status: 200, body: { enabled: true, nativeGuard: { lastFailureAt: null }, stored: { unfinished: 0 } } });
routes['GET /api/xsession/pending'] = () => ({ status: 200, body: { total: 0, sessions: [] } });
routes['GET /api/xsession/messages'] = () => ({ status: 200, body: { messages: serverMsgs } });
const storageText = () => [...mem.values()].join('\n');
const queueOf = () => useStore.getState().messageQueue[B] || [];

// 会话正忙时 App.jsx handleSend 的入队写法(源码钉在第 4 节):opts 浅拷贝、去掉回调后整份进队列
const busySend = (prompt, opts) => {
  const queueOpts = { ...opts };
  delete queueOpts.onEnqueueFailure; delete queueOpts.onQueued; delete queueOpts.fromComposer;
  return useStore.getState().enqueueMessage(B, { text: prompt, queuedAt: Date.now(), hidden: !!opts.hiddenUserMessage, opts: queueOpts });
};

await xs.loadXsConfig();
const unwatch = xs.watchXsInbox(B);
await settle();

// ── 1. 忙时点【处理】:排进队列的只有消息 id;不认领;持久存储里没有凭据;卡片文案"已排队" ──
{
  const r = await xs.processXsMessage({ sessionId: B, messageId: M1, send: busySend, isStillOn: () => true });
  await settle();
  assert.deepEqual(r, { ok: true });
  assert.equal(queueOf().length, 1, '排进队列一条');
  assert.deepEqual(queueOf()[0].opts, { hiddenUserMessage: true, xsProcess: { messageId: M1, sessionId: B } }, '队列条目只带消息 id 与会话 id');
  assert.equal(count(`POST /api/xsession/messages/${M1}/claim`), 0, '排队时不认领');
  assert.ok(storageText().includes(M1), '前提:队列确实落进了 localStorage');
  assert.ok(!/token/i.test(JSON.stringify(queueOf())), '队列条目里没有任何 token 字段');
  assert.equal(useXsStoreStatus(M1), 'pending', '消息在服务端与卡片上都仍是 pending');
  assert.equal(xs.xsCardReasonText(msg(M1, 'pending'), true), '已排队，当前回合结束后处理', '卡片原因文案');
  assert.equal(xs.xsCardReasonText(msg(M1, 'pending'), false), '等待你确认后处理', '没排队时原样');
  // 再点一次:已在排队里,不重复排
  const again = await xs.processXsMessage({ sessionId: B, messageId: M1, send: busySend, isStillOn: () => true });
  await settle();
  assert.equal(again.ok, false);
  assert.equal(queueOf().length, 1, '同一条不重复排');
  console.log('✓ 忙时点【处理】:队列里只有消息 id,不认领,localStorage 里没有凭据');
}
function useXsStoreStatus(id) { return (xs.useXsStore.getState().inbox[B] || []).find((m) => m.id === id)?.status; }

// ── 2. 轮到它发出:这时才认领;凭据只在返回值里;认领之后 localStorage 里仍然没有凭据 ──
{
  routes[`POST /api/xsession/messages/${M1}/claim`] = () => ({ status: 200, body: { ok: true, id: M1, sessionId: B, token: TOKEN } });
  const next = useStore.getState().shiftMessage(B); // 流收尾 / 后台回合结束时的既有出队
  assert.equal(next.text, xs.XS_PROMPT_PLACEHOLDER);
  const c = await xs.claimXsForSend(next.opts.xsProcess, B);
  assert.equal(count(`POST /api/xsession/messages/${M1}/claim`), 1, '出队发出前才认领,且只认领一次');
  assert.deepEqual(c, { ok: true, fields: { xsMessageId: M1, xsToken: TOKEN } }, '凭据只交给这一次请求体');
  assert.equal(useXsStoreStatus(M1), 'claimed', '卡片转"等待发送"');
  assert.ok(!storageText().includes(TOKEN), '认领后 localStorage 里也没有凭据');
  assert.ok(!JSON.stringify(next.opts).includes(TOKEN), '出队条目的 opts 没被写进凭据');
  console.log('✓ 出队发出前才认领,凭据不落任何持久存储');
}

// ── 3. 认领失败(已被忽略 / 已不在)→ 不给凭据,按最新状态刷新卡片 ──
{
  await xs.processXsMessage({ sessionId: B, messageId: M2, send: busySend, isStillOn: () => true });
  await settle();
  serverMsgs = [msg(M1, 'claimed'), msg(M3, 'pending')]; // M2 背后已被忽略
  routes[`POST /api/xsession/messages/${M2}/claim`] = () => ({ status: 409, body: { ok: false, code: 'XS_NOT_PENDING', error: '消息不是待处理状态', status: 'dismissed' } });
  const before = count('GET /api/xsession/messages');
  const next = useStore.getState().shiftMessage(B);
  const c = await xs.claimXsForSend(next.opts.xsProcess, B);
  await settle();
  assert.equal(c.ok, false, '认领失败不发送');
  assert.equal(c.fields, undefined, '没有凭据');
  assert.ok(count('GET /api/xsession/messages') > before, '按最新状态刷新卡片');
  assert.equal(useXsStoreStatus(M2), undefined, '已忽略的卡片消失');
  console.log('✓ 认领失败:不发送、刷新卡片');
}

// ── 3b. 审计 S4:认领应答里凭据字段不全 / 形状不对 → 不发送(不给请求字段),按最新状态刷新卡片,给一行提示 ──
{
  for (const bad of [{ ok: true, id: M3, sessionId: B }, { ok: true, id: M3, sessionId: B, token: 'abc' }, { ok: true, id: M3, sessionId: B, token: '' }]) {
    serverMsgs = [msg(M1, 'claimed'), msg(M3, 'claimed')];
    routes[`POST /api/xsession/messages/${M3}/claim`] = () => ({ status: 200, body: bad });
    const before = count('GET /api/xsession/messages');
    const c = await xs.claimXsForSend({ messageId: M3, sessionId: B }, B);
    await settle();
    assert.equal(c.ok, false, `凭据 ${JSON.stringify(bad.token)}:不发送`);
    assert.equal(c.fields, undefined, '不给请求字段');
    assert.ok(typeof c.notice === 'string' && c.notice.includes('没有发出'), '给一行提示');
    assert.ok(count('GET /api/xsession/messages') > before, '按最新状态刷新卡片');
  }
  serverMsgs = [msg(M1, 'claimed'), msg(M3, 'pending')];
  console.log('✓ S4:凭据字段不全时不发送、刷新卡片');
}

// ── 4. 排队中点【忽略】:排队里的这一条一并取消,出队时不会再去认领 ──
{
  const claimed0 = count(`POST /api/xsession/messages/${M3}/claim`);
  await xs.processXsMessage({ sessionId: B, messageId: M3, send: busySend, isStillOn: () => true });
  await settle();
  assert.equal(queueOf().length, 1, '前提:M3 已排队');
  routes[`POST /api/xsession/messages/${M3}/dismiss`] = () => ({ status: 200, body: { ok: true, id: M3, status: 'dismissed' } });
  assert.deepEqual(await xs.dismissXsMessage({ sessionId: B, messageId: M3 }), { ok: true });
  assert.equal(queueOf().length, 0, '排队里的这一条被取消');
  assert.equal(count(`POST /api/xsession/messages/${M3}/claim`), claimed0, '排队到取消都没认领过');
  console.log('✓ 排队中忽略:一并取消排队');
}
unwatch();

// ── 5. App.jsx 接缝(源码):入队是 opts 浅拷贝;发出前才认领;凭据只经局部变量进请求体;不再有带凭据的 opts ──
{
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const app = readFileSync(join(ROOT, 'client', 'src', 'App.jsx'), 'utf8');
  const hsHead = 'const handleSend = useCallback(async (prompt, opts = {}) => {';
  const hs = app.indexOf(hsHead);
  assert.ok(hs > 0, '找到 handleSend');
  const he = app.indexOf('= useCallback(', hs + hsHead.length);
  const body = app.slice(hs, he > 0 ? he : undefined);
  const enq = body.indexOf('const queueOpts = { ...opts };');
  const enqCall = body.indexOf('enqueueMessage(sessionQueueKey, { text: prompt, queuedAt, hidden: !!hiddenUserMessage, opts: queueOpts })');
  const claim = body.indexOf('await claimXsForSend(opts.xsProcess, sid)');
  const post = body.indexOf("await fetch('/api/chat', {");
  assert.ok(enq > 0 && enqCall > enq, '会话正忙时入队的是 opts 的浅拷贝(与第 1 节 busySend 同一写法)');
  assert.ok(claim > enqCall && post > claim, '认领在入队之后(只在真正发出的路径上)、POST /api/chat 之前');
  assert.ok(body.includes('if (!xsClaimed.ok || !xsClaimed.fields) {'), '认领不成或凭据字段不全都不发送(S4)');
  const code = body.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n'); // 去掉整行注释
  const uses = code.match(/\bxsFields\b/g) || [];
  assert.equal(uses.length, 3, `xsFields 只在声明、赋值、请求体里出现(实际 ${uses.length} 处)`);
  assert.ok(body.includes('...(xsFields || {}),'), '请求体从局部变量取两个新字段');
  assert.ok(!/opts\.xsClaim|xsClaim:/.test(app), 'App.jsx 不再有带凭据的 opts.xsClaim');
  const xsSrc = readFileSync(join(ROOT, 'client', 'src', 'utils', 'xsession.js'), 'utf8');
  assert.ok(!/xsClaim:/.test(xsSrc), 'xsession.js 不再把凭据放进发送参数');
  assert.ok(!/\b(localStorage|sessionStorage|indexedDB)\s*\./.test(xsSrc), 'xsession.js 不直接读写任何浏览器持久存储');
  console.log('✓ App.jsx 接缝:入队浅拷贝 opts、发出前认领、凭据只经局部变量进请求体');
}

console.log('PASS check-r151b-xs-claim-late');
process.exit(0);
