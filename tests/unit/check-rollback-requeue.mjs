#!/usr/bin/env node
// 判官必修-8(⑧):需求8取证——"connecting/思考时点回滚,中断重发后同一条消息重复进入队列"。
// 结论 a(已治),机制:
//   旧成因 = 回滚/编辑重发走普通 handleSend,撞"回合进行中"入队门被当排队消息 →
//   界面上"AI 被断掉 + 队列里多一条一模一样的";stoppedPids 不记时 1.5s 轮询还会把
//   刚杀的进程复活成 backgroundPid,后续发送继续被门进队列。
//   现行结构性防线(缺一即可复现,全部用本测试钉死):
//   1) App.jsx 全文只有一处 enqueueMessage 调用点,且在 `!opts.forceSend && (streaming||
//      backgroundPid)` 门内 —— 入队是唯一的,forceSend 永不入队;
//   2) 回滚/重做/编辑重发的重发通道 resendReplacing 恒带 forceSend:true(先轮询 ≤4s 等
//      停止落地,到点也发,服务端复用块完成替换);
//   3) handleRollback 把被杀 pid 记进 stoppedPidsRef 并 hard /stop + 清 backgroundPid,
//      轮询不会复活死 pid 把重发再次逼进队列;
//   4) drain 出队后撞门重入队走同一 enqueueMessage 且保留 queueId —— pop→requeue 净一份。
// 变异哨兵(已实际验证红过一次):删掉 resendReplacing 的 forceSend:true → 守卫2红;
// 删掉入队门的 !opts.forceSend 或新增第二个 enqueueMessage 调用点 → 守卫1红。
// Run: node tests/unit/check-rollback-requeue.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); },
};

const { useStore } = await import('../../client/src/stores/sessionStore.js');

// ── store 级时序模拟:回滚重发期间队列不产生第二份 ──
// 场景:M 已排队(忙回合手打消息) → 用户点回滚重发 R(forceSend,不经入队) →
// 老流 finally drain 弹出 M → 新回合已起,M 撞门被重入队(同 queueId)。
useStore.setState({ messageQueue: {} });
const st = useStore.getState();
const M = st.enqueueMessage('sess-r8', { text: '排队中的消息M', queuedAt: 1 });
assert.equal(useStore.getState().messageQueue['sess-r8'].length, 1);

// 回滚重发 R:forceSend 路径【不调用 enqueueMessage】(由下方源码守卫1/2 保证),
// 队列不因 R 增长。
assert.equal(useStore.getState().messageQueue['sess-r8'].length, 1, '重发不入队(forceSend 直发)');

// 老流收尾 drain:原子 pop M
const popped = useStore.getState().shiftMessage('sess-r8');
assert.equal(popped.text, '排队中的消息M');
assert.equal(useStore.getState().messageQueue['sess-r8'].length, 0);
// M 的 50ms 延时发送撞上 R 已起的新回合 → 入队门重入队(handleSend 透传原条目,queueId 不变)
useStore.getState().enqueueMessage('sess-r8', popped);
const after = useStore.getState().messageQueue['sess-r8'];
assert.equal(after.length, 1, 'pop→撞门 requeue 净一份,不复制');
assert.equal(after[0].queueId, M.queueId, 'requeue 保留原 queueId(enqueueMessage 不重新发号)');
assert.equal(after.filter((x) => x.text === '排队中的消息M').length, 1, '同文本只存一份');

// ── 源码守卫(机制1-3;JSX 进不了 node,钉关键判据)──
const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
// 守卫1:App 内入队点白名单保持唯一(handleSend 入队门内);HomeState.submit 的
// **会话前**入队抽进 enqueueHomeDraft 的可执行纯编排层 —— 发生在 draft 尚未挂进任何窗格、该 draftId 也
// 不可能有 streamingRef/backgroundPid 之时(先入队后 setPaneSession),不经过回滚/
// forceSend/重发任何通道;随后由 drain(唯一消费口)弹给 handleSend,撞门重入队仍
// 保留 queueId → 需求8(回滚重发不双入队)不受影响。除这两处外新增仍须重新论证。
assert.equal((app.match(/enqueueMessage\(/g) || []).length, 1,
  'App.jsx 只允许 handleSend 入队门内这一处直接调用;Home 必须走 enqueueHomeDraft 编排入口');
assert.match(app, /enqueueHomeDraft\(\{[\s\S]*?sessionKey: queueKeyFor\(_homeDraft\),/,
  'Home 必须把带 draftId 的 queueKeyFor(draft) 交给原子编排入口');
assert.match(app, /if \(!reattachPid && !opts\.forceSend && \(streamingRef\.current \|\| backgroundPidRef\.current\)\) \{/,
  '入队门必须豁免 forceSend(回滚/重做重发绝不入队)');
// 守卫2:重发通道恒 forceSend
const resendBlock = app.slice(app.indexOf('const resendReplacing = useCallback'), app.indexOf('// Auto-reattach:'));
assert.ok(resendBlock.length > 0, 'resendReplacing 不见了(重构后同步本守卫)');
assert.match(resendBlock, /handleSendRef\.current\?\.\(text, \{ \.\.\.opts, forceSend: true \}\);/,
  '回滚/重做/编辑重发必须带 forceSend:true');
assert.match(resendBlock, /streamingRef\.current \|\| backgroundPidRef\.current/,
  '重发前必须轮询本地 ref 等停止落地(不裸 await 控制类调用)');
// 守卫3:回滚记死 pid + hard 停止 + 清本地 backgroundPid(轮询不复活死 pid)
const rollbackBlock = app.slice(app.indexOf('const handleRollback = useCallback'), app.indexOf('useEffect(() => { handleRollbackRef.current = handleRollback; }'));
assert.match(rollbackBlock, /stoppedPidsRef\.current\.add\(String\(_rbPid\)\);/,
  '回滚必须把被杀 pid 记进 stoppedPidsRef(否则轮询复活死 pid→重发被门进队列)');
assert.equal((rollbackBlock.match(/JSON\.stringify\(\{ hard: true \}\)/g) || []).length, 2,
  '前台流与转后台两种形态都必须真发 hard /stop');
assert.match(rollbackBlock, /backgroundPidRef\.current = null;/,
  '回滚必须同步清 backgroundPidRef(state 有一帧延迟)');

console.log('PASS check-rollback-requeue');
