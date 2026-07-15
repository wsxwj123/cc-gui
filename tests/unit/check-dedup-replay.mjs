#!/usr/bin/env node
// CJ-1 变体去重自检:停止→--resume 时 CLI 把一段历史【原样重放】追加,重放段带
// 【新 record.uuid】但 message.id 与内容不变 → 同一条 AI 回复渲染两遍。
// dedupReplayedRecords 对 assistant 按 (message.id + 内容签名) 去重,须满足:
//   ① 新-uuid 重放的 assistant 段不翻倍;② 同一 message.id 拆成多条块记录
//   (thinking/text/tool_use)不被误删;③ 老 CJ-1(同-uuid 重放)仍被去掉;
//   ④ user 记录不受 message.id 去重影响。
import assert from 'node:assert/strict';
import { dedupReplayedRecords } from '../../server/services/session-reader.js';

// CLI 真实形态:一次 assistant API 调用(一个 message.id)按内容块拆成多条记录,
// 每条一个不同 uuid、共享同一 message.id。
function asstBlock(uuid, mid, block) {
  return { type: 'assistant', uuid, message: { id: mid, model: 'claude', content: [block] } };
}
const think = (t) => ({ type: 'thinking', thinking: t });
const text = (t) => ({ type: 'text', text: t });
const tool = (id, name) => ({ type: 'tool_use', id, name, input: {} });

// 一个正常回合:user 提问 → assistant(同一 msg_A,三块:思考/正文/工具调用)。
const turnA = [
  { type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'text', text: '问题' }] } },
  asstBlock('a1', 'msg_A', think('先想一下')),
  asstBlock('a2', 'msg_A', text('这是回复正文')),
  asstBlock('a3', 'msg_A', tool('toolu_1', 'Read')),
];

// ── 场景1:新-uuid 重放整个 assistant 段(uuid 全换新,message.id/内容不变)──
{
  const replayed = [
    turnA[0],
    turnA[1], turnA[2], turnA[3],
    // 重放段:新 uuid,旧 message.id + 逐字节相同内容
    asstBlock('a1-replay', 'msg_A', think('先想一下')),
    asstBlock('a2-replay', 'msg_A', text('这是回复正文')),
    asstBlock('a3-replay', 'msg_A', tool('toolu_1', 'Read')),
  ];
  const out = dedupReplayedRecords(replayed);
  const asst = out.filter((r) => r.type === 'assistant');
  assert.equal(asst.length, 3, '新-uuid 重放的 assistant 块应被去掉,只剩原始 3 条');
  // 三块都在(没被 message.id 单键误删)
  const kinds = asst.map((r) => r.message.content[0].type).sort();
  assert.deepEqual(kinds, ['text', 'thinking', 'tool_use'], '同一 message.id 的三种块都保留,未被误删');
}

// ── 场景2:健康会话(无重放)不动 ──
{
  const out = dedupReplayedRecords(turnA);
  assert.equal(out.length, 4, '无重放:4 条原样保留');
  assert.equal(out.filter((r) => r.type === 'assistant').length, 3, '三块 assistant 全在');
}

// ── 场景3:老 CJ-1(同-uuid 重放)仍被 uuid 去重去掉 ──
{
  const dup = [...turnA, turnA[1], turnA[2], turnA[3]]; // 追加同 uuid 的三条
  const out = dedupReplayedRecords(dup);
  assert.equal(out.length, 4, '同-uuid 重放按 uuid 去重,回到 4 条');
}

// ── 场景4:两次不同 API 调用即使正文文本相同,也不能被误合(靠 message.id 区分)──
{
  const recs = [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'q1' }] } },
    asstBlock('b1', 'msg_A', text('完成')),
    { type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'text', text: 'q2' }] } },
    asstBlock('b2', 'msg_B', text('完成')), // 不同 message.id,同样文本
  ];
  const out = dedupReplayedRecords(recs);
  assert.equal(out.filter((r) => r.type === 'assistant').length, 2, '不同 message.id 的同文本回复不被误删');
}

// ── 场景5:user 记录不参与 message.id 去重;无 uuid 记录保留 ──
{
  const recs = [
    { type: 'user', uuid: 'u1', message: { id: 'shared', content: [{ type: 'text', text: 'A' }] } },
    { type: 'user', uuid: 'u2', message: { id: 'shared', content: [{ type: 'text', text: 'B' }] } },
    { type: 'queue-operation' }, // 无 uuid
  ];
  const out = dedupReplayedRecords(recs);
  assert.equal(out.length, 3, 'user 共享 message.id 不被去重;无 uuid 记录保留');
}

console.log('check-dedup-replay: all assertions passed');
