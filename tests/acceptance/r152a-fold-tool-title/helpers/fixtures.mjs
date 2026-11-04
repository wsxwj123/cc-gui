// r152a-fold-tool-title 验收套件的会话夹具（全部落在本套件 .artifacts/runtime-data 下，不读用户 profile）。
// 记录形态照抄 stripfold-20260913 的夹具（那份逐字抄自真实转写）；内容是自造的。
//
// 五条会话（每个用例读自己的，互不共享可变状态；直播用例 B8 会往 H 里追加，所以 H 只给 B8 用，且每次跑前重建）：
//   T：B1  标题清洗（description 的空白 / 反引号 / 60 字符边界 / emoji 边界 / markdown 记号）
//   M：B2 B4 B5 B6 B7  Bash 回退 / 末块是思考 / 纯思考与子代理卡 / 长标题 / 展开收起
//   R：B3  逐种工具的标题
//   E：B11 入参异常（错误契约）
//   H：B8  两个历史回合（直播回合要和它们同页）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function suitePath(...parts) { return path.join(suiteDir, ...parts); }
export function dataRoot() { return suitePath('.artifacts', 'runtime-data'); }
export function homeDir() { return path.join(dataRoot(), 'home'); }
export function guiConfigDir() { return path.join(homeDir(), '.claude-gui'); }
export function workspaceDir() { return path.join(dataRoot(), 'fixture-workspace'); }
export function fakebinDir() { return suitePath('.artifacts', 'fakebin'); }
export function fakeCtlDir() { return path.join(homeDir(), 'fake-claude'); }
export function manifestPath() { return suitePath('.artifacts', 'fixture-manifest.json'); }
export const PROJECT_NAME = 'fixture-workspace';

export const SESSIONS = {
  t: { sid: 'a1520001-0000-4000-8000-0000000000a1', marker: 'R152AMARKTITLE' },
  m: { sid: 'a1520002-0000-4000-8000-0000000000a2', marker: 'R152AMARKMISC' },
  r: { sid: 'a1520003-0000-4000-8000-0000000000a3', marker: 'R152AMARKTOOLS' },
  e: { sid: 'a1520004-0000-4000-8000-0000000000a4', marker: 'R152AMARKERROR' },
  h: { sid: 'a1520005-0000-4000-8000-0000000000a5', marker: 'R152AMARKHIST' },
  // B9 / B10 各用一条自己的“有一个历史回合”的会话来续写直播回合（侧栏“新建会话”那条路在本实例里不稳：标题生成会往侧栏塞临时项目）
  l9: { sid: 'a1520006-0000-4000-8000-0000000000a6', marker: 'R152AMARKLIVENINE' },
  l10: { sid: 'a1520007-0000-4000-8000-0000000000a7', marker: 'R152AMARKLIVETEN' },
  // ── r152c-head-desktop 追加（只增不改）──
  // ch = 只读的历史回合会话（C1/C2/C3/C11 与各用例的历史回合部分共用，用例不往里写）；
  // cl4…cl10 = 各直播用例各自的会话（直播回合会往转写里追加，所以每条直播用例独占一条，互不共用）。
  ch: { sid: 'a1520101-0000-4000-8000-0000000000c1', marker: 'R152CMARKHIST' },
  cl4: { sid: 'a1520104-0000-4000-8000-0000000000c4', marker: 'R152CMARKLIVEFOUR' },
  cl5: { sid: 'a1520105-0000-4000-8000-0000000000c5', marker: 'R152CMARKLIVEFIVE' },
  cl7: { sid: 'a1520107-0000-4000-8000-0000000000c7', marker: 'R152CMARKLIVESEVEN' },
  cl8: { sid: 'a1520108-0000-4000-8000-0000000000c8', marker: 'R152CMARKLIVEEIGHT' },
  cl9: { sid: 'a1520109-0000-4000-8000-0000000000c9', marker: 'R152CMARKLIVENINE' },
  cl10: { sid: 'a1520110-0000-4000-8000-0000000000ca', marker: 'R152CMARKLIVETEN2' },
};

