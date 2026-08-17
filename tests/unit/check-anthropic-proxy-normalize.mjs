// 单测:anthropic-proxy normalizeMessagesForCompat 的五则归一化 + 补桩防假(09481d7 对账入库)。
// import 真函数(非复制品):输入/输出都是 Buffer(JSON),逐则正反用例。
// 变异哨兵(每条都实际验证过红):
//   S1 删"kept.length === 0 时整条删除"分支 → t1b 红
//   S2 删 document 降级循环 → t2 红
//   S3 删相邻 user 合并循环 → t3 红
//   S4 删纯 tool_use assistant 合并循环 → t4 红
//   S5 删文本 user 后移 splice 段 → t5 红
//   S6 删 realResultIds 全局扫描(恢复只看 next 的旧判据) → t6 红
import assert from 'node:assert/strict';
import { normalizeMessagesForCompat } from '../../server/services/anthropic-proxy.js';

const run = (messages) => {
  const out = normalizeMessagesForCompat(Buffer.from(JSON.stringify({ model: 'x', messages })));
  return JSON.parse(out.toString('utf-8')).messages;
};

// t1a 空 text 块被剔除,同消息其余块保留
{
  const m = run([
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'text', text: '' }, { type: 'tool_use', id: 'T1', name: 'Bash', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'T1', content: 'ok' }] },
  ]);
  assert.equal(m[1].content.length, 1, 't1a: 空 text 应被剔,tool_use 保留');
  assert.equal(m[1].content[0].type, 'tool_use');
}
// t1b 纯空 text 消息整条删除
{
  const m = run([
    { role: 'user', content: [{ type: 'text', text: 'q' }] },
    { role: 'assistant', content: [{ type: 'text', text: '  ' }] },
    { role: 'user', content: [{ type: 'text', text: 'again' }] },
  ]);
  assert.ok(!m.some((x) => x.role === 'assistant'), 't1b: 纯空 assistant 应整条删除');
}
// t2 document 块降级为 text 占位(含标题),base64 不外发
{
  const m = run([
    { role: 'user', content: [
      { type: 'document', title: 'paper.pdf', source: { type: 'base64', media_type: 'application/pdf', data: 'QUJD' } },
      { type: 'text', text: 'read it' },
    ] },
  ]);
  const blocks = m[0].content;
  assert.ok(blocks.every((b) => b.type !== 'document'), 't2: 不得残留 document 块');
  const placeholder = blocks.find((b) => b.type === 'text' && /paper\.pdf/.test(b.text));
  assert.ok(placeholder, 't2: 占位文本须含文件名');
  assert.ok(!JSON.stringify(m).includes('QUJD'), 't2: base64 数据不得外发');
}
// t3 相邻数组式 user 合并为一条(string 式不合并)
{
  const m = run([
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'T2', content: 'r' }] },
    { role: 'user', content: [{ type: 'text', text: 'doc part' }] },
  ]);
  assert.equal(m.length, 1, 't3: 相邻两条数组式 user 应合并');
  assert.equal(m[0].content.length, 2);
  const s = run([
    { role: 'user', content: 'a' },
    { role: 'user', content: 'b' },
  ]);
  assert.equal(s.length, 2, 't3: string 式 user 不合并');
}
// t4 相邻纯 tool_use assistant 合并;带 text 的不合并
{
  const m = run([
    { role: 'assistant', content: [{ type: 'tool_use', id: 'A', name: 'x', input: {} }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'B', name: 'y', input: {} }] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'A', content: '1' },
      { type: 'tool_result', tool_use_id: 'B', content: '2' },
    ] },
  ]);
  const assistants = m.filter((x) => x.role === 'assistant');
  assert.equal(assistants.length, 1, 't4: 纯 tool_use 相邻 assistant 应合并');
  assert.deepEqual(assistants[0].content.map((b) => b.id), ['A', 'B']);
  const keep = run([
    { role: 'assistant', content: [{ type: 'text', text: 'say' }, { type: 'tool_use', id: 'C', name: 'x', input: {} }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'D', name: 'y', input: {} }] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'C', content: '1' },
      { type: 'tool_result', tool_use_id: 'D', content: '2' },
    ] },
  ]);
  assert.equal(keep.filter((x) => x.role === 'assistant').length, 2, 't4: 带 text 的 assistant 不得被合并');
}
// t5 夹在 tool_use 与其 result 间的 string 式纯文本 user 后移到 result 之后
// (数组式文本 user 走不到这一则:第 3 则已把它与相邻 result-user 合并,见 t5b)
{
  const m = run([
    { role: 'assistant', content: [{ type: 'tool_use', id: 'T5', name: 'Bash', input: {} }] },
    { role: 'user', content: '插话' },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'T5', content: 'done' }] },
  ]);
  const kinds = m.map((x) => (x.role === 'assistant' ? 'A' : (Array.isArray(x.content) && x.content.some((c) => c.type === 'tool_result') ? 'R' : 'U')));
  assert.deepEqual(kinds, ['A', 'R', 'U'], 't5: string 文本 user 应后移到 result 之后');
  assert.equal(m[2].content, '插话', 't5: 文本内容不丢');
}
// t5b 数组式文本 user 夹层:由第 3 则合并进 result-user(text 在前 result 在后),不再是独立消息
{
  const m = run([
    { role: 'assistant', content: [{ type: 'tool_use', id: 'T5B', name: 'Bash', input: {} }] },
    { role: 'user', content: [{ type: 'text', text: '插话' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'T5B', content: 'done' }] },
  ]);
  assert.equal(m.length, 2, 't5b: 数组式夹层应被合并成单条 user');
  assert.deepEqual(m[1].content.map((b) => b.type), ['text', 'tool_result'], 't5b: 合并后 text 在前 result 在后');
}
// t6 补桩防假:tool_result 在更后面存在 → 不得插假桩
{
  const m = run([
    { role: 'assistant', content: [{ type: 'tool_use', id: 'LATE', name: 'x', input: {} }] },
    { role: 'assistant', content: [{ type: 'text', text: '想了想' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'LATE', content: 'real' }] },
  ]);
  const stubs = JSON.stringify(m).match(/fed via system context/g) || [];
  assert.equal(stubs.length, 0, 't6: 真结果在后面时不得插假桩');
  const stubbed = run([
    { role: 'assistant', content: [{ type: 'tool_use', id: 'GONE', name: 'x', input: {} }] },
    { role: 'user', content: [{ type: 'text', text: 'next turn' }] },
  ]);
  assert.ok(JSON.stringify(stubbed).includes('GONE'), 't6: 真缺失时补桩仍在(回归既有行为)');
  assert.ok(JSON.stringify(stubbed).includes('fed via system context'), 't6: 真缺失时补桩仍在');
}
// t7 无需修补时原样返回(引用同一 Buffer 内容)
{
  const body = Buffer.from(JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hello' }] }));
  const out = normalizeMessagesForCompat(body);
  assert.equal(out.toString(), body.toString(), 't7: 零修补应原样返回');
}
console.log('check-anthropic-proxy-normalize: all assertions passed');
