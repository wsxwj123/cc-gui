#!/usr/bin/env node
// 定向压缩 compactSegmentJsonl 单测:结构合法性(parentUuid 链自洽、无孤儿工具配对)。
import assert from 'node:assert/strict';
import { compactSegmentJsonl, renderSegmentTranscript } from '../server/routes/sessions.js';

const S = (o) => JSON.stringify(o);
const base = { isSidechain: false, userType: 'external', cwd: '/tmp/p', sessionId: 'sid-1', version: '2.1.207', gitBranch: 'master' };

// 造一个含【并行工具(跨记录交错布局 asst/asst/user/user)】的会话:
// u1 → a1(text) → 回合2: u2 → a2(tool-a) / a3(tool-b) / u3(res-a) / u4(res-b) / a4(text)
// → 回合3: u5 → a5(text)
const records = [
  { ...base, type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-07-01T00:00:00Z', message: { role: 'user', content: [{ type: 'text', text: '第一问 暗号是ZEBRA' }] } },
  { ...base, type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-07-01T00:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: '记住了' }] } },
  { ...base, type: 'user', uuid: 'u2', parentUuid: 'a1', timestamp: '2026-07-01T00:00:02Z', message: { role: 'user', content: [{ type: 'text', text: '并行跑两个工具' }] } },
  { ...base, type: 'assistant', uuid: 'a2', parentUuid: 'u2', timestamp: '2026-07-01T00:00:03Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-a', name: 'Bash', input: { command: 'echo a' } }] } },
  { ...base, type: 'assistant', uuid: 'a3', parentUuid: 'a2', timestamp: '2026-07-01T00:00:04Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-b', name: 'Bash', input: { command: 'echo b' } }] } },
  { ...base, type: 'user', uuid: 'u3', parentUuid: 'a3', timestamp: '2026-07-01T00:00:05Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-a', content: 'a' }] } },
  { ...base, type: 'user', uuid: 'u4', parentUuid: 'u3', timestamp: '2026-07-01T00:00:06Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-b', content: 'b' }] } },
  { ...base, type: 'assistant', uuid: 'a4', parentUuid: 'u4', timestamp: '2026-07-01T00:00:07Z', message: { role: 'assistant', content: [{ type: 'text', text: '两个都跑完了' }] } },
  { ...base, type: 'user', uuid: 'u5', parentUuid: 'a4', timestamp: '2026-07-01T00:00:08Z', message: { role: 'user', content: [{ type: 'text', text: '第三问' }] } },
  { ...base, type: 'assistant', uuid: 'a5', parentUuid: 'u5', timestamp: '2026-07-01T00:00:09Z', message: { role: 'assistant', content: [{ type: 'text', text: '第三答' }] } },
];
const raw = records.map(S).join('\n') + '\n';

// 从叶子(末条)沿 parentUuid 走链,返回链上 uuid 序列(resume 加载语义)。
function walkChain(lines) {
  const objs = lines.filter((l) => l.trim()).map((l) => JSON.parse(l));
  const byUuid = new Map(objs.map((o) => [o.uuid, o]));
  const chain = [];
  let cur = objs[objs.length - 1];
  while (cur) {
    chain.unshift(cur);
    if (cur.parentUuid == null) break;
    cur = byUuid.get(cur.parentUuid);
    assert.ok(cur, `parentUuid 链断裂: 找不到 ${chain[0].parentUuid}`);
  }
  return chain;
}

// 链上工具配对检查:每个 tool_use 必须有 tool_result,反之亦然(无孤儿)。
function assertNoOrphans(chain) {
  const uses = new Set(); const results = new Set();
  for (const o of chain) {
    const c = o.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b?.type === 'tool_use') uses.add(b.id);
      if (b?.type === 'tool_result') results.add(b.tool_use_id);
    }
  }
  assert.deepEqual([...uses].sort(), [...results].sort(), '孤儿 tool_use/tool_result');
}