// 块构造：th 思考 / tx 正文 / tl 工具（input 原样写进转写，异常形态也照写）
const th = (text) => ({ k: 'think', text });
const tx = (text) => ({ k: 'text', text });
const tl = (name, input) => ({ k: 'tool', name, input });
/** 一轮 = 用户话术 + 块序列；expect = 这一轮折叠条末尾应得的值；text 是定位这一轮用的收官正文。 */
const rd = (key, blocks, expect) => ({ key, blocks, expect, anchor: `R152A-${key} 收尾。` });
const withEnd = (key, blocks, expect) => rd(key, [...blocks, tx(`R152A-${key} 收尾。`)], expect);

const D60 = '0123456789'.repeat(6);
export const TITLE_ROWS = [
  withEnd('T1', [th('T1 思考内容不该出现在折叠条末尾。'), tl('Bash', { command: 'ls', description: '整理工作区里的临时文件' })], '整理工作区里的临时文件'),
  withEnd('T2', [th('T2 思考内容。'), tl('Bash', { command: 'ls', description: '\n  先看  \n 一眼\t现场  \n' })], '先看 一眼 现场'),
  withEnd('T3', [th('T3 思考内容。'), tl('Bash', { command: 'ls', description: '运行 `npm test` 并检查输出' })], '运行 npm test 并检查输出'),
  withEnd('T4', [th('T4 思考内容。'), tl('Bash', { command: 'ls', description: D60 })], D60),
  withEnd('T5', [th('T5 思考内容。'), tl('Bash', { command: 'ls', description: `${D60}X` })], `${D60}…`),
  withEnd('T6', [th('T6 思考内容。'), tl('Bash', { command: 'ls', description: `${'x'.repeat(59)}🙂${'y'.repeat(10)}` })], `${'x'.repeat(59)}🙂…`),
  withEnd('T7', [th('T7 思考内容。'), tl('Bash', { command: 'ls', description: '**加粗** 与 `代码` 和 ~~删~~ 与 *强* 的记号都该剥掉。' })], '加粗 与 代码 和 删 与 强 的记号都该剥掉。'),
  withEnd('T8', [th('T8 思考内容。'), tl('Bash', { command: 'ls', description: '零散记号 foo_bar_baz 2*3*4 x**2 + y**2 原样。' })], '零散记号 foo_bar_baz 2*3*4 x**2 + y**2 原样。'),
  withEnd('T9', [th('T9 思考内容。'), tl('Read', { file_path: '/a/b/c.txt', description: '读取配置说明（非 Bash 也以 description 为先）' })], '读取配置说明（非 Bash 也以 description 为先）'),
];

export const TOOL_ROWS = [
  ['Read /a/b/c.txt', tl('Read', { file_path: '/a/b/c.txt' }), '读取 c.txt'],
  ['Read C:\\x\\y.ts', tl('Read', { file_path: 'C:\\x\\y.ts' }), '读取 y.ts'],
  ['Edit', tl('Edit', { file_path: '/p/q/edit-me.js', old_string: 'a', new_string: 'b' }), '编辑 edit-me.js'],
  ['Write', tl('Write', { file_path: '/p/q/new-file.md', content: 'hello' }), '新建 new-file.md'],
  ['Grep', tl('Grep', { pattern: 'foo', path: '/p' }), '搜索 foo'],
  ['Glob', tl('Glob', { pattern: '*.md' }), '查找文件 *.md'],
  ['WebFetch', tl('WebFetch', { url: 'https://example.com/docs', prompt: 'x' }), '抓取 https://example.com/docs'],
  ['WebSearch', tl('WebSearch', { query: 'claude code hooks' }), '搜索网页 claude code hooks'],
  ['其它工具带 summary', tl('CustomTool', { summary: '自定义工具的摘要' }), '自定义工具的摘要'],
  ['未知工具无字段', tl('MysteryTool', {}), 'MysteryTool'],
  ['MCP 工具无字段', tl('mcp__srv__do_thing', {}), 'do_thing'],
  ['Read 缺 file_path', tl('Read', {}), 'Read'],
  ['MultiEdit', tl('MultiEdit', { file_path: '/p/q/multi.ts', edits: [] }), '编辑 multi.ts'],
].map(([label, tool, expect], i) => ({ ...withEnd(`R${i + 1}`, [th(`R${i + 1} 思考内容。`), tool], expect), label }));

