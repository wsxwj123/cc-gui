#!/usr/bin/env node
// r26-B2【复现+边界】:claim-draft 孤儿回收丢掉用户对草稿的编辑。
// 场景:取回流程 finalize 后留下 {text:'',hidden:true,claimDraft} 槽;用户在取回窗格里
// 把草稿改成别的内容(updateClaimDraft 写进 claimDraft.text);随后目标窗格被关/切换,
// 孤儿回收把槽还原成可见 needs-review 条目 —— 但还原用的是 claimDraft.queueText(原始
// 出站文本),用户改过的 claimDraft.text 被丢弃。
// 修复后期望:回收还原的可见文本 = 用户最后编辑的 claimDraft.text(没编辑过才回落 queueText)。
// Run: node tests/acceptance/r26/b2-claim-draft-edit-preserved.mjs
import assert from 'node:assert/strict';
import { stubLocalStorage, stubWindowNoop } from './lib.mjs';

stubWindowNoop();
stubLocalStorage();

const { reclaimClaimItem } = await import('../../../client/src/utils/steerQueue.js');
const { useStore } = await import('../../../client/src/stores/sessionStore.js');

// ── 纯函数层:编辑过的草稿回收必须还原文本 ──
{
  const slot = {
    text: '', queuedAt: 5, hidden: true, queueId: 'claim-draft-9',
    claimDraft: {
      sessionKey: 's', sourceQueueId: 'q-src', claimId: 'c9', targetPaneId: 'p9',
      text: '用户改过的草稿', queueText: '原始出站文本', steerId: 'steer-9', sendable: true,
    },
  };
  const back = reclaimClaimItem(slot);
  assert.equal(back.text, '用户改过的草稿',
    'B2: 回收必须保留用户在 claimDraft.text 里的编辑(现在还原成了 queueText 原文,编辑被丢)');
  assert.equal(back.steerState, 'needs-review', 'B2: 回收后仍是人工复核态');
  assert.equal(back.hidden, undefined, 'B2: 回收后必须可见');
}

// ── store 全链路:finalize → 用户编辑 → 孤儿回收 ──
{
  useStore.setState({ messageQueue: {}, paneCount: 2, paneIds: ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'] });
  const st = useStore.getState();
  const item = st.enqueueMessage('sess-b2', { text: '排队原文', queuedAt: 1 });
  st.prepareSteer('sess-b2', item.queueId);
  useStore.getState().settleSteer('sess-b2', item.queueId, 'ambiguous');
  const claimId = useStore.getState().beginQueueClaim('sess-b2', item.queueId, 'p1');
  assert.ok(claimId);
  assert.ok(useStore.getState().writePendingClaimDraft('sess-b2', item.queueId, claimId, 'p1'));
  assert.ok(useStore.getState().finalizeQueueClaim('sess-b2', item.queueId, claimId, 'p1'));
  // 用户在取回窗格把草稿改掉(composer 输入实时同步进 claimDraft.text)
  useStore.getState().updateClaimDraft('p1', claimId, { text: '改成这个再发' });
  const slot = useStore.getState().messageQueue['sess-b2'][0];
  assert.equal(slot.claimDraft.text, '改成这个再发', 'B2 夹具:编辑已写进 claimDraft.text');
  // 目标窗格消失 → 孤儿回收
  useStore.setState({ paneIds: ['p0', 'p2', 'p3', 'p4', 'p5'] });
  useStore.getState().reclaimOrphanClaimDrafts();
  const cur = useStore.getState().messageQueue['sess-b2'][0];
  assert.equal(cur.hidden, undefined, 'B2: 回收后可见');
  assert.equal(cur.text, '改成这个再发',
    'B2: 孤儿回收丢掉了用户编辑(还原成了 queueText 的「排队原文」)');
  // 回收后的条目必须有删除逃生口(不再是不可见的死锁槽)
  useStore.getState().removeFromQueue('sess-b2', 0);
  assert.equal((useStore.getState().messageQueue['sess-b2'] || []).length, 0,
    'B2: 回收后的 needs-review 条目必须可删除');
}

console.log('PASS r26-b2-claim-draft-edit-preserved');
