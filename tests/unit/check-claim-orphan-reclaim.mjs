#!/usr/bin/env node
// 判官必修-2(②):claim-draft 隐藏槽死锁 → 孤儿归一化。
// 死锁形态:取回流程把条目换成 { text:'', hidden:true, claimDraft:{sendable:true} } 槽——
// 不可见(hidden 不渲染)、不可删(claimDraft 拒删)、阻塞 drain(text 空),目标 pane
// 消失(关窗格/重启后 pane id 计数器重置)即永久孤儿。
// 修法:a) 跨重启 stripSteerState 把一切 claim 残留复位为可见 needs-review(原文/附件/
//        steerId 从 claimDraft 还原);b) 会话内 closePane 后 reclaimOrphanClaimDrafts
//        回收 targetPaneId 已不在 paneIds 的槽。复位后走 needs-review barrier 规则(①的出口)。
// 变异哨兵(已实际验证红过一次):
//   · 删掉 stripSteerState 的 claimDraft 分支(恢复"槽原样放行") → "跨重启复位"断言红;
//   · 删掉 closePane 的 reclaimOrphanClaimDrafts 调用 → "关窗格回收孤儿"断言红。
// Run: node tests/unit/check-claim-orphan-reclaim.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); },
};

const { firstDrainableIndex, reclaimClaimItem, stripSteerState } = await import('../../client/src/utils/steerQueue.js');
const { useStore } = await import('../../client/src/stores/sessionStore.js');

// ── 纯函数:hidden sendable 槽 → 可见 needs-review 原条目(文本/附件/steerId 还原)──
const slot = {
  text: '', queuedAt: 5, hidden: true, queueId: 'claim-draft-1',
  claimDraft: {
    sessionKey: 's', sourceQueueId: 'q-src', claimId: 'c1', targetPaneId: 'p9',
    text: '纯文本', queueText: '纯文本\n\n附件:\n@/tmp/a.png', steerId: 'steer-orig',
    attachments: [{ kind: 'image', name: 'a.png', path: '/tmp/a.png' }], sendable: true,
  },
};
const back = reclaimClaimItem(slot);
assert.equal(back.steerState, 'needs-review', '复位为人工复核态(走①的出口)');
assert.equal(back.attemptWasAmbiguous, true);
assert.equal(back.hidden, undefined, '必须可见');
assert.equal('claimDraft' in back, false, '不得残留 claimDraft');
assert.equal('targetPaneId' in back, false);
assert.equal(back.text, '纯文本\n\n附件:\n@/tmp/a.png', '出站原文从 queueText 还原');
assert.equal(back.queueId, 'q-src', '恢复原条目身份(sourceQueueId)');
assert.equal(back.steerId, 'steer-orig', 'steerId 还原,UUID 落盘对账仍可自动清理');
assert.deepEqual(back.opts.meta.attachments, slot.claimDraft.attachments, '附件卡片数据还原');
assert.equal(back.opts.meta.displayText, '纯文本');
// claiming 中间态(claimDraft 未写入)同样复位,不留 claiming
const mid = reclaimClaimItem({ queueId: 'q2', text: '原文', steerState: 'claiming', claimId: 'c2', targetPaneId: 'p9' });
assert.equal(mid.steerState, 'needs-review');
assert.equal('claimId' in mid, false);
// 非 claim 条目原样返回
const plain = { queueId: 'q3', text: 'x' };
assert.equal(reclaimClaimItem(plain), plain);

// ── 跨重启:stripSteerState 不得放行任何 claim 残留(判官抓到的"测成预期"翻案)──
const restoredMap = stripSteerState({ s: [slot] });
assert.equal(restoredMap.s[0].steerState, 'needs-review', '跨重启复位为 needs-review');
assert.equal('claimDraft' in restoredMap.s[0], false, '跨重启不得保留 hidden 槽(孤儿即死锁)');

// ── 会话内:closePane 回收 targetPaneId 悬空的槽(真 store 全流程)──
useStore.setState({ messageQueue: {}, paneCount: 2, paneIds: ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'] });
const st = useStore.getState();
const item = st.enqueueMessage('sess-a', { text: '取回我', queuedAt: 1 });
st.prepareSteer('sess-a', item.queueId);
useStore.getState().settleSteer('sess-a', item.queueId, 'ambiguous');
const claimId = useStore.getState().beginQueueClaim('sess-a', item.queueId, 'p1');
assert.ok(claimId);
assert.ok(useStore.getState().writePendingClaimDraft('sess-a', item.queueId, claimId, 'p1'));
assert.ok(useStore.getState().finalizeQueueClaim('sess-a', item.queueId, claimId, 'p1'));
let cur = useStore.getState().messageQueue['sess-a'][0];
assert.equal(cur.hidden, true, '取回后是 hidden 槽(目标 pane 活着时由 composer 恢复)');
assert.equal(firstDrainableIndex(useStore.getState().messageQueue['sess-a']), -1, '槽阻塞 drain(在飞期正确)');
useStore.getState().closePane(1); // 关掉目标 pane → p1 出列 → 槽成孤儿
cur = useStore.getState().messageQueue['sess-a'][0];
assert.equal(cur.steerState, 'needs-review', '关窗格必须回收孤儿槽为 needs-review');
assert.equal(cur.hidden, undefined, '回收后可见');
assert.equal(cur.text, '取回我', '原文完整还原');
assert.equal('claimDraft' in cur, false);
// 复位后走①的出口:可删除
useStore.getState().removeFromQueue('sess-a', 0);
assert.equal((useStore.getState().messageQueue['sess-a'] || []).length, 0, '复位后条目可删除(不再是死路)');

// pane 未消失时不误伤:活跃 claim 原样保留
useStore.setState({ messageQueue: {}, paneCount: 3, paneIds: ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'] });
const st2 = useStore.getState();
const item2 = st2.enqueueMessage('sess-b', { text: '别动我', queuedAt: 2 });
st2.prepareSteer('sess-b', item2.queueId);
useStore.getState().settleSteer('sess-b', item2.queueId, 'ambiguous');
const claim2 = useStore.getState().beginQueueClaim('sess-b', item2.queueId, 'p2');
assert.ok(useStore.getState().writePendingClaimDraft('sess-b', item2.queueId, claim2, 'p2'));
assert.ok(useStore.getState().finalizeQueueClaim('sess-b', item2.queueId, claim2, 'p2'));
useStore.getState().closePane(1); // 关的是 p1,p2 仍在(splice 后仍在 paneIds 里)
cur = useStore.getState().messageQueue['sess-b'][0];
assert.equal(cur.claimDraft?.sendable, true, '目标 pane 仍在 → 活跃 claim 槽不受影响');

// 持久化根格式仍是 sessionKey → array(旧版兼容)
const persistedRoot = JSON.parse(storage.get('cgui-message-queue'));
assert.ok(Object.values(persistedRoot).every(Array.isArray), '根 JSON 保持 sessionKey → array');

// ── 源码守卫:closePane 两个分支都必须挂回收钩子 ──
const store = readFileSync(new URL('../../client/src/stores/sessionStore.js', import.meta.url), 'utf8');
assert.equal((store.match(/get\(\)\.reclaimOrphanClaimDrafts\(\)/g) || []).length, 2,
  'closePane 单窗格换 id 与多窗格 splice 两个分支都要回收孤儿');

console.log('PASS check-claim-orphan-reclaim');
