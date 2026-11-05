#!/usr/bin/env node
// r154 R3:底部状态行状态词纯函数 liveStatusLabel 的分支与工具动词 / 对象。
//
// 锁的事:
//   S1 六种 phase 与对应 verb;无入参 / 空对象回落「正在思考」;sawModelOutput=false 才是「连接中」。
//   S2 优先级 stopping > compacting > pendingTool > text > thinking。
//   S3 每个工具的 verb 与 object(文件取最后一段、Bash description 优先、WebFetch 取域名…)。
//   S4 路径分隔符 / 与 \ 都认;50 字符边界(按码点)、不加省略号、verb/object 不含「…」。
//   S5 空入参 / 非对象入参 / 缺字段时 object 为 ''。
//
// 跑法:node tests/unit/check-r154-live-status.mjs
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeReport } from './q8-helpers/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const { liveStatusLabel, TOOL_VERBS } = await import(pathToFileURL(join(ROOT, 'client', 'src', 'utils', 'liveStatus.js')).href);
const report = makeReport('check-r154-live-status');
const tool = (name, input) => liveStatusLabel({ pendingTool: { name, input } });

await report.check('S1', '六种 phase 与 verb;缺省回落正在思考;sawModelOutput=false 为连接中', 'red', () => {
  assert.deepEqual(liveStatusLabel({ stopping: true }), { phase: 'stopping', verb: '停止中', object: '' });
  assert.deepEqual(liveStatusLabel({ compacting: true }), { phase: 'compacting', verb: '正在压缩上下文', object: '' });
  assert.deepEqual(liveStatusLabel({ text: true }), { phase: 'text', verb: '正在输出', object: '' });
  assert.deepEqual(liveStatusLabel({ thinking: true }), { phase: 'thinking', verb: '正在思考', object: '' });
  assert.deepEqual(liveStatusLabel({ sawModelOutput: false }), { phase: 'connecting', verb: '连接中', object: '' });
  assert.deepEqual(liveStatusLabel(), { phase: 'thinking', verb: '正在思考', object: '' });
  assert.deepEqual(liveStatusLabel({}), { phase: 'thinking', verb: '正在思考', object: '' });
  // sawModelOutput 只认严格 false
  assert.equal(liveStatusLabel({ sawModelOutput: undefined }).phase, 'thinking');
  assert.equal(liveStatusLabel({ sawModelOutput: 0 }).phase, 'thinking');
  assert.equal(tool('Read', { file_path: '/a/b.md' }).phase, 'tool');
});

await report.check('S2', '优先级 stopping > compacting > pendingTool > text > thinking > connecting', 'red', () => {
  const pt = { name: 'Read', input: { file_path: '/x/y.js' } };
  const all = { stopping: true, compacting: true, pendingTool: pt, text: true, thinking: true, sawModelOutput: false };
  assert.equal(liveStatusLabel(all).phase, 'stopping');
  assert.equal(liveStatusLabel({ ...all, stopping: false }).phase, 'compacting');
  assert.equal(liveStatusLabel({ ...all, stopping: false, compacting: false }).phase, 'tool');
  assert.equal(liveStatusLabel({ ...all, stopping: false, compacting: false, pendingTool: null }).phase, 'text');
  assert.equal(liveStatusLabel({ ...all, stopping: false, compacting: false, pendingTool: null, text: false }).phase, 'thinking');
  assert.equal(liveStatusLabel({ ...all, stopping: false, compacting: false, pendingTool: null, text: false, thinking: false }).phase, 'connecting');
});

