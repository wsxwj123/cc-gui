// r208 第 2 项:同一次压缩只画一条「上下文已压缩」分隔线(client/src/utils/liveCompactDivider.js + App.jsx 接线)。
//   L1 历史里已有本轮那次压缩(时间不早于这一轮起点)→ 直播那条不画
//   L2 历史里还没有(还没重读到)→ 直播那条照画
//   L3 历史里只有更早的压缩 → 直播那条照画,更早的一条不动
//   L4 一轮里只有直播那条(历史一条压缩都没有)→ 不被误藏
//   L5 边界:没记下起点的直播那条照画;时间等于起点算本轮;历史那条没有时间 / 时间解析不出不算;不需要去掉时返回原数组
//   L6 没有快照的重接:起点取历史里这一轮提示词的时间(重放把重接之前那次压缩再送一遍时也能认出),用重接那一刻就认不出
//   L7 App.jsx 接线:渲染期 renderChatBase 按已显示的历史过一遍;收到 compact_boundary 追加直播那条时记下 roundStartTs
// node tests/unit/check-r208-live-compact-divider.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dropLiveCompactCoveredByHistory, historyHasRoundCompact, isLiveCompactDivider } from '../../client/src/utils/liveCompactDivider.js';
import { lastPromptTs } from '../../client/src/utils/reattachTail.js';

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };

const iso = (ms) => new Date(ms).toISOString();
const T0 = Date.parse('2026-11-21T12:00:00.000Z');
const user = (uuid, ms, extra = {}) => ({ type: 'user', uuid, text: [`提示 ${uuid}`], timestamp: iso(ms), ...extra });
const turn = (uuid, ms) => ({ type: 'turn', uuid, timestamp: iso(ms) });
const histCompact = (uuid, ms) => ({ type: 'compact', uuid, timestamp: iso(ms) });
const live = (roundStartTs) => ({ type: 'compact', uuid: 'live-compact', _live: true, ownerKey: 'sid-a', roundStartTs });
const localUser = { type: 'user', uuid: 'local-u', text: ['本轮'], ownerKey: 'sid-a' };
// 渲染出来的整页 = 已显示的历史 + 本地段(与 App.jsx 的 allMessages 同构),数压缩分隔线条数
const dividers = (history, local) => [...history, ...dropLiveCompactCoveredByHistory(local, history)].filter((m) => m?.type === 'compact').length;

const roundStart = T0 + 10_000;
const earlier = [user('u1', T0), turn('t1', T0 + 1000), histCompact('c-old', T0 + 2000), turn('t2', T0 + 3000)];

// L1
{
  const history = [...earlier, user('u2', roundStart + 50), histCompact('c-now', roundStart + 4000), turn('t3', roundStart + 5000)];
  const local = [localUser, live(roundStart)];
  const out = dropLiveCompactCoveredByHistory(local, history);
  ok(!out.some(isLiveCompactDivider), 'L1:历史已有本轮那次压缩 → 直播那条不画');
  ok(out.includes(localUser), 'L1:本地其余条目原样保留');
  ok(dividers(history, local) === 2, 'L1:整页 = 更早一条 + 本轮一条(本轮只一条)');
  ok(historyHasRoundCompact(history, roundStart), 'L1:historyHasRoundCompact 认出本轮那次');
}

// L2
{
  const history = [...earlier, user('u2', roundStart + 50)];
  const local = [localUser, live(roundStart)];
  const out = dropLiveCompactCoveredByHistory(local, history);
  ok(out === local, 'L2:历史还没重读到本轮压缩 → 原样返回(直播那条照画)');
  ok(dividers(history, local) === 2, 'L2:整页 = 更早一条 + 直播一条');
}

// L3
{
  const history = [...earlier, histCompact('c-old2', T0 + 4000)];
  const local = [live(roundStart)];
  ok(dropLiveCompactCoveredByHistory(local, history) === local, 'L3:历史只有更早的压缩 → 直播那条照画');
  ok(dividers(history, local) === 3, 'L3:更早的两条各一条 + 直播一条');
  ok(!historyHasRoundCompact(history, roundStart), 'L3:更早的压缩不算本轮');
}

// L4
{
  const local = [localUser, live(roundStart)];
  ok(dropLiveCompactCoveredByHistory(local, []) === local, 'L4:历史为空 → 直播那条照画');
  ok(dropLiveCompactCoveredByHistory(local, [user('u1', T0), turn('t1', T0 + 1)]) === local, 'L4:历史没有压缩 → 直播那条照画');
  ok(dividers([user('u1', T0)], local) === 1, 'L4:一轮里只有直播那条 → 整页一条');
  // 这一轮结束:本地段清空,只剩历史那条
  ok(dividers([...earlier, user('u2', roundStart + 50), histCompact('c-now', roundStart + 4000)], []) === 2, 'L4:这一轮结束后本轮仍是一条(历史那条)');
}

