#!/usr/bin/env node
// 条带折叠:异常收尾记录(roundStrip)+ 读侧时间窗判据(roundStripEnd)。
// 这套东西取代了原稿的"按 turn.uuid 查表"—— 直播回合期间 paneMessages 是陈旧的
// (整轮不刷历史),"取最后一条 turn"会取到上一轮;而本地停止/报错副本的 uuid 是 chat-* 哨兵,
// 按 uuid 查必然落空。时间窗只用两个现成时刻(本轮流开始 + 写记录那一刻),不读消息列表。
// 变异哨兵:判据里的 since/until 任一边界写成开区间 → t3 红;selector 键改成 uuid → t4 红;
// 写入侧把 since 兜底改回 `Number(since) || 0`(或把拒写改回静默)→ t2 红。
import assert from 'node:assert/strict';
import { useStore, roundStripEnd } from '../../client/src/stores/sessionStore.js';

const SID = 'aaaa1111-2222-4333-8444-555566667777';
const SID2 = 'bbbb1111-2222-4333-8444-555566667777';
const iso = (ms) => new Date(ms).toISOString();
const T0 = Date.parse('2026-09-13T10:00:00.000Z');

// ── t1 写入形状:四件事齐全、单槽覆盖、跨会话互不影响 ──
{
  const st = () => useStore.getState();
  st().markRoundAbnormal(SID, { end: 'aborted', since: T0, until: T0 + 800 });
  const rec = st().roundStrip[SID];
  assert.equal(rec.end, 'aborted', 'end 落盘');
  assert.equal(rec.since, T0, 'since 落盘');
  assert.equal(rec.until, T0 + 800, 'until 落盘');
  assert.ok(rec.since <= rec.until, 'since ≤ until');

  st().markRoundAbnormal(SID, { end: 'error', since: T0 + 5000, until: T0 + 5600 });
  assert.equal(Object.keys(st().roundStrip).length, 1, '同一会话恒 1 条(后写覆盖,不追加)');
  assert.equal(st().roundStrip[SID].end, 'error', '后写覆盖旧记录');

  st().markRoundAbnormal(SID2, { end: 'aborted', since: T0, until: T0 + 100 });
  assert.equal(st().roundStrip[SID].end, 'error', '写别的会话不动本会话');
  assert.equal(st().roundStrip[SID2].end, 'aborted', '两个会话各自一条');

  st().clearRoundAbnormal(SID);
  assert.equal(st().roundStrip[SID], undefined, 'clear 掉本会话');
  assert.equal(st().roundStrip[SID2].end, 'aborted', 'clear 不误伤别的会话');
  st().clearRoundAbnormal(SID2);
  assert.deepEqual(st().roundStrip, {}, 'clear 干净');
}

// ── t2 非法入参:不写、不抛 ──
{
  const st = () => useStore.getState();
  const before = JSON.stringify(st().roundStrip);
  st().markRoundAbnormal(null, { end: 'aborted', since: T0, until: T0 });
  st().markRoundAbnormal('', { end: 'aborted', since: T0, until: T0 });
  st().markRoundAbnormal(SID, { end: 'running', since: T0, until: T0 });   // 只有两态
  st().markRoundAbnormal(SID, { end: undefined, since: T0, until: T0 });
  assert.equal(JSON.stringify(st().roundStrip), before, '非法 sessionId / 非法 end 一律不写(不设 running/done 态)');
  st().clearRoundAbnormal(null);
  assert.equal(JSON.stringify(st().roundStrip), before, 'clear(null) 不抛不改');
  // since 缺失/不可解析 → **拒写**(绝不兜底成 0:下界 0 会把该会话全部历史轮撑开),
  // 且留一条 console.error(漏传必须开发期可见,不许静默吞)。
  // 变异哨兵:把拒写改回 `since: Number(since) || 0` → 本段红。
  const errs = [];
  const origErr = console.error;
  console.error = (...a) => { errs.push(a); };
  try {
    st().markRoundAbnormal(SID, { end: 'error' });
    assert.equal(st().roundStrip[SID], undefined, '缺 since → 拒写,不留 0 下界');
    assert.equal(errs.length, 1, '拒写留痕(console.error,非静默)');
    st().markRoundAbnormal(SID, { end: 'error', since: NaN, until: T0 });
    assert.equal(st().roundStrip[SID], undefined, 'since=NaN → 拒写');
  } finally { console.error = origErr; }
  // until 缺失仍是**安全**兜底(窗口收窄到"此刻",不越界);数字字符串按既有 Number() 口径接受
  const PAST = Date.now() - 60_000;
  st().markRoundAbnormal(SID, { end: 'error', since: String(PAST) });
  const rec = st().roundStrip[SID];
  assert.equal(rec.since, PAST, '数字字符串仍按 Number() 接受');
  assert.ok(Number.isFinite(rec.until) && rec.until >= rec.since, '缺 until → 兜底成此刻,窗口不早于 since');
  st().clearRoundAbnormal(SID);
}

// ── t3 判据五分支:窗内开、窗外关、晚于 until 关、没记录关、时间戳不可解析关 ──
{
  const rec = { end: 'aborted', since: T0, until: T0 + 1000 };
  assert.equal(roundStripEnd(rec, SID, iso(T0)), 'aborted', '正好落在下界 → 开(闭区间)');
  assert.equal(roundStripEnd(rec, SID, iso(T0 + 1000)), 'aborted', '正好落在上界 → 开(闭区间)');
  assert.equal(roundStripEnd(rec, SID, iso(T0 + 500)), 'aborted', '窗内 → 开');
  assert.equal(roundStripEnd(rec, SID, iso(T0 - 1)), null, '早于 since(上一轮)→ 关 ← 防误伤的核心');
  assert.equal(roundStripEnd(rec, SID, iso(T0 + 1001)), null, '晚于 until(下一轮)→ 关');
  assert.equal(roundStripEnd(rec, SID, iso(T0 - 86_400_000)), null, '一天前的轮 → 关');
  assert.equal(roundStripEnd(null, SID, iso(T0)), null, '该会话没记录(历史轮/正常收尾)→ 关');
  assert.equal(roundStripEnd(rec, null, iso(T0)), null, '没有 sessionId(本地副本哨兵)→ 不查表,由 interrupted/errorAction 兜');
  assert.equal(roundStripEnd(rec, SID, undefined), null, '时间戳缺失 → 关');
  assert.equal(roundStripEnd(rec, SID, '不是时间'), null, '时间戳不可解析 → 关(不抛)');
  assert.equal(roundStripEnd({ end: 'error', since: T0, until: T0 + 1000 }, SID, iso(T0 + 10)), 'error', 'end 原样返回');
}

// ── t4 撤回/重发/换会话不会翻案:旧轮的时间戳永远早于 since ──
{
  // 一轮在 T0..T0+1000 里异常收尾;随后用户在 T0+60000 发新消息(新轮),又撤回到那一条
  // → 旧轮仍在列表里,但它的时间戳在窗**外** → 不许被撑开。
  const rec = { end: 'aborted', since: T0, until: T0 + 1000 };
  const olderTurn = iso(T0 - 60_000);
  const laterTurn = iso(T0 + 61_000);
  assert.equal(roundStripEnd(rec, SID, olderTurn), null, '撤回后列表里的旧轮不被撑开');
  assert.equal(roundStripEnd(rec, SID, laterTurn), null, '重发出来的新轮也不被撑开');
  // 只有真正那一轮(窗内)开着
  assert.equal(roundStripEnd(rec, SID, iso(T0 + 300)), 'aborted', '窗内那一轮仍开着');
}

console.log('check-strip-abnormal: all passed');
