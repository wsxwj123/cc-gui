#!/usr/bin/env node
// r111 契约测试:0.2.375 Windows 审查的必修 1 + 建议 2/3/4/5/6/7。
// 契约 .devflow/INTERFACE-r111-win-review-375.md 逐条。
//
// 必修那条的真实用户视角:Windows 上参数以反斜杠结尾很常见(资源管理器复制的目录路径
// `C:\Users\x\Documents\`、盘根 `D:\`、env 形态 `ROOT=D:\data\`)。r110 给每个 token 加引号后,
// 尾部的 `\` 和收尾引号连成 `\"` —— cmd 不管(引号数仍是偶数),但 node.exe 的 CRT 把它当
// "一个字面引号" → 引号不闭合 → 后面所有参数被并进同一个字符串。表现是莫名其妙的失败:
// `claude project purge -y D:\` 静默不生效、`--bg` 以反斜杠结尾的 prompt 吞掉后续 flag。
//
// Run: node tests/unit/check-r111-win-review-375.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const { winCmdSpawnSpec } = await import('../../server/utils/win-cmd.js');
const { renderAll, applyReadme, START_MARK, END_MARK } = await import('../../scripts/gen-changelog-md.mjs');

let pass = 0;
const fails = [];
function check(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fails.push(name); console.log(`  FAIL ${name}\n       ${String(e?.message || e).split('\n').slice(0, 6).join('\n       ')}`); }
}

const BIN = 'C:\\npm\\claude.cmd';
// 命令行里该 token 的形态(去掉外层引号和其它 token 后单看这一个)。
const tokenOf = (arg) => winCmdSpawnSpec(BIN, [arg], {}).args[3].slice(1, -1).split(' ').slice(1).join(' ');

console.log('\n§1 win-cmd:token 结尾的连续反斜杠翻倍');

