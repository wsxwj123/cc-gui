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
  assert.deepEqual(resolveWinCommand('uvx', { env, liveDirs: [] }), { file: uvx, viaCmd: false });
});

check('② 全都没有 → 返回 null(不瞎猜),文案是人话不是 ENOENT', () => {
  assert.equal(resolveWinCommand('definitely-not-installed', { env, liveDirs: [] }), null);
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
  assert.equal(resolveWinCommand('uvx', { env, liveDirs: [live] })?.file, inLive, 'liveDirs 未优先');
});

check('④ 目录顺序优先于扩展名;同一目录内 .exe > .cmd > .bat', () => {
  const d = join(root, 'order');
  touch(d, 'tool.bat'); touch(d, 'tool.cmd');
  assert.deepEqual(resolveWinCommand('tool', { env, liveDirs: [d] }), { file: join(d, 'tool.cmd'), viaCmd: true }, '.cmd 应优先于 .bat');
  const exe = touch(d, 'tool.exe');
  assert.deepEqual(resolveWinCommand('tool', { env, liveDirs: [d] }), { file: exe, viaCmd: false }, '.exe 应最优先');
  // 靠前目录里的 .bat 要赢过靠后目录里的 .exe(目录优先级 > 扩展名优先级)
  const first = join(root, 'ord-a'), second = join(root, 'ord-b');
  const bat = touch(first, 'both.bat'); touch(second, 'both.exe');
  assert.deepEqual(resolveWinCommand('both', { env, liveDirs: [first, second] }), { file: bat, viaCmd: true });
});

check('⑤ .cmd/.bat 经 cmd.exe /c 起(Node 拒绝直跑批处理)', () => {
  const d = join(root, 'cmdonly');
  const cmd = touch(d, 'npx.cmd');
  assert.deepEqual(resolveWinCommand('npx', { env, liveDirs: [d] }), { file: cmd, viaCmd: true });
  assert.ok(/const viaCmd = hit \? hit\.viaCmd : /.test(src) && /if \(viaCmd\) return spawn\('cmd\.exe', \['\/c', resolved/.test(src),
    'spawnMcpCommand 没按 viaCmd 包 cmd.exe /c');
});

check('⑥ Python Scripts 的版本号目录靠枚举命中(%LOCALAPPDATA% 与 %APPDATA% 两处)', () => {
  const a = touch(env.LOCALAPPDATA, 'Programs', 'Python', 'Python312', 'Scripts', 'mcp-server-fetch.exe');
  assert.equal(resolveWinCommand('mcp-server-fetch', { env, liveDirs: [] })?.file, a);
  const b = touch(env.APPDATA, 'Python', 'Python311', 'Scripts', 'pipx-tool.exe');
  assert.equal(resolveWinCommand('pipx-tool', { env, liveDirs: [] })?.file, b);
});

check('⑦ 其余候选:%APPDATA%\\npm、~\\scoop\\shims、~\\.cargo\\bin', () => {
  const npmTool = touch(env.APPDATA, 'npm', 'npm-tool.cmd');
  const scoopTool = touch(home, 'scoop', 'shims', 'scoop-tool.exe');
  const cargoTool = touch(home, '.cargo', 'bin', 'cargo-tool.exe');
  assert.deepEqual(resolveWinCommand('npm-tool', { env, liveDirs: [] }), { file: npmTool, viaCmd: true });
  assert.equal(resolveWinCommand('scoop-tool', { env, liveDirs: [] })?.file, scoopTool);
  assert.equal(resolveWinCommand('cargo-tool', { env, liveDirs: [] })?.file, cargoTool);
});

check('⑧ 已是路径的命令原样放行(不当裸名再解析一遍)', () => {
  assert.equal(resolveWinCommand('C:\\tools\\uvx.exe', { env, liveDirs: [] }), null);
  assert.equal(resolveWinCommand('./local/uvx', { env, liveDirs: [] }), null);
  assert.equal(resolveWinCommand('', { env, liveDirs: [] }), null);
});

check('⑨ existsSync/readdirSync 全注入也成立(不落地真文件)', () => {
  const want = join('C:/Users/me/.local/bin', 'uvx.exe');
  const hit = resolveWinCommand('uvx', {
    env: { USERPROFILE: 'C:/Users/me' },
    existsSync: (p) => p === want,
    readdirSync: () => { throw new Error('no such dir'); }, // 枚举失败不能炸整条解析
    liveDirs: [],
  });
  assert.deepEqual(hit, { file: want, viaCmd: false });
});

check('⑪ 脏入参不抛:liveDirs 非数组/含非字符串、env 缺键、readdirSync 抛错', () => {
  const d = join(root, 'dirty');
  const exe = touch(d, 'dirty-tool.exe');
  for (const bad of [null, undefined, 'not-an-array', 42, {}]) {
    assert.equal(resolveWinCommand('dirty-tool', { env, liveDirs: bad }), null, `liveDirs=${String(bad)} 应被忽略而非抛错`);
  }
  assert.equal(resolveWinCommand('dirty-tool', { env, liveDirs: [null, 42, {}, d] })?.file, exe, '非法项应跳过、合法项照旧命中');
  // env 缺键(空对象 / null)只是没候选目录,不能抛
  assert.equal(resolveWinCommand('uvx', { env: {}, liveDirs: [] }), null);
  assert.equal(resolveWinCommand('uvx', { env: null, liveDirs: [d] }), null);
  assert.equal(resolveWinCommand('dirty-tool', { env: {}, liveDirs: [d] })?.file, exe);
});

check('⑫ 扩展名大小写不敏感(盘上是 UVX.EXE 也认)', () => {
  const d = join(root, 'upper');
  const exe = touch(d, 'UPTOOL.EXE');
  assert.deepEqual(resolveWinCommand('uptool', { env, liveDirs: [d] }), { file: exe, viaCmd: false });
  const d2 = join(root, 'upper2');
  const bat = touch(d2, 'BTOOL.CMD');
  assert.deepEqual(resolveWinCommand('btool', { env, liveDirs: [d2] }), { file: bat, viaCmd: true }, '大写 .CMD 也要标 viaCmd');
});

check('⑩ Windows 三坑:不用 wmic;探测参数不含内嵌双引号', () => {
  assert.ok(!/\bwmic\b/.test(src), 'mcp.js 出现 wmic(Win11 24H2 已移除)');
  assert.ok(/execFileP\('where', \[command\]/.test(src), 'where 探测参数被拼成字符串了');
});

rmSync(root, { recursive: true, force: true });
if (failed) { console.error(`\n❌ r106 MCP 命令解析自测 ${failed} 项失败`); process.exit(1); }
console.log('\n✅ r106 MCP 命令解析自测全绿');
