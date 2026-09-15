#!/usr/bin/env node
// r118 切会话暂存自检:回合进行中切走再切回,刚发出的用户气泡不许消失,也不许画两遍/串会话。
//
// 被测的是 client/src/utils/localUserStash.js(纯函数,零 React/store 依赖)。App.jsx 只做三处接线:
//   ① 切会话 effect:挑本会话的用户气泡暂存后再清本地副本;
//   ② 历史变化 effect:切回后补回未落盘的、撤掉已落盘的;
//   ③ init 的 draft→真 sid 迁移:暂存改键。
// 覆盖四条:按会话隔离(不渲染到别的会话)、历史出现后撤除(不画两遍)、draft/真 sid 两键口径、
// 身份口径防误撤(同文本旧消息不得把新气泡判成已落盘 —— 这条是 App.jsx makePersistedIndex 的规则,
// 这里按同口径复刻一份驱动暂存的对账分支;App.jsx 里喂进来的就是真身)。
import assert from 'node:assert/strict';
import {
  dropUserStash, migrateUserStash, pickStashableUserBubbles, stashUserBubbles, takePendingUserBubbles,
} from '../../client/src/utils/localUserStash.js';
import { localEntryVisible } from '../../client/src/utils/sessionFlowIdentity.js';

// 模块级暂存是跨用例共享的 → 每条用例自带一套会话键,互不串门。
let seq = 0;
const nextKey = () => `sess-${(seq += 1)}`;

const bubble = (uuid, text, timestamp = '2026-09-15T05:00:00.000Z') => ({ uuid, type: 'user', text, timestamp });
const other = (uuid, type = 'turn') => ({ uuid, type, text: 'assistant 侧内容' });

// App.jsx 模块级 makePersistedIndex 的用户消息口径:类型 + 全文 + 【落盘时间不早于本地发送时刻】。
// 同文本的旧消息(时间更早)不得判成"这条已落盘"——否则刚发出的气泡会被整条清掉(实测缺席 17.6s)。
function persistedIndex(persisted) {
  const userLatest = new Map();
  const weak = new Set();
  for (const m of persisted || []) {
    weak.add(`${m?.type}|${String(m?.text || '').slice(0, 80)}`);
    if (m?.type === 'user') {
      const ts = Date.parse(m?.timestamp);
      if (Number.isFinite(ts) && !(userLatest.get(m.text) >= ts)) userLatest.set(m.text, ts);
    }
  }
  return {
    has(m) {
      if (m?.type !== 'user') return weak.has(`${m?.type}|${String(m?.text || '').slice(0, 80)}`);
      const latest = userLatest.get(m.text);
      const ts = Date.parse(m?.timestamp);
      return latest !== undefined && Number.isFinite(ts) && latest >= ts;
    },
  };
}