// L5
{
  const history = [...earlier, histCompact('c-now', roundStart + 4000)];
  for (const bad of [0, undefined, null, NaN, -1]) {
    const local = [live(bad)];
    ok(dropLiveCompactCoveredByHistory(local, history) === local, `L5:没记下起点(${String(bad)})→ 照画`);
  }
  ok(historyHasRoundCompact([histCompact('c-eq', roundStart)], roundStart), 'L5:时间等于起点算本轮');
  ok(!historyHasRoundCompact([histCompact('c-1ms', roundStart - 1)], roundStart), 'L5:早 1 毫秒不算本轮');
  ok(!historyHasRoundCompact([{ type: 'compact', uuid: 'c-nots' }], roundStart), 'L5:历史那条没有时间不算');
  ok(!historyHasRoundCompact([{ type: 'compact', uuid: 'c-bad', timestamp: 'not-a-date' }], roundStart), 'L5:时间解析不出不算');
  ok(!historyHasRoundCompact([{ ...live(roundStart), timestamp: iso(roundStart + 1) }], roundStart), 'L5:历史里混进的直播条目不算');
  const plain = [localUser, turn('local-t', roundStart + 1)];
  ok(dropLiveCompactCoveredByHistory(plain, history) === plain, 'L5:本地没有直播分隔线 → 返回原数组');
  ok(Array.isArray(dropLiveCompactCoveredByHistory(null, history)) && dropLiveCompactCoveredByHistory(null, history).length === 0, 'L5:本地段不是数组 → 空数组');
  ok(dropLiveCompactCoveredByHistory([live(roundStart)], null).length === 1, 'L5:历史不是数组 → 照画');
}

// L6:没有快照的重接(刷新后接上一轮在跑的回复)。这一轮的提示词在 roundStart+50 写进会话记录,压缩在重接之前(roundStart+4000)
// 就发生了,重接那一刻是 roundStart+9000,重放把那次 compact_boundary 再送一遍。
{
  const reattachAt = roundStart + 9000;
  const history = [...earlier, user('u2', roundStart + 50), user('steer', roundStart + 6000, { steered: true }), histCompact('c-now', roundStart + 4000)];
  const bound = lastPromptTs(history) || reattachAt; // 与 App.jsx 收到 compact_boundary 处同一取法
  eq(bound, roundStart + 50, 'L6:起点取这一轮提示词的时间(引导条目不算提示词)');
  ok(!dropLiveCompactCoveredByHistory([live(bound)], history).some(isLiveCompactDivider), 'L6:按提示词时间 → 认出历史里那条,直播那条不画');
  ok(dropLiveCompactCoveredByHistory([live(reattachAt)], history).some(isLiveCompactDivider), 'L6:对照:按重接那一刻 → 认不出(会画两条),所以不能用它');
  ok(lastPromptTs([...earlier]) === T0, 'L6:历史里只有更早的提示词时取到的是更早的(起点只会更早,不会更晚)');
}

// L7
{
  const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
  ok(app.includes("import { dropLiveCompactCoveredByHistory } from './utils/liveCompactDivider.js';"), 'L7:App.jsx 引入判据');
  const baseAt = app.indexOf('const renderChatBase = useMemo(() => {');
  const baseEnd = app.indexOf('}, [visibleChat, renderedTurnIdentity, finalizedMessages]);', baseAt);
  ok(baseAt > 0 && baseEnd > baseAt, 'L7:找到 renderChatBase');
  ok(app.slice(baseAt, baseEnd).includes('dropLiveCompactCoveredByHistory(kept, finalizedMessages)'), 'L7:renderChatBase 按已显示的历史(finalizedMessages)过一遍');
  const evAt = app.indexOf("if (event.type === 'system' && event.subtype === 'compact_boundary') {");
  const evEnd = app.indexOf('});', evAt);
  const ev = app.slice(evAt, evEnd);
  ok(evAt > 0 && app.indexOf("if (event.type === 'system' && event.subtype === 'compact_boundary') {", evAt + 1) < 0, 'L7:收到 compact_boundary 的追加处只有一处');
  ok(ev.includes('const liveCompactPromptTs = unseededReattach() && paneStillOn(sessionQueueKey, streamSid) ? lastPromptTs(getLocalMessages()) : 0;'), 'L7:没有快照的重接取历史里这一轮提示词的时间');
  ok(ev.includes('const liveCompactRoundStartTs = liveCompactPromptTs || turnStreamStart;'), 'L7:其余取本流起流时刻');
  ok(ev.includes("{ type: 'compact', uuid: 'live-compact', _live: true, ownerKey: streamSid || sessionQueueKey, roundStartTs: liveCompactRoundStartTs }"), 'L7:直播那条记下 roundStartTs');
}

console.log(`✓ check-r208-live-compact-divider:${checks} 项断言全部通过`);
