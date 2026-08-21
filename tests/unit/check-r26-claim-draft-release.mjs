#!/usr/bin/env node
// r26-B2:claim-draft 隐藏空槽卡死队列 + 孤儿回收丢编辑。
// 三刀:①composer-clear 释放 claim(releaseClaimDraft 还原可见 needs-review,原文 queueText);
//      ②reclaimClaimItem 保编辑(无附件 draft.text 优先;有附件恒 queueText 为发送文本,
//        draft.text 只进 displayText);③切会话释放(claimDraft.sessionKey !== 新 permKey)。
// 注意(与 PLAN 验收点①的偏差,语义按状态机钉住):release 产物是 needs-review,
// 它按设计仍是 barrier(等人工处置)——「不再卡死」的可观测锚 = 条目可见 + 可删除,
// 删除后 B 立即可 drain;而不是 release 当场让 B 越过复核条目自动发出(那会复活
// 「未复核消息自动发送」的 bug 家族)。
// Run: node tests/unit/check-r26-claim-draft-release.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); },
};

const { firstDrainableIndex, reclaimClaimItem } = await import('../../client/src/utils/steerQueue.js');
const { useStore } = await import('../../client/src/stores/sessionStore.js');
const st = () => useStore.getState();

// ── ③ reclaimClaimItem 编辑保留哨兵(无附件):draft.text(用户改过的)优先 ──
{
  const back = reclaimClaimItem({
    text: '', queuedAt: 5, hidden: true, queueId: 'claim-draft-9',
    claimDraft: {
      sessionKey: 's', sourceQueueId: 'q-src', claimId: 'c9', targetPaneId: 'p9',
      text: '用户改过的', queueText: '原文', steerId: 'st-9', sendable: true, attachments: [],
    },
  });
  assert.equal(back.text, '用户改过的', 'B2: 回收必须保留用户对草稿的编辑(draft.text 优先)');
  assert.equal(back.steerState, 'needs-review');
  assert.equal(back.hidden, undefined, 'B2: 回收后必须可见');
}

// ── ④ 附件形态哨兵:发送文本恒 queueText,draft.text 只进 displayText ──
{
  const back = reclaimClaimItem({
    text: '', queuedAt: 5, hidden: true, queueId: 'claim-draft-10',
    claimDraft: {
      sessionKey: 's', sourceQueueId: 'q-src', claimId: 'c10', targetPaneId: 'p9',
      text: '展示文本(改过)', queueText: '原始发送文本', sendable: true,
      attachments: [{ kind: 'image', name: 'a.png', path: '/tmp/a.png' }],
    },
  });
  assert.equal(back.text, '原始发送文本', 'B2: 附件形态发送文本恒取 queueText(展示文本绝不当发送文本)');
  assert.equal(back.opts?.meta?.displayText, '展示文本(改过)', 'B2: draft.text 只回填 displayText');
  assert.equal(back.opts?.meta?.attachments?.length, 1, 'B2: 附件原样回填');
}