export const ERROR_ROWS = [
  ['入参是字符串', tl('Bash', 'echo hi'), ['Bash']],
  ['入参是数组', tl('Read', ['/a/b.txt']), ['Read']],
  ['入参是 null', tl('Grep', null), ['Grep']],
  ['字段类型不对（数字）', tl('Bash', { description: 123, command: 456 }), ['Bash']],
  ['字段是对象 / 数组', tl('Glob', { pattern: { x: 1 }, description: ['a'] }), ['Glob']],
  ['MCP 工具入参是字符串', tl('mcp__srv__do_other', 'oops'), ['do_other']],
  // 契约把 description 里的奇怪字符也归入“入参异常”，但没写死是原样显示还是退回工具名：两种都合规，其它都不合规。
  ['description 带 HTML 字符', tl('Bash', { description: '<script>window.__r152a_xss=1</script>' }), ['<script>window.__r152a_xss=1</script>', 'Bash']],
].map(([label, tool, expectAny], i) => ({ ...withEnd(`E${i + 1}`, [th(`E${i + 1} 思考内容。`), tool], expectAny[0]), label, expectAny }));

export const LONG_THINK = 'R152A 这一轮只有思考没有工具：先把问题拆成三步，读配置、改入口、再跑一遍全部测试确认没有回归。';
export const LONG_TITLE = '这是一个特别特别长的工具描述，用来确认折叠条在窄窗口下仍然只占一行并且用省略号收尾。'.repeat(2);
const cp = (s, n) => [...s].slice(0, n).join('');
const sub = (name, label) => tl(name, { subagent_type: 'fixer', description: label, prompt: '改一处' });

/** 会话 M 的各轮（B2 / B4 / B5 / B6 / B7 各取自己的）。M9 最后一块是思考、没有收官正文，必须排在最后。 */
export const MISC = {
  b2a: withEnd('M1', [th('M1 思考。'), tl('Bash', { command: 'npm run build\nnpm test' })], 'npm run build'),
  b2b: withEnd('M2', [th('M2 思考。'), tl('Bash', { description: '   \n\t ', command: '\n\n   git status --short   \necho done' })], 'git status --short'),
  b2c: withEnd('M3', [th('M3 思考。'), tl('Bash', {})], 'Bash'),
  b5thinkOnly: withEnd('M4', [th('M4 第一条思考：不该出现在末尾。'), th(LONG_THINK)], `${cp(LONG_THINK, 40)}…`),
  b5cardThenBash: withEnd('M5', [
    th('M5 思考。'), tl('Bash', { command: 'ls', description: '卡片前的 Bash 甲' }),
    sub('Task', 'R152A 子代理卡标题甲'), tl('Bash', { command: 'ls', description: '卡片后的 Bash 甲' }),
  ], '卡片后的 Bash 甲'),
  b5cardLast: withEnd('M6', [
    tl('Bash', { command: 'ls', description: '卡片前的 Bash 乙' }), sub('Agent', 'R152A 子代理卡标题乙'),
    th('M6 卡片之后的思考不该成为末尾。'),
  ], '卡片前的 Bash 乙'),
  b6long: withEnd('M7', [th('M7 思考。'), tl('Bash', { command: 'ls', description: LONG_TITLE })], `${cp(LONG_TITLE, 60)}…`),
  b7toggle: withEnd('M8', [th('M8 思考。'), tl('Bash', { command: 'ls', description: '展开收起用的标题' })], '展开收起用的标题'),
  b4lastThink: rd('M9', [
    th('M9 思考一。'), tl('Bash', { command: 'ls', description: 'M9 甲标题' }), th('M9 思考二。'),
    tl('Read', { file_path: '/x/y/b4-read.txt' }), th('M9 最后一块是思考。'),
  ], '读取 b4-read.txt'),
};
const MISC_ORDER = ['b2a', 'b2b', 'b2c', 'b5thinkOnly', 'b5cardThenBash', 'b5cardLast', 'b6long', 'b7toggle', 'b4lastThink'];

export const HIST_ROWS = [
  withEnd('H1', [th('H1 思考。'), tl('Bash', { command: 'ls', description: '历史回合甲' })], '历史回合甲'),
  withEnd('H2', [th('H2 思考。'), tl('Bash', { command: 'ls', description: '历史回合乙' })], '历史回合乙'),
];

