#!/usr/bin/env node
// r151b T-X7:前端跨会话状态收敛(client/src/utils/xsession.js)与 Dock 角标合并规则(utils/attention.js)。
// 真 import 被测模块;只把服务端换成按路径应答的 fetch 替身(核心逻辑 —— 收敛、分发、按钮动作 —— 都是真的)。
// node tests/unit/check-r151b-xs-client.mjs
import assert from 'node:assert/strict';

// ── 浏览器全局的最小替身(sessionStore 顶层要 localStorage;startXsession 要 window 事件) ──
{
  const mem = new Map();
  globalThis.localStorage = {
    get length() { return mem.size; }, key: (i) => [...mem.keys()][i] ?? null,
    getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); }, clear: () => mem.clear(),
  };
  if (!globalThis.window) globalThis.window = globalThis;
  if (!globalThis.addEventListener) { globalThis.addEventListener = () => {}; globalThis.removeEventListener = () => {}; }
}

const calls = [];
const routes = {};
globalThis.fetch = async (url, opts = {}) => {
  const method = (opts && opts.method) || 'GET';
  const u = new URL(url, 'http://127.0.0.1:6999');
  calls.push(`${method} ${u.pathname}${u.search}`);
  const h = routes[`${method} ${u.pathname}`];
  const r = h ? h(u) : { status: 404, body: { ok: false } };
  return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async () => { for (let i = 0; i < 6; i += 1) await sleep(0); };
const count = (prefix) => calls.filter((c) => c.startsWith(prefix)).length;

const xs = await import('../../client/src/utils/xsession.js');
const { nextBadgeState, resetBadgeState } = await import('../../client/src/utils/attention.js');
const { useStore } = await import('../../client/src/stores/sessionStore.js');
const { useXsStore } = xs;

const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const M1 = '11111111-0000-4000-8000-000000000001';
const M2 = '22222222-0000-4000-8000-000000000002';
const M3 = '33333333-0000-4000-8000-000000000003';
const TOKEN = 'cccccccc-0000-4000-8000-00000000000c';
const msg = (id, status, extra = {}) => ({
  id, createdAt: '2026-10-15T01:00:00.000Z', status, chainId: id, hop: 1,
  from: { kind: 'user', sessionId: A, title: '甲', deleted: false }, to: { sessionId: B, title: '乙' },
  body: `正文-${id.slice(0, 2)}`, bodyBytes: 9, via: null,
  heldReason: status === 'pending' ? 'target-card' : null, heldText: status === 'pending' ? '等待你确认后处理' : null, ...extra,
});
const noBody = (m) => { const c = { ...m }; delete c.body; return c; };
let serverMsgs = [msg(M1, 'pending'), msg(M2, 'pending')];
routes['GET /api/xsession/config'] = () => ({ status: 200, body: { enabled: true, limits: { bodyBytes: 32768, pendingPerSession: 50 }, nativeGuard: { lastFailureAt: null } } });
routes['GET /api/xsession/pending'] = () => ({ status: 200, body: { total: 3, sessions: [{ sessionId: B, projectPath: '/p/b/', pending: 2 }, { sessionId: A, projectPath: '/p/b', pending: 1 }] } });
routes['GET /api/xsession/messages'] = (u) => ({ status: 200, body: { messages: u.searchParams.get('sessionId') === B ? serverMsgs : [] } });

// ── 1. 总开关关:WS 事件不收敛,选择器给的都是"没有" ─────────────────────────────
{
  assert.equal(useXsStore.getState().enabled, false, '默认关');
  xs.handleXsWsEvent({ type: 'xs:message', message: noBody(msg(M1, 'pending')) });
  await settle();
  assert.deepEqual(useXsStore.getState().inbox, {}, '开关关时不收敛 xs:message');
  assert.equal(calls.length, 0, '开关关时不发任何请求');
  console.log('✓ 开关关:不收敛、不请求');
}

// ── 2. 打开:计数按会话 / 项目汇总(项目目录去尾部分隔符后同一口径) ───────────────────
{
  await xs.loadXsConfig();
  await settle();
  const st = useXsStore.getState();
  assert.equal(st.enabled, true);
  assert.equal(st.pendingTotal, 3, 'total 取接口值');
  assert.equal(st.pendingBySession[B], 2);
  assert.equal(st.pendingByProject['/p/b'], 3, '同一项目两个写法(尾部 /)汇总到一处');
  assert.equal(xs.xsProjectPending(st.pendingByProject, '/p/b/'), 3);
  console.log('✓ 打开后计数:按会话、按项目');
}

// ── 3. 收件箱:只拉被关注的会话;xs:message 按 to.sessionId 分发;已知消息就地合并、不重拉 ───────
{
  const unwatch = xs.watchXsInbox(B);
  await settle();
  let list = useXsStore.getState().inbox[B];
  assert.deepEqual(list.map((m) => [m.id, m.status, m.body]), [[M1, 'pending', '正文-11'], [M2, 'pending', '正文-22']]);
  const before = count('GET /api/xsession/messages');
  xs.handleXsWsEvent({ type: 'xs:message', message: noBody(msg(M1, 'claimed')) });
  list = useXsStore.getState().inbox[B];
  assert.equal(list[0].status, 'claimed', '已知消息:状态就地合并');
  assert.equal(list[0].body, '正文-11', '已知消息:保留已有正文(广播不带正文)');
  assert.deepEqual(list[0].heldBefore, { heldReason: 'target-card', heldText: '等待你确认后处理' }, '离开 pending 时记下原因');
  await settle();
  assert.equal(count('GET /api/xsession/messages'), before, '已知消息的状态变化不整表重拉');
  // 目标是别的会话:不进 B 的收件箱,也不替没关注的会话去拉
  xs.handleXsWsEvent({ type: 'xs:message', message: noBody({ ...msg(M3, 'pending'), to: { sessionId: A, title: '甲' } }) });
  await settle();
  assert.equal(useXsStore.getState().inbox[B].length, 2, '按 message.to.sessionId 分发,不串到 B');
  assert.equal(useXsStore.getState().inbox[A], undefined, '没被关注的会话不拉');
  assert.equal(count('GET /api/xsession/messages'), before);
  // 没见过的消息(要正文)→ 重拉 B
  serverMsgs = [msg(M1, 'claimed'), msg(M2, 'pending'), msg(M3, 'pending')];
  xs.handleXsWsEvent({ type: 'xs:message', message: noBody(msg(M3, 'pending')) });
  await settle();
  assert.equal(count('GET /api/xsession/messages'), before + 1, '新消息才重拉');
  assert.deepEqual(useXsStore.getState().inbox[B].map((m) => m.id), [M1, M2, M3], '按到达升序');
  // 结束的状态 → 移除
  xs.handleXsWsEvent({ type: 'xs:message', message: noBody(msg(M3, 'done', { via: 'card' })) });
  assert.deepEqual(useXsStore.getState().inbox[B].map((m) => m.id), [M1, M2], 'done 的消息离开卡片区');
  serverMsgs = [msg(M1, 'claimed'), msg(M2, 'pending')];
  unwatch();
  console.log('✓ 收件箱:按目标会话分发、已知消息就地合并、新消息才重拉');
}

// ── 4. 【处理】:只交出消息 id(不认领、不带凭据);真正发出前 claimXsForSend 才认领;认领 409 → 刷新、不给凭据 ───────
{
  const unwatch = xs.watchXsInbox(B);
  await settle();
  const sent = [];
  const claims = (id) => count(`POST /api/xsession/messages/${id}/claim`);
  let r = await xs.processXsMessage({ sessionId: B, messageId: M2, send: (p, o) => { sent.push([p, o]); }, isStillOn: () => true });
  await settle();
  assert.deepEqual(r, { ok: true });
  assert.equal(sent.length, 1, '交给发送入口一次');
  assert.equal(sent[0][0], xs.XS_PROMPT_PLACEHOLDER);
  assert.ok(sent[0][0].trim() && !sent[0][0].startsWith('/'), '占位 prompt 非空、不是斜杠命令');
  assert.deepEqual(sent[0][1], { hiddenUserMessage: true, xsProcess: { messageId: M2, sessionId: B } }, '不画"你"的气泡;只带消息 id,不带凭据');
  assert.equal(claims(M2), 0, '点【处理】这一步不认领');
  assert.equal(useXsStore.getState().inbox[B].find((m) => m.id === M2).status, 'pending', '没认领前消息仍是 pending');
  // 真正发出前才认领:凭据只在返回值里(给这一次请求体)
  routes['POST /api/xsession/messages/' + M2 + '/claim'] = () => ({ status: 200, body: { ok: true, id: M2, sessionId: B, token: TOKEN } });
  let c = await xs.claimXsForSend(sent[0][1].xsProcess, B);
  assert.deepEqual(c, { ok: true, fields: { xsMessageId: M2, xsToken: TOKEN } }, '发出前认领,请求体两个新字段');
  assert.equal(claims(M2), 1);
  assert.equal(useXsStore.getState().inbox[B].find((m) => m.id === M2).status, 'claimed', '卡片转"等待发送"');
  // 要发往的会话不是消息的目标:不认领、不发
  c = await xs.claimXsForSend({ messageId: M1, sessionId: B }, A);
  assert.deepEqual(c, { ok: false, notice: '' });
  assert.equal(claims(M1), 0, '目标不是本会话 → 不认领');
  // 认领 409(背后已被忽略)→ 不给凭据、按最新状态刷新
  serverMsgs = [msg(M2, 'claimed')];
  routes['POST /api/xsession/messages/' + M1 + '/claim'] = () => ({ status: 409, body: { ok: false, code: 'XS_NOT_PENDING', error: '消息不是待处理状态', status: 'dismissed' } });
  const before = count('GET /api/xsession/messages');
  c = await xs.claimXsForSend({ messageId: M1, sessionId: B }, B);
  await settle();
  assert.deepEqual(c, { ok: false, notice: '' }, '409 不给凭据,只刷新不另行提示');
  assert.ok(count('GET /api/xsession/messages') > before, '409 → 按最新状态刷新');
  assert.deepEqual(useXsStore.getState().inbox[B].map((m) => m.id), [M2], '刷新后已忽略的卡片消失');
  // 本窗格已换了会话 → 不交出去
  serverMsgs = [msg(M1, 'pending'), msg(M2, 'claimed')];
  r = await xs.processXsMessage({ sessionId: B, messageId: M1, send: (p, o) => { sent.push([p, o]); }, isStillOn: () => false });
  await settle();
  assert.equal(r.ok, false);
  assert.equal(sent.length, 1, '换了会话不交出去');
  unwatch();
  console.log('✓ 【处理】:只交出消息 id;发出前才认领;目标不符不认领;409 刷新不给凭据;换会话不交出');
}

// ── 5. 【撤回】恢复原因;【撤回】/【忽略】顺带撤掉前端排队里同一条 ─────────────────────────
{
  const unwatch = xs.watchXsInbox(B);
  await settle();
  xs.handleXsWsEvent({ type: 'xs:message', message: noBody(msg(M1, 'claimed')) }); // pending → claimed,记下原因
  routes['POST /api/xsession/messages/' + M1 + '/release'] = () => ({ status: 200, body: { ok: true, id: M1, status: 'pending' } });
  assert.deepEqual(await xs.releaseXsMessage({ sessionId: B, messageId: M1 }), { ok: true });
  const m1 = useXsStore.getState().inbox[B].find((m) => m.id === M1);
  assert.equal(m1.status, 'pending');
  assert.equal(xs.xsCardReasonText(m1), '等待你确认后处理', '撤回后原因恢复为认领前的');
  const queued = useStore.getState().enqueueMessage(B, { text: xs.XS_PROMPT_PLACEHOLDER, queuedAt: Date.now(), hidden: true, opts: { hiddenUserMessage: true, xsProcess: { messageId: M2, sessionId: B } } });
  assert.ok(queued, '前置:入队成功');
  routes['POST /api/xsession/messages/' + M2 + '/dismiss'] = () => ({ status: 200, body: { ok: true, id: M2, status: 'dismissed' } });
  assert.deepEqual(await xs.dismissXsMessage({ sessionId: B, messageId: M2 }), { ok: true });
  assert.equal((useStore.getState().messageQueue[B] || []).length, 0, '排队里的同一条被撤掉');
  assert.equal(useXsStore.getState().inbox[B].some((m) => m.id === M2), false, '忽略后卡片消失');
  unwatch();
  console.log('✓ 【撤回】恢复原因;撤回 / 忽略清掉排队里的同一条');
}

// ── 6. 关开关:收件箱与计数清空 ────────────────────────────────────────────────────
{
  xs.handleXsWsEvent({ type: 'xs:config', enabled: false });
  const st = useXsStore.getState();
  assert.equal(st.enabled, false);
  assert.deepEqual([st.pendingTotal, Object.keys(st.pendingBySession).length, Object.keys(st.inbox).length], [0, 0, 0]);
  console.log('✓ 关开关:状态清空');
}

// ── 6b. 行为清单第 26 条:关着时取残留条数;【清空】失败给服务端 error、成功置 0 并重取 config(服务端不广播) ──
{
  const cfg = (unfinished) => () => ({ status: 200, body: { enabled: false, limits: { bodyBytes: 32768, pendingPerSession: 50 }, nativeGuard: { lastFailureAt: null }, stored: { unfinished } } });
  routes['GET /api/xsession/config'] = cfg(2);
  xs.handleXsWsEvent({ type: 'xs:config', enabled: false }); // 别处关了开关
  await settle();
  assert.equal(useXsStore.getState().storedUnfinished, 2, '关着时重取 config 拿到残留条数');
  assert.equal(useXsStore.getState().enabled, false);
  routes['POST /api/xsession/clear'] = () => ({ status: 500, body: { ok: false, code: 'STORAGE_WRITE_FAILED', error: '保存失败，请重试' } });
  assert.deepEqual(await xs.clearXsStored(), { ok: false, error: '保存失败，请重试' }, '失败:返回服务端 error');
  assert.equal(useXsStore.getState().storedUnfinished, 2, '失败时条数不变');
  routes['POST /api/xsession/clear'] = () => ({ status: 200, body: { ok: true, removed: 3 } });
  routes['GET /api/xsession/config'] = cfg(0);
  const gets = count('GET /api/xsession/config');
  assert.deepEqual(await xs.clearXsStored(), { ok: true });
  assert.equal(useXsStore.getState().storedUnfinished, 0, '成功后条数为 0(提示与按钮消失)');
  assert.ok(count('GET /api/xsession/config') > gets, '成功后重取 config');
  routes['GET /api/xsession/config'] = () => ({ status: 200, body: { enabled: false, nativeGuard: { lastFailureAt: null } } });
  await xs.loadXsConfig();
  assert.equal(useXsStore.getState().storedUnfinished, 0, '应答没有 stored 时按 0');
  console.log('✓ 第 26 条:关着时取残留条数;清空失败给 error、成功置 0 并重取');
}

// ── 7. Dock 角标合并规则:角标 = 改动前的计数 + 跨会话待处理条数;标题只看改动前的计数 ─────────────
{
  resetBadgeState();
  assert.deepEqual(nextBadgeState(2, 3), { count: 5, title: 'CC-GUI (2)' }, '两部分直接相加;标题不变');
  assert.equal(nextBadgeState(2, 3), null, '没变不重发');
  assert.deepEqual(nextBadgeState(0, 3), { count: 3, title: 'CC-GUI' }, '只有跨会话消息:角标 3、标题无计数');
  assert.deepEqual(nextBadgeState(0, 0), { count: undefined, title: 'CC-GUI' }, '归零清角标');
  assert.deepEqual(nextBadgeState(4), { count: 4, title: 'CC-GUI (4)' }, '不给附加数 = 与改动前相同');
  resetBadgeState();
  console.log('✓ Dock 角标:相加不去重,标题口径不变');
}

// ── 8. 气泡对象与文案 ────────────────────────────────────────────────────────────
{
  const card = xs.peerFromXsEvent({ type: 'xs_message', id: M1, from: { kind: 'user', sessionId: A, title: '甲' }, body: '正文', via: 'card', hop: 1 });
  assert.equal(card.type, 'peer-message');
  assert.equal(xs.peerVia(card), 'card');
  assert.equal(xs.peerFromLabel(card), '用户转发自 甲', '手动转发显示来源名');
  assert.equal(xs.peerFromSession(card), A);
  assert.equal(xs.peerFromLabel(xs.peerFromXsEvent({ type: 'xs_message', id: M1, from: { kind: 'user', sessionId: null, title: null }, body: 'x', via: 'card' })), '用户', '没有来源会话为"用户"');
  const R = (origin, extra = {}) => xs.peerFromResultEvent({ type: 'result', uuid: 'u-1', origin, ...extra });
  const nat = R({ kind: 'peer', from: 'uds:/tmp/cc-socks/a.sock', name: '乙', body: '直播正文' });
  assert.equal(xs.peerVia(nat), 'native');
  assert.equal(xs.peerFromLabel(nat), '来自 乙');
  assert.equal(xs.peerFromLabel(R({ kind: 'peer', from: 'uds:/x' })), '来自另一个会话', '名字缺失');
  assert.equal(R({ kind: 'peer', from: 'uds:/x' }).body, null, '正文缺失为 null(界面显示固定文案)');
  assert.equal(xs.PEER_BODY_MISSING, '（内容未能解析）');
  assert.equal(R({ kind: 'peer', name: 'x', body: 'y', hostInjected: true }), null, 'GUI 自己投递的不补');
  assert.equal(R({ kind: 'peer', name: 'x', body: 'y', senderTaskId: 'task_1' }), null, '子代理回传不补');
  assert.equal(R({ kind: 'peer', name: 'x', body: 'y' }, { parent_tool_use_id: 'toolu_1' }), null, '子代理内的 result 不补');
  assert.equal(R({ kind: 'user' }), null);
  assert.equal(xs.peerFromResultEvent({ type: 'result', uuid: 'u-2' }), null, '没有 origin 不补');
  // 历史条目
  assert.equal(xs.peerVia({ type: 'peer-message', from: 'gui:user', fromName: '用户转发自 甲' }), 'gui');
  assert.equal(xs.peerVia({ type: 'peer-message', from: 'uds:/x', fromName: null }), 'native');
  assert.equal(xs.peerFromLabel({ type: 'peer-message', from: 'gui:user', fromName: '用户转发自 甲' }), '用户转发自 甲');
  assert.equal(xs.peerFromLabel({ type: 'peer-message', from: `gui:${A}`, fromName: '甲' }), '来自 甲');
  assert.equal(xs.peerFromSession({ type: 'peer-message', from: `gui:${A}` }), A);
  // 回合落盘对账:历史里有同一条才交给历史
  const live = { ...card, timestamp: '2026-10-15T01:00:01.000Z' };
  assert.equal(xs.keepLivePeer(live, []), true, '历史里没有 → 留着');
  assert.equal(xs.keepLivePeer(live, [{ type: 'peer-message', timestamp: '2026-10-15T01:00:00.900Z', from: 'gui:user', fromName: '用户转发自 甲', body: '正文' }]), false, '历史里有同一条 → 交给历史');
  assert.equal(xs.keepLivePeer(live, [{ type: 'peer-message', timestamp: '2026-10-15T01:00:00.900Z', body: '别的正文' }]), true, '正文不同不算');
  assert.equal(xs.keepLivePeer({ type: 'turn', live: true }, []), false, '只管直播来源气泡');
  assert.equal(xs.keepLivePeer({ type: 'peer-message', timestamp: live.timestamp, body: '正文' }, []), false, '历史条目本身不归它管');
  const natNoBody = { ...R({ kind: 'peer', from: 'uds:/x', name: '丙' }), timestamp: live.timestamp };
  assert.equal(xs.keepLivePeer(natNoBody, [{ type: 'peer-message', timestamp: live.timestamp, fromName: '丙', body: null }]), false, '没有正文时按来源名认');
  // 判官建议 1:直播有正文、历史那条 body 为 null(CLI 没给 origin.body、文本兜底也解析不出)→ 改按来源名认,不出现两个气泡
  const histNoBody = (fromName) => [{ type: 'peer-message', timestamp: '2026-10-15T01:00:00.900Z', from: 'gui:user', fromName, body: null }];
  assert.equal(xs.keepLivePeer(live, histNoBody('用户转发自 甲')), false, '历史正文为 null、来源名相同 → 交给历史');
  assert.equal(xs.keepLivePeer(live, histNoBody('用户转发自 乙')), true, '历史正文为 null、来源名不同 → 留着');
  const natLive = { ...nat, timestamp: live.timestamp };
  assert.equal(xs.keepLivePeer(natLive, [{ type: 'peer-message', timestamp: live.timestamp, from: 'uds:/x', fromName: '乙', body: null }]), false, '原生直播同理');
  // 卡片文案
  assert.equal(xs.xsCardFromText(msg(M1, 'pending')), '由你从 甲 转发');
  assert.equal(xs.xsCardFromText({ from: { kind: 'session', title: '丁' } }), '来自 丁');
  assert.equal(xs.xsCardReasonText(msg(M1, 'pending')), '等待你确认后处理');
  assert.equal(xs.xsCardReasonText({ status: 'claimed' }), '等待发送');
  assert.equal(xs.xsCardReasonText({ status: 'processing' }), '处理中');
  // 回合整轮落盘后留下的来源气泡(历史里没写出它):锚到本回合第一条回复,渲染时插回它之前
  const since = Date.parse('2026-10-15T01:00:00.000Z');
  const oldPeer = { ...card, uuid: 'old-peer', timestamp: '2026-10-15T00:59:00.000Z' };
  const hist = [{ type: 'turn', uuid: 'T0', timestamp: '2026-10-15T00:59:30.000Z' }, { type: 'user', uuid: 'U1', timestamp: '2026-10-15T01:00:00.500Z' }, { type: 'turn', uuid: 'T1', timestamp: '2026-10-15T01:00:02.000Z' }];
  const anchored = xs.anchorLivePeers([oldPeer, live], hist, since);
  assert.equal(anchored[1].anchorUuid, 'T1', '锚到本回合第一条回复');
  assert.equal(anchored[0].anchorUuid, undefined, '本回合之前的不动');
  assert.equal(xs.anchorLivePeers(anchored, hist, since), anchored, '没变化返回原数组');
  const placed = xs.placeAnchoredPeers(hist, anchored);
  assert.deepEqual(placed.list.map((m) => m.uuid), ['T0', 'U1', live.uuid, 'T1'], '插在锚点之前(该回合的回复之前)');
  assert.ok(placed.placed.has(live.uuid) && !placed.placed.has('old-peer'));
  assert.equal(xs.placeAnchoredPeers(hist, [oldPeer]).list, hist, '没有可插的返回原引用(不打穿 MessageList 的 memo)');
  console.log('✓ 气泡对象(card / native / 历史)、对账过滤、落盘后锚定插回、卡片文案');
}

console.log('PASS check-r151b-xs-client');
process.exit(0);
