#!/usr/bin/env node
// r151c 派工 5:前端跨会话二期的状态收敛(client/src/utils/xsession.js)。真 import 被测模块,只把服务端换成按路径应答的 fetch 替身。
//   ① WS xs:inbound / xs:turn 按事件里的 sessionId 收敛,不读"当前选中会话"(sessionStore 的选中 / 窗格字段一读就抛错)
//   ② xs:config 的 autoPaused 收敛、计数重取;【恢复自动处理】成功 / 失败("没有恢复：<原因>")
//   ③ 接收设置:取值、改成功、改失败回到原值并给"接收设置没有保存：<原因>"、xs:inbound 清提示、断线重连重取
//   ④ P22:点【处理】一条 queued 的消息 → 当场认领(服务端此刻起不再自动处理它);凭据只在内存,不进 opts / 排队 / localStorage;
//      真正发出时用这张凭据、不再认领;认领 409 → 不发;撤回后作废
//   ⑤ 卡片文案:AI 发来的来源带目录名;连锁第 N 次
//   ⑦ 审计 I1:随每次发送带上的全局设置同步给服务端(开关打开 / 重连强制发、变化合并 300 毫秒后发、值没变不发、关着不发)
// node tests/unit/check-r151c-xs-ui-client.mjs
import assert from 'node:assert/strict';

const listeners = new Map();
{
  const mem = new Map();
  globalThis.localStorage = {
    get length() { return mem.size; }, key: (i) => [...mem.keys()][i] ?? null,
    getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); }, clear: () => mem.clear(),
  };
  if (!globalThis.window) globalThis.window = globalThis;
  globalThis.addEventListener = (t, f) => { if (!listeners.has(t)) listeners.set(t, new Set()); listeners.get(t).add(f); };
  globalThis.removeEventListener = (t, f) => { listeners.get(t)?.delete(f); };
}
const fire = (t) => { for (const f of [...(listeners.get(t) || [])]) f({ type: t }); };

