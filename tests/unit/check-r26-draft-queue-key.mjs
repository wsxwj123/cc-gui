#!/usr/bin/env node
// r26-B5:同项目双 draft 共用 `draft-<hash>` 队列键串窗格 → 键带 draftId。
// 哨兵:①同 projectHash 两个 draftId → 两个键不等(串窗格本体);
//       ②迁移只搬 fromKey 精确匹配的旧键,另一 draft 的队列原样保留;
//       ③旧形态键(无第三段)与新 draft 的键恒不等(旧键从此匹配不到任何新窗格);
//       ④draftQueueProjectHash 新/旧形态都能解析出 hash 段(孤儿回收按项目过滤依赖它)。
// Run: node tests/unit/check-r26-draft-queue-key.mjs
import assert from 'node:assert/strict';

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); },
};

const { queueKeyFor, draftQueueProjectHash, isDraftQueueKey } = await import('../../client/src/utils/steerQueue.js');
const { migrateDraftQueue } = await import('../../client/src/utils/routing.js');
const { useStore } = await import('../../client/src/stores/sessionStore.js');

// ① 串窗格哨兵:同 projectHash 两个 draftId → 两个键不等
{
  const a = queueKeyFor({ sessionId: null, projectHash: 'h1', draftId: 'd1-1' });
  const b = queueKeyFor({ sessionId: null, projectHash: 'h1', draftId: 'd2-2' });
  assert.notEqual(a, b, 'B5: 同项目两个 draft 的队列键必须不同(相同即串窗格)');
  assert.equal(a, 'draft-h1-d1-1', 'B5: 键形态 draft-<projectHash>-<draftId>');
  // 真会话恒为 sessionId;无 draftId 的理论残留落 '-none' 尾段(失败安全,不共享)
  assert.equal(queueKeyFor({ sessionId: 'sid-1', projectHash: 'h1', draftId: 'd1-1' }), 'sid-1');
  assert.equal(queueKeyFor({ sessionId: null, projectHash: 'h1' }), 'draft-h1-none');
}

// ② 迁移隔离哨兵:migrateDraftQueue 只搬 fromKey,另一 draft 的队列原样保留
{
  const mq = {
    'draft-h1-d1-1': [{ queueId: 'a1', text: 'A 的', queuedAt: 1 }],
    'draft-h1-d2-2': [{ queueId: 'b1', text: 'B 的', queuedAt: 2 }],
  };
  const next = migrateDraftQueue(mq, 'draft-h1-d1-1', 'sid-a');
  assert.deepEqual((next?.['draft-h1-d2-2'] || []).map((m) => m.queueId), ['b1'],
    'B5: 迁移 A 不得带走 B 的排队消息');
  assert.equal(next?.['draft-h1-d1-1'], undefined, 'B5: 迁移后 A 的 draft 键清空');
  assert.deepEqual((next?.['sid-a'] || []).map((m) => m.queueId), ['a1'], 'B5: A 的消息落到真 sid');
}

// ②b store 级:migrateSessionKey 精确匹配 fromKey,同项目另一 draft 不动
{
  useStore.setState({ messageQueue: {
    'draft-h2-d1-1': [{ queueId: 'x1', text: 'X', queuedAt: 1 }],
    'draft-h2-d2-2': [{ queueId: 'y1', text: 'Y', queuedAt: 2 }],
  } });
  useStore.getState().migrateSessionKey('draft-h2-d1-1', 'sid-x');
  const mq = useStore.getState().messageQueue;
  assert.equal(mq['draft-h2-d1-1'], undefined, 'B5: fromKey 已迁走');
  assert.deepEqual((mq['draft-h2-d2-2'] || []).map((m) => m.queueId), ['y1'],
    'B5: store 迁移不碰同项目另一 draft 的队列');
  assert.deepEqual((mq['sid-x'] || []).map((m) => m.queueId), ['x1']);
}

// ③ 旧形态隔离哨兵:旧键 `draft-<hash>` 恒不等于任何新 draft 的键
//    (旧键 → 孤儿表是 B1 的职责,这里只钉"键形态永不再匹配")
{
  const legacy = 'draft-h1';
  assert.notEqual(queueKeyFor({ sessionId: null, projectHash: 'h1', draftId: 'd9-9' }), legacy,
    'B5: 新 draft 的键不得撞上旧形态键(否则孤儿旧消息被继承自动发出)');
}

// ④ projectHash 解析:新/旧形态 + 边界
{
  assert.equal(draftQueueProjectHash('draft-h1-d123-4'), 'h1', 'B5: 新形态剥 draftId 尾段');
  assert.equal(draftQueueProjectHash('draft-h1'), 'h1', 'B5: 旧形态整段即 hash');
  assert.equal(draftQueueProjectHash('draft-none-none'), 'none-none', 'B5: 退化键(hash 与 draftId 均缺)原样返回,不匹配任何真实项目');
  assert.equal(draftQueueProjectHash('sid-real'), null, 'B5: 非 draft 键 → null');
  assert.ok(isDraftQueueKey('draft-h1') && !isDraftQueueKey('sid-real'));
}

console.log('PASS check-r26-draft-queue-key');
