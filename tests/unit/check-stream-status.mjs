#!/usr/bin/env node
// #2 思考折叠摘要 + 流式动态状态 纯逻辑自检。
// 覆盖:摘要取首行/去 markdown/截断/空回退;状态行按最后 block 的类型与工具名映射。
import assert from 'node:assert/strict';
import { thinkingSummary, thinkingLabel, groupCoworkBlocks, activeGroupKey } from '../../client/src/utils/streamStatus.js';

// ── thinkingSummary ──
assert.equal(thinkingSummary(''), null, '空串 → null');
assert.equal(thinkingSummary(null), null, 'null → null');
assert.equal(thinkingSummary('   \n\n  '), null, '纯空白 → null');
assert.equal(thinkingSummary('***'), null, '纯强调符(去标记后为空)→ null');
assert.equal(thinkingSummary('用户想要修复登录 bug'), '用户想要修复登录 bug', '正常首行原样返回');
assert.equal(thinkingSummary('\n\n第二段才是内容'), '第二段才是内容', '跳过前导空行取首个非空行');
assert.equal(thinkingSummary('## 标题式思考\n正文'), '标题式思考', '去掉 markdown 标题符');
assert.equal(thinkingSummary('- 列表项思考'), '列表项思考', '去掉列表符');
assert.equal(thinkingSummary('这是 **加粗** 和 `代码`'), '这是 加粗 和 代码', '去掉强调/代码反引号');
{
  const long = '这段思考非常长'.repeat(20); // 140 字
  const s = thinkingSummary(long);
  assert.ok(s.length <= 61 && s.endsWith('…'), '超 60 字截断加省略号');
}

// ── thinkingLabel ──
assert.equal(thinkingLabel('分析问题的根因'), '已思考 · 分析问题的根因', '有摘要 → 已思考 · X');
assert.equal(thinkingLabel(''), '思考过程', '无摘要 → 回退 思考过程');
assert.equal(thinkingLabel('#'), '思考过程', '极短 → 回退 思考过程');

// ── groupCoworkBlocks (#1 cowork 分组)──
const tool = (name, id = name) => ({ type: 'tool_use', toolCall: { id, name, input: {} } });
const txt = (c) => ({ type: 'text', content: c });
const think = (c) => ({ type: 'thinking', content: c });

// 空 / 纯文本
assert.deepEqual(groupCoworkBlocks([]), [], '空 blocks → 空段');
{
  const segs = groupCoworkBlocks([txt('hi')]);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].kind, 'text', '纯文本 → 一个 text 段(无 group)');
}
// [思考][工具][正文] → [group][text]
{
  const segs = groupCoworkBlocks([think('t'), tool('Bash'), txt('答案')]);
  assert.equal(segs.length, 2, '思考+工具+正文 → 2 段');
  assert.equal(segs[0].kind, 'group');
  assert.equal(segs[0].items.length, 2, 'group 收了思考+工具');
  assert.equal(segs[1].kind, 'text');
}
// 两段正文各自一个 group:[思考][工具][正文A][思考][工具][正文B]
{
  const segs = groupCoworkBlocks([think('a'), tool('Read'), txt('A'), think('b'), tool('Edit'), txt('B')]);
  assert.deepEqual(segs.map((s) => s.kind), ['group', 'text', 'group', 'text'], '两段正文 → 两个 group + 两段正文');
  assert.notEqual(segs[0].key, segs[2].key, '两个 group 的 key(起始下标)不同');
}
// 末尾无正文的思考+工具也成 group(常见:最后思考+工具后直接给答案在同段)
{
  const segs = groupCoworkBlocks([txt('A'), think('b'), tool('Bash')]);
  assert.deepEqual(segs.map((s) => s.kind), ['text', 'group'], '末尾 group 也 flush');
}
// Task/Skill/清单 独立成段(不进 group);清单只作边界不成段
{
  const segs = groupCoworkBlocks([tool('Bash'), tool('Task'), tool('TaskCreate'), tool('Bash', 'b2')]);
  assert.deepEqual(segs.map((s) => s.kind), ['group', 'task', 'group'], 'Task 独立成段、清单只作边界、其后工具另起 group');
}
// 空 content 的 text/thinking 被跳过(流式刚建块还没内容)
{
  const segs = groupCoworkBlocks([think(''), tool('Bash'), txt('')]);
  assert.equal(segs.length, 1, '空思考/空正文跳过');
  assert.equal(segs[0].kind, 'group');
}

// ── activeGroupKey ──
{
  const segs = groupCoworkBlocks([think('a'), tool('Bash')]); // 末段是 group
  assert.equal(activeGroupKey(segs, true), segs[0].key, '流式 + 末段 group → 活跃');
  assert.equal(activeGroupKey(segs, false), null, '历史轮 → 无活跃段');
}
{
  const segs = groupCoworkBlocks([think('a'), tool('Bash'), txt('done')]); // 末段是 text
  assert.equal(activeGroupKey(segs, true), null, '正文已落地(末段 text)→ group 收起,无活跃段');
}

console.log('✓ check-stream-status: all passed');