// ── ①② store 全链路:finalize → 用户编辑 → release(放弃编辑,还原原文)──
{
  useStore.setState({ messageQueue: {}, paneCount: 2, paneIds: ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'] });
  const item = st().enqueueMessage('sess-rel', { text: '排队原文', queuedAt: 1 });
  st().prepareSteer('sess-rel', item.queueId);
  st().settleSteer('sess-rel', item.queueId, 'ambiguous');
  // 后面再压一条,验证「卡死 → 有逃生口」
  st().enqueueMessage('sess-rel', { text: 'B', queuedAt: 2 });
  const claimId = st().beginQueueClaim('sess-rel', item.queueId, 'p1');
  assert.ok(claimId);
  assert.ok(st().writePendingClaimDraft('sess-rel', item.queueId, claimId, 'p1'));
  assert.ok(st().finalizeQueueClaim('sess-rel', item.queueId, claimId, 'p1'));
  st().updateClaimDraft('p1', claimId, { text: '改成这个再发' });
  // 卡死形态:占位槽沉在队首,B 永远排不到
  assert.equal(firstDrainableIndex(st().messageQueue['sess-rel']), -1, 'B2 夹具:占位槽卡死 drain');
  // 用户清空输入框 → release:还原 queueText 原文(编辑随放弃丢弃),可见 needs-review
  st().releaseClaimDraft('p1', claimId);
  const list = st().messageQueue['sess-rel'];
  assert.equal(list[0].hidden, undefined, 'B2: release 后可见');
  assert.equal(list[0].text, '排队原文', 'B2: release 还原 queueText 原文(放弃编辑语义)');
  assert.equal(list[0].steerState, 'needs-review');
  assert.equal('claimDraft' in list[0], false);
  // 逃生口:needs-review 可删(不再被 claimDraft 拒删),删后 B 立即可 drain
  st().removeFromQueue('sess-rel', 0);
  assert.equal(st().messageQueue['sess-rel'].length, 1, 'B2: release 产物可删除(死锁解除)');
  assert.equal(firstDrainableIndex(st().messageQueue['sess-rel']), 0, 'B2: 删除复核条目后 B 可 drain');
}

// ── ②b reclaim(非放弃路径,如孤儿回收)保编辑:与 release 的 discardEdits 区分 ──
{
  useStore.setState({ messageQueue: {}, paneIds: ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'] });
  const item = st().enqueueMessage('sess-keep', { text: '原文文本', queuedAt: 1 });
  st().prepareSteer('sess-keep', item.queueId);
  st().settleSteer('sess-keep', item.queueId, 'ambiguous');
  const claimId = st().beginQueueClaim('sess-keep', item.queueId, 'p1');
  st().writePendingClaimDraft('sess-keep', item.queueId, claimId, 'p1');
  st().finalizeQueueClaim('sess-keep', item.queueId, claimId, 'p1');
  st().updateClaimDraft('p1', claimId, { text: '我改过的版本' });
  useStore.setState({ paneIds: ['p0', 'p2', 'p3', 'p4', 'p5'] }); // p1 消失 → 孤儿
  st().reclaimOrphanClaimDrafts();
  assert.equal(st().messageQueue['sess-keep'][0].text, '我改过的版本',
    'B2: 孤儿回收(非用户放弃)必须保留编辑');
}

// ── ③b 切会话释放的 store 侧锚:releaseClaimDraft 只动匹配的 (paneId, claimId) ──
{
  useStore.setState({ messageQueue: {}, paneIds: ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'] });
  const item = st().enqueueMessage('sess-x', { text: 'X', queuedAt: 1 });
  st().prepareSteer('sess-x', item.queueId);
  st().settleSteer('sess-x', item.queueId, 'ambiguous');
  const claimId = st().beginQueueClaim('sess-x', item.queueId, 'p1');
  st().writePendingClaimDraft('sess-x', item.queueId, claimId, 'p1');
  st().finalizeQueueClaim('sess-x', item.queueId, claimId, 'p1');
  st().releaseClaimDraft('p2', 'claim-不存在'); // 误匹配哨兵
  assert.equal(st().messageQueue['sess-x'][0].claimDraft?.sendable, true, 'B2: 不匹配的 release 不得动别的 claim 槽');
  st().releaseClaimDraft('p1', claimId);
  assert.equal(st().messageQueue['sess-x'][0].steerState, 'needs-review');
}

// ── migrateSessionKey 同步 claimDraft.sessionKey(draft→真 sid 不触发误释放)──
{
  useStore.setState({ messageQueue: {}, paneIds: ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'] });
  const draftKey = 'draft-h9-d1-1';
  const item = st().enqueueMessage(draftKey, { text: 'M', queuedAt: 1 });
  st().prepareSteer(draftKey, item.queueId);
  st().settleSteer(draftKey, item.queueId, 'ambiguous');
  const claimId = st().beginQueueClaim(draftKey, item.queueId, 'p1');
  st().writePendingClaimDraft(draftKey, item.queueId, claimId, 'p1');
  st().finalizeQueueClaim(draftKey, item.queueId, claimId, 'p1');
  st().migrateSessionKey(draftKey, 'sid-real-9');
  const moved = st().messageQueue['sid-real-9']?.[0];
  assert.equal(moved?.claimDraft?.sessionKey, 'sid-real-9',
    'B2: 队列迁移必须同步 claimDraft.sessionKey(否则切会话判据误释放)');
}

// ── 源码守卫:ChatInput 两条释放路径都在(JSX 进不了 node,钉接线)──
{
  const src = readFileSync(new URL('../../client/src/components/ChatInput.jsx', import.meta.url), 'utf8');
  const onClearBlock = src.slice(src.indexOf('const onClear ='), src.indexOf("addEventListener('cgui:composer-clear'"));
  assert.ok(/releaseClaimDraft\(paneId, claimDraft\.claimId\)/.test(onClearBlock),
    'B2①: composer-clear 必须释放 sendable claim');
  assert.ok(/claimDraft\.sessionKey !== permKey/.test(src),
    'B2③: 切会话(permKey 变化)必须释放不属于新会话的 claim');
}

console.log('PASS check-r26-claim-draft-release');