check('A1 结尾 1 个 `\\` → 2 个(契约逐字:"ROOT=D:\\data\\\\")', () => {
  const line = winCmdSpawnSpec(BIN, ['-e', 'ROOT=D:\\data\\'], {}).args[3];
  assert.equal(line, `""${BIN}" "-e" "ROOT=D:\\data\\\\""`);
  assert.ok(line.includes('"ROOT=D:\\data\\\\"'), `尾反斜杠没翻倍:${line}`);
  // 反向:未翻倍的形态(`\` 紧贴收尾引号)不得出现 —— 那正是 CRT 眼里的转义引号。
  assert.equal(/[^\\]\\"/.test(line), false, `命令行里仍有 \\" 转义引号形态:${line}`);
});

check('A2 盘根 `D:\\` → `"D:\\\\"`', () => {
  assert.equal(tokenOf('D:\\'), '"D:\\\\"');
});

check('A3 结尾 2 个 `\\` → 4 个', () => {
  assert.equal(tokenOf('D:\\\\'), '"D:\\\\\\\\"');
});

check('A4 中间的反斜杠不动(C:\\a\\b 原样)', () => {
  assert.equal(tokenOf('C:\\a\\b'), '"C:\\a\\b"');
  assert.equal(winCmdSpawnSpec('C:\\a\\b\\claude.exe', [], {}).args[3], '""C:\\a\\b\\claude.exe""');
});

check('A5 不含反斜杠的 token 与 r110 逐字相同(元字符/空格/内嵌引号)', () => {
  const args = ['mcp<2', 'a&b', 'c|d', 'e^f', 'g>h', 'has space', 'say "hi"'];
  assert.equal(winCmdSpawnSpec(BIN, args, {}).args[3],
    `""${BIN}" "mcp<2" "a&b" "c|d" "e^f" "g>h" "has space" "say ""hi""""`);
});

check('A6 引号总数仍是偶数(cmd 的"删首尾引号"规则)', () => {
  for (const a of ['D:\\', 'D:\\\\', 'ROOT=D:\\data\\', 'C:\\a\\b']) {
    const line = winCmdSpawnSpec(BIN, [a], {}).args[3];
    assert.equal((line.match(/"/g) || []).length % 2, 0, `引号总数为奇数:${line}`);
  }
});

check('A7 文件头注释写明引号挡不住的两条(%VAR% 展开 / 换行截断)', () => {
  const src = read('server/utils/win-cmd.js');
  assert.match(src, /%VAR%/, '注释没提 %VAR% 在引号内照常展开');
  assert.match(src, /换行/, '注释没提换行处 cmd 截断整条命令');
});

// CRT 规则的另一半:紧邻**内嵌引号**前的反斜杠同样要翻倍。`a\"b` 里那个 `\` 会把我们用来
// 转义的 `""` 吃掉半个(2N+1 个 `\` + `"` = 字面引号,不切换引号状态)→ 引号状态错位,
// 后续参数被吞。MCP args 里 `--config "{\"k\":\"v\"}"` 就是这形态。
check('A8 反斜杠紧邻内嵌引号 → 一并翻倍(a\\"b → "a\\\\""b")', () => {
  assert.equal(tokenOf('a\\"b'), '"a\\\\""b"');
});

check('A9 两个反斜杠+内嵌引号(a\\\\"b → "a\\\\\\\\""b")', () => {
  assert.equal(tokenOf('a\\\\"b'), '"a\\\\\\\\""b"');
});

check('A10 token 以 `\\"` 结尾(最险:两条规则叠在一起)', () => {
  assert.equal(tokenOf('x\\"'), '"x\\\\"""');
});

check('A11 引号后跟反斜杠 a"\\ → "a""\\\\"(两条规则各管一段)', () => {
  assert.equal(tokenOf('a"\\'), '"a""\\\\"');
});

// 端到端复核:cmd 剥掉外层引号后,node.exe 的 CRT 必须把命令行还原成原始 argv。
// crtParse 是 UCRT parse_command_line 的复刻(2N \ + " → N \ 且切换引号态;2N+1 → N \ + 字面 ";
// 引号内 "" → 字面 " 且留在引号内)。
function crtParse(cmdline) {
  const out = []; let i = 0, inQ = false, cur = '', started = false;
  while (i < cmdline.length) {
    const c = cmdline[i];
    if (!inQ && (c === ' ' || c === '\t')) { if (started) { out.push(cur); cur = ''; started = false; } i++; continue; }
    started = true;
    let bs = 0; while (cmdline[i] === '\\') { i++; bs++; }
    if (cmdline[i] === '"') {
      let copy = true;
      if (bs % 2 === 0) {
        if (inQ && cmdline[i + 1] === '"') { i++; }
        else { copy = false; inQ = !inQ; }
      }
      bs = Math.floor(bs / 2);
      cur += '\\'.repeat(bs);
      if (copy) cur += '"';
      i++;
    } else { cur += '\\'.repeat(bs); if (i < cmdline.length) { cur += cmdline[i]; i++; } }
  }
  if (started) out.push(cur);
  return out;
}

check('A12 往返:cmd 剥外层引号后 CRT 还原出的 argv 与原始逐字相同', () => {
  const cases = [
    ['ROOT=D:\\data\\', '--', 'npx'],
    ['project', 'purge', '-y', 'D:\\'],
    ['D:\\a\\\\', 'next'],
    ['D:\\a\\\\\\', 'next'],
    ['\\', 'next'],
    ['C:\\a\\b', 'next'],
    ['', 'next'],
    ['mcp<2', 'a&b', 'has space', 'say "hi"', 'next'],
    ['"', 'next'],
    ['a\\"b', 'next'],
    ['a\\\\"b', 'next'],
    ['x\\"', 'next'],
    ['a"\\', 'next'],
    ['--config', '{\\"k\\":\\"v\\"}', 'next'],
  ];
  for (const args of cases) {
    const line = winCmdSpawnSpec(BIN, args, {}).args[3];
    // cmd.exe /s 只剥掉整条命令行的首尾引号,中间原样(cmd 不认反斜杠转义)。
    assert.ok(line.startsWith('"') && line.endsWith('"'), `外层引号没了:${line}`);
    assert.deepEqual(crtParse(line.slice(1, -1)), [BIN, ...args], `往返不一致:${JSON.stringify(args)} → ${line}`);
  }
});

console.log('\n§2 remote-control:winpty 回退路径给 cmd.exe 绝对路径');

check('B1 Windows 分支拼 %SystemRoot%\\System32\\cmd.exe(不靠 PATH)', () => {
  const src = read('server/routes/remote-control.js');
  assert.match(src, /join\(process\.env\.SystemRoot \|\| 'C:\\\\Windows', 'System32', 'cmd\.exe'\)/,
    'remote-control 没按绝对路径起 cmd.exe(winpty 把 file 当 lpApplicationName,不搜 PATH)');
  assert.match(src, /import \{ join, resolve \} from 'path';/, 'join 没从 path 导入');
  assert.match(src, /pty\.spawn\(ptyFile, ptyArgs,/, '解析出的绝对路径没交给 pty.spawn');
});

console.log('\n§3 gen-changelog-md:CRLF 检出的仓库(Windows autocrlf)');

// 临时目录复刻仓库结构:scripts/ 两个脚本 + CRLF 版 CHANGELOG/README。
// 临时目录不在 git 仓里 → gitTags() 返回 [],生成的是无链接版,README 照此写。
function crlfRepo({ stale = false } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cgui-r111-')));
  mkdirSync(join(dir, 'scripts'));
  for (const f of ['gen-changelog-md.mjs', 'gen-release-notes.mjs']) {
    copyFileSync(join(ROOT, 'scripts', f), join(dir, 'scripts', f));
  }
  const changelog = read('CHANGELOG.md').replace(/\r\n/g, '\n');
  const body = stale ? 'x' : renderAll(changelog, { tags: [] });
  const readme = applyReadme(`# T\n\n${START_MARK}\n\nplaceholder\n\n${END_MARK}\n`, body);
  const toCrlf = (s) => s.replace(/\n/g, '\r\n');
  writeFileSync(join(dir, 'CHANGELOG.md'), toCrlf(changelog));
  writeFileSync(join(dir, 'README.md'), toCrlf(readme));
  return { dir, script: join(dir, 'scripts', 'gen-changelog-md.mjs') };
}
const runAt = (script, dir, args) => {
  try { execFileSync(process.execPath, [script, ...args], { cwd: dir, encoding: 'utf8' }); return 0; }
  catch (e) { return e.status ?? 1; }
};

check('C1 CRLF 版 README/CHANGELOG:--check 退出码 0', () => {
  const { dir, script } = crlfRepo();
  assert.equal(runAt(script, dir, ['--check']), 0, 'CRLF 检出时 --check 仍红 —— 换行没归一');
});

check('C2 反向:同一 CRLF 副本里 README 过期 → --check 退出码 1(证明 C1 不是空过)', () => {
  const { dir, script } = crlfRepo({ stale: true });
  assert.equal(runAt(script, dir, ['--check']), 1, '过期的 README 居然算同步 —— 归一归过头了');
});

check('C3 --readme 写回保持 CRLF(不产生混合换行)', () => {
  const { dir, script } = crlfRepo({ stale: true });
  assert.equal(runAt(script, dir, ['--readme']), 0);
  const raw = readFileSync(join(dir, 'README.md'), 'utf8');
  assert.ok(raw.includes('\r\n'), '写回后 CRLF 全没了');
  assert.equal(/(^|[^\r])\n/.test(raw), false, '写回后出现裸 LF = 混合换行');
  assert.equal(runAt(script, dir, ['--check']), 0, '刚写回的 README 立刻 --check 应绿');
});

check('C4 LF 仓库写回仍是 LF(不给 mac/CI 引入 CRLF)', () => {
  const { dir, script } = crlfRepo({ stale: true });
  const lf = (s) => s.replace(/\r\n/g, '\n');
  writeFileSync(join(dir, 'README.md'), lf(readFileSync(join(dir, 'README.md'), 'utf8')));
  writeFileSync(join(dir, 'CHANGELOG.md'), lf(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8')));
  assert.equal(runAt(script, dir, ['--readme']), 0);
  assert.equal(/\r/.test(readFileSync(join(dir, 'README.md'), 'utf8')), false, 'LF 仓库被写成了 CRLF');
});

check('C5 .gitattributes 把 *.md 钉成 LF 检出', () => {
  assert.ok(existsSync(join(ROOT, '.gitattributes')), '仓库根没有 .gitattributes');
  assert.match(read('.gitattributes'), /^\*\.md text eol=lf$/m);
});

console.log('\n§4 CI release notes:Windows 只有 NSIS .exe');

check('D1 notes.md 不再写"`.msi` 均可"', () => {
  const yml = read('.github/workflows/tauri.yml');
  assert.equal(/`\.msi`\s*均可/.test(yml), false, 'notes.md 仍宣称提供 .msi(bundle.targets 里没有)');
  assert.match(yml, /\*\*Windows\*\*:`\.exe`(\(|(（))NSIS 安装程序/);
});

console.log('\n§5 agents.js:--bg prompt 长度上限 + 守卫注释');

check('E1 Windows 分支有 7000 字符上限,文案含当前长度', () => {
  const src = read('server/routes/agents.js');
  assert.match(src, /process\.platform === 'win32' && prompt\.length > 7000/);
  assert.match(src, /长度上限 7000 字符,当前 \$\{prompt\.length\} 字符/);
});

check('E2 原注入守卫逻辑一字未动,注释改成"纵深防御"', () => {
  const src = read('server/routes/agents.js');
  assert.match(src, /if \(process\.platform === 'win32' && !\/\\s\/\.test\(prompt\.trim\(\)\) && \/\[&\|<>\^\]\/\.test\(prompt\)\) \{/);
  assert.match(src, /纵深防御/, 'agents.js 守卫注释没更新');
});

check('E3 chat.js MODEL_ARG_RE 注释同源更新(白名单降级为纵深防御)', () => {
  const src = read('server/routes/chat.js');
  assert.match(src, /export const MODEL_ARG_RE = \/\^\[\\w\.:\\-\\\[\\\]\/\]\{1,128\}\$\//, '白名单本身被改动了');
  assert.match(src, /纵深防御/, 'chat.js 白名单注释没更新');
});

console.log('\n§6 claude-resolver:import 回到顶部 import 块');

check('F1 winCmdSpawnSpec 的 import 在第一个函数声明之前', () => {
  const src = read('server/utils/claude-resolver.js');
  const imp = src.indexOf("import { winCmdSpawnSpec } from './win-cmd.js';");
  const fn = src.indexOf('async function safeExecAsync');
  assert.ok(imp >= 0, 'import 没了');
  assert.ok(fn >= 0, 'safeExecAsync 没了');
  assert.ok(imp < fn, 'import 仍夹在函数声明中间');
});

console.log(`\n${pass} 通过 / ${fails.length} 失败`);
if (fails.length) { console.log(`失败:\n  - ${fails.join('\n  - ')}`); process.exit(1); }
console.log('✅ r111 契约测试全过');