// ── r152c-head-desktop 追加（只增不改）：会话 ch 的各轮 ─────────────────────────────
// c1a/c1b/c1c：有通用工具（Bash 带 description，含清洗）；c2：整轮只有思考；c3：唯一的思考块是纯空白；
// c11long/c11short：超长标题 vs 短标题（同页比较折叠条高度）。标题清洗后最多 60 个字符 + …，普通汉字 60 个只有约 700–820px，
// 放得进 1600 宽窗口的折叠条（约 1060px）；所以长标题用三倍长破折号 ⸻（U+2E3B，宽 3em）：90 个清洗成 60 个 + …，
// 在 WebKit 里实测约 1900–2200px，两档窗口都放不下。
export const C_ROWS = {
  c1a: withEnd('C1a', [th('C1a 思考内容不该出现在折叠条里。'), tl('Bash', { command: 'ls', description: '整理工作区里的临时文件' })], '整理工作区里的临时文件'),
  c1b: withEnd('C1b', [th('C1b 思考内容。'), tl('Bash', { command: 'ls', description: '运行 `npm test` 并检查输出' })], '运行 npm test 并检查输出'),
  c1c: withEnd('C1c', [th('C1c 思考内容。'), tl('Bash', { command: 'ls', description: '\n  先看  \n 一眼\t现场  \n' })], '先看 一眼 现场'),
  c2: withEnd('C2', [th('C2 第一条思考：不该出现在折叠条里。'), th(LONG_THINK)], `${cp(LONG_THINK, 40)}…`),
  c3: withEnd('C3', [th('   \n\t  ')], null),
  c11long: withEnd('C11L', [th('C11L 思考。'), tl('Bash', { command: 'ls', description: '⸻'.repeat(90) })], `${'⸻'.repeat(60)}…`),
  c11short: withEnd('C11S', [th('C11S 思考。'), tl('Bash', { command: 'ls', description: '短标题' })], '短标题'),
};
const C_HIST_ROWS = Object.values(C_ROWS);

// ── 记录构造（形状同 stripfold 夹具）────────────────────────────────────────
const ISO = (min, sec = 0) => new Date(Date.UTC(2026, 9, 30, 9, min, sec)).toISOString();
function encodeProjectDir(cwd) { return cwd.replace(/[/\\]/g, '-'); }
export function projectDir() { return path.join(homeDir(), '.claude', 'projects', encodeProjectDir(workspaceDir())); }
function sessionFile(sid) { return path.join(projectDir(), `${sid}.jsonl`); }
const base = (sid, cwd) => ({
  parentUuid: null, isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid,
  version: '2.1.267', gitBranch: 'fix/r152a-fold-tool-title',
});

