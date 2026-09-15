#!/usr/bin/env node
// 单测:R13「会话流」客户端一半的身份判定与竞态归属(白盒,直调真函数/真 store)。
// 覆盖三件事:
//   ① 迟到事件的归属判定 —— A 的产物(任何形态)不得在 B 的窗格里可见;
//   ② clientTurnId 生成 / 重试复用 —— 格式合法、每次新发唯一、带既有 id 时原样沿用;
//   ③ 窗格 identity 的稳定映射 —— paneId/代际在关窗格、切会话、draft→真 sid 时不错位。
// 变异哨兵(实际验证过红):
//   S1 localEntryVisible 去掉 ownerKey 分支(恒按 liveVisible 判)→ t1 的"迟到 turn 不得进 B"红;
//   S2 resolveClientTurnId 忽略 existing(恒新生成)→ t2 的"重试沿用同一 id"红;
//   S3 sameOwnerRound 的 draft→sid 分支改成 return false → t3 的"绑定真 sid 代际不变"红;
//   S4 closePane 的 splice 不同步 paneGenerations(只 splice ids)→ t4 的"关最左不错位"红。
// Run: node tests/unit/check-r13-client-flow.mjs
import assert from 'node:assert/strict';

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); },
};

const {
  CLIENT_TURN_ID_RE, localEntryVisible, makeClientTurnId, resolveClientTurnId,
  sameOwnerRound, rotatedPaneGenerations, resolveStopOwner,
} = await import('../../client/src/utils/sessionFlowIdentity.js');
const { useStore } = await import('../../client/src/stores/sessionStore.js');

// ── t1 迟到事件归属:A 的一切产物在 B 的窗格里都不可见 ──────────────────────
{
  const A = 'sess-A';
  const B = 'sess-B';
  // 本窗格已切到 B,而 A 的流还在闭包里跑(streamOwnerKey 仍是 A 的键)
  const ctx = { streamOwnerKey: A, sessionQueueKey: B };
  assert.equal(localEntryVisible({ ...ctx, ownerKey: A }), false, 't1: A 的停止半截/错误气泡不得显示在 B');
  assert.equal(localEntryVisible({ ...ctx, ownerKey: B }), true, 't1: B 自己的本地条目照常显示');
  assert.equal(localEntryVisible({ ...ctx, ownerKey: 'draft-x' }), false, 't1: 别的 draft 的条目不得显示');
  // 无 ownerKey 的条目(流式 turn / 用户回显)只认"本窗格正在消费的那条流"
  assert.equal(localEntryVisible({ ...ctx, ownerKey: null }), false, 't1: A 的迟到 turn 不得进 B 正文');
  assert.equal(localEntryVisible({ ownerKey: null, streamOwnerKey: A, sessionQueueKey: A }), true, 't1: 原会话里照常显示');
  assert.equal(localEntryVisible({ ownerKey: null, streamOwnerKey: null, sessionQueueKey: null }), false, 't1: 无归属即不显示(不误挂到空窗格)');
  // A 的结果仍归 A(切回 A 后照常显示)
  assert.equal(localEntryVisible({ ownerKey: A, streamOwnerKey: B, sessionQueueKey: A }), true, 't1: 切回 A 后 A 的产物可见');
}

// ── t2 clientTurnId:格式合法 / 唯一 / 重试沿用 ─────────────────────────────
{
  const first = makeClientTurnId(1768000000000, 1);
  const second = makeClientTurnId(1768000000000, 2);
  assert.equal(CLIENT_TURN_ID_RE.test(first), true, 't2: 生成的 id 必须满足服务端 1–64 位 [A-Za-z0-9_-]');
  assert.equal(CLIENT_TURN_ID_RE.test(second), true);
  assert.notEqual(first, second, 't2: 两次发送不得共用同一个 id');
  assert.ok(first.length <= 64, 't2: 长度不得超 64');
  // 重试/响应丢失:调用方把原 id 传回来,必须原样沿用(换新 id = 重新发一条)
  assert.equal(resolveClientTurnId(first, 1768000000001, 3), first, 't2: 重试沿用同一个 clientTurnId');
  // 没带合法 id 时才新生成
  assert.equal(CLIENT_TURN_ID_RE.test(resolveClientTurnId(null, 1768000000001, 4)), true);
  assert.equal(CLIENT_TURN_ID_RE.test(resolveClientTurnId('非法 id', 1768000000001, 5)), true, 't2: 非法 id 不沿用,换成合法新 id');
  assert.notEqual(resolveClientTurnId('非法 id', 1768000000001, 5), '非法 id');
}

