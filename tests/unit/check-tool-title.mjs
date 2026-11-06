#!/usr/bin/env node
// r152a 折叠条末尾「最新工具调用标题」:toolTitle(标题规则 / 优先级 / 清洗截断 / 坏入参)
// + stripSummary 的 doneTitle / liveTitle(收官与直播两种选法、入参未到沿用、整轮多段拼接)。纯函数,零 DOM。
// 变异哨兵:description 不再优先 → p1 红;截断上限改回 40 → c3 红;直播改成"恒取最后一个" → s3 红;
// 入参未到不再沿用上一个 → s5 红;Task 卡也参与选取 → s2 红;思考尾句上限跟着变 → s8 红。
// r152a 修订:非说明性文字(命令首行 / 文件名 / pattern / url / query)也去记号 → l1 / l2 红;
// 说明性文字(description、其它工具的 summary / title)不再去记号 → m1–m5 红。
import assert from 'node:assert/strict';
import { toolTitle, stripSummary } from '../../client/src/utils/streamStatus.js';

let n = 0;
const eq = (a, b, msg) => { n += 1; assert.equal(a, b, msg); };
const tc = (name, input, result = null) => ({ id: `id-${name}-${n}`, name, input, result });
const RES = { toolUseId: 'x', content: 'ok', isError: false };
const tool = (name, input, result = RES) => ({ type: 'tool_use', toolCall: tc(name, input, result) });
const think = (content) => ({ type: 'thinking', content });
const text = (content) => ({ type: 'text', content });
const sum = (blocks) => stripSummary(blocks, null);

// ── r1 标题规则:每行一条 ──
eq(toolTitle(tc('Bash', { command: 'ls', description: '整理临时文件' })), '整理临时文件', 'Bash 有 description → description');
eq(toolTitle(tc('Bash', { command: '\n\n  npm run build  \nnpm test' })), 'npm run build', 'Bash 无 description → command 第一个非空行');
eq(toolTitle(tc('Bash', { command: 'a\r\nb' })), 'a', 'CRLF 换行同样只取第一行');
eq(toolTitle(tc('Bash', {})), null, 'Bash 无 command → null(调用方退回工具名)');
eq(toolTitle(tc('Read', { file_path: '/a/b/c.txt' })), '读取 c.txt', 'Read → 读取 <文件名>');
eq(toolTitle(tc('Read', { file_path: 'C:\\x\\y.ts' })), '读取 y.ts', 'Windows 路径按 \\ 切');
eq(toolTitle(tc('Read', { file_path: '/a/b/dir/' })), '读取 dir', '末尾带分隔符取上一段');
eq(toolTitle(tc('Read', {})), null, 'Read 缺 file_path → null');
eq(toolTitle(tc('Edit', { file_path: '/p/edit-me.js' })), '编辑 edit-me.js', 'Edit → 编辑');
eq(toolTitle(tc('MultiEdit', { file_path: '/p/multi.ts', edits: [] })), '编辑 multi.ts', 'MultiEdit → 编辑');
eq(toolTitle(tc('Write', { file_path: '/p/new.md' })), '新建 new.md', 'Write → 新建');
eq(toolTitle(tc('Grep', { pattern: 'foo' })), '搜索 foo', 'Grep → 搜索 <pattern>');
eq(toolTitle(tc('Glob', { pattern: '*.md' })), '查找文件 *.md', 'Glob → 查找文件 <pattern>(单个 * 不剥)');
eq(toolTitle(tc('Glob', { pattern: '**/*.md' })), '查找文件 **/*.md', 'Glob 通配 **/ 不被当成粗体剥掉');
eq(toolTitle(tc('WebFetch', { url: 'https://example.com/docs' })), '抓取 https://example.com/docs', 'WebFetch → 抓取 <url>');
eq(toolTitle(tc('WebSearch', { query: 'claude code hooks' })), '搜索网页 claude code hooks', 'WebSearch → 搜索网页 <query>');
eq(toolTitle(tc('CustomTool', { summary: '自定义摘要' })), '自定义摘要', '其它工具 → summary');
eq(toolTitle(tc('CustomTool', { title: '自定义标题' })), '自定义标题', '其它工具无 summary → title');
eq(toolTitle(tc('MysteryTool', {})), null, '未知工具什么字段都没有 → null');
eq(toolTitle(tc('mcp__srv__do_thing', { query: 'q' })), null, 'MCP 工具不猜 query/url');
eq(sum([tool('mcp__srv__do_thing', {})]).doneTitle, 'do_thing', 'MCP 无字段 → 工具名最后一段');
eq(sum([tool('MysteryTool', {})]).doneTitle, 'MysteryTool', '未知工具 → 工具原名');
eq(sum([tool('Read', {})]).doneTitle, 'Read', 'Read 缺字段 → Read');