// ── direction 'before':锚点 u5,之前(含并行工具回合)整段压缩 ───────────────
{
  const r = compactSegmentJsonl(raw, 'u5', 'before', '摘要:早前聊了暗号 ZEBRA 并并行跑了两个工具');
  assert.equal(r.ok, true, r.error);
  const chain = walkChain(r.lines);
  // 链 = boundary → summary → u5 → a5;被压缩的 u1..a4 不在链上但物理保留
  assert.equal(chain[0].subtype, 'compact_boundary');
  assert.equal(chain[0].parentUuid, null);
  assert.equal(chain[0].logicalParentUuid, 'a4');
  assert.equal(chain[1].isCompactSummary, true);
  assert.ok(chain[1].message.content.includes('ZEBRA'));
  assert.equal(chain[2].uuid, 'u5');
  assert.equal(chain[2].parentUuid, chain[1].uuid);
  assert.equal(chain[3].uuid, 'a5');
  assertNoOrphans(chain);
  // 原始记录全部物理保留(GUI 仍显示)
  const all = r.lines.filter((l) => l.trim()).map((l) => JSON.parse(l));
  for (const u of ['u1', 'a1', 'u2', 'a2', 'a3', 'u3', 'u4', 'a4']) {
    assert.ok(all.some((o) => o.uuid === u), `原始记录 ${u} 丢失`);
  }
}

// ── direction 'before':锚点落在并行工具回合中间(u2 之后没有更晚锚点时)──────
// 用 u2 当锚点:prefix=u1/a1 完整回合,合法;工具配对完整落在 suffix 内。
{
  const r = compactSegmentJsonl(raw, 'u2', 'before', '摘要:第一回合');
  assert.equal(r.ok, true, r.error);
  const chain = walkChain(r.lines);
  assertNoOrphans(chain);
  assert.ok(chain.some((o) => o.uuid === 'a4'));
}

// ── direction 'before':跨锚点工具配对 → 拒绝 ────────────────────────────────
{
  // 人为造一个 tool_result 在锚点之后、tool_use 在之前的坏布局
  const bad = [
    records[0], records[1],
    { ...base, type: 'assistant', uuid: 'ax', parentUuid: 'a1', timestamp: '2026-07-01T00:00:02Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-x', name: 'Bash', input: {} }] } },
    { ...base, type: 'user', uuid: 'uq', parentUuid: 'ax', timestamp: '2026-07-01T00:00:03Z', message: { role: 'user', content: [{ type: 'text', text: '新问题' }] } },
    { ...base, type: 'user', uuid: 'ur', parentUuid: 'uq', timestamp: '2026-07-01T00:00:04Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-x', content: 'late' }] } },
  ].map(S).join('\n');
  const r = compactSegmentJsonl(bad, 'uq', 'before', 'x');
  assert.equal(r.ok, false);
  assert.match(r.error, /跨越锚点/);
}

// ── direction 'before':锚点是首条用户消息 → 没东西可压,拒绝 ─────────────────
{
  const r = compactSegmentJsonl(raw, 'u1', 'before', 'x');
  assert.equal(r.ok, false);
}

// ── direction 'before':锚点是 tool_result 载体(非真实用户消息)→ 拒绝 ────────
{
  const r = compactSegmentJsonl(raw, 'u3', 'before', 'x');
  assert.equal(r.ok, false);
}

// ── direction 'after':锚点 u5,裁掉 u5/a5,叶子后追加摘要 ────────────────────
{
  const r = compactSegmentJsonl(raw, 'u5', 'after', '摘要:第三回合聊了X');
  assert.equal(r.ok, true, r.error);
  const chain = walkChain(r.lines);
  const last = chain[chain.length - 1];
  assert.equal(last.isCompactSummary, true);
  assert.equal(last.parentUuid, 'a4');
  assert.ok(!chain.some((o) => o.uuid === 'u5' || o.uuid === 'a5'), '锚点及之后应被移除');
  assertNoOrphans(chain);
}

// ── direction 'after':锚点是首条 → 没有可保留内容,拒绝 ─────────────────────
{
  const r = compactSegmentJsonl(raw, 'u1', 'after', 'x');
  assert.equal(r.ok, false);
}

// ── 锚点不存在 / direction 非法 ──────────────────────────────────────────────
assert.equal(compactSegmentJsonl(raw, 'nope', 'before', 'x').ok, false);
assert.equal(compactSegmentJsonl(raw, 'u5', 'sideways', 'x').ok, false);

// ── renderSegmentTranscript:用户/助手文本 + 工具一行摘要;tool_result 不出现 ──
{
  const t = renderSegmentTranscript(records);
  assert.ok(t.includes('用户: 第一问 暗号是ZEBRA'));
  assert.ok(t.includes('[工具 Bash]'));
  assert.ok(t.includes('助手: 两个都跑完了'));
  assert.ok(!t.includes('tool_result'));
}

console.log('check-compact-segment: all assertions passed');
