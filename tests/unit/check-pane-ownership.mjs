#!/usr/bin/env node
// 串扰窗口1守卫纯函数自检:paneMessages 归属判定(第226轮主诉,切会话瞬间
// 代办/计划/费用/模型徽章短暂串显的根因守卫)。失败方向必须是"藏"(EMPTY)而非"显"。
import assert from 'node:assert/strict';
import { paneMessagesOwned } from '../../client/src/utils/routing.js';

// 核心串扰场景:pane 历史还是 A 的(fetch 未回),当前会话已切到 B → 不归属,必须藏
assert.equal(paneMessagesOwned('sid-A', 'sid-B'), false, 'A 的历史不许以 B 名义显示');

// 正常场景:历史归属 = 当前会话 → 显示
assert.equal(paneMessagesOwned('sid-A', 'sid-A'), true, '归属匹配 → 可见');

// draft(sessionId null)+ 空白历史(null 标记)→ 同为 null 视为归属(draft 显示空数组本体)
assert.equal(paneMessagesOwned(null, null), true, 'draft/空窗格 null===null');
assert.equal(paneMessagesOwned(undefined, undefined), true, 'undefined 归一为 null');
assert.equal(paneMessagesOwned(undefined, null), true, 'undefined vs null 归一相等');

// draft 切到真会话(toast 跳转/撤销删除恢复):历史标记还是 null,会话已是真 sid → 藏
assert.equal(paneMessagesOwned(null, 'sid-B'), false, '空白标记不许认领真会话');

// 真会话切到 draft(回滚 sessionReset/新建会话按钮):旧 sid 历史不许显示在 draft 下
assert.equal(paneMessagesOwned('sid-A', null), false, '旧会话历史不许显示在 draft 下');

// 空串归一(防御:sessionId 意外为 '' 时与 null 同义,不因 ''!==null 误判)
assert.equal(paneMessagesOwned('', null), true, '空串归一为 null');
assert.equal(paneMessagesOwned('', 'sid-A'), false, '空串标记不认领真会话');

// ── 真 store 行为断言(claim 契约自守 + fetchMessages 乱序丢弃)──────────
const { useStore } = await import('../../client/src/stores/sessionStore.js');
const st = () => useStore.getState();

// claim 契约自守:槽位已归属别的真 sid(重置点漏清)→ 认领时消息一并清空
st().setPaneMessages(1, [{ role: 'assistant', text: '旧会话残留' }], 'sid-OLD');
st().claimPaneMessages(1, 'sid-NEW');
assert.deepEqual(st().paneMessages[1], [], 'claim 非空槽:旧消息必须清空');
assert.equal(st().paneMessagesSid[1], 'sid-NEW', 'claim 非空槽:归属升级为新 sid');

// claim draft 空槽(null)正常升级,消息保留(draft 期的空数组本体)
st().setPaneMessages(2, [], null);
st().claimPaneMessages(2, 'sid-X');
assert.equal(st().paneMessagesSid[2], 'sid-X', 'claim 空槽:null→真 sid 升级');
assert.deepEqual(st().paneMessages[2], [], 'claim 空槽:消息不动');

// claim 同 sid 幂等:不清消息
st().setPaneMessages(3, [{ role: 'user' }], 'sid-Y');
st().claimPaneMessages(3, 'sid-Y');
assert.equal(st().paneMessages[3].length, 1, 'claim 同 sid:消息保留');

// fetchMessages 乱序丢弃:响应落地时 pane 已切走 → 整条丢弃,不覆盖
const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: true, json: async () => ({ messages: [{ role: 'assistant', text: '慢响应' }] }) });
try {
  st().setPaneSession(1, { sessionId: 'sid-B' });
  st().setPaneMessages(1, [{ role: 'user', text: 'B 的消息' }], 'sid-B');
  await st().fetchMessages('sid-A', 'hash', { tab: 1 });   // A 的慢响应,pane 已是 B
  assert.equal(st().paneMessagesSid[1], 'sid-B', '乱序响应:归属不被 A 覆盖');
  assert.equal(st().paneMessages[1][0]?.text, 'B 的消息', '乱序响应:B 的消息不被 A 覆盖');

  // 对照:pane 仍是发起时的会话 → 正常写入
  st().setPaneSession(1, { sessionId: 'sid-A' });
  await st().fetchMessages('sid-A', 'hash', { tab: 1 });
  assert.equal(st().paneMessagesSid[1], 'sid-A', '归属一致:正常写入 sid');
  assert.equal(st().paneMessages[1][0]?.text, '慢响应', '归属一致:消息正常落地');
} finally {
  globalThis.fetch = realFetch;
}

console.log('check-pane-ownership: all assertions passed');
