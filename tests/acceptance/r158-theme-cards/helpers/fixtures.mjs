// r158-theme-cards 验收套件的会话夹具（全部落在本套件 .artifacts/runtime-data 下，不读用户 profile）。
// 记录形态抄自 r157-live-line 的夹具（只读参考）；内容按 .devflow/r158-theme-cards-接口.md「夹具：一个历史回合」自造。
// 会话只读（用例不往里发消息），所以不同用例可以共用同一条；需要往里发消息的直播会话（l9 / l10）各自独占。
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

// h = 主夹具（历史回合：接口文件夹具表里除第 9 项以外的 10 项 + 回合末尾正文）。第 9 项（运行中）历史转写里造不出：
// 探路结果 —— 历史回合里没有结果的工具调用，界面一律当「已停止」（data-entry-state=stopped），所以第 10 项 = 没有结果的 Bash；
// 第 9 项只能在直播回合里造（工具已发出、一直没返回），用 f* 会话：历史内容同 h，打开后再发一条消息，假 claude 发出 sleep 999 且不返回。
// f4 / f5 / f6 / f15 = B4 / B5 / B6 / B15 各一条；ft0…ft6 = 七个主题各一条；e2 = 错误契约 E2（Edit 参数还在传输）；x = 附加夹具。
export const KEYS = ['h', 'x', 'f4', 'f5', 'f6', 'f15', 'e2', ...Array.from({ length: 7 }, (_, i) => `ft${i}`)];
export const SESSIONS = Object.fromEntries(KEYS.map((k, i) => [k, {
  sid: `a1580${String(i + 1).padStart(3, '0')}-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
  marker: `R158MARK${k.toUpperCase()}X`, // 以 X 收尾：不会是别的 marker 的子串
}]));

export const END_ANCHOR = 'R158 回合末尾正文。';
export const END_ANCHOR_X = 'R158 附加夹具收尾。';
export const LONG_DESC = '这是一个故意写得非常长的工具描述用来检验卡头标题在窄屏下是否被截断而不是把整个页面撑宽或者把右侧信息挤到下一行去';
export const LONG_CMD = `echo ${'x'.repeat(160)}`;

// 28 行 python（每行都有可见字符：折叠按「可见文字行」数行，空行会让数行失真）。
export const PY_LINES = [
  'import json', 'from pathlib import Path', 'def load_refs(path):', '    """读取参考文献表。"""', '    refs = []',
  '    for line in Path(path).read_text().splitlines():', '        if not line.strip() or line.startswith("#"):', '            continue',
  '        key, _, rest = line.partition(":")', '        refs.append({"key": key.strip(), "text": rest.strip()})', '    return refs',
  'def normalise_unit(value):', '    # 统一剂量单位', '    table = {"mg/L": 1000.0, "ug/L": 1.0}', '    return table.get(value, 0.0)',
  'def summarise(refs):', '    counts = {}', '    for r in refs:', '        counts[r["key"]] = counts.get(r["key"], 0) + 1', '    return counts',
  'if __name__ == "__main__":', '    refs = load_refs("refs.txt")', '    total = sum(1 for r in refs if r["key"])',
  '    print(json.dumps(refs, ensure_ascii=False))', '    print("total:", total)', '    for r in refs[:3]:', '        print(normalise_unit(r["key"]))', '    print(summarise(refs))',
];
if (PY_LINES.length !== 28) throw new Error(`PY_LINES 应为 28 行，实为 ${PY_LINES.length}`);
export const PY_CODE = PY_LINES.join('\n');
export const BASH_LONG_LINE = `curl -sS "https://example.org/api/v1/items?query=${'x'.repeat(200)}" -H "Accept: application/json"`;
export const BASH_CODE = ['echo start', BASH_LONG_LINE, 'echo done'].join('\n');

// 回合末尾正文：三级标题 / 两条列表 / 引用 / 表格 / 行内代码 / python / bash / html / 坏 JSON 的 cgui-ui。
export const END_TEXT = [
  END_ANCHOR, '', '### 三级标题', '', '- 列表项甲', '- 列表项乙', '', '> 这是一段引用文字。', '',
  '| 列甲 | 列乙 | 列丙 |', '| --- | --- | --- |', '| 甲1 | 乙1 | 丙1 |', '| 甲2 | 乙2 | 丙2 |', '| 甲3 | 乙3 | 丙3 |', '',
  '行内代码 `foo()` 在这一段里。', '', '```python', PY_CODE, '```', '', '```bash', BASH_CODE, '```', '',
  '```html', '<h3 style="margin:0">HTML 预览</h3><p>演示段落</p>', '```', '', '```cgui-ui', '{"items":[', '```', '',
].join('\n');

export const EDIT_OLD = '其中 barium 的暴露剂量单位写成了 mg/L,与原文不符。\n暴露组血压显著降低(p = 0.07)。';
export const EDIT_NEW = '其中 barium 的暴露剂量单位应为 µg/L,已按原文更正。\n暴露组血压呈下降趋势(p = 0.07,未达显著)。';
export const GREP_MARKS = ['暴露组样本', '对照组样本', '剂量单位', '检出限值'];
export const WEB_MD = '# 示例页面摘要\n\n- 要点甲\n- 要点乙';
export const BASH2_RESULT = "Exit code 1\nFAILED tests/test_refs.py::test_unit_normalised - AssertionError\n  assert '17' in refs_with_issues\n1 failed, 11 passed in 3.04s";


/** 接口文件夹具表的 11 项（res 缺省 = 没有结果）。 */
export function items() {
  return [
    { name: 'Bash', input: { command: 'ls -la /tmp/ws', description: '列出目录' }, res: { text: 'a1\na2\na3\na4\na5\na6' } },
    { name: 'Bash', input: { command: 'pytest tests/test_refs.py -q' }, res: { text: BASH2_RESULT, isError: true } },
    { name: 'Read', input: { file_path: '/tmp/ws/section.md' }, res: { text: Array.from({ length: 12 }, (_, i) => `L${i + 1}`).join('\n') } },
    { name: 'Edit', input: { file_path: '/tmp/ws/section.md', old_string: EDIT_OLD, new_string: EDIT_NEW }, res: { text: 'The file /tmp/ws/section.md has been updated.' } },
    { name: 'Write', input: { file_path: '/tmp/ws/new.txt', content: 'n1\nn2\nn3' }, res: { text: 'File created successfully at: /tmp/ws/new.txt' } },
    { name: 'Grep', input: { pattern: 'barium', path: '/tmp/ws' }, res: { text: ['/tmp/ws/a.md:3:barium 暴露组样本', '/tmp/ws/a.md:9:barium 对照组样本', '/tmp/ws/b.md:2:barium 剂量单位', '/tmp/ws/c.md:7:barium 检出限值'].join('\n') } },
    { name: 'WebFetch', input: { url: 'https://example.org/a', prompt: '摘要' }, res: { text: WEB_MD } },
    { name: 'mcp__demo__search', input: { query: 'x' }, res: { text: 'found 3' } },
    { name: 'Bash', input: { command: 'echo stopped' }, },
    { name: 'NotebookEdit', input: { a: 1 }, res: { text: 'ok' } },
  ];
}
/** 附加夹具 x：依次 = 无输出的成功 Bash / 取不到 Exit code 的失败 Bash / 超长命令 + 超长描述的 Bash。 */
export function itemsX() {
  return [
    { name: 'Bash', input: { command: 'true' }, res: { text: '' } },
    { name: 'Bash', input: { command: 'cat /nope' }, res: { text: 'cat: /nope: No such file or directory', isError: true } },
    { name: 'Bash', input: { command: LONG_CMD, description: LONG_DESC }, res: { text: 'ok' } },
  ];
}
function turnFor(key) {
  // r158 主会话修订（折叠行去箭头）：主夹具的回合开头加一个思考块，让「思考折叠行」也在被检查的折叠行里。
  if (key === 'h' || /^f/.test(key)) return { think: 'R158 思考一行预览。', items: items(), endText: END_TEXT };
  if (key === 'x') return { items: itemsX(), endText: END_ANCHOR_X };
  return { items: [], endText: `R158 ${key} 历史回合收尾。` };
}

const ISO = (min, sec = 0) => new Date(Date.UTC(2026, 10, 5, 9, min, sec)).toISOString();
const encodeProjectDir = (cwd) => cwd.replace(/[/\\]/g, '-');
export function projectDir() { return path.join(homeDir(), '.claude', 'projects', encodeProjectDir(workspaceDir())); }
const sessionFile = (sid) => path.join(projectDir(), `${sid}.jsonl`);
const base = (sid, cwd) => ({
  parentUuid: null, isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid,
  version: '2.1.267', gitBranch: 'feature/r158-theme-cards',
});
const USAGE = { input_tokens: 120, output_tokens: 34, cache_read_input_tokens: 5120, cache_creation_input_tokens: 340 };

function writeSession(key) {
  const { sid, marker } = SESSIONS[key];
  const cwd = workspaceDir();
  const turn = turnFor(key);
  const lines = [{ type: 'summary', summary: `${marker} r158 夹具`, leafUuid: `r158-leaf-${key}` }];
  lines.push({
    ...base(sid, cwd), promptId: 'r158-prompt', type: 'user', isMeta: false,
    message: { role: 'user', content: `${marker} 第 1 轮：历史` },
    uuid: `r158-u-${key}`, timestamp: ISO(0), permissionMode: 'default', promptSource: 'sdk',
  });
  const blocks = [...(turn.think ? [{ k: 'think', text: turn.think }] : []), ...turn.items.map((it) => ({ k: 'tool', ...it })), { k: 'text', text: turn.endText }];
  blocks.forEach((b, k) => {
    const id = `r158_${key}_${k}`;
    const block = b.k === 'text' ? { type: 'text', text: b.text }
      : b.k === 'think' ? { type: 'thinking', thinking: b.text, signature: 'r158-sig' }
        : { type: 'tool_use', id: `toolu_${id}`, name: b.name, input: b.input };
    lines.push({
      ...base(sid, cwd),
      message: {
        model: 'claude-sonnet-4-6', id, type: 'message', role: 'assistant', content: [block],
        stop_reason: b.k === 'text' ? 'end_turn' : 'tool_use', stop_sequence: null, stop_details: null, usage: USAGE,
      },
      apiBlockIndex: 0, requestId: `req_${id}`, type: 'assistant', uuid: `r158-a-${id}`, timestamp: ISO(0, k + 1), effort: 'high',
    });
    if (b.k === 'tool' && b.res) {
      lines.push({
        ...base(sid, cwd), promptId: 'r158-prompt', type: 'user', isMeta: false, toolUseResult: b.res.tur !== undefined ? b.res.tur : b.res.text,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${id}`, content: b.res.text, ...(b.res.isError ? { is_error: true } : {}) }] },
        uuid: `r158-tr-${id}`, timestamp: ISO(0, k + 1), toolUseID: `toolu_${id}`,
      });
    }
  });
  let prev = null; // 真实转写是一条 uuid 链
  const out = lines.map((l) => {
    const line = { ...l };
    if (prev !== null && 'parentUuid' in line) line.parentUuid = prev;
    if (line.uuid) prev = line.uuid;
    return line;
  });
  fs.mkdirSync(path.dirname(sessionFile(sid)), { recursive: true });
  fs.writeFileSync(sessionFile(sid), `${out.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

/** 首启浮层的「已看过」（与被测行为无关，与同批其它验收套件同一套做法）。 */
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

/** 每次整套重建（直播用例会往转写里追加，不重建的话第二遍就脏了）。 */
export function ensureFixtures() {
  fs.mkdirSync(workspaceDir(), { recursive: true });
  fs.mkdirSync(projectDir(), { recursive: true });
  fs.mkdirSync(fakeCtlDir(), { recursive: true });
  writeOverlayState();
  writeFakeClaudeShim();
  for (const k of KEYS) writeSession(k);
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