// ── p 优先级 ──
eq(toolTitle(tc('Read', { file_path: '/a/c.txt', description: '读配置' })), '读配置', 'p1 非 Bash 也以 description 为先');
eq(toolTitle(tc('Bash', { command: 'git status', description: ' \n\t ' })), 'git status', 'p2 description 全是空白 → 退到 command');
eq(toolTitle(tc('CustomTool', { summary: '甲', title: '乙' })), '甲', 'p3 summary 先于 title');
eq(toolTitle(tc('Read', { summary: '不该用' })), null, 'p4 已知工具不取 summary');
eq(toolTitle(tc('Bash', { description: 123, command: 'ls' })), 'ls', 'p5 description 不是字符串 → 下一条规则');

// ── c 清洗与截断 ──
const D60 = '0123456789'.repeat(6);
eq(toolTitle(tc('Bash', { description: '\n  先看  \n 一眼\t现场  \n' })), '先看 一眼 现场', 'c1 空白折叠 + 去首尾');
eq(toolTitle(tc('Bash', { description: '**加粗** 与 `代码` 和 ~~删~~ 与 *强* 与 _强_' })), '加粗 与 代码 和 删 与 强 与 强', 'c2 成对记号剥掉');
eq(toolTitle(tc('Bash', { description: 'foo_bar_baz 2*3*4 x**2 + y**2' })), 'foo_bar_baz 2*3*4 x**2 + y**2', 'c2 零散记号原样');
eq(toolTitle(tc('Bash', { description: D60 })), D60, 'c3 恰好 60 个码点不截');
eq(toolTitle(tc('Bash', { description: `${D60}X` })), `${D60}…`, 'c3 61 个码点 → 前 60 + …');
eq(toolTitle(tc('Bash', { description: `${'x'.repeat(59)}🙂${'y'.repeat(5)}` })), `${'x'.repeat(59)}🙂…`, 'c4 按码点截,不劈开 emoji');
eq(toolTitle(tc('Grep', { pattern: 'a\nb' })), '搜索 a b', 'c5 模板拼出的标题同样清洗');
eq(toolTitle(tc('Bash', { description: '<script>x</script>' })), '<script>x</script>', 'c6 HTML 字符原样当文字');

// ── l 非说明性文字:记号原样保留,只折叠空白 + 按码点截 60 ──
eq(toolTitle(tc('Glob', { pattern: 'src/**/*.test.*' })), '查找文件 src/**/*.test.*', 'l1 Glob 通配里的星号原样');
eq(toolTitle(tc('Grep', { pattern: 'function.*foo.*' })), '搜索 function.*foo.*', 'l1 Grep 正则里的 .* 原样');
eq(toolTitle(tc('Bash', { command: 'find . -name "*.js" -o -name "*.ts"' })), 'find . -name "*.js" -o -name "*.ts"', 'l1 命令首行里的星号原样');
eq(toolTitle(tc('Bash', { command: 'echo `date` and `whoami`' })), 'echo `date` and `whoami`', 'l1 命令首行里的反引号原样');
eq(toolTitle(tc('Read', { file_path: '/p/__init__.py' })), '读取 __init__.py', 'l2 文件名里的下划线原样');
eq(toolTitle(tc('Write', { file_path: '/p/~~old~~.md' })), '新建 ~~old~~.md', 'l2 文件名里的波浪线原样');
eq(toolTitle(tc('WebSearch', { query: '**bold** _x_ `y`' })), '搜索网页 **bold** _x_ `y`', 'l2 query 里的成对记号也原样');
eq(toolTitle(tc('WebFetch', { url: 'https://e.com/a_b_c/*x*' })), '抓取 https://e.com/a_b_c/*x*', 'l2 url 原样');
eq(toolTitle(tc('Bash', { command: '  ls \t  -la   \t /tmp  \nnext' })), 'ls -la /tmp', 'l3 命令首行里多个空白 / 制表符折叠成一个空格');
eq(toolTitle(tc('Grep', { pattern: 'a\t\t  *b*' })), '搜索 a *b*', 'l3 pattern 里的制表符折叠、星号原样');
{
  const C70 = `${'*'.repeat(10)}${'x'.repeat(60)}`;
  eq(toolTitle(tc('Bash', { command: C70 })), `${'*'.repeat(10)}${'x'.repeat(50)}…`, 'l4 非说明性文字超过 60 码点 → 前 60 + …(星号原样计入)');
  eq(toolTitle(tc('Glob', { pattern: 'y'.repeat(60) })), `查找文件 ${'y'.repeat(55)}…`, 'l4 拼上动词前缀后整串按 60 截');
  eq(toolTitle(tc('Bash', { command: `${'x'.repeat(59)}🙂${'y'.repeat(5)}` })), `${'x'.repeat(59)}🙂…`, 'l4 按码点截,不劈开 emoji');
}

