// 单测:session-repair repairOfficialCompat(r10-12 旧会话切官方 400 清理)。
// import 真函数;fixture 自造(严禁触碰真实 ~/.claude/projects 文件)。
// 变异哨兵(实际验证过红):
//   S1 删 R3 接骨逻辑(droppedParent 重指循环)→ t3/t4 红
//   S2 删 R2 thinking 分支 → t2 红
import assert from 'node:assert/strict';
import { repairOfficialCompat } from '../../server/utils/session-repair.js';

const L = (obj) => JSON.stringify(obj);
const msg = (type, uuid, parentUuid, content, extra = {}) =>
  L({ uuid, parentUuid, sessionId: 'S', type, message: { role: type, content }, ...extra });
const parseAll = (lines) => lines.map((l) => JSON.parse(l));

// t1 R1:空 text 块删除,同行其余块保留;行不删
{
  const { lines, report } = repairOfficialCompat([
    msg('user', 'u1', null, [{ type: 'text', text: 'hi' }]),
    msg('assistant', 'a1', 'u1', [
      { type: 'text', text: '' },
      { type: 'tool_use', id: 'T1', name: 'Bash', input: {} },
    ]),
  ]);
  assert.equal(lines.length, 2, 't1: 行数不变');
  const a = parseAll(lines)[1];
  assert.equal(a.message.content.length, 1, 't1: 空 text 应删,tool_use 保留');
  assert.equal(a.message.content[0].type, 'tool_use');
  assert.deepEqual(report, { emptyText: 1, emptyThinking: 0, droppedLines: 0, relinked: 0 });
}

// t2 R2:空 thinking 块删除(实证 222 处形态:与其他块同行共存)
{
  const { lines, report } = repairOfficialCompat([
    msg('assistant', 'a1', null, [
      { type: 'thinking', thinking: '' },
      { type: 'text', text: 'ok' },
    ]),
  ]);
  const a = parseAll(lines)[0];
  assert.equal(a.message.content.length, 1, 't2: 空 thinking 应删');
  assert.equal(a.message.content[0].type, 'text');
  assert.equal(report.emptyThinking, 1, 't2: report 计数');
}

// t3 R3:整行删除 + 多子指同父接骨(实证元凶形态:单空 text 块 + stop_reason tool_use)
{
  const { lines, report } = repairOfficialCompat([
    msg('user', 'u1', null, [{ type: 'text', text: 'q' }]),
    msg('assistant', 'a1', 'u1', [{ type: 'text', text: '' }], { stop_reason: 'tool_use' }),
    msg('user', 'u2', 'a1', [{ type: 'text', text: 'child A' }]),
    msg('user', 'u3', 'a1', [{ type: 'text', text: 'child B' }]),
  ]);
  assert.equal(lines.length, 3, 't3: 空行应整条删除');
  const objs = parseAll(lines);
  assert.ok(!objs.some((o) => o.uuid === 'a1'), 't3: a1 不复存在');
  assert.equal(objs.find((o) => o.uuid === 'u2').parentUuid, 'u1', 't3: 子 A 重指到祖父');
  assert.equal(objs.find((o) => o.uuid === 'u3').parentUuid, 'u1', 't3: 子 B 重指到祖父');
  assert.equal(report.droppedLines, 1);
  assert.equal(report.relinked, 2);
}

// t4 R3 链式删除 + summary leafUuid / compact_boundary logicalParentUuid 重指
{
  const { lines } = repairOfficialCompat([
    msg('user', 'u1', null, [{ type: 'text', text: 'root' }]),
    msg('assistant', 'a1', 'u1', [{ type: 'text', text: ' ' }]),
    msg('assistant', 'a2', 'a1', [{ type: 'thinking', thinking: '  ' }]),
    msg('user', 'u2', 'a2', [{ type: 'text', text: 'leaf' }]),
    L({ type: 'summary', summary: 'S', leafUuid: 'a2' }),
    L({ type: 'system', subtype: 'compact_boundary', uuid: 'cb1', parentUuid: null, logicalParentUuid: 'a1' }),
  ]);
  const objs = parseAll(lines);
  assert.equal(objs.find((o) => o.uuid === 'u2').parentUuid, 'u1', 't4: 链式删除穿透到存活祖先');
  assert.equal(objs.find((o) => o.type === 'summary').leafUuid, 'u1', 't4: summary.leafUuid 重指');
  assert.equal(objs.find((o) => o.subtype === 'compact_boundary').logicalParentUuid, 'u1', 't4: logicalParentUuid 重指');
}

// t5 非消息行 / 解析失败行原样透传(字节级)
{
  const junk = '{broken json';
  const title = L({ type: 'custom-title', customTitle: 'T', sessionId: 'S' });
  const strContent = L({ uuid: 'x1', parentUuid: null, type: 'user', message: { role: 'user', content: 'plain string' } });
  const { lines, report } = repairOfficialCompat([junk, title, strContent]);
  assert.deepEqual(lines, [junk, title, strContent], 't5: 三类行原样透传');
  assert.deepEqual(report, { emptyText: 0, emptyThinking: 0, droppedLines: 0, relinked: 0 });
}

// t6 幂等:二次跑 report 全零、行集不变;原本就空的 content 数组不删(非"因清而空")
{
  const preEmpty = msg('assistant', 'a9', null, []);
  const first = repairOfficialCompat([
    msg('user', 'u1', null, [{ type: 'text', text: 'q' }]),
    msg('assistant', 'a1', 'u1', [{ type: 'text', text: '' }]),
    msg('user', 'u2', 'a1', [{ type: 'text', text: 'x' }]),
    preEmpty,
  ]);
  const second = repairOfficialCompat(first.lines);
  assert.deepEqual(second.report, { emptyText: 0, emptyThinking: 0, droppedLines: 0, relinked: 0 }, 't6: 二次跑全零');
  assert.deepEqual(second.lines, first.lines, 't6: 二次跑行集不变');
  assert.ok(first.lines.some((l) => l.includes('"a9"')), 't6: 原本就空的行不删');
}

// t7 被删行 parent 为 null 时子行重指为 null(链首残缺回合)
{
  const { lines } = repairOfficialCompat([
    msg('assistant', 'a1', null, [{ type: 'text', text: '' }]),
    msg('user', 'u1', 'a1', [{ type: 'text', text: 'x' }]),
  ]);
  const u1 = parseAll(lines).find((o) => o.uuid === 'u1');
  assert.equal(u1.parentUuid, null, 't7: 重指到 null 而非悬空 uuid');
}

// t8 仪表化判据:chat.js 的 matchOfficialEmptyBlockError(真实 400 文案/无关错误)
{
  const { matchOfficialEmptyBlockError } = await import('../../server/routes/chat.js');
  assert.equal(matchOfficialEmptyBlockError(
    'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.5.content.0: text content blocks must be non-empty"}}',
  ), true, 't8: 官方 400 文案应命中');
  assert.equal(matchOfficialEmptyBlockError('Invalid signature in thinking block'), false, 't8: 无关错误不命中');
  assert.equal(matchOfficialEmptyBlockError(''), false, 't8: 空串不命中');
}

console.log('check-session-repair: all passed');
process.exit(0); // chat.js 顶层可能挂定时器,显式退出
