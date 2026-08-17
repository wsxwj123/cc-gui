#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); },
};

const {
  firstDrainableIndex,
  firstSteerableIndex,
  isSteerBarrier,
  persistedSteerKeys,
  reconcileSteered,
  stripSteerState,
} = await import('../../client/src/utils/steerQueue.js');
const { acceptSteer, findBusySlot, validateSteerRequest } = await import('../../server/routes/chat.js');
const { useStore } = await import('../../client/src/stores/sessionStore.js');

const makeSlot = (overrides = {}) => ({
  sessionId: 'session-a', idle: false, closing: false, pumpEnded: false, exitCode: null,
  steerReceipts: new Map(),
  input: {
    pushed: [],
    push(message) { this.pushed.push(message); return true; },
  },
  ...overrides,
});

assert.equal(validateSteerRequest(null), null);
assert.equal(validateSteerRequest([]), null);
assert.equal(validateSteerRequest({ sessionId: '../bad', uuid: 'steer-ok', content: 'x' }), null);
assert.equal(validateSteerRequest({ sessionId: 'session-a', uuid: 'bad id', content: 'x' }), null);
assert.equal(validateSteerRequest({ sessionId: 'session-a', uuid: 'steer-ok', content: '   ' }), null);
assert.deepEqual(validateSteerRequest({ sessionId: ' session-a ', uuid: ' STEER-ABC ', content: ' x ' }), {
  sessionId: 'session-a', uuid: 'steer-abc', content: ' x ',
}, 'session/uuid 规范化，但原文空白必须保留');

{
  const slot = makeSlot();
  const procs = new Map([['sdk-1', slot]]);
  const request = validateSteerRequest({ sessionId: 'session-a', uuid: 'steer-same-id', content: '正文 ' });
  const first = acceptSteer(procs, request);
  assert.deepEqual(first, { status: 200, body: { ok: true, accepted: true, duplicate: false, pid: 'sdk-1' } });
  assert.equal(slot.input.pushed.length, 1);
  assert.equal(slot.input.pushed[0].priority, 'now');
  assert.equal(slot.input.pushed[0].uuid, 'steer-same-id');
  slot.idle = true;
  const duplicate = acceptSteer(procs, request);
  assert.equal(duplicate.body.duplicate, true, 'duplicate 查询必须先于 busy 判定');
  assert.equal(slot.input.pushed.length, 1, '同 UUID 同原文不能再次 push');
  const conflict = acceptSteer(procs, { ...request, content: '正文' });
  assert.equal(conflict.status, 409, '同 UUID 空白差异也必须 conflict');
  assert.equal(conflict.body.code, 'steer-id-conflict');
  assert.equal(slot.input.pushed.length, 1);
}

{
  const closed = makeSlot({ input: { push: () => false } });
  const noActive = acceptSteer(new Map([['p', closed]]), {
    sessionId: 'session-a', uuid: 'steer-closed', content: 'x',
  });
  assert.equal(noActive.body.code, 'no-active-turn');
  assert.equal(closed.steerReceipts.size, 0, 'push=false 不能登记 receipt');
  const throwing = makeSlot({ input: { push: () => { throw new Error('private'); } } });
  const unknown = acceptSteer(new Map([['p', throwing]]), {
    sessionId: 'session-a', uuid: 'steer-throws', content: 'x',
  });
  assert.deepEqual(unknown, {
    status: 500,
    body: { ok: false, code: 'steer-acceptance-unknown', error: '并入结果无法确认' },
  });
  assert.equal(JSON.stringify(unknown).includes('private'), false, '内部错误不得泄漏');
}

assert.ok(findBusySlot(new Map([['p', makeSlot()]]), 'session-a'));
assert.equal(findBusySlot(new Map([['p', makeSlot({ idle: true })]]), 'session-a'), null);

const queued = { queueId: 'q-1', text: '后项', queuedAt: 1 };
const unknown = { queueId: 'q-0', text: '未决', steerId: 'steer-u', steerState: 'unknown' };
assert.equal(firstDrainableIndex([unknown, queued]), -1, 'unknown 队首必须阻断后项');
assert.equal(firstDrainableIndex([queued, unknown]), 0, '只允许发送 queued 队首');
assert.equal(firstSteerableIndex([{ ...queued, hidden: true }, queued]), -1, '不能越过 hidden 队首做 steer');
assert.equal(isSteerBarrier({ steerState: 'accepted' }), true);
assert.equal(isSteerBarrier({ steerState: 'needs-review' }), true);

const keys = persistedSteerKeys([
  { type: 'user', uuid: 'STEER-A', text: 'x' },
  { type: 'user', steerUuid: 'STEER-B', text: 'y' },
]);
assert.deepEqual([...keys].sort(), ['steer-a', 'steer-b']);
assert.deepEqual(reconcileSteered([unknown, queued], null, new Set(['steer-u'])), [queued],
  '只有 UUID 正向命中才能删除');
