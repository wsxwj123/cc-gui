#!/usr/bin/env node
// r110 契约测试(黑盒):Windows 经 cmd.exe 调用 claude.cmd 时的参数引号。
//
// 真实用户视角:Windows 上 npm 装的 claude 是 claude.cmd,添加 paper-search MCP 时参数里有
// `mcp<2`(uvx 的版本约束,合法参数)。旧写法把参数原样拼进 cmd.exe 命令行 → `<2` 被 cmd 当成
// "从名为 2 的文件读 stdin" → cmd 报 "The system cannot find the file specified."、claude 根本
// 没被执行 → runMcpAdd 把这句 stderr 原文抛给前端,用户看到一句莫名其妙的报错。
//
// 契约 .devflow/INTERFACE-r110-claude-cmd-quoting.md §6 逐条。
// Run: node tests/unit/check-r110-claude-cmd-quoting.mjs
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { claudeExecSpec, claudeCommand } = await import('../../server/utils/claude-resolver.js');
const { winCmdSpawnSpec } = await import('../../server/utils/win-cmd.js');
const mcp = await import('../../server/routes/mcp.js');

let pass = 0;
const fails = [];
function check(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fails.push(name); console.log(`  FAIL ${name}\n       ${String(e?.message || e).split('\n').slice(0, 6).join('\n       ')}`); }
}

// paper-search 预设(client/src/utils/builtinMcpServers.js)展开后交给 `claude mcp add` 的原参数。
const CMD_BIN = 'C:\\Users\\x\\AppData\\Roaming\\npm\\claude.cmd';
const EXE_BIN = 'C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
const PAPER_ARGS = ['mcp', 'add', 'paper-search-mcp', '--', 'uvx', '--with', 'mcp<2',
  '--from', 'paper-search-mcp', 'python', '-m', 'paper_search_mcp.server'];

console.log('\n§6-1 claude.cmd:经 cmd.exe 且 mcp<2 落在自己的引号内');

