#!/usr/bin/env node
// 条带折叠:摘要行取值 stripSummary + 可折段判据 isFoldableSegment(纯函数,零 DOM)。
// 变异哨兵:把 steps 改成数全部过程块(task/workflow 段也算)→ t3 红;
// 尾段改回"按位置判据取最后一条正文" → t2 红;去掉剥配对标记那一段 → t2/t7 红。
// 口径 2026-09-13 变更(用户实报"摘要行与正文重复"):尾段恒取最后一条思考(取不到就省略);
// 清洗时不剥零散记号,但**成对**的行内标记要剥(剥在截断之前)。
import assert from 'node:assert/strict';
import { stripSummary, isFoldableSegment, groupCoworkBlocks } from '../../client/src/utils/streamStatus.js';

const think = (content) => ({ type: 'thinking', content });
const text = (content) => ({ type: 'text', content });
const tool = (name, id = name) => ({ type: 'tool_use', toolCall: { id, name, input: {} } });
const tail = (s) => s.tail;

// ── t1 可折段判据:写死 kind === 'group' ──
{
  assert.equal(isFoldableSegment({ kind: 'group' }), true, 'group 可折');
  for (const kind of ['text', 'task', 'workflow', 'skill', 'skilldoc']) {
    assert.equal(isFoldableSegment({ kind }), false, `${kind} 段恒显不折(R114 的既有决策)`);
  }
  assert.equal(isFoldableSegment(null), false, 'null → 不可折(不抛)');
  assert.equal(isFoldableSegment(undefined), false, 'undefined → 不可折(不抛)');
}

// ── t2 尾段:恒取最后一条思考(取不到就省略)+ 清洗四步 ──
{
  // ① 有思考 → 取**最后一条**思考;与"最后一块是什么"无关
  assert.equal(tail(stripSummary([think('先看文件。'), text('改完了。')], null)),
    '先看文件。', '最后一块是正文 → 取最后一条思考');
  assert.equal(tail(stripSummary([think('想完了。'), text('正文。'), tool('Agent')], null)),
    '想完了。', '最后一块是工具调用 → 仍取最后一条思考(不看位置)');
  assert.equal(tail(stripSummary([think('第一条'), think('第二条'), text('正文')], null)),
    '第二条', '取的是**最后**一条思考,不是第一条');
  // ② 没有思考 → 省略尾段。**不回落取正文** —— 正文段在任何折叠态都恒显(只折 group 段),
  //    拿它当尾句就是摘要行与它下面那行逐字重复(用户实报的形态:thinking→text→Agent)。
  assert.equal(tail(stripSummary([text('先看文件再动手。'), tool('Read')], null)), null,
    '有正文无思考(最后一块是工具)→ 无尾段,不取正文');
  assert.equal(tail(stripSummary([think('收到四件事。'), text('收到四件事。'), tool('Agent')], null)),
    '收到四件事。', '思考与正文同句时取的是思考那条(结构上不保证去重,但不是"必然重复")');
  assert.equal(tail(stripSummary([text('只有正文,没有思考。')], null)), null, '纯正文轮 → 无尾段');
  // ③ 取不到内容 → null
  assert.equal(tail(stripSummary([tool('Bash')], null)), null, '只有工具 → 无尾段');
  assert.equal(tail(stripSummary([], null)), null, '空 blocks → 无尾段');
  assert.equal(tail(stripSummary([think(''), text('')], null)), null, '空 content → 无尾段');
  assert.equal(tail(stripSummary([think(null), text('x')], null)), null, 'content 为 null → 无尾段(不变成 "null")');
  // 清洗:剥配对标记 → 空白折叠 → trim → 40 码点截断
  assert.equal(tail(stripSummary([think('修好了。\n\n  下一步跑测试')], null)),
    '修好了。 下一步跑测试', '换行/缩进折叠成单个空格');
  assert.equal(tail(stripSummary([think('  前后空白  ')], null)), '前后空白', 'trim');
  assert.equal(tail(stripSummary([think('**加粗** 与 `代码`')], null)),
    '加粗 与 代码', '**成对**的行内标记剥掉(零散的单个记号不碰 —— 见 t7)');
  // 按 Unicode 码点截断:代理对不得劈开
  const emoji41 = '🙂'.repeat(41);
  const t = tail(stripSummary([think(emoji41), text('图看完了。')], null));
  assert.equal([...t].length, 41, '41 个 emoji → 40 + 省略号(按码点算)');
  assert.equal(t, `${'🙂'.repeat(40)}…`, '截断后逐字 = 40 emoji + U+2026');
  // 41 个中文字同样截断
  const han = '字'.repeat(41);
  assert.equal(tail(stripSummary([think(han)], null)), `${'字'.repeat(40)}…`, '41 个汉字 → 40 + …');
  // 非字符串 content(第三方 provider 落盘对象)→ String() 清洗(契约 §C.2 第 1 步),不抛
  assert.equal(tail(stripSummary([think({ a: 1 })], null)), '[object Object]', '非字符串 → String() 后清洗');
  assert.equal(tail(stripSummary([think(Object.create(null))], null)), null,
    '连 toString 都没有的对象 → 取不到尾段,绝不抛(摘要在渲染路径上)');
}

