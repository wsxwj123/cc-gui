#!/usr/bin/env node
// r191:没有直播快照的重接带 openBlock=1 时,接流先补「正在写的那一块」已被上一个连接读走的开头与增量,
// 再照旧原样回放 earlyLines。直接 import chat.js 的真函数(findOpenTopBlockSeq / openBlockPrefixLines),
// 用 stampRunEvent 造真实形态的环形窗;另用源码文字核对接流处的写法。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findOpenTopBlockSeq, openBlockPrefixLines, stampRunEvent } from '../../server/routes/chat.js';

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log('  ok', name); };

const mkSlot = () => ({ runId: 'sdk-1', seq: 0, eventLog: [], earlyLines: [] });
const se = (event, parent = null) => JSON.stringify({ type: 'stream_event', event, session_id: 's', parent_tool_use_id: parent, uuid: 'u' });
// listening = 当时有没有连接在读:有 → 实时发走,不进 earlyLines;没有 → 进 earlyLines。两种都进环形窗。
const push = (slot, line, { early = false } = {}) => {
  const out = stampRunEvent(slot, line, true);
  if (early) slot.earlyLines.push(out);
  return slot.seq;
};
const start = (i, t = 'text') => se({ type: 'content_block_start', index: i, content_block: { type: t, text: '' } });
const delta = (i, s, parent = null) => se({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: s } }, parent);
const stop = (i) => se({ type: 'content_block_stop', index: i });
const DONE = JSON.stringify({ type: 'done', exitCode: 0 });
const isDone = (l) => l.startsWith('{"type":"done"');
const label = (l) => {
  try {
    const o = JSON.parse(l);
    if (o.type !== 'stream_event') return o.type === 'system' && o.subtype ? o.subtype : o.type;
    return o.event?.delta?.text ?? o.event?.type;
  } catch { return '?'; }
};
const replay = (slot, afterSeq = null, notice = null, param = '1') => [...openBlockPrefixLines(slot, afterSeq, notice, param), ...slot.earlyLines].map(label);

ok('findOpenTopBlockSeq:正在写的顶层块给出 seq 与 index', () => {
  const s = mkSlot();
  push(s, se({ type: 'message_start', message: {} }));
  const a = push(s, start(0));
  push(s, delta(0, 'x')); push(s, delta(0, 'y'));
  assert.deepEqual(findOpenTopBlockSeq(s.eventLog), { seq: a, index: 0 });
});

ok('findOpenTopBlockSeq:块已写完 / message_stop / result:null', () => {
  const s = mkSlot();
  push(s, start(0)); push(s, delta(0, 'x')); push(s, stop(0));
  push(s, JSON.stringify({ type: 'assistant', parent_tool_use_id: null, uuid: 'r1', message: { content: [] } }));
  assert.equal(findOpenTopBlockSeq(s.eventLog), null);
  const t = mkSlot();
  push(t, start(0)); push(t, se({ type: 'message_stop' }));
  assert.equal(findOpenTopBlockSeq(t.eventLog), null);
  const u = mkSlot();
  push(u, start(0)); push(u, JSON.stringify({ type: 'result', subtype: 'success', parent_tool_use_id: null }));
  assert.equal(findOpenTopBlockSeq(u.eventLog), null);
});

ok('findOpenTopBlockSeq:新消息里 index 重新开始;子代理事件跳过;坏行跳过', () => {
  const s = mkSlot();
  push(s, start(0)); push(s, stop(0)); push(s, start(1, 'tool_use')); push(s, stop(1));
  push(s, se({ type: 'message_stop' }));
  push(s, se({ type: 'message_start', message: {} }));
  const b = push(s, start(0));
  push(s, se({ type: 'content_block_stop', index: 0 }, 'toolu_sub'));
  push(s, se({ type: 'message_stop' }, 'toolu_sub'));
  s.eventLog.push({ seq: 999, line: '{"type":"stream_event","event":{"type":"content_block_stop"' });
  assert.deepEqual(findOpenTopBlockSeq(s.eventLog), { seq: b, index: 0 });
  const t = mkSlot();
  push(t, se({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }, 'toolu_sub'));
  assert.equal(findOpenTopBlockSeq(t.eventLog), null, '只有子代理的块在写');
  assert.equal(findOpenTopBlockSeq([]), null);
  assert.equal(findOpenTopBlockSeq(undefined), null);
});

ok('场景 1:后台续写、上一段收尾时没有连接在读 —— 不重发被剔掉的结束标记,回放与改动前相同', () => {
  const s = mkSlot();
  push(s, se({ type: 'message_start', message: {} })); push(s, start(0)); push(s, delta(0, '一段开头'));
  push(s, delta(0, '一段后半'), { early: true }); push(s, stop(0), { early: true }); push(s, se({ type: 'message_stop' }), { early: true });
  push(s, JSON.stringify({ type: 'result', subtype: 'success', parent_tool_use_id: null }), { early: true });
  push(s, DONE, { early: true });
  s.earlyLines = s.earlyLines.filter((l) => !isDone(l)); // 复活时后端现有的做法
  push(s, se({ type: 'message_start', message: {} }), { early: true }); push(s, start(0), { early: true }); push(s, delta(0, '续写'), { early: true });
  assert.deepEqual(openBlockPrefixLines(s, null, null, '1'), [], '续写段的开头本来就在缓冲里');
  const lines = [...openBlockPrefixLines(s, null, null, '1'), ...s.earlyLines];
  assert.equal(lines.filter(isDone).length, 0);
  assert.deepEqual(lines.map(label), ['一段后半', 'content_block_stop', 'message_stop', 'result', 'message_start', 'content_block_start', '续写']);
});

