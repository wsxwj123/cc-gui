#!/usr/bin/env node
// r106 开发自测:Windows 上 MCP 命令解析(server/routes/mcp.js)。
// 根因:GUI 后端的 PATH 是启动时快照,uv 装在 %USERPROFILE%\.local\bin 常不在其中 →
// `where uvx` 落空 → 原样 spawn('uvx') → ENOENT("The system cannot find the file specified")。
// 变异哨兵:把 resolveWinCommand 的候选目录列表砍空 → "PATH 没有但 .local\bin 有"必红。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWinCommand, missingCommandHint } from '../../server/routes/mcp.js';

const src = readFileSync(new URL('../../server/routes/mcp.js', import.meta.url), 'utf8');
const root = mkdtempSync(join(tmpdir(), 'cgui-r106-mcp-'));
const home = join(root, 'Users', 'me');
const env = {
  USERPROFILE: home,
  APPDATA: join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: join(home, 'AppData', 'Local'),
};
const touch = (...seg) => {
  const p = join(...seg);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, 'MZ');
  return p;
};

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

check('① PATH 里没有、%USERPROFILE%\\.local\\bin\\uvx.exe 有 → 命中它(uv 的默认落点)', () => {
  const uvx = touch(home, '.local', 'bin', 'uvx.exe');
  assert.equal(resolveWinCommand('uvx', { env, liveDirs: [] }), uvx);
});

check('② 全都没有 → 返回 ""(不瞎猜),文案是人话不是 ENOENT', () => {
  assert.equal(resolveWinCommand('definitely-not-installed', { env, liveDirs: [] }), '');
  const msg = missingCommandHint('uvx', 'win32');
  assert.ok(msg.includes('找不到命令 uvx'), msg);
  assert.ok(/绝对路径/.test(msg) && /PATH/.test(msg), msg);
  assert.ok(msg.includes('C:\\Users\\<你>\\.local\\bin\\uvx.exe'), 'Windows 例子路径缺失');
  assert.ok(!/ENOENT|cannot find the file/i.test(msg), '还在甩原始 ENOENT');
  assert.ok(!/"/.test(msg), '文案里不该有双引号(会混进 execFile 参数)');
});

check('③ 注册表实时 PATH(liveDirs)优先于固定候选', () => {
  const live = join(root, 'live-dir');
  const inLive = touch(live, 'uvx.exe');
  assert.equal(resolveWinCommand('uvx', { env, liveDirs: [live] }), inLive, 'liveDirs 未优先');
});

check('④ 同目录内 .exe > .cmd > .bat', () => {
  const d = join(root, 'order');
  touch(d, 'tool.bat'); touch(d, 'tool.cmd');
  assert.equal(resolveWinCommand('tool', { env, liveDirs: [d] }), join(d, 'tool.cmd'), '.cmd 应优先于 .bat');
  const exe = touch(d, 'tool.exe');
  assert.equal(resolveWinCommand('tool', { env, liveDirs: [d] }), exe, '.exe 应最优先');
});

check('⑤ .cmd/.bat 经 cmd.exe /c 起(Node 拒绝直跑批处理)', () => {
  const d = join(root, 'cmdonly');
  const cmd = touch(d, 'npx.cmd');
  assert.equal(resolveWinCommand('npx', { env, liveDirs: [d] }), cmd);
  assert.ok(/if \(\/\\\.\(cmd\|bat\)\$\/i\.test\(resolved\)\) return spawn\('cmd\.exe', \['\/c', resolved/.test(src),
    'spawnMcpCommand 没把 .cmd/.bat 包进 cmd.exe /c');
});

check('⑥ Python Scripts 的版本号目录靠枚举命中(%LOCALAPPDATA% 与 %APPDATA% 两处)', () => {
  const a = touch(env.LOCALAPPDATA, 'Programs', 'Python', 'Python312', 'Scripts', 'mcp-server-fetch.exe');
  assert.equal(resolveWinCommand('mcp-server-fetch', { env, liveDirs: [] }), a);
  const b = touch(env.APPDATA, 'Python', 'Python311', 'Scripts', 'pipx-tool.exe');
  assert.equal(resolveWinCommand('pipx-tool', { env, liveDirs: [] }), b);
});

check('⑦ 其余候选:%APPDATA%\\npm、~\\scoop\\shims、~\\.cargo\\bin', () => {
  const npmTool = touch(env.APPDATA, 'npm', 'npm-tool.cmd');
  const scoopTool = touch(home, 'scoop', 'shims', 'scoop-tool.exe');
  const cargoTool = touch(home, '.cargo', 'bin', 'cargo-tool.exe');
  assert.equal(resolveWinCommand('npm-tool', { env, liveDirs: [] }), npmTool);
  assert.equal(resolveWinCommand('scoop-tool', { env, liveDirs: [] }), scoopTool);
  assert.equal(resolveWinCommand('cargo-tool', { env, liveDirs: [] }), cargoTool);
});

check('⑧ 已是路径的命令原样放行(不当裸名再解析一遍)', () => {
  assert.equal(resolveWinCommand('C:\\tools\\uvx.exe', { env, liveDirs: [] }), '');
  assert.equal(resolveWinCommand('./local/uvx', { env, liveDirs: [] }), '');
  assert.equal(resolveWinCommand('', { env, liveDirs: [] }), '');
});

check('⑨ existsSync/readdirSync 全注入也成立(不落地真文件)', () => {
  const want = join('C:/Users/me/.local/bin', 'uvx.exe');
  const hit = resolveWinCommand('uvx', {
    env: { USERPROFILE: 'C:/Users/me' },
    existsSync: (p) => p === want,
    readdirSync: () => { throw new Error('no such dir'); }, // 枚举失败不能炸整条解析
    liveDirs: [],
  });
  assert.equal(hit, want);
});

check('⑩ Windows 三坑:不用 wmic;探测参数不含内嵌双引号', () => {
  assert.ok(!/\bwmic\b/.test(src), 'mcp.js 出现 wmic(Win11 24H2 已移除)');
  assert.ok(/execFileP\('where', \[command\]/.test(src), 'where 探测参数被拼成字符串了');
});

rmSync(root, { recursive: true, force: true });
if (failed) { console.error(`\n❌ r106 MCP 命令解析自测 ${failed} 项失败`); process.exit(1); }
console.log('\n✅ r106 MCP 命令解析自测全绿');