// ── t7 剥标记:只剥**成对**的;零散记号一个不动 ──
{
  const one = (src) => tail(stripSummary([think(src)], null));
  // 剥:六种配对形态
  const paired = [
    ['**加粗**', '加粗'],
    ['__加粗__', '加粗'],
    ['~~删掉~~', '删掉'],
    ['`代码`', '代码'],
    ['*强调*', '强调'],
    ['_强调_', '强调'],
    ['改完了,**跑一遍** `npm test` 确认。', '改完了,跑一遍 npm test 确认。'],
  ];
  for (const [input, want] of paired) assert.equal(one(input), want, `配对记号应当被剥:${input}`);
  // 不碰:零散的单个记号(全字符类扫射 `[*_`~]` 会把这些吃掉 = 误伤真内容)
  const literal = [
    'foo_bar_baz',
    '路径在 ~/edirect/ 下面',
    'ANTHROPIC_DEFAULT_*_MODEL',
    '2*3*4',
    '1 * 2 * 3',
    '算一下 x**2 + y**2 的值',
    'MY__VAR__X',
    '看下 config_v2_alpha.json',
    '单个反引号 ` 夹在文字里',
  ];
  for (const input of literal) assert.equal(one(input), input, `零散记号不得被剥:${input}`);
  // 未闭合的记号(被截断/作者漏写):按 CommonMark 就是字面量,**保留**(不做二次清理)
  assert.equal(one('**未闭合的加粗'), '**未闭合的加粗', '未闭合记号保留原样');
  assert.equal(one('`未闭合的代码'), '`未闭合的代码', '未闭合反引号保留原样');
  // 顺序:剥在截断**之前** —— 配对跨过 40 码点边界时,先截会把开记号留在行上
  const span = `${'x'.repeat(37)} **粗** ${'y'.repeat(5)}`;
  const outSpan = one(span);
  assert.equal(outSpan, `${'x'.repeat(37)} 粗 …`, '先剥后截:跨边界的配对整体消失,不残留 `**`');
  assert.ok(!outSpan.includes('*'), '截断后行上不得残留 `*`');
}

// ── t3 步数:只数**可折段**里会渲染的过程块 ──
{
  const blocks = [think('想一下'), tool('Bash'), text('中间插话'), tool('Read'), think('再看一眼'), text('收尾')];
  const s = stripSummary(blocks, null);
  assert.equal(s.steps, 4, '2 思考 + 2 通用工具 = 4 步');
  assert.equal(s.rounds, null, '没有 usageCalls → rounds 为 null(不显示「N 轮」)');
  // Task/Workflow/Skill 段里的块**不计入**(它们不折,计进去会让"展开后看得见的东西"对不上账)
  assert.equal(stripSummary([think('想'), tool('Task', 't1'), text('派完了')], null).steps, 1, 'Task 段的块不计入');
  assert.equal(stripSummary([think('想'), tool('Workflow', 'w1'), text('跑完了')], null).steps, 1, 'Workflow 段的块不计入');
  assert.equal(stripSummary([think('想'), tool('Skill', 's1'), text('读完了')], null).steps, 1, 'Skill 段的块不计入');
  // 空 content 的思考 / 没有 toolCall 的工具块:跳过(groupCoworkBlocks 同款)
  assert.equal(stripSummary([think(''), tool('Bash')], null).steps, 1, '空思考不计数');
  assert.equal(stripSummary([{ type: 'tool_use', toolCall: null }, think('a')], null).steps, 1, '无 toolCall 的块不计数');
  // 纯正文轮 → 0 步(渲染侧据此走 data-strip-state="none",不画摘要行)
  assert.equal(stripSummary([text('只有正文')], null).steps, 0, '纯正文轮 = 0 步');
  assert.equal(stripSummary([], null).steps, 0, '空 blocks = 0 步');
  // 任务清单工具(TaskCreate 等)只作 group 边界、不成段 → 不计入
  assert.equal(stripSummary([think('列个清单'), tool('TaskCreate', 'tc1'), text('列完了')], null).steps, 1,
    '清单工具的块不计入(它只作 group 边界)');
}

// ── t4 轮数:按 usageCalls 的条数;非数组一律 null ──
{
  assert.equal(stripSummary([think('a')], [{ id: 1 }, { id: 2 }, { id: 3 }]).rounds, 3, 'usageCalls.length = N 轮');
  assert.equal(stripSummary([think('a')], []).rounds, 0, '空数组 → 0 轮(不是 null)');
  for (const bad of [null, undefined, 'x', 3, {}]) {
    assert.equal(stripSummary([think('a')], bad).rounds, null, `usageCalls=${JSON.stringify(bad)} → null(省略「N 轮」)`);
  }
}

// ── t5 不改入参、不抛 ──
{
  const blocks = [think('a'), tool('Bash'), text('b')];
  const snapshot = JSON.stringify(blocks);
  stripSummary(blocks, null);
  assert.equal(JSON.stringify(blocks), snapshot, 'stripSummary 不得修改入参');
  assert.deepEqual(stripSummary(null, null), { rounds: null, steps: 0, tail: null }, 'blocks=null 回落空值,不抛');
  assert.deepEqual(stripSummary(undefined, undefined), { rounds: null, steps: 0, tail: null }, 'blocks=undefined 同理');
}

// ── t6 与 groupCoworkBlocks 的段划分对齐(步数 == 可折段内 items 数)──
{
  const blocks = [think('想'), tool('Bash'), text('正文'), think('再想'), tool('Read'), text('收尾')];
  const segs = groupCoworkBlocks(blocks);
  const groupItems = segs.filter((s) => s.kind === 'group').reduce((n, s) => n + s.items.length, 0);
  assert.equal(stripSummary(blocks, null).steps, groupItems, 'steps == 可折段里的块数(单一判据来源)');
}

console.log('check-strip-summary: all passed');
