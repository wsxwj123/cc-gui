#!/usr/bin/env node
// r26-B1【复现】:draft 孤儿队列被新会话继承并自动发出。
// 场景:Home 发消息后 1.5-2s 窗口内刷新 → 消息留在 localStorage 的 draft-<hash> 队列里,
// 但 RESTORE_LAST_ON_BOOT=false 时 draft 窗格不还原 → 队列成孤儿;几天后同项目新发消息,
// drain 把这条旧消息当首条发进全新会话执行。
// 修复后期望:启动(模块水合)后,无存活 draft 窗格对应的 draft-* 队列不得留在 messageQueue
// 里等着被自动 drain(清理,或恢复对应 draft 窗格);真会话的队列不受影响。
// Run: node tests/acceptance/r26/b1-orphan-draft-queue.mjs
import assert from 'node:assert/strict';
import { stubLocalStorage, stubWindowNoop } from './lib.mjs';

stubWindowNoop();
// 启动前 localStorage 里躺着一个孤儿 draft 队列(对应窗格不会被恢复)+ 一个真会话队列。
stubLocalStorage({
  'cgui-message-queue': {
    'draft-deadhash': [{ queueId: 'q-orphan', text: '几天前没发出去的旧消息', queuedAt: 1 }],
    'real-session-1': [{ queueId: 'q-normal', text: '正常排队的消息', queuedAt: 2 }],
  },
});

const { useStore } = await import('../../../client/src/stores/sessionStore.js');
const { firstDrainableIndex } = await import('../../../client/src/utils/steerQueue.js');

const state = useStore.getState();
const mq = state.messageQueue || {};

// 反向断言(修复前恰好是 bug 形态):孤儿队列在,且首条就是可 drain 的纯文本 → 会被自动发出。
if (mq['draft-deadhash'] && firstDrainableIndex(mq['draft-deadhash']) === 0) {
  // 这就是 B1 的复现形态,下面两个断言必须红一个。
}

// 修复后期望①:孤儿 draft 队列不再留在 messageQueue;或者②对应 draft 窗格被恢复
// (paneSessions/selectedSession 里存在无 sessionId 的存活 draft),队列有主、不算孤儿。
const liveDraftExists = [...(state.paneSessions || []), state.selectedSession]
  .some((s) => s && !s.sessionId);
assert.ok(
  !('draft-deadhash' in mq) || liveDraftExists,
  'B1: 无存活 draft 窗格的 draft-deadhash 队列仍在 messageQueue 里,drain 会把旧消息自动发进新会话',
);

// 持久化快照同样不许残留孤儿(否则下次启动又水合回来)。
const persisted = JSON.parse(globalThis.localStorage.getItem('cgui-message-queue') || '{}');
assert.ok(
  !('draft-deadhash' in persisted) || liveDraftExists,
  'B1: 孤儿 draft 队列仍持久化在 localStorage,下次启动照样复活',
);

// 不误伤:真会话的队列原样保留(清理只许针对无主的 draft-* 键)。
assert.deepEqual(
  (mq['real-session-1'] || []).map((m) => m.queueId),
  ['q-normal'],
  'B1: 真会话队列必须原样保留',
);

console.log('PASS r26-b1-orphan-draft-queue');