// ── m 说明性文字仍去成对记号 ──
eq(toolTitle(tc('Bash', { command: 'ls *.md', description: '跑 **粗** 与 `码`' })), '跑 粗 与 码', 'm1 description 去成对记号');
eq(toolTitle(tc('Read', { file_path: '/a/b.md', description: '读 `b.md` 的 _说明_' })), '读 b.md 的 说明', 'm2 非 Bash 的 description 同样去记号');
eq(toolTitle(tc('CustomTool', { summary: '**摘要** 里 `码` 与 ~~删~~' })), '摘要 里 码 与 删', 'm3 其它工具 summary 去成对记号');
eq(toolTitle(tc('CustomTool', { title: '_标题_ 与 *强*' })), '标题 与 强', 'm4 其它工具 title 去成对记号');
eq(toolTitle(tc('mcp__srv__x', { summary: '`a` 与 **b**' })), 'a 与 b', 'm5 MCP 工具的 summary 也是说明性文字');

// ── b 坏入参不抛,退回 null / 工具名 ──
for (const bad of [null, undefined, 0, 'Bash', [], Object.create(null)]) {
  eq(toolTitle(bad), null, `b1 toolCall=${String(bad && typeof bad)} → null`);
}
for (const [label, input] of [['字符串', 'echo hi'], ['数组', ['/a/b.txt']], ['null', null], ['数字', 7], ['布尔', true]]) {
  eq(toolTitle(tc('Bash', input)), null, `b2 入参是${label} → null`);
}
eq(toolTitle(tc('Glob', { pattern: { x: 1 }, description: ['a'] })), null, 'b3 字段是对象 / 数组 → null');
const nullProto = Object.assign(Object.create(null), { description: '无原型入参' });
eq(toolTitle(tc('Bash', nullProto)), '无原型入参', 'b4 无原型入参照常取');
const nullProtoCall = Object.assign(Object.create(null), { name: 'Bash', input: { command: 'pwd' } });
eq(toolTitle(nullProtoCall), 'pwd', 'b4 无原型 toolCall 照常取');
const evil = { name: 'Bash', input: {} };
Object.defineProperty(evil.input, 'description', { enumerable: true, get() { throw new Error('boom'); } });
eq(toolTitle(evil), null, 'b5 字段 getter 抛错 → null 不外抛');
eq(sum([tool('mcp__srv__do_other', 'oops')]).doneTitle, 'do_other', 'b6 MCP 入参是字符串 → 工具名最后一段');
eq(sum([tool('Bash', { description: 123, command: 456 })]).doneTitle, 'Bash', 'b7 字段全是数字 → Bash');
eq(sum([{ type: 'tool_use', toolCall: { id: 'x', input: {} } }]).doneTitle, null, 'b8 工具没有名字 → null(回落思考尾句)');