await report.check('S3', '每个工具的 verb 与 object', 'red', () => {
  const cases = [
    ['Read', { file_path: '/Users/me/proj/section_06_02.md' }, '读取', 'section_06_02.md'],
    ['Edit', { file_path: '/a/b/App.jsx' }, '编辑', 'App.jsx'],
    ['MultiEdit', { file_path: 'rel/dir/x.py' }, '编辑', 'x.py'],
    ['NotebookEdit', { notebook_path: '/n/book.ipynb' }, '编辑', 'book.ipynb'],
    ['Write', { file_path: 'only.txt' }, '写入', 'only.txt'],
    ['Bash', { command: 'npm test', description: '跑单测' }, '运行', '跑单测'],
    ['Bash', { command: '\n  ls -la\nrm x' }, '运行', 'ls -la'],
    ['Bash', { command: 'echo hi', description: '   ' }, '运行', 'echo hi'],
    ['BashOutput', { bash_id: 'b1' }, '运行', ''],
    ['KillShell', { shell_id: 's1' }, '运行', ''],
    ['Grep', { pattern: 'useStore\\(' }, '搜索', 'useStore\\('],
    ['Glob', { pattern: '**/*.jsx' }, '查找', '**/*.jsx'],
    ['WebFetch', { url: 'https://docs.example.com/a/b?q=1' }, '抓取', 'docs.example.com'],
    ['WebFetch', { url: 'not a url' }, '抓取', 'not a url'],
    ['WebSearch', { query: 'tauri updater' }, '联网搜索', 'tauri updater'],
    ['Task', { description: '查资料', prompt: 'p' }, '委派子代理', '查资料'],
    ['Agent', { description: '写测试' }, '委派子代理', '写测试'],
    ['TaskCreate', { subject: 'x' }, '更新任务清单', ''],
    ['TaskUpdate', { taskId: '1' }, '更新任务清单', ''],
    ['TodoWrite', { todos: [] }, '更新任务清单', ''],
    ['Skill', { skill: 'dev-flow' }, '调用技能', 'dev-flow'],
    ['Skill', { name: 'pdf' }, '调用技能', 'pdf'],
    ['ExitPlanMode', { plan: 'p' }, '提交计划', ''],
    ['AskUserQuestion', { questions: [] }, '等待你的回答', ''],
    ['mcp__paper-search__search_arxiv', { query: 'q' }, '调用', 'search_arxiv'],
    ['mcp__computer-use__screenshot', {}, '调用', 'screenshot'],
    ['SomeNewTool', { a: 1 }, '调用', 'SomeNewTool'],
  ];
  for (const [name, input, verb, object] of cases) {
    assert.deepEqual(tool(name, input), { phase: 'tool', verb, object }, `${name} ${JSON.stringify(input)}`);
  }
  // 动词表本身与上面一致,且不可被改
  assert.equal(TOOL_VERBS.Read, '读取');
  assert.equal(TOOL_VERBS.TodoWrite, '更新任务清单');
  assert.ok(Object.isFrozen(TOOL_VERBS));
  // 原型链上的名字不当工具动词
  assert.deepEqual(tool('constructor', {}), { phase: 'tool', verb: '调用', object: 'constructor' });
});

await report.check('S4', '路径分隔符 / 与 \\;50 字符边界;不含省略号', 'red', () => {
  assert.equal(tool('Read', { file_path: 'C:\\Users\\me\\proj\\main.rs' }).object, 'main.rs');
  assert.equal(tool('Read', { file_path: 'C:/Users/me/mixed\\a.txt' }).object, 'a.txt');
  assert.equal(tool('Read', { file_path: '/a/dir/' }).object, 'dir');
  const s50 = 'a'.repeat(50);
  assert.equal(tool('Grep', { pattern: s50 }).object, s50);
  assert.equal(tool('Grep', { pattern: s50 + 'bcd' }).object, s50);
  assert.equal(tool('Bash', { command: 'x'.repeat(80) }).object.length, 50);
  assert.equal(tool('WebSearch', { query: '查'.repeat(60) }).object, '查'.repeat(50));
  // 按码点截,emoji 不被切坏
  const emo = '😀'.repeat(55);
  assert.equal(Array.from(tool('WebSearch', { query: emo }).object).length, 50);
  assert.equal(tool('WebFetch', { url: 'z'.repeat(70) }).object, 'z'.repeat(50));
  // 入参自带的省略号也去掉
  const r = tool('Task', { description: '处理中…' });
  assert.equal(r.object, '处理中');
  for (const name of Object.keys(TOOL_VERBS)) assert.ok(!TOOL_VERBS[name].includes('…'));
  for (const p of [{ stopping: true }, { compacting: true }, { text: true }, { thinking: true }, { sawModelOutput: false }]) {
    const l = liveStatusLabel(p);
    assert.ok(!l.verb.includes('…') && !l.object.includes('…'));
  }
  // 换行与多空白折成单个空格
  assert.equal(tool('Task', { description: '甲\n\n乙   丙' }).object, '甲 乙 丙');
});

await report.check('S5', '空入参 / 非对象入参 / 缺字段时 object 为空串', 'red', () => {
  for (const name of ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'Skill']) {
    for (const input of [undefined, null, {}, 'str', 42, []]) {
      const r = tool(name, input);
      assert.equal(r.phase, 'tool');
      assert.equal(r.verb, TOOL_VERBS[name]);
      assert.equal(r.object, '', `${name} ${JSON.stringify(input)}`);
    }
  }
  assert.equal(tool('Read', { file_path: 123 }).object, '');
  assert.equal(tool('WebFetch', { url: '' }).object, '');
  // 没有 name 的工具
  assert.deepEqual(liveStatusLabel({ pendingTool: {} }), { phase: 'tool', verb: '调用', object: '' });
  assert.deepEqual(liveStatusLabel({ pendingTool: { name: null } }), { phase: 'tool', verb: '调用', object: '' });
  assert.deepEqual(liveStatusLabel({ pendingTool: { name: 'mcp__' } }), { phase: 'tool', verb: '调用', object: 'mcp__' });
});

process.exit(report.finish());
