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
//
// r189 起另有结清判据 S2–S4(窗口证据)与结清记账:见文件末尾第 6–8 节。
import {
  dropStashedUserBubble, dropUserStash, migrateUserStash, pickStashableUserBubbles, settledByWindow,
  stashUserBubbles, summarizeHistoryWindow, takePendingUserBubbles, windowAllLaterThan,
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

// ── 6. r189 窗口汇总(纯函数)────────────────────────────────────────────
const T0 = '2026-11-14T10:00:00.000Z';                       // M 的本地发送时刻
const later = (s) => new Date(Date.parse(T0) + s * 1000).toISOString();
const hUser = (uuid, text, ts) => ({ type: 'user', uuid, text, timestamp: ts });
const hTurn = (uuid, ts) => ({ type: 'turn', uuid, timestamp: ts });
const hNotice = (uuid, ts) => ({ type: 'task-notice', uuid, text: '<task-notification>…</task-notification>', timestamp: ts });
const hPeer = (uuid, ts) => ({ type: 'peer-message', uuid, text: '别的会话发来的', timestamp: ts });
const hCompact = (uuid, ts) => ({ type: 'compact', uuid, timestamp: ts });
const NONE = persistedIndex([]);
const uuidsOf = (r) => ({ pending: r.pending.map((m) => m.uuid), persisted: r.persisted.map((m) => m.uuid) });

t('summarizeHistoryWindow:最晚用户 / 最晚压缩 / 最早时间 / 有无非回复;时间取不到的条目记 allTimed=false', () => {
  const s = summarizeHistoryWindow([hTurn('a', later(5)), hUser('b', 'x', later(3)), hCompact('c', later(9)),
    hUser('d', 'y', later(7)), hNotice('e', later(20))], { hasMore: true });
  assert.equal(s.count, 5); assert.equal(s.hasMore, true);
  assert.equal(s.latestUserTs, Date.parse(later(7)), 'task-notice 不算用户条目');
  assert.equal(s.latestCompactTs, Date.parse(later(9)));
  assert.equal(s.earliestTs, Date.parse(later(3)));
  assert.equal(s.allTimed, true); assert.equal(s.hasNonReply, true);
  const onlyTurns = summarizeHistoryWindow([hTurn('a', later(1)), { type: 'turn', uuid: 'b' }]);
  assert.equal(onlyTurns.hasNonReply, false); assert.equal(onlyTurns.allTimed, false); assert.equal(onlyTurns.hasMore, false);
  assert.equal(windowAllLaterThan(onlyTurns, Date.parse(T0)), false, '有取不到时间的条目 → 不算「每条都晚于 T」');
  assert.equal(windowAllLaterThan(summarizeHistoryWindow([]), Date.parse(T0)), false, '空窗口不算');
  assert.equal(windowAllLaterThan(summarizeHistoryWindow([hTurn('a', later(1))]), Date.parse(T0)), true);
  assert.equal(windowAllLaterThan(summarizeHistoryWindow([hTurn('a', T0)]), Date.parse(T0)), false, '等于 T 不算晚于');
});

// ── 7. r189 结清判据 S1–S4 与两条「不许用的证据」反例 ─────────────────────────
t('S2:窗口里有晚于 T 的用户条目 ⇒ 已结清(孪生在窗口外也撤)', () => {
  const k = nextKey();
  stashUserBubbles(k, [bubble('m1', '上线', T0)]);
  const r = takePendingUserBubbles(k, NONE, { messages: [hTurn('t', later(2)), hUser('n', '别的话', later(60))], hasMore: false });
  assert.deepEqual(uuidsOf(r), { pending: [], persisted: ['m1'] });
});

t('S2 反面:窗口里的用户条目都不晚于 T ⇒ 不结清', () => {
  const k = nextKey();
  stashUserBubbles(k, [bubble('m1', '刚发的', T0)]);
  const r = takePendingUserBubbles(k, NONE, { messages: [hUser('o', '更早的', later(-60)), hUser('p', '同刻', T0)], hasMore: false });
  assert.deepEqual(uuidsOf(r), { pending: ['m1'], persisted: [] });
});

t('S3:有更早的页 + 整页都晚于 T + 有非回复条目 ⇒ 已结清(整页全是任务通知 / 回复也算)', () => {
  const k = nextKey();
  stashUserBubbles(k, [bubble('m1', '旧消息', T0)]);
  const page = [hNotice('n1', later(10)), hTurn('t1', later(11)), hNotice('n2', later(12)), hTurn('t2', later(13))];
  assert.deepEqual(uuidsOf(takePendingUserBubbles(k, NONE, { messages: page, hasMore: true })), { pending: [], persisted: ['m1'] });
});

t('S3 三个条件缺一不可:没有更早的页 / 有一条不晚于 T / 有一条时间取不到 ⇒ 不结清', () => {
  const page = [hNotice('n1', later(10)), hTurn('t1', later(11))];
  const cases = [
    { messages: page, hasMore: false },
    { messages: [hTurn('t0', later(-1)), ...page], hasMore: true },
    { messages: [{ type: 'task-notice', uuid: 'nx', text: 'x' }, ...page], hasMore: true },
  ];
  for (const w of cases) {
    const k = nextKey();
    stashUserBubbles(k, [bubble('m1', '还在等', T0)]);
    assert.deepEqual(uuidsOf(takePendingUserBubbles(k, NONE, w)), { pending: ['m1'], persisted: [] }, JSON.stringify(w));
  }
});

t('反例(不许用的证据一):窗口里只有晚于 T 的回复(哪怕占满一页、左边还有更早的页)⇒ 不结清', () => {
  const k = nextKey();
  stashUserBubbles(k, [bubble('m1', '等着被这轮接收', T0)]);
  const r = takePendingUserBubbles(k, NONE, { messages: [hTurn('t1', later(30))], hasMore: true });
  assert.deepEqual(uuidsOf(r), { pending: ['m1'], persisted: [] }, '回复的时间是最后一条记录的时间,T 之前开始的回复也会晚于 T');
});

t('反例(不许用的证据二):晚于 T 的任务通知 / 别的会话发来的消息(没有更早的页)⇒ 不结清', () => {
  const k = nextKey();
  stashUserBubbles(k, [bubble('m1', '排在通知后面', T0)]);
  const r = takePendingUserBubbles(k, NONE,
    { messages: [hUser('o', '更早', later(-30)), hNotice('n1', later(5)), hTurn('t1', later(6)), hPeer('p1', later(7))], hasMore: false });
  assert.deepEqual(uuidsOf(r), { pending: ['m1'], persisted: [] }, '通知先被处理、先存盘,M 还在等,切回来必须还在');
});

t('S4:/compact 气泡 + 窗口里有不早于 T 的压缩条目 ⇒ 已结清;压缩条目更早或文字不是 /compact ⇒ 不结清', () => {
  const k1 = nextKey();
  stashUserBubbles(k1, [bubble('c1', '  /compact 保留要点', T0)]);
  assert.deepEqual(uuidsOf(takePendingUserBubbles(k1, NONE, { messages: [hCompact('x', T0)], hasMore: false })),
    { pending: [], persisted: ['c1'] });
  const k2 = nextKey();
  stashUserBubbles(k2, [bubble('c2', '/compact', T0)]);
  assert.deepEqual(uuidsOf(takePendingUserBubbles(k2, NONE, { messages: [hCompact('x', later(-5))], hasMore: false })),
    { pending: ['c2'], persisted: [] }, '更早的压缩不是这条的');
  const k3 = nextKey();
  stashUserBubbles(k3, [bubble('c3', '/compactor 不是压缩', T0)]);
  assert.deepEqual(uuidsOf(takePendingUserBubbles(k3, NONE, { messages: [hCompact('x', later(5))], hasMore: false })),
    { pending: ['c3'], persisted: [] });
});

t('M 自己的时间解析不出 ⇒ 只按 S1(窗口证据一概不用)', () => {
  const k = nextKey();
  stashUserBubbles(k, [bubble('m1', '/compact', 'not-a-date')]);
  const w = { messages: [hUser('n', 'x', later(60)), hCompact('c', later(60)), hNotice('z', later(61))], hasMore: true };
  assert.deepEqual(uuidsOf(takePendingUserBubbles(k, NONE, w)), { pending: ['m1'], persisted: [] });
  assert.equal(settledByWindow({ text: 'x', timestamp: undefined }, summarizeHistoryWindow(w.messages, { hasMore: true })), false);
});

t('不传窗口信息时行为与旧版一致(只按 S1)', () => {
  const k = nextKey();
  stashUserBubbles(k, [bubble('m1', '旧调用', T0)]);
  assert.deepEqual(uuidsOf(takePendingUserBubbles(k, NONE)), { pending: ['m1'], persisted: [] });
});

// ── 8. r189 结清记账 ──────────────────────────────────────────────────────
t('一旦结清就记账:之后窗口怎么变(哪怕变空)都归 persisted,不再补回', () => {
  const k = nextKey();
  stashUserBubbles(k, [bubble('m1', '上线', T0), bubble('m2', '刚发', later(100))]);
  const first = takePendingUserBubbles(k, NONE, { messages: [hUser('n', 'x', later(50))], hasMore: false });
  assert.deepEqual(uuidsOf(first), { pending: ['m2'], persisted: ['m1'] });
  assert.deepEqual(uuidsOf(takePendingUserBubbles(k, NONE, { messages: [], hasMore: false })), { pending: ['m2'], persisted: ['m1'] });
  assert.deepEqual(uuidsOf(takePendingUserBubbles(k, NONE)), { pending: ['m2'], persisted: ['m1'] });
});

t('S1 结清同样记账:孪生滑出窗口后不再补回', () => {
  const k = nextKey();
  stashUserBubbles(k, [bubble('m1', '继续', T0)]);
  takePendingUserBubbles(k, persistedIndex([hUser('h', '继续', later(1))]), { messages: [hUser('h', '继续', later(1))], hasMore: false });
  assert.deepEqual(uuidsOf(takePendingUserBubbles(k, NONE, { messages: [hTurn('t', later(2))], hasMore: true })),
    { pending: [], persisted: ['m1'] });
});

t('记账不修改气泡对象(冻结对象照样能结清)', () => {
  const k = nextKey();
  const m = Object.freeze(bubble('m1', '冻结的', T0));
  stashUserBubbles(k, [m]);
  const r = takePendingUserBubbles(k, NONE, { messages: [hUser('n', 'x', later(9))], hasMore: false });
  assert.equal(r.persisted[0], m, '返回的是同一个对象');
  assert.deepEqual(Object.keys(m).sort(), ['text', 'timestamp', 'type', 'uuid']);
});

t('分屏两个窗格各自调用拿到同样的 persisted(不清账)', () => {
  const k = nextKey();
  stashUserBubbles(k, [bubble('m1', '旧', T0)]);
  const w = { messages: [hUser('n', 'x', later(9))], hasMore: false };
  assert.deepEqual(uuidsOf(takePendingUserBubbles(k, NONE, w)), uuidsOf(takePendingUserBubbles(k, NONE, w)));
  assert.deepEqual(uuidsOf(takePendingUserBubbles(k, NONE, w)).persisted, ['m1']);
});

t('同 uuid 再次 stash:已结清的保持已结清', () => {
  const k = nextKey();
  stashUserBubbles(k, [bubble('m1', '旧', T0)]);
  takePendingUserBubbles(k, NONE, { messages: [hUser('n', 'x', later(9))], hasMore: false });
  stashUserBubbles(k, [{ ...bubble('m1', '旧', T0), ownerKey: k }]);
  assert.deepEqual(uuidsOf(takePendingUserBubbles(k, NONE)), { pending: [], persisted: ['m1'] });
});

t('删则同删:dropStashedUserBubble / dropUserStash / 8 键淘汰后,同 uuid 重新进暂存是未结清', () => {
  const settleOne = (k) => {
    stashUserBubbles(k, [bubble('m1', '旧', T0)]);
    takePendingUserBubbles(k, NONE, { messages: [hUser('n', 'x', later(9))], hasMore: false });
  };
  const k1 = nextKey(); settleOne(k1); dropStashedUserBubble(k1, 'm1');
  stashUserBubbles(k1, [bubble('m1', '旧', T0)]);
  assert.deepEqual(uuidsOf(takePendingUserBubbles(k1, NONE)), { pending: ['m1'], persisted: [] }, 'dropStashedUserBubble');
  const k2 = nextKey(); settleOne(k2); dropUserStash(k2);
  stashUserBubbles(k2, [bubble('m1', '旧', T0)]);
  assert.deepEqual(uuidsOf(takePendingUserBubbles(k2, NONE)), { pending: ['m1'], persisted: [] }, 'dropUserStash');
  const k3 = nextKey(); settleOne(k3);
  for (let i = 0; i < 8; i += 1) stashUserBubbles(nextKey(), [bubble(`f${i}`, '挤', T0)]);
  stashUserBubbles(k3, [bubble('m1', '旧', T0)]);
  assert.deepEqual(uuidsOf(takePendingUserBubbles(k3, NONE)), { pending: ['m1'], persisted: [] }, '8 键淘汰');
});

t('迁则同迁:draft→真 sid 改键,结清账跟过去', () => {
  const sid = nextKey(); const draft = `draft-ph2-d${sid}`;
  stashUserBubbles(draft, [bubble('m1', '草稿里的旧消息', T0), bubble('m2', '没结清', later(100))]);
  takePendingUserBubbles(draft, NONE, { messages: [hUser('n', 'x', later(9))], hasMore: false });
  migrateUserStash(draft, sid);
  assert.deepEqual(uuidsOf(takePendingUserBubbles(sid, NONE)), { pending: ['m2'], persisted: ['m1'] });
  assert.deepEqual(uuidsOf(takePendingUserBubbles(draft, NONE)), { pending: [], persisted: [] });
});

t('每个会话键最多 40 条:超出时丢最旧的已结清条目,没结清的一条不丢', () => {
  const k = nextKey();
  // 10 条旧的先结清,再进 31 条没结清的 → 41 条,丢最旧的 1 条已结清
  stashUserBubbles(k, Array.from({ length: 10 }, (_, i) => bubble(`old${i}`, `旧${i}`, later(i))));
  takePendingUserBubbles(k, NONE, { messages: [hUser('n', 'x', later(20))], hasMore: false });
  stashUserBubbles(k, Array.from({ length: 31 }, (_, i) => bubble(`new${i}`, `新${i}`, later(100 + i))));
  const r = uuidsOf(takePendingUserBubbles(k, NONE));
  assert.equal(r.pending.length + r.persisted.length, 40);
  assert.equal(r.pending.length, 31, '没结清的全在');
  assert.deepEqual(r.persisted, Array.from({ length: 9 }, (_, i) => `old${i + 1}`), '丢的是最旧的 old0');
  const k2 = nextKey();
  stashUserBubbles(k2, Array.from({ length: 45 }, (_, i) => bubble(`p${i}`, `等${i}`, later(i))));
  assert.equal(takePendingUserBubbles(k2, NONE).pending.length, 45, '全是没结清的 ⇒ 超上限也不丢');
});

if (failed) { console.log(`\n${failed} 条失败`); process.exit(1); }
console.log('全部通过');