// ── t3 窗格代际:同一轮不轮换,换 owner 才轮换 ─────────────────────────────
{
  const sessionA = { sessionId: 'sess-A', projectHash: 'h1' };
  const sessionB = { sessionId: 'sess-B', projectHash: 'h1' };
  const draft = { draft: true, draftId: 'd1', sessionId: null, projectHash: 'h1' };
  const promoted = { draft: false, draftId: 'd1', sessionId: 'sess-New', projectHash: 'h1' };
  assert.equal(sameOwnerRound(sessionA, { ...sessionA }), true, 't3: 同 sid 换对象引用 = 同一轮');
  assert.equal(sameOwnerRound(sessionA, sessionB), false, 't3: 切到别的会话 = 新一轮');
  assert.equal(sameOwnerRound(null, null), true, 't3: 空窗格重设空 = 同一轮');
  assert.equal(sameOwnerRound(null, draft), true, 't3: 空窗格发出第一条消息(建 draft)= 同一轮');
  assert.equal(sameOwnerRound(draft, promoted), true, 't3: draft 绑定真 sid = 同一轮(generation 不变)');
  assert.equal(sameOwnerRound(null, sessionA), false, 't3: 空窗格点开一个已有会话 = 新一轮');
  assert.equal(sameOwnerRound(sessionA, null), false, 't3: 关窗格/新建会话清空 = 新一轮');
  assert.equal(sameOwnerRound(draft, { ...draft, draftId: 'd2' }), false, 't3: 换一个 draft = 新一轮');

  let seq = 0;
  const fresh = () => `g-test-${++seq}`;
  const generations = ['g0', 'g1', 'g2'];
  assert.equal(rotatedPaneGenerations({ generations, idx: 0, prev: draft, next: promoted, fresh }), null, 't3: 同一轮不产生新数组');
  const rotated = rotatedPaneGenerations({ generations, idx: 1, prev: sessionA, next: sessionB, fresh });
  assert.deepEqual(rotated, ['g0', 'g-test-1', 'g2'], 't3: 换 owner 只轮换该格');
  assert.deepEqual(generations, ['g0', 'g1', 'g2'], 't3: 原数组不得被就地改写');
}

// ── t4 store 级:关窗格 splice 后 paneId/ownerKey/代际不错位 ────────────────
{
  const st = useStore;
  const sess = (id) => ({ sessionId: id, projectHash: 'h', projectPath: '/tmp', firstPrompt: id });
  st.setState({
    paneCount: 3,
    paneSessions: [sess('A'), sess('B'), sess('C'), null, null, null],
    paneMessages: [[], [], [], [], [], []],
    paneMessagesSid: ['A', 'B', 'C', null, null, null],
    paneIds: ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'],
    paneGenerations: ['gA', 'gB', 'gC', 'g3', 'g4', 'g5'],
    activeTabIndex: 0,
  });
  // 绑定会话不轮换代际(同 sid 重设)
  st.getState().setPaneSession(0, sess('A'));
  assert.equal(st.getState().paneGenerations[0], 'gA', 't4: 同会话重设不轮换代际');
  // 换会话轮换
  st.getState().setPaneSession(0, sess('A2'));
  assert.equal(st.getState().paneGenerations[0] !== 'gA', true, 't4: 换会话轮换代际');
  const before = {
    ids: st.getState().paneIds.slice(0, 3),
    gens: st.getState().paneGenerations.slice(0, 3),
    owners: st.getState().paneSessions.slice(0, 3).map((s) => s && s.sessionId),
  };
  st.getState().closePane(0);                    // 关最左
  const after = {
    ids: st.getState().paneIds.slice(0, 2),
    gens: st.getState().paneGenerations.slice(0, 2),
    owners: st.getState().paneSessions.slice(0, 2).map((s) => s && s.sessionId),
  };
  assert.equal(st.getState().paneCount, 2, 't4: 三窗格关一剩二');
  assert.deepEqual(after.ids, before.ids.slice(1), 't4: 剩余窗格 paneId 原样左移,不错位、不重排');
  assert.deepEqual(after.gens, before.gens.slice(1), 't4: 剩余窗格代际跟着自己的 owner 走');
  assert.deepEqual(after.owners, before.owners.slice(1), 't4: 剩余窗格 ownerKey 不错位');
  // 单窗格关窗:清空 + 换 paneId/代际(空窗格不能被当成"还在显示那个会话")
  st.setState({ paneCount: 1, paneIds: [...st.getState().paneIds], activeTabIndex: 0 });
  const sidBefore = st.getState().paneIds[0];
  st.getState().closePane(0);
  assert.equal(st.getState().paneSessions[0], null, 't4: 单窗格关掉=清空该格');
  assert.notEqual(st.getState().paneIds[0], sidBefore, 't4: 清空后换 paneId(旧实例干净卸载)');
}

// ── t5 停止身份:只发能证明属于该 pid 的 owner,拿不准就不发 ────────────────
{
  assert.equal(resolveStopOwner({ pid: 'p1', recordedPid: 'p1', recordedOwner: 'sess-A' }), 'sess-A', 't5: pid 一致才用记下的 owner');
  assert.equal(resolveStopOwner({ pid: 'p2', recordedPid: 'p1', recordedOwner: 'sess-A' }), null, 't5: pid 变了绝不复用旧 owner');
  assert.equal(resolveStopOwner({ pid: 'p9', backgroundPid: 'p9', currentSessionId: 'sess-B' }), 'sess-B', 't5: 后台 pid 用本会话 sid(poll 按 sessionId 匹配出的)');
  assert.equal(resolveStopOwner({ pid: 'p9', recordedPid: 'p9', recordedOwner: null }), null, 't5: 没有可证明的 owner → 走老路径');
  assert.equal(resolveStopOwner({ pid: null }), null, 't5: 无目标 pid 不发身份');
}

console.log('check-r13-client-flow: 全部通过');
