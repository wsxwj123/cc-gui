#!/usr/bin/env node
// r207 自检(前端):回合结束核对带 limit 只取最后一页之后,判定与原来拉整份时相同。
//   ① persistedTurnCount:各种「发送开头那份 / 这一页」组合下,「整份回合数 > 发送前回合数」的结论与拿整份算的逐一相同
//      (短会话、发送前已加载到头、发送前只加载了最后一页、这一轮新增超过一页、回合还没落盘);
//   ② 窗口证据:最后一个回合超过 8MB、一页只有它时,本回合较早入队的并入条目不被误判失败(留到下次);
//      这一页覆盖到入队时刻 / 页左边没有更早的 → 照原来判;已落盘的照旧出队;
//   ③ 接线哨兵:peek 请求带 limit;reconcileSteerQueue 收到 canJudge;roundLanded 用 persistedTurnCount。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { persistedTurnCount, pagingHasOlder, HISTORY_PAGE_SIZE } = await import('../../client/src/utils/historyPaging.js');
const { steerWindowJudge, reconcileSteered } = await import('../../client/src/utils/steerQueue.js');

let passed = 0;
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); passed += 1; };

// ── ① 回合数换算 ──────────────────────────────────────────────────────
const T0 = Date.parse('2026-11-21T10:00:00.000Z');
let seq = 0;
const msg = (type) => { seq += 1; return { type, uuid: `${type}-${seq}`, timestamp: new Date(T0 + seq * 1000).toISOString(), ...(type === 'turn' ? { text: [`答${seq}`] } : { text: `问${seq}` }) }; };
const history = (pairs) => Array.from({ length: pairs }, () => [msg('user'), msg('turn')]).flat();
const turns = (list) => list.filter((m) => m.type === 'turn').length;
const pageOf = (full, size = HISTORY_PAGE_SIZE) => ({ page: full.slice(-size), pageHasMore: full.length > size });

function check(name, { sendFull, loaded, added, pageSize = HISTORY_PAGE_SIZE }) {
  const origin = sendFull.slice(-loaded);                // 发送开头那份 = 已加载的最后 loaded 条
  const originHasOlder = loaded < sendFull.length;
  const turnsBefore = turns(origin);
  const now = [...sendFull, ...added];
  const oldLanded = turns(now) > turnsBefore;            // 原来:拉整份
  const { page, pageHasMore } = pageOf(now, pageSize);
  const newLanded = persistedTurnCount({ page, pageHasMore, origin, originHasOlder }) > turnsBefore;
  eq(newLanded, oldLanded, `${name}:带 limit 的结论(${newLanded})与拉整份(${oldLanded})相同`);
}
for (const landed of [true, false]) {
  const tail = () => (landed ? [msg('user'), msg('turn')] : [msg('user')]);
  const tag = landed ? '回合已落盘' : '回合还没落盘';
  { const f = history(20); check(`短会话全加载 / ${tag}`, { sendFull: f, loaded: f.length, added: tail() }); }
  { const f = history(70); check(`发送前已加载到头(140 条)/ ${tag}`, { sendFull: f, loaded: f.length, added: tail() }); }
  { const f = history(200); check(`发送前只加载了最后 120 条 / ${tag}`, { sendFull: f, loaded: 120, added: tail() }); }
  { const f = history(70); check(`发送前已加载到头,这一轮新增 130 条 / ${tag}`, { sendFull: f, loaded: f.length,
    added: [msg('user'), ...Array.from({ length: 64 }, () => [msg('user'), msg('turn')]).flat(), ...(landed ? [msg('turn')] : [msg('user')])] }); }
  { const f = history(70); check(`最后一个回合超过 8MB(一页只有 1 条)/ ${tag}`, { sendFull: f, loaded: f.length, added: tail(), pageSize: 1 }); }
}
eq(persistedTurnCount({ page: [], pageHasMore: false, origin: history(3), originHasOlder: false }), 0, 'peek 失败(空页):0 回合 = 不算落盘');
eq(pagingHasOlder({ sessionId: 's', hasMore: true }, 's'), true, '分页账属于本会话:按 hasMore');
eq(pagingHasOlder({ sessionId: 'x', hasMore: true }, 's'), false, '分页账不属于本会话:按没有更早的算');
eq(pagingHasOlder(null, 's'), false, '没有分页账');

// ── ② 窗口证据 ────────────────────────────────────────────────────────
{
  const enqueuedAt = T0 + 500_000;
  const steer = (id) => ({ queueId: `q-${id}`, steerId: id, steerState: 'accepted', queuedAt: enqueuedAt, acceptedAt: enqueuedAt + 50, text: '并入' });
  const hugeLastTurn = [{ type: 'turn', uuid: 'big', timestamp: new Date(enqueuedAt + 60_000).toISOString(), text: ['超过 8MB 的最后一个回合'] }];
  const keys = new Set();
  // 原来(不看窗口)会翻成复核
  eq(reconcileSteered([steer('s1')], null, keys, { turnActive: false })[0].steerState, 'needs-review', '前提:不看窗口时,没命中的终局对账会翻成复核');
  // 一页只有超大的最后一个回合,且它晚于入队 → 不判,原样留着
  const judge = steerWindowJudge(hugeLastTurn, true);
  const kept = reconcileSteered([steer('s1')], null, keys, { turnActive: false, canJudge: judge });
  eq(kept[0].steerState, 'accepted', '这一页覆盖不到入队时刻 → 不判失败,留到下次刷新');
  // 这一页第一条早于入队 → 照原来判
  const covering = [{ type: 'user', uuid: 'u-early', timestamp: new Date(enqueuedAt - 1000).toISOString() }, ...hugeLastTurn];
  eq(reconcileSteered([steer('s1')], null, keys, { turnActive: false, canJudge: steerWindowJudge(covering, true) })[0].steerState, 'needs-review', '覆盖到入队时刻 → 照原来翻');
  // 页左边没有更早的(整份)→ 照原来判
  eq(reconcileSteered([steer('s1')], null, keys, { turnActive: false, canJudge: steerWindowJudge(hugeLastTurn, false) })[0].steerState, 'needs-review', '整份 → 照原来翻');
  // 已落盘的照旧出队(不受窗口影响)
  eq(reconcileSteered([steer('s2')], null, new Set(['s2']), { turnActive: false, canJudge: judge }), [], '已落盘 → 出队');
  // 取不到入队时刻:只有整份才判
  const noTime = { queueId: 'q3', steerId: 's3', steerState: 'accepted', text: 'x' };
  eq(steerWindowJudge(covering, true)(noTime), false, '没有入队时刻且不是整份 → 不判');
  eq(steerWindowJudge(covering, false)(noTime), true, '整份 → 判');
}

// ── ③ 接线哨兵 ────────────────────────────────────────────────────────
{
  const app = readFileSync(join(root, 'client/src/App.jsx'), 'utf8');
  eq(app.includes('/messages?projectHash=${encodeURIComponent(finalizePh)}&limit=${HISTORY_PAGE_SIZE}`'), true, '回合结束 peek 带 limit');
  eq(/\/messages\?projectHash=\$\{encodeURIComponent\(finalizePh\)\}`/.test(app), false, '没有不带 limit 的 peek');
  eq(app.includes('st.reconcileSteerQueue(finalizeSid, keys, { turnActive: false, canJudge });'), true, '终局对账带窗口证据');
  eq(app.includes('if (!reattachPid && persistedTurnCount({'), true, 'roundLanded 按换算后的回合数比');
}

console.log(`check-r207-peek-window: OK (${passed} assertions)`);
