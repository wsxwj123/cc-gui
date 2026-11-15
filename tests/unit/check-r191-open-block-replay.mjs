#!/usr/bin/env node
// r191:没有直播快照的重接带 openBlock=1 时,接流从"正在写的那一段"的开头起回放。
// 直接 import chat.js 的真函数(findOpenTopBlockSeq / openBlockReplayFrom),用 stampRunEvent 造真实形态的环形窗;
// 另用源码文字核对接流处的新分支只在无游标、没有 replay_complete 时生效,且原路径保留。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findOpenTopBlockSeq, openBlockReplayFrom, stampRunEvent } from '../../server/routes/chat.js';

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log('  ok', name); };

const mkSlot = () => ({ runId: 'sdk-1', seq: 0, eventLog: [], earlyLines: [] });
const se = (event, parent = null) => JSON.stringify({ type: 'stream_event', event, session_id: 's', parent_tool_use_id: parent, uuid: 'u' });
const push = (slot, line, { early = false } = {}) => {
  const out = stampRunEvent(slot, line, true);
  if (early) slot.earlyLines.push(out);
  return slot.seq;
};
const start = (i, t = 'text') => se({ type: 'content_block_start', index: i, content_block: { type: t, text: '' } });
const delta = (i, s) => se({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: s } });
const stop = (i) => se({ type: 'content_block_stop', index: i });

ok('正在写的顶层块:返回它的 content_block_start 的 seq', () => {
  const s = mkSlot();
  push(s, se({ type: 'message_start', message: {} }));
  const a = push(s, start(0));
  push(s, delta(0, 'x')); push(s, delta(0, 'y'));
  assert.equal(findOpenTopBlockSeq(s.eventLog), a);
});

ok('块已写完(stop 在 start 之后):null', () => {
  const s = mkSlot();
  push(s, start(0)); push(s, delta(0, 'x')); push(s, stop(0));
  push(s, JSON.stringify({ type: 'assistant', parent_tool_use_id: null, uuid: 'r1', message: { content: [] } }));
  assert.equal(findOpenTopBlockSeq(s.eventLog), null);
});