const calls = []; // { line, body }
const routes = {};
globalThis.fetch = async (url, opts = {}) => {
  const method = (opts && opts.method) || 'GET';
  const u = new URL(url, 'http://127.0.0.1:6999');
  const body = opts && typeof opts.body === 'string' ? JSON.parse(opts.body) : undefined;
  calls.push({ line: `${method} ${u.pathname}${u.search}`, body });
  const h = routes[`${method} ${u.pathname}`];
  const r = h ? h(u, body) : { status: 404, body: { ok: false } };
  if (r === 'NETWORK') throw new TypeError('fetch failed');
  return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async () => { for (let i = 0; i < 8; i += 1) await sleep(0); };
const count = (prefix) => calls.filter((c) => c.line.startsWith(prefix)).length;
const lastBody = (prefix) => [...calls].reverse().find((c) => c.line.startsWith(prefix))?.body;

const xs = await import('../../client/src/utils/xsession.js');
const { useStore } = await import('../../client/src/stores/sessionStore.js');
const { useXsStore } = xs;

const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const MQ = '11111111-0000-4000-8000-000000000001';
const MQ2 = '22222222-0000-4000-8000-000000000002';
const MQ3 = '33333333-0000-4000-8000-000000000003';
const TOKEN = 'cccccccc-0000-4000-8000-00000000000c';
const TOKEN3 = 'dddddddd-0000-4000-8000-00000000000d';
const msg = (id, status, extra = {}) => ({
  id, createdAt: '2026-10-16T01:00:00.000Z', status, chainId: id, hop: 1,
  from: { kind: 'session', sessionId: A, title: '甲', project: 'proj-a', deleted: false }, to: { sessionId: B, title: '乙' },
  body: `正文-${id.slice(0, 2)}`, bodyBytes: 9, via: null, heldReason: null, heldText: null, ...extra,
});

const cfg = { enabled: true, autoPaused: false, autoBudget: { limit: 20, windowMs: 600000, used: 3 }, limits: { bodyBytes: 32768, pendingPerSession: 50, chainDepth: 4, targetsPerSend: 8, sendsPerTurn: 16 }, nativeGuard: { lastFailureAt: null }, stored: { unfinished: 0 } };
let serverInbound = 'card';
let serverMsgs = [];
routes['GET /api/xsession/config'] = () => ({ status: 200, body: structuredClone(cfg) });
routes['GET /api/xsession/pending'] = () => ({ status: 200, body: { total: 0, sessions: [] } });
routes['GET /api/xsession/messages'] = (u) => ({ status: 200, body: { messages: u.searchParams.get('sessionId') === B ? serverMsgs : [] } });
routes['GET /api/xsession/sessions'] = (u) => ({ status: 200, body: { sessions: (u.searchParams.get('ids') || '').split(',').filter((id) => id === A).map((sessionId) => ({ sessionId, inbound: serverInbound, hasProfile: true })) } });
routes['GET /api/agents/active'] = () => ({ status: 200, body: { agents: [] } });

const stop = xs.startXsession();
await settle();
assert.equal(useXsStore.getState().enabled, true, '前置:开着');
assert.equal(useXsStore.getState().autoUsed, 3, 'GET config 的 autoBudget.used 进了 store');
assert.equal(useXsStore.getState().autoPaused, false);

// ── ① 两种新事件按 sessionId 收敛,不读当前选中会话 ─────────────────────────────────
{
  useStore.setState({ selectedSession: { sessionId: B, projectHash: 'h' }, paneSessions: [{ sessionId: B }], activeTabIndex: 0 });
  const st = useStore.getState();
  const PICKED = ['selectedSession', 'paneSessions', 'activeTabIndex'];
  for (const k of PICKED) {
    Object.defineProperty(st, k, { get() { throw new Error(`跨会话事件读了"当前选中会话"的字段 ${k}`); }, configurable: true });
  }
  xs.handleXsWsEvent({ type: 'xs:inbound', sessionId: A, mode: 'auto' });
  assert.equal(useXsStore.getState().inboundBySession[A], 'auto', 'xs:inbound 收敛到事件里的会话');
  assert.equal(useXsStore.getState().inboundBySession[B], undefined, '当前选中的会话不受影响');
  xs.handleXsWsEvent({ type: 'xs:inbound', sessionId: A, mode: 'bogus' });
  xs.handleXsWsEvent({ type: 'xs:inbound', sessionId: 'not-an-id', mode: 'card' });
  assert.equal(useXsStore.getState().inboundBySession[A], 'auto', '非法 mode / 非法 id 不收敛');
  const n0 = count('GET /api/agents/active');
  xs.handleXsWsEvent({ type: 'xs:turn', sessionId: A, pid: 4321, messageId: MQ });
  await settle();
  assert.equal(count('GET /api/agents/active'), n0 + 1, 'xs:turn → 立刻探测一次后台运行(各窗格按自己的会话认领)');
  xs.handleXsWsEvent({ type: 'xs:turn', sessionId: 'nope', pid: 1, messageId: MQ });
  await settle();
  assert.equal(count('GET /api/agents/active'), n0 + 1, 'sessionId 不是会话 id → 不探测');
  for (const k of PICKED) delete st[k]; // 撤掉抛错的读取器(setState 合并时会读到)
  useStore.setState({ selectedSession: null, paneSessions: [], activeTabIndex: 0 });
  console.log('✓ ① xs:inbound / xs:turn 按事件里的 sessionId 收敛,不读当前选中会话');
}

// ── ② 暂停 / 恢复只经 xs:config;恢复的成功与失败 ───────────────────────────────────
{
  cfg.autoPaused = true;
  cfg.autoBudget.used = 20;
  const g0 = count('GET /api/xsession/config');
  xs.handleXsWsEvent({ type: 'xs:config', enabled: true, autoPaused: true });
  assert.equal(useXsStore.getState().autoPaused, true, 'xs:config autoPaused:true → 暂停');
  await settle();
  assert.equal(count('GET /api/xsession/config'), g0 + 1, '暂停状态变了 → 重取一次 config(计数)');
  assert.equal(useXsStore.getState().autoUsed, 20);
  xs.handleXsWsEvent({ type: 'xs:config', enabled: true, autoPaused: true });
  await settle();
  assert.equal(count('GET /api/xsession/config'), g0 + 1, '同值不重取');

  routes['PUT /api/xsession/config'] = () => ({ status: 500, body: { ok: false, code: 'STORAGE_WRITE_FAILED', error: '写入偏好失败' } });
  let r = await xs.resumeXsAuto();
  assert.deepEqual(r, { ok: false, error: '没有恢复：写入偏好失败' }, '恢复失败:提示带服务端的 error');
  assert.deepEqual(lastBody('PUT /api/xsession/config'), { autoPaused: false }, '请求体只有 autoPaused:false');
  assert.equal(useXsStore.getState().autoPaused, true, '恢复失败:暂停不变');
  routes['PUT /api/xsession/config'] = () => 'NETWORK';
  r = await xs.resumeXsAuto();
  assert.deepEqual(r, { ok: false, error: '没有恢复：网络错误' });
  routes['PUT /api/xsession/config'] = () => { cfg.autoPaused = false; cfg.autoBudget.used = 0; return { status: 200, body: { ok: true, enabled: true, autoPaused: false } }; };
  r = await xs.resumeXsAuto();
  assert.deepEqual(r, { ok: true });
  assert.equal(useXsStore.getState().autoPaused, false, '恢复成功:不再暂停');
  assert.equal(useXsStore.getState().autoUsed, 0, '恢复成功后重取 config,计数回到 0');
  console.log('✓ ② 暂停 / 恢复经 xs:config 收敛;恢复失败给"没有恢复：<原因>",暂停不变');
}

// ── ③ 接收设置 ─────────────────────────────────────────────────────────────────
{
  serverInbound = 'card';
  const un = xs.watchXsInbound(A);
  await settle();
  assert.ok(calls.some((c) => c.line === `GET /api/xsession/sessions?ids=${A}`), '关注时按 ids 取这一个会话');
  assert.equal(useXsStore.getState().inboundBySession[A], 'card', '以接口为准');

  const PUT = `PUT /api/xsession/sessions/${A}/inbound`;
  routes[PUT] = () => ({ status: 500, body: { ok: false, code: 'STORAGE_WRITE_FAILED', error: '写入偏好失败' } });
  let r = await xs.setXsInbound(A, 'auto');
  assert.equal(r.ok, false);
  assert.deepEqual(lastBody(PUT), { mode: 'auto' });
  assert.equal(useXsStore.getState().inboundBySession[A], 'card', '失败:回到原值');
  assert.equal(useXsStore.getState().inboundError[A], '接收设置没有保存：写入偏好失败', '失败提示逐字');
  xs.handleXsWsEvent({ type: 'xs:inbound', sessionId: A, mode: 'card' });
  assert.equal(useXsStore.getState().inboundError[A], undefined, '收到该会话的 xs:inbound → 提示清掉');
  routes[PUT] = () => 'NETWORK';
  r = await xs.setXsInbound(A, 'auto');
  assert.equal(useXsStore.getState().inboundError[A], '接收设置没有保存：网络错误');
  xs.clearXsInboundError(A);
  assert.equal(useXsStore.getState().inboundError[A], undefined, '提示可关');
  routes[PUT] = (_u, body) => { serverInbound = body.mode; return { status: 200, body: { ok: true, sessionId: A, mode: body.mode } }; };
  r = await xs.setXsInbound(A, 'auto');
  assert.deepEqual(r, { ok: true });
  assert.equal(useXsStore.getState().inboundBySession[A], 'auto', '成功:按应答');

  serverInbound = 'card'; // 断线期间别处改回了"等你确认"(广播丢了)
  const s0 = count(`GET /api/xsession/sessions?ids=${A}`);
  const g0 = count('GET /api/xsession/config');
  fire('cgui:ws-reconnected');
  await settle();
  assert.equal(count('GET /api/xsession/config'), g0 + 1, '重连 → 重取 config');
  assert.equal(count(`GET /api/xsession/sessions?ids=${A}`), s0 + 1, '重连 → 重取正显示的接收设置');
  assert.equal(useXsStore.getState().inboundBySession[A], 'card', '以重取结果为准');
  un();
  fire('cgui:ws-reconnected');
  await settle();
  assert.equal(count(`GET /api/xsession/sessions?ids=${A}`), s0 + 1, '不再显示(菜单关了)就不重取');
  console.log('✓ ③ 接收设置:取值、改成功、改失败回原值并提示、xs:inbound 清提示、断线重连重取');
}

// ── ④ P22:点【处理】一条 queued 的消息 ───────────────────────────────────────────────
{
  serverMsgs = [msg(MQ, 'queued', { hop: 2 }), msg(MQ2, 'queued'), msg(MQ3, 'queued')];
  const unwatch = xs.watchXsInbox(B);
  await settle();
  assert.deepEqual((useXsStore.getState().inbox[B] || []).map((m) => m.status), ['queued', 'queued', 'queued'], '前置:三条 queued');
  const claimOf = (id) => `POST /api/xsession/messages/${id}/claim`;
  routes[claimOf(MQ)] = () => ({ status: 200, body: { ok: true, id: MQ, sessionId: B, token: TOKEN } });
  const sent = [];
  const send = (p, o) => {
    sent.push([p, o]);
    useStore.getState().enqueueMessage(B, { text: p, queuedAt: Date.now(), hidden: true, opts: o }); // 会话正忙:进既有排队(会落 localStorage)
  };
  let r = await xs.processXsMessage({ sessionId: B, messageId: MQ, send, isStillOn: () => true });
  await settle();
  assert.deepEqual(r, { ok: true });
  assert.equal(count(claimOf(MQ)), 1, '点下那一刻就认领:服务端此刻起不再自动处理它(调度器只投 queued)');
  assert.equal(useXsStore.getState().inbox[B].find((m) => m.id === MQ).status, 'claimed', '卡片转"等待发送"');
  assert.deepEqual(sent.map(([, o]) => o), [{ hiddenUserMessage: true, xsProcess: { messageId: MQ, sessionId: B } }], '交给发送流程的 opts 只带消息 id');
  assert.ok(!JSON.stringify(useStore.getState().messageQueue).includes(TOKEN), '排队里没有凭据');
  let dump = '';
  for (let i = 0; i < localStorage.length; i += 1) dump += localStorage.getItem(localStorage.key(i));
  assert.ok(!dump.includes(TOKEN), 'localStorage 里没有凭据(审计 F1)');
  let c = await xs.claimXsForSend(sent[0][1].xsProcess, B);
  assert.deepEqual(c, { ok: true, fields: { xsMessageId: MQ, xsToken: TOKEN } }, '真正发出时用点下时领的凭据');
  assert.equal(count(claimOf(MQ)), 1, '发出时不再认领');
  routes[claimOf(MQ)] = () => ({ status: 409, body: { ok: false, code: 'XS_NOT_PENDING', error: '这条消息不是待处理状态', status: 'processing' } });
  c = await xs.claimXsForSend(sent[0][1].xsProcess, B);
  assert.equal(c.ok, false, '凭据只用一次:再发要重新认领,409 → 不发');
  assert.equal(count(claimOf(MQ)), 2);

  // 认领 409(调度器已先一步自动处理了它)→ 不交给发送流程,卡片按最新状态刷新
  routes[claimOf(MQ2)] = () => ({ status: 409, body: { ok: false, code: 'XS_NOT_PENDING', error: '这条消息不是待处理状态', status: 'processing' } });
  serverMsgs = [msg(MQ, 'processing', { hop: 2 }), msg(MQ2, 'processing', { via: 'auto' }), msg(MQ3, 'queued')];
  const before = sent.length;
  r = await xs.processXsMessage({ sessionId: B, messageId: MQ2, send, isStillOn: () => true });
  await settle();
  assert.deepEqual(r, { ok: false, error: '' }, '409 不另行提示');
  assert.equal(sent.length, before, '没认领到就不发');
  assert.equal(useXsStore.getState().inbox[B].find((m) => m.id === MQ2).status, 'processing', '卡片已按最新状态刷新');

  // 认领后撤回:凭据作废,之后要发就得重新认领
  routes[claimOf(MQ3)] = () => ({ status: 200, body: { ok: true, id: MQ3, sessionId: B, token: TOKEN3 } });
  routes[`POST /api/xsession/messages/${MQ3}/release`] = () => ({ status: 200, body: { ok: true, id: MQ3, status: 'pending' } });
  r = await xs.processXsMessage({ sessionId: B, messageId: MQ3, send: () => {}, isStillOn: () => true });
  assert.deepEqual(r, { ok: true });
  assert.equal(count(claimOf(MQ3)), 1);
  assert.deepEqual(await xs.releaseXsMessage({ sessionId: B, messageId: MQ3 }), { ok: true });
  c = await xs.claimXsForSend({ messageId: MQ3, sessionId: B }, B);
  assert.equal(count(claimOf(MQ3)), 2, '撤回后内存里的凭据作废,发出时重新认领');
  assert.deepEqual(c, { ok: true, fields: { xsMessageId: MQ3, xsToken: TOKEN3 } });
  unwatch();
  console.log('✓ ④ P22:queued 点【处理】当场认领,凭据只在内存、发出时取用一次;409 不发;撤回作废');
}

// ── ⑤ 卡片文案 ─────────────────────────────────────────────────────────────────
{
  assert.equal(xs.xsCardFromText({ from: { kind: 'session', title: '甲', project: 'proj-a' } }), '来自 甲 · proj-a', 'AI 发来的:来自 <标题> · <目录名>');
  assert.equal(xs.xsCardFromText({ from: { kind: 'session', title: '甲' } }), '来自 甲', '没有目录名时与一期相同');
  assert.equal(xs.xsCardFromText({ from: { kind: 'user', title: '甲', project: 'x' } }), '由你从 甲 转发', '手动转发的不变');
  assert.equal(xs.xsCardHopText({ hop: 5 }), '连锁第 5 次');
  assert.equal(xs.xsCardHopText({ hop: 1 }), '', 'hop 为 1 不显示');
  assert.equal(xs.xsCardHopText({}), '');
  assert.equal(xs.xsCardReasonText({ status: 'queued' }), '目标会话正在运行，回合结束后自动处理');
  console.log('✓ ⑤ 卡片来源带目录名、连锁第 N 次、排队原因');
}

// ── ⑥ 总开关关:新事件不收敛,接收设置清空 ───────────────────────────────────────────
{
  cfg.enabled = false;
  xs.handleXsWsEvent({ type: 'xs:config', enabled: false });
  await settle();
  assert.equal(useXsStore.getState().enabled, false);
  assert.deepEqual(useXsStore.getState().inboundBySession, {}, '关:接收设置清空');
  const n0 = count('GET /api/agents/active');
  xs.handleXsWsEvent({ type: 'xs:inbound', sessionId: A, mode: 'auto' });
  xs.handleXsWsEvent({ type: 'xs:turn', sessionId: A, pid: 1, messageId: MQ });
  await settle();
  assert.deepEqual(useXsStore.getState().inboundBySession, {}, '关着不收敛 xs:inbound');
  assert.equal(count('GET /api/agents/active'), n0, '关着不为 xs:turn 探测');
  assert.deepEqual(await xs.setXsInbound(A, 'auto'), { ok: false, error: '' }, '关着不发改接收设置的请求');
  console.log('✓ ⑥ 总开关关:新事件不收敛、不请求');
}

// ── ⑦ 审计 I1:全局设置同步给服务端 ─────────────────────────────────────────────────
{
  const SS = 'PUT /api/xsession/send-settings';
  routes[SS] = () => ({ status: 200, body: { ok: true } });
  const n0 = count(SS);
  cfg.enabled = true;
  xs.handleXsWsEvent({ type: 'xs:config', enabled: true, autoPaused: false });
  await settle();
  assert.equal(count(SS), n0 + 1, '开关打开:同步一次');
  assert.deepEqual(lastBody(SS), { globalRead: true, addDirs: [], maxBudgetUsd: null, keepAlive: true, promptSuggestions: 'auto', genui: true }, '请求体 = 当前全局设置(默认值,形态同发送 /api/chat)');
  const st = useStore.getState();
  st.setGlobalRead(false); st.setAddDirs(['/r151c/extra']); st.setMaxBudgetUsd('2.5');
  await sleep(350); await settle();
  assert.equal(count(SS), n0 + 2, '连续改三项:合并成一次');
  const b = lastBody(SS);
  assert.deepEqual([b.globalRead, b.addDirs, b.maxBudgetUsd], [false, ['/r151c/extra'], 2.5], '带最新值');
  st.setAddDirs(['/r151c/extra']);
  useStore.setState({ xsUnrelatedProbe: 1 });
  await sleep(350); await settle();
  assert.equal(count(SS), n0 + 2, '值没变、改的是别的字段:不发');
  fire('cgui:ws-reconnected');
  await settle(); await sleep(20); await settle();
  assert.equal(count(SS), n0 + 3, '断线重连:强制重发一次(服务端那份只在内存)');
  cfg.enabled = false;
  xs.handleXsWsEvent({ type: 'xs:config', enabled: false });
  await settle();
  st.setGlobalRead(true);
  await sleep(350); await settle();
  assert.equal(count(SS), n0 + 3, '总开关关着:不发');
  console.log('✓ ⑦ 全局设置同步给服务端');
}

stop();
console.log('PASS check-r151c-xs-ui-client');
process.exit(0);