ok('场景 2:刷新 —— 补上正在写的块的开头与已读走的增量', () => {
  const s = mkSlot();
  push(s, se({ type: 'message_start', message: {} })); push(s, start(0)); push(s, delta(0, '甲')); push(s, delta(0, '乙'));
  push(s, delta(0, '丙'), { early: true });
  assert.deepEqual(replay(s), ['content_block_start', '甲', '乙', '丙']);
});

ok('场景 3:被读走的那一段里夹着子代理事件与通知 —— 不重发它们', () => {
  const s = mkSlot();
  push(s, start(0)); push(s, delta(0, '甲'));
  push(s, delta(0, '子代理的字', 'toolu_sub'));
  push(s, JSON.stringify({ type: 'system', subtype: 'task_notification', tool_use_id: 'toolu_x', parent_tool_use_id: null }));
  push(s, delta(0, '乙'));
  push(s, delta(0, '丙'), { early: true });
  assert.deepEqual(replay(s), ['content_block_start', '甲', '乙', '丙']);
});

ok('场景 4:兜底收尾之后又接着写 —— 不重发那条结束标记', () => {
  const s = mkSlot();
  push(s, start(0)); push(s, delta(0, '甲'));
  push(s, JSON.stringify({ type: 'stall_notice', text: 'x', ended: true })); push(s, DONE);
  push(s, delta(0, '乙'), { early: true });
  assert.deepEqual(replay(s), ['content_block_start', '甲', '乙']);
});

ok('开关只认字符串 "1";带游标 / 命中 replay_complete / 没有槽:空', () => {
  const s = mkSlot();
  push(s, start(0)); push(s, delta(0, 'x'));
  push(s, delta(0, 'y'), { early: true });
  assert.equal(openBlockPrefixLines(s, null, null, '1').length, 2);
  for (const v of [undefined, '', '0', 'true', 1, ['1']]) assert.deepEqual(openBlockPrefixLines(s, null, null, v), [], `openBlock=${String(v)}`);
  assert.deepEqual(openBlockPrefixLines(s, 0, null, '1'), [], '带游标');
  assert.deepEqual(openBlockPrefixLines(s, null, '{"type":"replay_complete"}', '1'), [], '命中 replay_complete');
  assert.deepEqual(openBlockPrefixLines(null, null, null, '1'), [], '没有槽');
});

ok('earlyLines 没有带编号的行:前缀一直到窗尾', () => {
  const s = mkSlot();
  push(s, start(0)); push(s, delta(0, 'a')); push(s, delta(0, 'b'));
  s.earlyLines.push('plain');
  assert.deepEqual(openBlockPrefixLines(s, null, null, '1').map(label), ['content_block_start', 'a', 'b']);
});

ok('块开头不早于 earlyLines 第一条带编号的行:空', () => {
  const s = mkSlot();
  push(s, start(0)); push(s, stop(0));
  push(s, se({ type: 'message_stop' }), { early: true });
  push(s, start(0), { early: true }); push(s, delta(0, 'z'), { early: true });
  assert.deepEqual(openBlockPrefixLines(s, null, null, '1'), []);
});

ok('块开头已被环形窗挤掉(窗里只有它的增量):空', () => {
  const s = mkSlot();
  push(s, start(0)); push(s, delta(0, 'a')); push(s, delta(0, 'b'));
  s.eventLog.shift(); // 最老的(块开头)被挤掉
  push(s, delta(0, 'c'), { early: true });
  assert.deepEqual(openBlockPrefixLines(s, null, null, '1'), []);
});

ok('正在写的是另一个 index 的块:不带出别的 index 的增量', () => {
  const s = mkSlot();
  push(s, start(0, 'thinking')); push(s, delta(0, 'th')); push(s, stop(0));
  push(s, start(1)); push(s, delta(1, 'x'));
  push(s, delta(0, '迟到的0号'));
  push(s, delta(1, 'y'));
  push(s, delta(1, 'z'), { early: true });
  assert.deepEqual(replay(s), ['content_block_start', 'x', 'y', 'z']);
});

ok('源码:接流处先判通知、再算前缀、再置已读;前缀之后无条件原样回放 earlyLines', () => {
  const src = readFileSync(new URL('../../server/routes/chat.js', import.meta.url), 'utf8');
  assert.ok(!src.includes('openBlockReplayFrom'), '旧函数不留');
  const i = src.indexOf("router.get('/chat/:pid/stream'");
  assert.ok(i > 0);
  const body = src.slice(i, i + 6000);
  const pNotice = body.indexOf('replayCompleteNotice(slot, cur.afterSeq)');
  const pPrefix = body.indexOf('openBlockPrefixLines(slot, cur.afterSeq, replayNotice, req.query?.openBlock)');
  const pUnread = body.indexOf('slot.turnUnread = false');
  assert.ok(pNotice > 0 && pPrefix > pNotice && pUnread > pPrefix, '先判通知、再算前缀、再置已读');
  assert.ok(body.includes('if (cur.afterSeq !== null) replayEventLog(slot, cur.afterSeq, onLine); else {'), '带游标路径不变');
  const pOverflow = body.indexOf("onLine(JSON.stringify({ type: 'early_overflow' }))");
  const pPrefixSend = body.indexOf('for (const l of openPrefix) { if (!closed) onLine(l); }');
  const pEarly = body.indexOf('    for (const l of slot.earlyLines) { if (!closed) onLine(l); }\n  }');
  assert.ok(pOverflow > 0 && pPrefixSend > pOverflow && pEarly > pPrefixSend, 'early_overflow → 前缀 → earlyLines 原样回放(不在 else 里)');
});

console.log(`check-r191-open-block-replay: ${passed} passed`);
