#!/usr/bin/env node
// r177:回合第一次被读取时,服务端声明「本次重放自回合起点完整」(replay_complete)。
// 直接 import chat.js 的真函数;另用源码文字核对"在哪置位、在哪发"(与 check-r13-turn-identity 同法)。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { replayCompleteNotice, stampStreamNotice, sseFrame } from '../../server/routes/chat.js';

const base = (over = {}) => ({ turnUnread: true, earlyOverflowed: false, startedAt: 1700000000123, runId: 'sdk-9', seq: 4, eventLog: [], ...over });

// ① 判据:只有"本回合没人读过 + 没溢出 + 无游标 + 有开始时刻"才发
{
  const line = replayCompleteNotice(base(), null);
  assert.ok(line, '首次无游标接上应发通知');
  const ev = JSON.parse(line);
  assert.equal(ev.type, 'replay_complete');
  assert.equal(ev.turnStartedAt, 1700000000123, '带回合开始时刻');
  assert.equal(replayCompleteNotice(base({ turnUnread: false }), null), null, '已有连接读过:不发');
  assert.equal(replayCompleteNotice(base({ turnUnread: undefined }), null), null, '回合起点没置位(标记缺省):保守不发');
  assert.equal(replayCompleteNotice(base({ turnUnread: 1 }), null), null, '标记不是明确的 true:不发');
  assert.equal(replayCompleteNotice(base({ earlyOverflowed: true }), null), null, '缓冲溢出过:不发');
  assert.equal(replayCompleteNotice(base(), 0), null, '带游标重连(afterSeq=0):不发');
  assert.equal(replayCompleteNotice(base(), 3), null, '带游标重连:不发');
  assert.equal(replayCompleteNotice(base({ startedAt: null }), null), null, '没有开始时刻:不发');
  assert.equal(replayCompleteNotice(base({ startedAt: NaN }), null), null, '开始时刻不是有限数:不发');
  assert.equal(replayCompleteNotice(null, null), null, '没有槽:不发');
}

// ② 通知帧走流级通知盖章:带 runId+seq,但不进环形窗
{
  const slot = base();
  const stamped = stampStreamNotice(slot, replayCompleteNotice(slot, null));
  const ev = JSON.parse(stamped);
  assert.equal(ev.type, 'replay_complete');
  assert.equal(ev.runId, 'sdk-9');
  assert.equal(ev.seq, 5);
  assert.equal(slot.eventLog.length, 0, '流级通知不进环形窗');
  assert.ok(sseFrame(stamped).startsWith('id: sdk-9:5\n'), 'SSE id = runId:seq');
}

// ③ 源码核对:两处回合起点置位、复活续跑清掉、接流处"先判后置已读"且通知在回放缓冲之前
{
  const src = readFileSync(new URL('../../server/routes/chat.js', import.meta.url), 'utf8');
  const reuse = src.indexOf('s.eventLog = [];');
  assert.ok(reuse > 0 && /s\.startedAt = Date\.now\(\);\s*\n\s*s\.turnUnread = true;/.test(src.slice(reuse, reuse + 1500)),
    '复用常驻进程开新回合处置 turnUnread = true');
  const literal = src.indexOf('earlyLines: [],');
  assert.ok(literal > 0 && /startedAt: Date\.now\(\),\s*\n\s*turnUnread: true,/.test(src.slice(literal, literal + 6000)),
    '新建进程槽处置 turnUnread: true');
  assert.ok(/slot\.revived = true;[^\n]*\n\s*slot\.turnUnread = false;/.test(src), '复活续跑清掉 turnUnread');
  const route = src.indexOf("router.get('/chat/:pid/stream'");
  const body = src.slice(route, route + 4000);
  const iJudge = body.indexOf('replayCompleteNotice(slot, cur.afterSeq)');
  const iMark = body.indexOf('slot.turnUnread = false;');
  const iSend = body.indexOf('if (replayNotice) onLine(replayNotice);');
  const iReplay = body.indexOf('for (const l of slot.earlyLines)');
  assert.ok(iJudge > 0 && iMark > iJudge, '先判定再置"已读"');
  assert.ok(iSend > iMark && iSend < iReplay, '通知在回放缓冲之前发');
  assert.ok(iSend < body.indexOf("type: 'early_overflow'"), '通知在 early_overflow 判定之前(依赖溢出标记原值)');
}

console.log('✓ check-r177-replay-notice: 首次接上声明重放完整的判据、盖章与置位点');