check('T1 file=cmd.exe / 前三项 /d /s /c / opts 带 windowsVerbatimArguments', () => {
  const s = claudeExecSpec(CMD_BIN, PAPER_ARGS, 'win32');
  assert.equal(s.file, 'cmd.exe');
  assert.deepEqual(s.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(s.args.length, 4, 'verbatim 形态恒为 4 项(整条命令行是最后一项)');
  assert.equal(s.opts.windowsVerbatimArguments, true);
});

check('T2 `mcp<2` 带引号出现,且整条首尾各一个外层引号', () => {
  const line = claudeExecSpec(CMD_BIN, PAPER_ARGS, 'win32').args[3];
  assert.ok(line.includes('"mcp<2"'), `mcp<2 没被自己的引号包住:${line}`);
  assert.equal(line[0], '"', '缺外层起始引号');
  assert.equal(line[line.length - 1], '"', '缺外层收尾引号');
  // 逐字期望:cmd 拿到这条时 `<` 在引号内不做重定向,claude 收到的仍是 mcp<2
  const expected = '"' + ['"' + CMD_BIN + '"', ...PAPER_ARGS.map((a) => `"${a}"`)].join(' ') + '"';
  assert.equal(line, expected);
});

check('T3 反向:`<2` 不会以裸形态出现在命令行里(那正是 cmd 的重定向)', () => {
  const line = claudeExecSpec(CMD_BIN, PAPER_ARGS, 'win32').args[3];
  // 裸重定向 = `<` 前面是空格(token 起始)。加了引号后 `<` 前面必是 `p`(mcp<2)。
  assert.equal(/\s</.test(line), false, `命令行里出现裸重定向:${line}`);
});

console.log('\n§6-2 .exe 与非 Windows 分支不受影响');

check('T4 .exe → 直接执行该 exe、args 原样、opts 不含 windowsVerbatimArguments', () => {
  const s = claudeExecSpec(EXE_BIN, PAPER_ARGS, 'win32');
  assert.equal(s.file, EXE_BIN);
  assert.deepEqual(s.args, PAPER_ARGS);
  assert.equal('windowsVerbatimArguments' in s.opts, false);
});

check('T5 darwin → file 即 bin、args 原样、opts 不含 windowsVerbatimArguments', () => {
  const s = claudeExecSpec('/usr/local/bin/claude', PAPER_ARGS, 'darwin');
  assert.equal(s.file, '/usr/local/bin/claude');
  assert.deepEqual(s.args, PAPER_ARGS);
  assert.equal('windowsVerbatimArguments' in s.opts, false);
});

check('T5b 空 bin 回落 claude:win32 仍经 cmd.exe,darwin 直跑 claude', () => {
  const w = claudeExecSpec('', ['--version'], 'win32');
  assert.equal(w.file, 'cmd.exe');
  assert.equal(w.args[3], '""claude" "--version""', '无扩展名 shim / 裸名同样要经 cmd.exe');
  assert.equal(claudeExecSpec('', ['--version'], 'darwin').file, 'claude');
});

console.log('\n§6-3 claudeCommand 带 opts');

check('T6 claudeCommand(["--version"]) 返回 { file, args, opts } 三件套', () => {
  const c = claudeCommand(['--version']);
  assert.ok('opts' in c, 'claudeCommand 没返回 opts —— 消费者无从把 verbatim 并进 execFile 选项');
  assert.equal(typeof c.opts, 'object');
  assert.notEqual(c.opts, null);
  assert.equal(typeof c.file, 'string');
  assert.ok(Array.isArray(c.args));
});

console.log('\n§6-4 元字符逐个:全部落在自己的引号内、内嵌引号翻倍');

check('T7 & | ^ > < 空格 内嵌" 各一例', () => {
  const args = ['a&b', 'c|d', 'e^f', 'g>h', 'i<j', 'has space', 'say "hi"'];
  const line = claudeExecSpec(CMD_BIN, args, 'win32').args[3];
  assert.equal(line,
    `""${CMD_BIN}" "a&b" "c|d" "e^f" "g>h" "i<j" "has space" "say ""hi""""`,
    '元字符/空格/内嵌引号的逐字形态不符');
  for (const a of ['a&b', 'c|d', 'e^f', 'g>h', 'i<j', 'has space']) {
    assert.ok(line.includes(`"${a}"`), `${a} 没被自己的引号包住`);
  }
  // 引号成对:cmd 的"删首尾引号"规则要求整条引号数为偶数,单个落单就会把命令行拆坏
  assert.equal((line.match(/"/g) || []).length % 2, 0, '引号总数不是偶数');
});

check('T8 claudeExecSpec 与 winCmdSpawnSpec 同源(不是两套引号规则)', () => {
  assert.deepEqual(claudeExecSpec(CMD_BIN, PAPER_ARGS, 'win32'), winCmdSpawnSpec(CMD_BIN, PAPER_ARGS, {}));
});

check('T9 mcp.js 继续 re-export 同名 winCmdSpawnSpec(r108 锁定测试的导入口径)', () => {
  assert.equal(typeof mcp.winCmdSpawnSpec, 'function');
  assert.equal(mcp.winCmdSpawnSpec, winCmdSpawnSpec, 're-export 的应是同一个函数,不是复制一份');
});

console.log('\n§6-5 反向:server 目录下不再有旧拼法');

check('T10 server/ 里不存在 `spawn(\'cmd.exe\', [\'/c\'` 或 `[\'/c\', `', () => {
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.(js|mjs|cjs)$/.test(name)) continue;
      const src = readFileSync(full, 'utf8');
      src.split('\n').forEach((l, i) => {
        if (l.includes("spawn('cmd.exe', ['/c'") || l.includes("['/c', ")) {
          hits.push(`${full.slice(ROOT.length + 1)}:${i + 1}: ${l.trim()}`);
        }
      });
    }
  };
  walk(join(ROOT, 'server'));
  assert.deepEqual(hits, [], `旧拼法残留(Windows 上这些调用点仍吃 < > | & ^):\n       ${hits.join('\n       ')}`);
});

console.log('\n§2 消费者接线:opts 必须被并进各自的 spawn/execFile 选项');

// 漏一处 = Windows 上那条路仍然吃元字符,且只有真机能发现 → 用源码断言逐个钉住。
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

check('T11 claudeCommand 的四个消费者都把 opts 并进了 execFile 选项', () => {
  for (const [rel, needle] of [
    ['server/routes/mcp.js', /const \{ file, args: fullArgs, opts: execOpts \} = claudeCommand\(args\);/],
    ['server/routes/agents.js', /execFileP\(file, fullArgs, \{ timeout: 6000, \.\.\.execOpts \}\)/],
    ['server/routes/subscription-usage.js', /execFileP\(file, args, \{ timeout: 5000, \.\.\.execOpts \}\)/],
    ['server/routes/remote-control.js', /execOpts\?\.windowsVerbatimArguments \? args\.join\(' '\) : args/],
  ]) assert.ok(needle.test(read(rel)), `${rel} 没把 claudeCommand 的 opts 用起来`);
  // mcp.js 两处 execFileP(runClaude / runMcpAdd)都要带
  const mcpSrc = read('server/routes/mcp.js');
  assert.equal((mcpSrc.match(/\.\.\.execOpts/g) || []).length, 2, 'mcp.js 的 runClaude / runMcpAdd 应各带一处 ...execOpts');
});

check('T12 探测链路(prompt-cache-env 同步+异步、logSdkClaudeOnce)都透传 spec.opts', () => {
  const pce = read('server/utils/prompt-cache-env.js');
  assert.ok(/execFileSync\(spec\.file, spec\.args, \{ timeout: 2000, encoding: 'utf8', \.\.\.spec\.opts \}\)/.test(pce), '同步 --help 探测没带 spec.opts');
  assert.ok(/execFile\(spec\.file, spec\.args, \{ timeout: 8000, encoding: 'utf8', \.\.\.spec\.opts \}/.test(pce), '异步 --help 探测没带 spec.opts');
  const rs = read('server/utils/claude-resolver.js');
  assert.ok(/safeExecAsync\(spec\.file, spec\.args, 8000, spec\.opts\)/.test(rs), 'logSdkClaudeOnce 的 --version 探测没带 spec.opts');
  assert.ok(/async function safeExecAsync\(file, args, timeout = 5000, extra = \{\}\)/.test(rs), 'safeExecAsync 没有第四参');
  assert.ok(/execFileP\(file, args, \{ timeout, \.\.\.extra \}\)/.test(rs), 'safeExecAsync 的 extra 没并进 execFileP 选项');
});

check('T13 claudeSpawn 的 .cmd 分支经 winCmdSpawnSpec(聊天这条路同样吃元字符)', () => {
  const chat = read('server/routes/chat.js');
  const body = chat.slice(chat.indexOf('export function claudeSpawn'), chat.indexOf('// Windows 残留 NUL 文件清扫'));
  assert.ok(/const s = winCmdSpawnSpec\(resolved, finalArgs, opts\);/.test(body), '.cmd 分支没走 winCmdSpawnSpec');
  assert.ok(/const proc = spawn\(s\.file, s\.args, s\.opts\);/.test(body), '没把 spec 三件套交给 spawn');
  assert.ok(/tempFiles\.length/.test(body), '临时文件清理逻辑被改掉了');
  assert.ok(/\n  return spawn\(resolved \|\| 'claude', args, opts\);/.test(body), '非 Windows 分支被改动');
});

console.log(`\n${pass} 通过 / ${fails.length} 失败`);
if (fails.length) { console.log(`失败:\n  - ${fails.join('\n  - ')}`); process.exit(1); }
console.log('✅ r110 契约测试全过');