const review = reconcileSteered([unknown, queued], new Map([['未决', Date.now()]]), new Set());
assert.equal(review[0].steerState, 'needs-review', '签名命中也不能自动删除');
assert.equal(firstDrainableIndex(review), -1, 'needs-review 必须继续作为队首 barrier');

const restored = stripSteerState({
  a: [{ ...unknown, steerState: 'claiming', claimId: 'claim-a', targetPaneId: 'p0', claimDraft: { sendable: false } }],
  b: [{ text: '', hidden: true, claimDraft: { sendable: true, text: 'draft', queueText: 'draft 原文' } }],
});
assert.equal(restored.a[0].steerState, 'needs-review');
assert.equal('claimDraft' in restored.a[0], false, '中断 pending draft 必须回滚');
// ②判官必修-2:跨重启的 claim 槽一律复位为可见 needs-review(pane id 计数器重启即重置,
// 槽必悬空;旧断言把"跨重启保留 hidden 槽"测成预期,正是不可见永久阻塞的死锁)。
assert.equal('claimDraft' in restored.b[0], false, 'sendable 槽跨重启不得保留(孤儿即死锁)');
assert.equal(restored.b[0].steerState, 'needs-review', '复位为人工复核态');
assert.equal(restored.b[0].hidden, undefined, '必须重新可见');
assert.equal(restored.b[0].text, 'draft 原文', '原文从 claimDraft.queueText 还原');

// claim 三阶段：原 item → 原 item + pending draft → hidden 空文本 sendable draft。
useStore.setState({ messageQueue: {} });
const store = useStore.getState();
const item = store.enqueueMessage('session-a', { text: '合成消息', queuedAt: 10, opts: { meta: { attachments: [] } } });
store.prepareSteer('session-a', item.queueId);
useStore.getState().settleSteer('session-a', item.queueId, 'ambiguous');
assert.equal(useStore.getState().messageQueue['session-a'][0].steerState, 'needs-review');
const claimId = useStore.getState().beginQueueClaim('session-a', item.queueId, 'p0');
assert.ok(claimId);
let phase = useStore.getState().messageQueue['session-a'][0];
assert.equal(phase.text, '合成消息', 'claiming 阶段原副本必须仍完整');
assert.equal(useStore.getState().writePendingClaimDraft('session-a', item.queueId, claimId, 'p0'), true);
phase = useStore.getState().messageQueue['session-a'][0];
assert.equal(phase.text, '合成消息');
assert.equal(phase.claimDraft.sendable, false, 'pending draft 不可发送');
assert.equal(useStore.getState().finalizeQueueClaim('session-a', item.queueId, claimId, 'p0'), true);
phase = useStore.getState().messageQueue['session-a'][0];
assert.equal(phase.text, '', '旧 drain 不会把 claim draft 当消息发送');
assert.equal(phase.hidden, true);
assert.equal(phase.claimDraft.text, '合成消息');
assert.equal(phase.claimDraft.sendable, true);
assert.equal(firstDrainableIndex([phase, queued]), -1, '新版本在 draft 被发送前不越过该槽');
const oldDrain = (list) => list.findIndex((entry) => entry && entry.text && !entry.steerId);
assert.equal(oldDrain([phase]), -1, '旧版 drain 也不会发送或删除 hidden 空文本 claim 槽');
const persistedRoot = JSON.parse(storage.get('cgui-message-queue'));
assert.ok(Object.values(persistedRoot).every(Array.isArray), '根 JSON 必须保持 sessionKey → array 的旧格式');
assert.equal('__claimDrafts' in persistedRoot, false, '不得增加旧版不认识的根对象槽');

useStore.getState().clearClaimDraft('p0', claimId);
assert.equal(useStore.getState().messageQueue['session-a'].length, 0);

const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
const input = readFileSync(new URL('../../client/src/components/ChatInput.jsx', import.meta.url), 'utf8');
const server = readFileSync(new URL('../../server/routes/chat.js', import.meta.url), 'utf8');
const index = readFileSync(new URL('../../server/index.js', import.meta.url), 'utf8');
assert.match(app, /prepareSteer\(sessionQueueKey, queued\.queueId\)[\s\S]{0,700}steerId: prepared\.steerId/,
  'Cmd/Ctrl+Enter 必须在 HTTP 前持久化稳定 queueId/steerId');
assert.doesNotMatch(app, /acceleratingRef/, '不能再用全局布尔协调多个 steer');
assert.match(input, /并入结果无法确认，已暂停后续队列/);
assert.match(input, /原消息可能已被模型接收，再次发送可能重复。是否取回为新消息？/);
assert.match(server, /steerReceipts: new Map\(\)/, 'receipt Map 必须归属 slot');
assert.match(index, /code: 'malformed-json'/);
assert.match(index, /code: 'request-too-large'/);

console.log('PASS check-steer-inject');
