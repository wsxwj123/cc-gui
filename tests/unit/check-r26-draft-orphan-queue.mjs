#!/usr/bin/env node
// r26-B1:draft 孤儿队列被新会话继承自动发出 → 启动显式回收进 orphanDraftQueues。
// 哨兵:①水合后孤儿键从 messageQueue 摘除、原文逐字保留在孤儿表;
//       ②新 draft 的 queueKeyFor 恒不等于任何孤儿键(键形态钉死);
//       ③「丢弃」后孤儿表与 localStorage 同步清空;
//       ④跨项目隔离:orphan 表混有 A/B 两项目条目时,「全部丢弃(本项目)」只清 A,
//         B 的条目既不被动也不出现在 A 的可见集(projectHash 过滤语义);
//       ⑤drain 侧:只剩孤儿键的队列 map,firstDrainableIndex 恒 -1。
// Run: node tests/unit/check-r26-draft-orphan-queue.mjs
import assert from 'node:assert/strict';

const ORPHAN_TEXT = '几天前没发出去的旧消息(逐字哨兵)';
const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key) ; },
};
// 启动前 localStorage 躺着一个旧形态孤儿 + 一个新形态孤儿(属于别的项目)+ 一个真会话队列
storage.set('cgui-message-queue', JSON.stringify({
  'draft-hashA': [{ queueId: 'q-orphan', text: ORPHAN_TEXT, queuedAt: 1 }],
  'draft-hashB-d17-2': [{ queueId: 'q-orphan-b', text: 'B 项目的孤儿', queuedAt: 2 }],
  'real-session-1': [{ queueId: 'q-normal', text: '正常排队的消息', queuedAt: 3 }],
}));

const { useStore } = await import('../../client/src/stores/sessionStore.js');
const { firstDrainableIndex, queueKeyFor } = await import('../../client/src/utils/steerQueue.js');

const st = () => useStore.getState();

// ① 启动回收:孤儿键离开 messageQueue,原文逐字进孤儿表
{
  const mq = st().messageQueue || {};
  assert.ok(!('draft-hashA' in mq), 'B1: 孤儿 draft 键必须离开 messageQueue(drain 够不着)');
  assert.ok(!('draft-hashB-d17-2' in mq), 'B1: 新形态孤儿键同样回收');
  assert.equal(st().orphanDraftQueues?.['draft-hashA']?.items?.[0]?.text, ORPHAN_TEXT,
    'B1: 孤儿表保留原文(逐字相等,不静默删用户输入)');
  assert.equal(st().orphanDraftQueues?.['draft-hashA']?.projectHash, 'hashA');
  assert.equal(st().orphanDraftQueues?.['draft-hashB-d17-2']?.projectHash, 'hashB',
    'B1: 新形态键解析出正确 projectHash(项目隔离过滤依赖)');
  // 持久化快照同步摘除(否则下次启动水合复活)
  const persisted = JSON.parse(globalThis.localStorage.getItem('cgui-message-queue') || '{}');
  assert.ok(!('draft-hashA' in persisted), 'B1: 孤儿键不得残留在 localStorage 快照');
  // 不误伤:真会话队列原样保留
  assert.deepEqual((mq['real-session-1'] || []).map((m) => m.queueId), ['q-normal'],
    'B1: 真会话队列必须原样保留');
}

// ② 键形态哨兵:新 draft 的键恒不等于任何孤儿键
{
  const orphanKeys = Object.keys(st().orphanDraftQueues || {});
  const fresh = queueKeyFor({ sessionId: null, projectHash: 'hashA', draftId: 'd999-1' });
  assert.ok(!orphanKeys.includes(fresh), 'B1: 新 draft 的队列键不得撞上任何孤儿键');
  assert.ok(fresh.startsWith('draft-hashA-'), 'B1: 新键带 draftId 段(B5 形态)');
}

// ⑤ drain 哨兵:只剩孤儿键的 map,没有任何可 drain 条目
{
  const mq = st().messageQueue || {};
  for (const key of Object.keys(st().orphanDraftQueues || {})) {
    assert.equal(firstDrainableIndex(mq[key] || []), -1, `B1: 孤儿键 ${key} 不在 messageQueue,drain 恒空`);
  }
}

// ④ 跨项目隔离 + ③ 丢弃同步
{
  // 「全部丢弃(本项目 hashA)」只清 A 的可见集,B 的不动
  st().discardOrphanDraftQueuesFor('hashA');
  assert.ok(!st().orphanDraftQueues['draft-hashA'], 'B1: 本项目孤儿键已清');
  assert.ok(st().orphanDraftQueues['draft-hashB-d17-2'], 'B1: 别的项目的孤儿条目不受影响(跨项目隔离)');
  const persistedOrphans = JSON.parse(globalThis.localStorage.getItem('cgui-orphan-draft-queues') || '{}');
  assert.ok(!('draft-hashA' in persistedOrphans), 'B1: 丢弃后 localStorage 孤儿表同步(刷新不复活)');
  assert.ok('draft-hashB-d17-2' in persistedOrphans);

  // 单条摘除(take):填入语义=摘出即返还原条,键空即删
  const taken = st().takeOrphanDraftMessage('draft-hashB-d17-2', 'q-orphan-b');
  assert.equal(taken?.text, 'B 项目的孤儿', 'B1: take 返回原条目(填入输入框用)');
  assert.ok(!st().orphanDraftQueues['draft-hashB-d17-2'], 'B1: 最后一条摘除后键删除');
  // 单键丢弃兜底
  useStore.setState({ orphanDraftQueues: { 'draft-hashC-d1-1': { projectHash: 'hashC', items: [{ queueId: 'q', text: 'x' }] } } });
  st().discardOrphanDraftQueue('draft-hashC-d1-1');
  assert.deepEqual(st().orphanDraftQueues, {}, 'B1: 单键丢弃清空');
}

console.log('PASS check-r26-draft-orphan-queue');