let failed = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) { failed += 1; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

console.log('check-local-user-stash:');

// ── 1. 挑暂存:只挑用户气泡,且必须严格属于切走的那个会话 ──────────────────────
t('只挑用户气泡:turn/error/btw 等助手侧本地条目不进暂存', () => {
  const k = nextKey();
  const chat = [bubble('u1', '刚发的那句'), other('t1'), { uuid: 'b1', type: 'btw', text: '旁问' }];
  const picked = pickStashableUserBubbles(chat, { ownerKey: k, streamOwnerKey: k });
  assert.deepEqual(picked.map((m) => m.uuid), ['u1']);
});

t('归属门:流归属是别的会话时,无 ownerKey 的条目不算本会话的(不暂存)', () => {
  const a = nextKey(); const b = nextKey();
  const chat = [bubble('u1', 'A 的'), { ...bubble('u2', 'B 的'), ownerKey: b }];
  assert.equal(pickStashableUserBubbles(chat, { ownerKey: a, streamOwnerKey: b }).length, 0,
    'streamOwnerKey 指向 B ⇒ A 的无主条目不许被当成 A 的暂存走(反之会串会话)');
  assert.equal(pickStashableUserBubbles(chat, { ownerKey: a, streamOwnerKey: null }).length, 0,
    'ownerKey 指向 B 的条目只在当前会话是 B 时才可见');
  assert.deepEqual(pickStashableUserBubbles([], { ownerKey: a, streamOwnerKey: a }), [], '空输入不挑出任何东西');
});

// ── 2. 按会话隔离:暂存的东西永不落到别的会话 ────────────────────────────────
t('按会话隔离:给 A 存的暂存,B 取不到', () => {
  const a = nextKey(); const b = nextKey();
  stashUserBubbles(a, [bubble('u1', 'A 的话')]);
  const inB = takePendingUserBubbles(b, persistedIndex([]));
  assert.deepEqual([inB.pending, inB.persisted], [[], []], 'B 会话不该拿到任何 A 的暂存内容');
  assert.deepEqual(takePendingUserBubbles(a, persistedIndex([])).pending.map((m) => m.uuid), ['u1']);
});

t('补回的条目 ownerKey 钉在当前会话键上:切到别的会话后渲染层门控挡得住', () => {
  const a = nextKey(); const b = nextKey();
  const restored = { ...bubble('u1', 'A 的话'), ownerKey: a };
  assert.equal(localEntryVisible({ ownerKey: restored.ownerKey, streamOwnerKey: null, sessionQueueKey: a }), true);
  assert.equal(localEntryVisible({ ownerKey: restored.ownerKey, streamOwnerKey: b, sessionQueueKey: b }), false,
    '同一份内容出现在 B 会话时必须被判为不可见 —— 加上这一层,暂存永无串会话的可能');
});

// ── 3. 历史出现后撤除(不画两遍)────────────────────────────────────────────
t('历史里出现了同一条 ⇒ 判为已落盘,交给历史画(本地副本撤除)', () => {
  const k = nextKey();
  stashUserBubbles(k, [bubble('u1', '继续', '2026-09-15T05:00:00.000Z')]);
  const known = persistedIndex([{ type: 'user', text: '继续', timestamp: '2026-09-15T05:00:03.000Z' }]);
  const { pending, persisted } = takePendingUserBubbles(k, known);
  assert.deepEqual(pending, [], '已落盘的不再补回');
  assert.deepEqual(persisted.map((m) => m.uuid), ['u1'], '返回给组件撤除的那一条正是本地副本');
});

t('还没落盘 ⇒ 不撤除,继续补回(慢启动窗口里的正确行为)', () => {
  const k = nextKey();
  stashUserBubbles(k, [bubble('u2', 'R118 SLOW 第1轮')]);
  const { pending, persisted } = takePendingUserBubbles(k, persistedIndex([]));
  assert.deepEqual(pending.map((m) => m.uuid), ['u2']);
  assert.deepEqual(persisted, []);
});

t('防误撤:历史里同文本的【旧】消息不得把新气泡判成已落盘', () => {
  const k = nextKey();
  stashUserBubbles(k, [bubble('u3', '继续', '2026-09-15T06:00:00.000Z')]);   // 刚发出的这条
  const known = persistedIndex([{ type: 'user', text: '继续', timestamp: '2026-09-15T05:00:00.000Z' }]); // 一小时前那条
  assert.deepEqual(takePendingUserBubbles(k, known).persisted, [],
    '同文本旧消息不能当成本条的落盘证据(弱口径会误判 → 气泡凭空消失)');
});

t('撤除幂等:反复取回结果一致,不会第二次又变回"该补回"', () => {
  const k = nextKey();
  stashUserBubbles(k, [bubble('u4', '再试一次', '2026-09-15T05:00:00.000Z')]);
  const known = persistedIndex([{ type: 'user', text: '再试一次', timestamp: '2026-09-15T05:00:01.000Z' }]);
  assert.equal(takePendingUserBubbles(k, known).pending.length, 0);
  assert.equal(takePendingUserBubbles(k, known).pending.length, 0, '第二次仍为空(不会失而复现)');
});

// ── 4. draft 键与真 sid 两个口径 ──────────────────────────────────────────
t('draft→真 sid 改键:暂存跟过去,旧键不再留副本', () => {
  const sid = nextKey(); const draft = `draft-ph1-d${sid}`; const otherSid = nextKey();
  stashUserBubbles(draft, [bubble('u5', '草稿里发的第一条')]);
  migrateUserStash(draft, sid);
  assert.deepEqual(takePendingUserBubbles(sid, persistedIndex([])).pending.map((m) => m.uuid), ['u5']);
  assert.deepEqual(takePendingUserBubbles(draft, persistedIndex([])).pending, [], '旧 draft 键已清空,不会两处都补回');
  migrateUserStash('draft-另一个', otherSid);   // 空键改键 = 纯 no-op
  assert.deepEqual(takePendingUserBubbles(otherSid, persistedIndex([])).pending, []);
});

t('同 uuid 重复切走只留一份(反复切走切回不叠加)', () => {
  const k = nextKey();
  const one = bubble('u6', '反复切');
  stashUserBubbles(k, [one]);
  stashUserBubbles(k, [{ ...one, uuid: 'u6', text: '反复切' }]);
  assert.equal(takePendingUserBubbles(k, persistedIndex([])).pending.length, 1);
});

t('回滚后丢弃:dropUserStash 后不再补回(尾部已从 jsonl 裁掉)', () => {
  const k = nextKey();
  stashUserBubbles(k, [bubble('u7', '要被回滚的')]);
  dropUserStash(k);
  assert.deepEqual(takePendingUserBubbles(k, persistedIndex([])).pending, []);
});

// ── 5. 上限:长期使用不无限涨 ─────────────────────────────────────────────
t('只留最近 N 个会话键:超上限整键淘汰最旧的,最新的还在', () => {
  const keys = Array.from({ length: 10 }, () => nextKey());
  keys.forEach((k, i) => stashUserBubbles(k, [bubble(`u-${k}`, `内容 ${i}`)]));
  assert.deepEqual(takePendingUserBubbles(keys[0], persistedIndex([])).pending, [], '最旧的键已被淘汰');
  assert.deepEqual(takePendingUserBubbles(keys[9], persistedIndex([])).pending.map((m) => m.uuid), [`u-${keys[9]}`]);
});

if (failed) { console.log(`\n${failed} 条失败`); process.exit(1); }
console.log('全部通过');
