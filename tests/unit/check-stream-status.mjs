#!/usr/bin/env node
// #2 思考折叠摘要 + 流式动态状态 纯逻辑自检。
// 覆盖:摘要取首行/去 markdown/截断/空回退;状态行按最后 block 的类型与工具名映射。
import assert from 'node:assert/strict';
import { thinkingSummary, thinkingLabel, streamStatusText } from '../../client/src/utils/streamStatus.js';

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

// ── streamStatusText ──
assert.equal(streamStatusText(null), null, 'null blocks → null');
assert.equal(streamStatusText([]), null, '空 blocks → null');
assert.equal(streamStatusText([{ type: 'thinking', content: 'x' }]), '正在思考…', '末 thinking → 正在思考');
assert.equal(streamStatusText([{ type: 'text', content: 'x' }]), '正在回复…', '末 text → 正在回复');
assert.equal(
  streamStatusText([{ type: 'tool_use', toolCall: { name: 'Read', input: { file_path: '/a/b/foo.js' } } }]),
  '正在读取 foo.js', 'Read → 正在读取 + 文件名(basename)');
assert.equal(
  streamStatusText([{ type: 'tool_use', toolCall: { name: 'Bash', input: {} } }]),
  '正在运行命令…', 'Bash 无预览 → 动词 + 省略号');
assert.equal(
  streamStatusText([{ type: 'tool_use', toolCall: { name: 'Grep', input: { pattern: 'TODO' } } }]),
  '正在搜索 TODO', 'Grep → 正在搜索 + pattern');
assert.equal(
  streamStatusText([{ type: 'tool_use', toolCall: { name: 'Task', input: {} } }]),
  '正在派发子代理…', 'Task → 派发子代理');
assert.equal(
  streamStatusText([{ type: 'tool_use', toolCall: { name: 'TaskCreate', input: {} } }]),
  '正在整理任务清单…', '任务清单工具 → 整理任务清单');
assert.equal(
  streamStatusText([{ type: 'tool_use', toolCall: { name: 'SomethingElse', input: {} } }]),
  '正在调用 SomethingElse…', '未知工具 → 正在调用 name');
// 取"最后一个" block(前面的忽略)
assert.equal(
  streamStatusText([
    { type: 'text', content: 'a' },
    { type: 'tool_use', toolCall: { name: 'Edit', input: { file_path: 'x/y.ts' } } },
  ]),
  '正在编辑 y.ts', '多 block → 只看最后一个');

console.log('✓ check-stream-status: all passed');
