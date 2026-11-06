#!/usr/bin/env node
// r154 R3 / ui-live-line-v2:底部状态行状态词纯函数 liveStatusLabel 的分支与工具标题。
//
// 锁的事:
//   S1 六种 phase 与对应 verb;缺省回落「思考」;thinking 带最后一条思考预览;sawModelOutput=false 才是「连接中」。
//   S2 优先级 stopping > compacting > pendingTool > lastType > 兼容布尔 > connecting。
//   S3 工具阶段显示该工具调用的标题(toolTitle,不带动词前缀);标题取不到才回落旧动词短语。
//   S4 标题的 60 字符边界(按码点)、路径分隔符 / 与 \,空白折叠。
//   S5 空入参 / 非对象入参 / 缺字段时回落旧动词短语,object 为 ''。
//
// 跑法:node tests/unit/check-r154-live-status.mjs
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeReport } from './q8-helpers/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const { liveStatusLabel, TOOL_VERBS } = await import(pathToFileURL(join(ROOT, 'client', 'src', 'utils', 'liveStatus.js')).href);
const streamStatus = await import(pathToFileURL(join(ROOT, 'client', 'src', 'utils', 'streamStatus.js')).href);
const { latestThinkingPreview, latestToolTitles } = streamStatus;
const report = makeReport('check-r154-live-status');
const tool = (name, input) => liveStatusLabel({ pendingTool: { name, input } });

await report.check('S1', '六种 phase 与 verb;缺省回落「思考」;thinking 带预览;sawModelOutput=false 为连接中', 'red', () => {
  assert.deepEqual(liveStatusLabel({ stopping: true }), { phase: 'stopping', verb: '停止中', object: '' });
  assert.deepEqual(liveStatusLabel({ compacting: true }), { phase: 'compacting', verb: '正在压缩上下文', object: '' });
  assert.deepEqual(liveStatusLabel({ lastType: 'text' }), { phase: 'text', verb: '正在输出', object: '' });
  assert.deepEqual(liveStatusLabel({ lastType: 'thinking', lastThinkingText: '分析问题的根因' }), { phase: 'thinking', verb: '思考', object: '分析问题的根因' });
  assert.deepEqual(liveStatusLabel({ lastType: 'thinking' }), { phase: 'thinking', verb: '思考', object: '' });
  assert.deepEqual(liveStatusLabel({ sawModelOutput: false }), { phase: 'connecting', verb: '连接中', object: '' });
  assert.deepEqual(liveStatusLabel(), { phase: 'thinking', verb: '思考', object: '' });
  assert.deepEqual(liveStatusLabel({}), { phase: 'thinking', verb: '思考', object: '' });
  // 兼容旧布尔入参:没有 lastType 时 text / thinking 仍可用
  assert.deepEqual(liveStatusLabel({ text: true }), { phase: 'text', verb: '正在输出', object: '' });
  assert.deepEqual(liveStatusLabel({ thinking: true }), { phase: 'thinking', verb: '思考', object: '' });
  // sawModelOutput 只认严格 false
  assert.equal(liveStatusLabel({ sawModelOutput: undefined }).phase, 'thinking');
  assert.equal(liveStatusLabel({ sawModelOutput: 0 }).phase, 'thinking');
  assert.equal(tool('Read', { file_path: '/a/b.md' }).phase, 'tool');
});

await report.check('S2', '优先级 stopping > compacting > pendingTool > lastType > 兼容布尔 > connecting', 'red', () => {
  const pt = { name: 'Read', input: { file_path: '/x/y.js' } };
  const all = { stopping: true, compacting: true, pendingTool: pt, lastType: 'text', text: true, thinking: true, sawModelOutput: false };
  assert.equal(liveStatusLabel(all).phase, 'stopping');
  assert.equal(liveStatusLabel({ ...all, stopping: false }).phase, 'compacting');
  assert.equal(liveStatusLabel({ ...all, stopping: false, compacting: false }).phase, 'tool');
  assert.equal(liveStatusLabel({ ...all, stopping: false, compacting: false, pendingTool: null }).phase, 'text');
  assert.equal(liveStatusLabel({ ...all, stopping: false, compacting: false, pendingTool: null, lastType: null }).phase, 'text');
  assert.equal(liveStatusLabel({ ...all, stopping: false, compacting: false, pendingTool: null, lastType: null, text: false }).phase, 'thinking');
  assert.equal(liveStatusLabel({ ...all, stopping: false, compacting: false, pendingTool: null, lastType: null, text: false, thinking: false }).phase, 'connecting');
  // lastType 压过整轮累计布尔(核心 Bug:前面出现过正文,最后一块是思考时不得显示「正在输出」)
  assert.deepEqual(liveStatusLabel({ lastType: 'thinking', lastThinkingText: '最后一块是思考', text: true }), { phase: 'thinking', verb: '思考', object: '最后一块是思考' });
  assert.deepEqual(liveStatusLabel({ lastType: 'tool', lastThinkingText: '', text: true }), { phase: 'thinking', verb: '思考', object: '' });
});