function writeSession(key, rounds) {
  const { sid, marker } = SESSIONS[key];
  const cwd = workspaceDir();
  const lines = [{ type: 'summary', summary: `${marker} r152a 夹具`, leafUuid: `r152a-leaf-${key}` }];
  rounds.forEach((round, n) => {
    const m = (k) => ISO(n * 2 + Math.floor(k / 50), k % 50);
    lines.push({
      ...base(sid, cwd), promptId: 'r152a-prompt', type: 'user', isMeta: false,
      message: { role: 'user', content: `${n === 0 ? `${marker} ` : ''}第 ${n + 1} 轮：${round.key}` },
      uuid: `r152a-u-${key}-${n}`, timestamp: m(0), permissionMode: 'default', promptSource: 'sdk',
    });
    round.blocks.forEach((b, k) => {
      const id = `r152a_${key}_${n}_${k}`;
      const block = b.k === 'think' ? { type: 'thinking', thinking: b.text, signature: 'r152a-sig' }
        : b.k === 'text' ? { type: 'text', text: b.text }
          : { type: 'tool_use', id: `toolu_${id}`, name: b.name, input: b.input };
      lines.push({
        ...base(sid, cwd),
        message: {
          model: 'claude-sonnet-4-6', id, type: 'message', role: 'assistant', content: [block],
          stop_reason: b.k === 'tool' ? 'tool_use' : 'end_turn', stop_sequence: null, stop_details: null,
          usage: { input_tokens: 120, output_tokens: 34, cache_read_input_tokens: 5120, cache_creation_input_tokens: 340 },
        },
        apiBlockIndex: 0, requestId: `req_${id}`, type: 'assistant', uuid: `r152a-a-${id}`, timestamp: m(k + 1), effort: 'high',
      });
      if (b.k === 'tool') {
        lines.push({
          ...base(sid, cwd), promptId: 'r152a-prompt', type: 'user', isMeta: false, toolUseResult: '（夹具）输出',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${id}`, content: '（夹具）输出' }] },
          uuid: `r152a-tr-${id}`, timestamp: m(k + 1), toolUseID: `toolu_${id}`,
        });
      }
    });
  });
  let prev = null; // 真实转写是一条 uuid 链；回滚 / 裁剪类历史操作要看它
  const out = lines.map((l) => {
    const line = { ...l };
    if (prev !== null && 'parentUuid' in line) line.parentUuid = prev;
    if (line.uuid) prev = line.uuid;
    return line;
  });
  fs.mkdirSync(path.dirname(sessionFile(sid)), { recursive: true });
  fs.writeFileSync(sessionFile(sid), `${out.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

/** 首启浮层的「已看过」（与被测行为无关，与 stripfold / r64 套件同一套做法）。 */
function writeOverlayState() {
  const version = JSON.parse(fs.readFileSync(suitePath('..', '..', '..', 'package.json'), 'utf8')).version;
  fs.mkdirSync(guiConfigDir(), { recursive: true });
  fs.writeFileSync(path.join(guiConfigDir(), 'prefs.json'), `${JSON.stringify({ releaseNotesSeen: version })}\n`);
  fs.writeFileSync(path.join(guiConfigDir(), 'permission-guide-shown.flag'), `${new Date().toISOString()}\n`);
}

/** PATH 上的假 claude：一个 shell 薄壳，转交给本套件 helpers/fake-claude.mjs。 */
function writeFakeClaudeShim() {
  fs.mkdirSync(fakebinDir(), { recursive: true });
  const shim = path.join(fakebinDir(), 'claude');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${path.join(suiteDir, 'helpers', 'fake-claude.mjs')}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
}

/** 每次都整套重建（会话很小；直播用例会往 H 里追加，不重建的话第二遍就脏了）。 */
export function ensureFixtures() {
  fs.mkdirSync(workspaceDir(), { recursive: true });
  fs.mkdirSync(projectDir(), { recursive: true });
  fs.mkdirSync(fakeCtlDir(), { recursive: true });
  writeOverlayState();
  writeFakeClaudeShim();
  writeSession('t', TITLE_ROWS);
  writeSession('m', MISC_ORDER.map((k) => MISC[k]));
  writeSession('r', TOOL_ROWS);
  writeSession('e', ERROR_ROWS);
  writeSession('h', HIST_ROWS);
  writeSession('l9', [withEnd('L9', [th('L9 思考。'), tl('Bash', { command: 'ls', description: 'L9 历史回合' })], 'L9 历史回合')]);
  writeSession('l10', [withEnd('L10', [th('L10 思考。'), tl('Bash', { command: 'ls', description: 'L10 历史回合' })], 'L10 历史回合')]);
  writeSession('ch', C_HIST_ROWS);
  for (const k of ['cl4', 'cl5', 'cl7', 'cl8', 'cl9', 'cl10']) {
    writeSession(k, [withEnd(`CL${k}`, [th(`${k} 思考。`), tl('Bash', { command: 'ls', description: `${k} 历史回合` })], `${k} 历史回合`)]);
  }
  const manifest = {
    dataRoot: dataRoot(), home: homeDir(), workspace: workspaceDir(), fakebin: fakebinDir(), fakeCtl: fakeCtlDir(),
    sessions: Object.fromEntries(Object.entries(SESSIONS).map(([k, v]) => [k, v.sid])),
    markers: Object.fromEntries(Object.entries(SESSIONS).map(([k, v]) => [k, v.marker])),
  };
  fs.mkdirSync(path.dirname(manifestPath()), { recursive: true });
  fs.writeFileSync(manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.stdout.write(`${JSON.stringify(ensureFixtures(), null, 2)}\n`);
}