ok('上一条消息的块写完、新消息里 index 0 重新开始:返回新块', () => {
  const s = mkSlot();
  push(s, start(0)); push(s, stop(0)); push(s, start(1, 'tool_use')); push(s, stop(1));
  push(s, se({ type: 'message_stop' }));
  push(s, JSON.stringify({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result' }] } }));
  push(s, se({ type: 'message_start', message: {} }));
  const b = push(s, start(0));
  push(s, delta(0, 'z'));
  assert.equal(findOpenTopBlockSeq(s.eventLog), b);
});

ok('先遇到顶层 message_stop / result:null', () => {
  const s = mkSlot();
  push(s, start(0)); push(s, se({ type: 'message_stop' }));
  assert.equal(findOpenTopBlockSeq(s.eventLog), null);
  const t = mkSlot();
  push(t, start(0)); push(t, JSON.stringify({ type: 'result', subtype: 'success', parent_tool_use_id: null }));
  assert.equal(findOpenTopBlockSeq(t.eventLog), null);
});

ok('子代理事件一律跳过', () => {
  const s = mkSlot();
  const a = push(s, start(0));
  push(s, se({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }, 'toolu_sub'));
  push(s, se({ type: 'content_block_stop', index: 0 }, 'toolu_sub'));
  push(s, se({ type: 'message_stop' }, 'toolu_sub'));
  push(s, JSON.stringify({ type: 'result', parent_tool_use_id: 'toolu_sub' }));
  assert.equal(findOpenTopBlockSeq(s.eventLog), a, '子代理的 stop / message_stop 不关顶层块');
  const t = mkSlot();
  push(t, se({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }, 'toolu_sub'));
  assert.equal(findOpenTopBlockSeq(t.eventLog), null, '只有子代理的块在写:null');
});

ok('坏行、非 JSON 行、空窗跳过', () => {
  const s = mkSlot();
  const a = push(s, start(0));
  s.eventLog.push({ seq: 99, line: '{"type":"stream_event","event":{"type":"content_block_stop"' });
  push(s, 'not json content_block_stop');
  assert.equal(findOpenTopBlockSeq(s.eventLog), a);
  assert.equal(findOpenTopBlockSeq([]), null);
  assert.equal(findOpenTopBlockSeq(undefined), null);
});

ok('起点:openBlock 只认字符串 "1";带游标 / 有 replay_complete 不走', () => {
  const s = mkSlot();
  const a = push(s, start(0)); push(s, delta(0, 'x'));
  push(s, delta(0, 'y'), { early: true });
  assert.equal(openBlockReplayFrom(s, null, null, '1'), a);
  for (const v of [undefined, '', '0', 'true', 1, ['1']]) assert.equal(openBlockReplayFrom(s, null, null, v), null, `openBlock=${String(v)}`);
  assert.equal(openBlockReplayFrom(s, 0, null, '1'), null, '带游标');
  assert.equal(openBlockReplayFrom(s, null, '{"type":"replay_complete"}', '1'), null, '命中 replay_complete');
  assert.equal(openBlockReplayFrom(null, null, null, '1'), null, '没有槽');
});

ok('起点取两者较小;只有一个就取那个;都没有 null', () => {
  // earlyLines 起点更早(上一段写完后断开,新段完整在缓冲里)
  const s = mkSlot();
  push(s, start(0)); push(s, stop(0));
  const e1 = push(s, se({ type: 'message_stop' }), { early: true });
  push(s, start(0), { early: true });
  assert.equal(openBlockReplayFrom(s, null, null, '1'), e1);
  // 正在写的块更早
  const t = mkSlot();
  const a = push(t, start(0)); push(t, delta(0, 'x'));
  push(t, delta(0, 'y'), { early: true });
  assert.equal(openBlockReplayFrom(t, null, null, '1'), a);
  // 只有 earlyLines
  const u = mkSlot();
  push(u, start(0)); push(u, stop(0));
  const e2 = push(u, se({ type: 'message_stop' }), { early: true });
  assert.equal(openBlockReplayFrom(u, null, null, '1'), e2);
  // 都没有
  const w = mkSlot();
  push(w, start(0)); push(w, stop(0)); push(w, se({ type: 'message_stop' }));
  assert.equal(openBlockReplayFrom(w, null, null, '1'), null);
  // earlyLines 里没盖章的行不算起点
  const x = mkSlot();
  x.earlyLines.push('plain');
  assert.equal(openBlockReplayFrom(x, null, null, '1'), null);
});

ok('源码:接流处新分支在判 replay_complete 之后、置已读之前取起点,原回放路径保留', () => {
  const src = readFileSync(new URL('../../server/routes/chat.js', import.meta.url), 'utf8');
  const i = src.indexOf("router.get('/chat/:pid/stream'");
  assert.ok(i > 0);
  const body = src.slice(i, i + 6000);
  const pNotice = body.indexOf('replayCompleteNotice(slot, cur.afterSeq)');
  const pFrom = body.indexOf('openBlockReplayFrom(slot, cur.afterSeq, replayNotice, req.query?.openBlock)');
  const pUnread = body.indexOf('slot.turnUnread = false');
  assert.ok(pNotice > 0 && pFrom > pNotice && pUnread > pFrom, '先判通知、再取起点、再置已读');
  assert.ok(body.includes('if (cur.afterSeq !== null) replayEventLog(slot, cur.afterSeq, onLine); else {'), '带游标路径不变');
  assert.ok(body.includes('for (const l of slot.earlyLines) { if (!closed) onLine(l); }'), '原 earlyLines 回放保留');
  assert.ok(body.includes('if (ev.seq >= openFrom) onLine(ev.line)'), '新分支从起点起回放环形窗');
});

console.log(`check-r191-open-block-replay: ${passed} passed`);