await report.check('S3', '工具阶段取该工具调用的标题(不带动词前缀),取不到才回落旧动词短语', 'red', () => {
  const cases = [
    ['Read', { file_path: '/Users/me/proj/section_06_02.md' }, '', '读取 section_06_02.md'],
    ['Edit', { file_path: '/a/b/App.jsx' }, '', '编辑 App.jsx'],
    ['MultiEdit', { file_path: 'rel/dir/x.py' }, '', '编辑 x.py'],
    // NotebookEdit 没有 toolTitle 分支(标题取不到)→ 回落旧动词短语,显示仍是「编辑 book.ipynb」
    ['NotebookEdit', { notebook_path: '/n/book.ipynb' }, '编辑', 'book.ipynb'],
    ['Write', { file_path: 'only.txt' }, '', '新建 only.txt'],
    ['Bash', { command: 'npm test', description: '跑单测' }, '', '跑单测'],
    ['Bash', { command: '\n  ls -la\nrm x' }, '', 'ls -la'],
    ['Bash', { command: 'echo hi', description: '   ' }, '', 'echo hi'],
    ['BashOutput', { bash_id: 'b1' }, '运行', ''],
    ['KillShell', { shell_id: 's1' }, '运行', ''],
    ['Grep', { pattern: 'useStore\\(' }, '', '搜索 useStore\\('],
    ['Glob', { pattern: '**/*.jsx' }, '', '查找文件 **/*.jsx'],
    ['WebFetch', { url: 'https://docs.example.com/a/b?q=1' }, '', '抓取 https://docs.example.com/a/b?q=1'],
    ['WebFetch', { url: 'not a url' }, '', '抓取 not a url'],
    ['WebSearch', { query: 'tauri updater' }, '', '搜索网页 tauri updater'],
    ['Task', { description: '查资料', prompt: 'p' }, '', '查资料'],
    ['Agent', { description: '写测试' }, '', '写测试'],
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
  // 动词表仍在(只需回落时用),且不可被改
  assert.equal(TOOL_VERBS.Read, '读取');
  assert.equal(TOOL_VERBS.TodoWrite, '更新任务清单');
  assert.ok(Object.isFrozen(TOOL_VERBS));
  // 原型链上的名字不当工具动词
  assert.deepEqual(tool('constructor', {}), { phase: 'tool', verb: '调用', object: 'constructor' });
});

await report.check('S4', '标题的 60 字符边界(按码点);路径分隔符 / 与 \\;空白折叠', 'red', () => {
  assert.equal(tool('Read', { file_path: 'C:\\Users\\me\\proj\\main.rs' }).object, '读取 main.rs');
  assert.equal(tool('Read', { file_path: 'C:/Users/me/mixed\\a.txt' }).object, '读取 a.txt');
  assert.equal(tool('Read', { file_path: '/a/dir/' }).object, '读取 dir');
  const s50 = 'a'.repeat(50);
  assert.equal(tool('Grep', { pattern: s50 }).object, `搜索 ${s50}`);
  assert.equal(tool('Grep', { pattern: s50 + 'bcd' }).object, `搜索 ${s50}bcd`);
  // 超过 60 个字符才截断,末位补一个省略号
  const longBash = tool('Bash', { command: 'x'.repeat(80) }).object;
  assert.equal(longBash, `${'x'.repeat(60)}…`);
  assert.equal(tool('WebSearch', { query: '查'.repeat(60) }).object, `搜索网页 ${'查'.repeat(55)}…`);
  // 恰好 60 个字符不截断
  const emo = '😀'.repeat(55);
  assert.equal(tool('WebSearch', { query: emo }).object, `搜索网页 ${emo}`);
  // 按码点截,emoji 不被切坏
  assert.equal(Array.from(tool('WebSearch', { query: '😀'.repeat(70) }).object).length, 61);
  assert.ok(!tool('WebSearch', { query: '😀'.repeat(70) }).object.includes('�'));
  // 入参自带的省略号原样保留(标题的省略号只作截断标记,不再全抹)
  assert.equal(tool('Task', { description: '处理中…' }).object, '处理中…');
  for (const name of Object.keys(TOOL_VERBS)) assert.ok(!TOOL_VERBS[name].includes('…'));
  // 换行与多空白折成单个空格
  assert.equal(tool('Task', { description: '甲\n\n乙   丙' }).object, '甲 乙 丙');
});

await report.check('S5', '空入参 / 非对象入参 / 缺字段时回落旧动词短语,object 为空串', 'red', () => {
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

await report.check('S6', 'latestThinkingPreview 取最新一句、只处理尾部、不拆小数 / 域名', 'red', () => {
  assert.equal(typeof latestThinkingPreview, 'function', 'streamStatus.js 应导出 latestThinkingPreview');
  // 非字符串 / 空 → null
  for (const v of [undefined, null, '', 42, {}, []]) assert.equal(latestThinkingPreview(v), null);
  // 多句 → 最后一句
  assert.equal(latestThinkingPreview('先看 A。再看 B。最后一句 C。'), '最后一句 C。');
  // 换行也算分段
  assert.equal(latestThinkingPreview('第一行内容\n第二行内容完整'), '第二行内容完整');
  // 全角句末标点
  for (const p of ['。', '！', '？', '；']) {
    assert.equal(latestThinkingPreview(`前面一句${p}最后一句内容`), '最后一句内容', `全角 ${p}`);
  }
  // 半角句末标点只在后面跟空白或结尾时切
  assert.equal(latestThinkingPreview('Done. Next step'), 'Next step');
  assert.equal(latestThinkingPreview('What? 真的确定了吗'), '真的确定了吗');
  assert.equal(latestThinkingPreview('End; next step'), 'next step');
  assert.equal(latestThinkingPreview('末尾有点.'), '末尾有点.');
  // 小数 / 域名 / 文件名不被切开
  assert.equal(latestThinkingPreview('圆周率是 3.14 左右'), '圆周率是 3.14 左右');
  assert.equal(latestThinkingPreview('访问 example.com/x 看看'), '访问 example.com/x 看看');
  assert.equal(latestThinkingPreview('打开 src/a.b.js 这个文件'), '打开 src/a.b.js 这个文件');
  // 最后一句不足 6 个字符且前面还有段 → 取前一段
  assert.equal(latestThinkingPreview('先做第一件事。好'), '先做第一件事。');
  assert.equal(latestThinkingPreview('长长的前一句。短'), '长长的前一句。');
  // 只有一句且很短 → 就取它
  assert.equal(latestThinkingPreview('嗯好'), '嗯好');
  // 超长思考只处理尾部:20 万字
  const huge = `${'很长的思考内容。'.repeat(30000)}最后一句在尾部。`;
  assert.ok(huge.length > 200000);
  assert.equal(latestThinkingPreview(huge), '最后一句在尾部。');
  // 仅末尾 600 个码元参与切段:前缀里的句号不影响
  const prefixed = `开头。${'x'.repeat(1000)}。尾巴句子在这里。`;
  assert.equal(latestThinkingPreview(prefixed), '尾巴句子在这里。');
  // 窗口切在代理对中间时丢弃半个字符,不产生孤立代理
  const emoji = `x${'😀'.repeat(400)}y`;
  const cut = latestThinkingPreview(emoji);
  assert.equal(typeof cut, 'string');
  assert.ok(!/^[\uDC00-\uDFFF]/.test(cut), '预览不应以孤立的低代理开头');
  assert.ok(!cut.includes('�'));
});

await report.check('S7', '工具入参未到时底部行沿用折叠行标题,不回落动词短语', 'red', () => {
  assert.equal(typeof latestToolTitles, 'function', 'streamStatus.js 应导出 latestToolTitles');
  // 入参未到(input:{}) + 上一条可用标题 → 用那个标题
  assert.deepEqual(
    liveStatusLabel({ pendingTool: { name: 'Bash', input: {} }, pendingTitle: '读取 a.txt' }),
    { phase: 'tool', verb: '', object: '读取 a.txt' },
  );
  assert.deepEqual(
    liveStatusLabel({ pendingTool: { name: 'Write', input: {} }, pendingTitle: '编辑 b.txt' }),
    { phase: 'tool', verb: '', object: '编辑 b.txt' },
  );
  assert.deepEqual(
    liveStatusLabel({ pendingTool: { name: 'Task', input: {} }, pendingTitle: 'Read' }),
    { phase: 'tool', verb: '', object: 'Read' },
  );
  // 入参到齐后 → 立刻换成真标题(即便还传着旧 pendingTitle)
  assert.deepEqual(
    liveStatusLabel({ pendingTool: { name: 'Bash', input: { command: 'ls', description: '列目录' } }, pendingTitle: '读取 a.txt' }),
    { phase: 'tool', verb: '', object: '列目录' },
  );
  // 入参已到、但取不到标题(TodoWrite)→ 照旧回落动词短语
  assert.deepEqual(
    liveStatusLabel({ pendingTool: { name: 'TodoWrite', input: { todos: [] } }, pendingTitle: 'TodoWrite' }),
    { phase: 'tool', verb: '更新任务清单', object: '' },
  );
  // 折叠行同一个函数:最后一个未返回的工具入参未到 → 沿用它之前最近一个入参已到的工具标题
  assert.deepEqual(
    latestToolTitles([
      { name: 'Read', input: { file_path: '/a/a.txt' }, result: {} },
      { name: 'Bash', input: {} },
    ]),
    { doneTitle: 'Bash', liveTitle: '读取 a.txt' },
  );
  // 此前没有任何工具 → 工具名
  assert.equal(latestToolTitles([{ name: 'Bash', input: {} }]).liveTitle, 'Bash');
  // 入参已到的工具 → 它自己的标题
  assert.equal(latestToolTitles([{ name: 'Bash', input: { command: 'ls', description: '列目录' }, result: null }]).liveTitle, '列目录');
  // 都有结果 → doneTitle
  assert.equal(latestToolTitles([{ name: 'TodoWrite', input: { todos: [] }, result: {} }]).liveTitle, 'TodoWrite');
});

process.exit(report.finish());