// ── s 选取口径(只在可折段里选)──
{
  const blocks = [think('想一'), tool('Bash', { description: '甲' }), think('想二'), tool('Read', { file_path: '/x/y/b4.txt' }), think('最后一块是思考')];
  const s = sum(blocks);
  eq(s.doneTitle, '读取 b4.txt', 's1 收官:最后一块是思考也取最后一个工具');
  eq(s.liveTitle, '读取 b4.txt', 's1 都有结果时 liveTitle 同 doneTitle');
  eq(s.tail, '最后一块是思考', 's1 tail 照旧(调用方按需回落)');
}
{
  const card = (name) => ({ type: 'tool_use', toolCall: tc(name, { subagent_type: 'fixer', description: '子代理卡标题' }, RES) });
  eq(sum([think('a'), tool('Bash', { description: '卡前' }), card('Task'), tool('Bash', { description: '卡后' })]).doneTitle, '卡后', 's2 卡后有 Bash → 卡后');
  // r157 起 Task/Agent 进 group:它就是组里最后一个工具,标题取它自己的 description
  eq(sum([tool('Bash', { description: '卡前' }), card('Agent'), think('卡后只有思考')]).doneTitle, '子代理卡标题', 's2 r157:最后一个工具是子代理 → 取子代理标题');
  eq(sum([card('Task'), think('只有思考')]).doneTitle, '子代理卡标题', 's2 r157:只有子代理 → 取子代理标题');
  eq(sum([tool('Skill', { skill: 'x', description: '技能' }), tool('TodoWrite', { todos: [] })]).doneTitle, null, 's2 Skill / Todo 不参与');
  eq(sum([tool('Read', { file_path: '/s/skills/demo/SKILL.md' })]).doneTitle, null, 's2 读 SKILL.md 不参与');
}
{
  const bash = (d, result) => tool('Bash', { command: 'echo', description: d }, result);
  eq(sum([bash('甲', RES), bash('乙', null)]).liveTitle, '乙', 's3 甲有结果、乙在跑 → 乙');
  eq(sum([bash('甲', RES), bash('乙', RES)]).liveTitle, '乙', 's3 都有结果 → 最后一个乙');
  const par = [bash('甲', RES), bash('乙', RES), bash('丙', null), bash('丁', RES)];
  eq(sum(par).liveTitle, '丙', 's3 并行:丁已回、丙还在跑 → 丙');
  eq(sum(par).doneTitle, '丁', 's3 收官口径:最后一个丁');
  eq(sum([bash('甲', null), bash('乙', null), bash('丙', RES)]).liveTitle, '乙', 's4 多个在跑 → 在跑的最后一个');
}
{
  const bash = (d, result = RES) => tool('Bash', { command: 'echo', description: d }, result);
  const fresh = (name = 'Bash') => ({ type: 'tool_use', toolCall: tc(name, {}, null) });
  eq(sum([bash('甲'), fresh()]).liveTitle, '甲', 's5 丙入参未到 → 沿用之前最近的甲');
  eq(sum([bash('甲'), fresh()]).doneTitle, 'Bash', 's5 收官口径不沿用(取最后一个的工具名)');
  eq(sum([bash('甲'), bash('乙', null), fresh(), fresh('Read')]).liveTitle, '乙', 's5 连着几个入参未到 → 跳过,取更前面已有标题的乙');
  eq(sum([fresh('mcp__srv__do_thing')]).liveTitle, 'do_thing', 's6 之前一个都没有 → 它自己的工具名');
  eq(sum([bash('甲'), { type: 'tool_use', toolCall: tc('Bash', null, null) }]).liveTitle, '甲', 's6 入参是 null 也算未到');
  eq(sum([bash('甲'), { type: 'tool_use', toolCall: tc('Bash', { command: 'echo c', description: '丙' }, null) }]).liveTitle, '丙', 's7 入参传完 → 换成丙');
  eq(sum([bash('甲'), { type: 'tool_use', toolCall: tc('MysteryTool', {}, RES) }]).liveTitle, 'MysteryTool', 's7 空入参但已有结果 → 不算未到');
}

// ── s8 没有工具 / 思考尾句口径不变(仍是 40 码点)──
{
  const long = '这一轮只有思考没有工具：先把问题拆成三步，读配置、改入口、再跑一遍全部测试确认没有回归。';
  const s = sum([think('第一条'), think(long)]);
  eq(s.doneTitle, null, 's8 无工具 → doneTitle null');
  eq(s.liveTitle, null, 's8 无工具 → liveTitle null');
  eq(s.tail, `${Array.from(long).slice(0, 40).join('')}…`, 's8 思考尾句仍截 40 码点');
}

// ── s9 整轮多段拼接(⚡引导切段时 App 按整轮 flatMap 算):后段的工具优先 ──
{
  const seg1 = [think('a'), tool('Bash', { description: '前段甲' }), text('前段正文')];
  const seg2 = [think('b'), tool('Grep', { pattern: 'needle' }, null), text('后段正文')];
  const whole = sum([...seg1, ...seg2]);
  eq(whole.doneTitle, '搜索 needle', 's9 整轮收官:后段最后一个工具');
  eq(whole.liveTitle, '搜索 needle', 's9 整轮直播:后段在跑的工具');
  eq(sum(seg1).doneTitle, '前段甲', 's9 只看首段时只有首段的工具(对照)');
  eq(whole.steps, 4, 's9 steps 照旧按整轮可折块计');
}

// ── s10 不改入参 ──
{
  const blocks = [tool('Bash', { command: 'ls', description: '甲' }), tool('Read', {}, null)];
  const snap = JSON.stringify(blocks);
  sum(blocks); toolTitle(blocks[0].toolCall);
  eq(JSON.stringify(blocks), snap, 's10 不修改入参');
}

console.log(`check-tool-title: all passed (${n} assertions)`);
