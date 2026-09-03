#!/usr/bin/env node
// r106:Windows 上 npm 装的 claude 让 SDK 回落自带旧 CLI(缓存命中忽高忽低)+ MCP 命令找不到文件。
//
// 本文件是【黑盒验收测试】:只依据 .devflow/BRIEF-r106-windows-npm-sdk-exe.md 与主会话定的
// 三条契约写,写的时候没看实现(源码只 grep 过 '^export')。三部分:
//   A. resolveSdkClaudeFrom(hitPath, { platform, existsSync, readFileSync })  —— 真 import 真跑
//   B. resolveWinCommand(command, { env, existsSync, readdirSync, liveDirs }) —— 真 import 真跑
//   C. 面板文案锁(JSX 进不了 node,只能读文件做结构断言;不写死文件名,按锚点字串扫)
//
// 设计要点:
//  * 纯函数部分用【动态 import + 逐条 try/catch】。静态 import 一个还不存在的导出会在 ESM
//    链接阶段直接抛错、后面一条断言都跑不到;改前必须"每条各自红",才看得出到底缺哪几件。
//  * Windows 布局全在临时目录里造,platform 与 fs 一律注入;反斜杠寻址那一轮用翻译版 fs,
//    这一轮红 = 实现偷偷用了真实 fs / 用 posix path 拆了反斜杠路径。
//  * HOME/USERPROFILE 在 import 前改到临时沙箱,本测试绝不读写真实 ~/.claude*。
//
// Run: node tests/unit/check-r106-windows-npm-sdk-exe.mjs
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync,
  existsSync as realExistsSync, readFileSync as realReadFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = mkdtempSync(join(tmpdir(), 'cgui-r106-'));

// 沙箱 HOME:claude-resolver 里若有读 ~/.claude-gui 的路径,一律落到临时目录,不碰真实家目录。
const REAL_HOME = process.env.HOME;
const REAL_USERPROFILE = process.env.USERPROFILE;
const SANDBOX_HOME = join(TMP, 'home');
mkdirSync(SANDBOX_HOME, { recursive: true });
process.env.HOME = SANDBOX_HOME;
process.env.USERPROFILE = SANDBOX_HOME;

let PASS = 0;
let FAILS = 0;
const failed = [];
function check(name, fn) {
  try {
    fn();
    PASS++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    FAILS++;
    failed.push(name);
    const msg = String((e && e.message) || e).split('\n').slice(0, 4).join('\n      ');
    console.log(`  ✗ ${name}\n      ${msg}`);
  }
}

// 路径比较一律"分隔符不敏感":实现在 win32 分支里可能用 path.win32 拼出反斜杠。
const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/{2,}/g, '/');
const toBs = (p) => String(p).replace(/\//g, '\\');
const unBs = (p) => (typeof p === 'string' ? p.replace(/\\/g, '/') : p);

// ══════════════════════════════════════════════════════════════════════════
// A. resolveSdkClaudeFrom —— server/utils/claude-resolver.js
// ══════════════════════════════════════════════════════════════════════════
console.log('\n[A] resolveSdkClaudeFrom(hitPath, { platform, existsSync, readFileSync })');

let RES = null;
let RESERR = '';
try {
  RES = await import('../../server/utils/claude-resolver.js');
} catch (e) {
  RESERR = String((e && e.message) || e);
}
const resolveSdkClaudeFrom = RES?.resolveSdkClaudeFrom;

// ── fixture:Windows npm 平铺布局(<prefix>\claude.cmd + <prefix>\node_modules\@anthropic-ai\claude-code\bin\claude.exe)
const mkNpm = (name, binKind) => {
  const npmDir = join(TMP, name);
  const pkg = join(npmDir, 'node_modules', '@anthropic-ai', 'claude-code');
  mkdirSync(join(pkg, 'bin'), { recursive: true });
  writeFileSync(join(pkg, 'install.cjs'), '// bootstrap installer\n');
  writeFileSync(join(pkg, 'cli.js'), '// cli entry\n');
  writeFileSync(join(npmDir, 'claude.cmd'),
    '@echo off\r\nnode "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n');
  writeFileSync(join(npmDir, 'claude'), '#!/bin/sh\nexec node "$basedir/node_modules/@anthropic-ai/claude-code/cli.js" "$@"\n');
  const exe = join(pkg, 'bin', 'claude.exe');
  if (binKind === 'pe') writeFileSync(exe, Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64)]));
  else if (binKind === 'text') writeFileSync(exe, '#!/usr/bin/env node\nconsole.error("native binary not installed; run install.cjs");\n');
  else if (binKind === 'empty') writeFileSync(exe, Buffer.alloc(0));
  return { npmDir, pkg, exe, shimCmd: join(npmDir, 'claude.cmd'), shimBare: join(npmDir, 'claude') };
};

const good = mkNpm('npm-good', 'pe');       // postinstall 成功:真 PE
const stub = mkNpm('npm-stub', 'text');     // 壳包半途而废:bin 还是 ASCII 假启动器
const gone = mkNpm('npm-missing', null);    // postinstall 根本没跑:bin 目标不存在
const zero = mkNpm('npm-empty', 'empty');   // 下载中断:0 字节

// 原生安装(路径里没有 npm 布局)
mkdirSync(join(TMP, 'native'), { recursive: true });
writeFileSync(join(TMP, 'native', 'claude.cmd'), '@echo off\r\n');
const nativeShim = join(TMP, 'native', 'claude.cmd');
// 已经是 .exe 的命中项(好的 / 坏的各一份)
mkdirSync(join(TMP, 'already'), { recursive: true });
const hitExeGood = join(TMP, 'already', 'claude.exe');
writeFileSync(hitExeGood, Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64)]));
const hitExeBad = join(TMP, 'already', 'broken.exe');
writeFileSync(hitExeBad, '#!/usr/bin/env node\n');
// 大写扩展名(Windows 文件名大小写不敏感)
const hitExeUpper = join(good.npmDir, 'claude.EXE');
writeFileSync(hitExeUpper, Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64)]));

// 注入版 fs:计数,用来证明实现真的走注入而不是偷偷用真实 fs
let fsCalls = 0;
const winOpts = () => ({
  platform: 'win32',
  existsSync: (p) => { fsCalls++; return realExistsSync(p); },
  readFileSync: (p, ...rest) => { fsCalls++; return realReadFileSync(p, ...rest); },
});
// 反斜杠寻址:把 \ 翻回 / 再落到真实 fs(mac 上文件只能用正斜杠找到)
const bsOpts = {
  platform: 'win32',
  existsSync: (p) => realExistsSync(unBs(p)),
  readFileSync: (p, ...rest) => realReadFileSync(unBs(p), ...rest),
};
const macOpts = {
  platform: 'darwin',
  existsSync: (p) => realExistsSync(p),
  readFileSync: (p, ...rest) => realReadFileSync(p, ...rest),
};

check('A0 claude-resolver.js 可 import', () => {
  assert.ok(RES, `import 失败:${RESERR}`);
});
check('A0 resolveSdkClaudeFrom 已导出且是函数', () => {
  assert.equal(typeof resolveSdkClaudeFrom, 'function');
});

check('A1 win32 + npm\\claude.cmd + 真 PE → 返回包内 bin\\claude.exe(正斜杠寻址)', () => {
  const r = resolveSdkClaudeFrom(good.shimCmd, winOpts());
  assert.equal(typeof r, 'string', `应返回 exe 路径字符串,实得 ${JSON.stringify(r)}`);
  assert.equal(norm(r), norm(good.exe));
  assert.ok(norm(r).endsWith('node_modules/@anthropic-ai/claude-code/bin/claude.exe'));
  assert.notEqual(norm(r), norm(good.shimCmd), '不能原样把 .cmd shim 交给 SDK');
});
check('A2 同一布局用反斜杠寻址 → 同一个 exe(实现必须按注入 platform 拆路径,不许用 posix path)', () => {
  const r = resolveSdkClaudeFrom(toBs(good.shimCmd), bsOpts);
  assert.equal(typeof r, 'string', `反斜杠路径下应返回 exe,实得 ${JSON.stringify(r)}`);
  assert.equal(norm(r), norm(good.exe));
});
check('A3 注入的 existsSync/readFileSync 真的被调用(不许绕过注入直接用真实 fs)', () => {
  fsCalls = 0;
  resolveSdkClaudeFrom(good.shimCmd, winOpts());
  assert.ok(fsCalls > 0, '一次注入 fs 都没调用 = 判定用的是真实 fs,Windows 上无法被测也无法被控');
});
check('A4 无扩展名 shim(npm\\claude)同样推出 bin\\claude.exe', () => {
  const r = resolveSdkClaudeFrom(good.shimBare, winOpts());
  assert.equal(norm(r), norm(good.exe));
});
check('A5 bin\\claude.exe 是文本占位(坏壳包)→ null(保持 SDK 回落,不能交个跑不起来的壳)', () => {
  assert.strictEqual(resolveSdkClaudeFrom(stub.shimCmd, winOpts()), null);
});
check('A6 bin\\claude.exe 缺失(postinstall 没跑)→ null', () => {
  assert.strictEqual(resolveSdkClaudeFrom(gone.shimCmd, winOpts()), null);
});
check('A7 bin\\claude.exe 是 0 字节(下载中断)→ null', () => {
  assert.strictEqual(resolveSdkClaudeFrom(zero.shimCmd, winOpts()), null);
});
check('A8 win32 但路径里没有 npm 布局(原生安装的 claude.cmd)→ null', () => {
  assert.strictEqual(resolveSdkClaudeFrom(nativeShim, winOpts()), null);
});
check('A9 win32 且命中项已是 .exe → 原样返回(=== 入参,不改写不推导)', () => {
  assert.strictEqual(resolveSdkClaudeFrom(hitExeGood, winOpts()), hitExeGood);
});
check('A10 win32 且命中项已是 .exe(哪怕内容是文本)→ 仍原样返回(契约:已是 .exe 就不体检)', () => {
  assert.strictEqual(resolveSdkClaudeFrom(hitExeBad, winOpts()), hitExeBad);
});
check('A11 darwin → 原样返回入参(即使同目录下真有 npm 布局的 claude.exe 也绝不改写)', () => {
  assert.strictEqual(resolveSdkClaudeFrom(good.shimCmd, macOpts), good.shimCmd);
});
check('A12 linux → 原样返回入参', () => {
  const r = resolveSdkClaudeFrom(good.shimCmd, { ...macOpts, platform: 'linux' });
  assert.strictEqual(r, good.shimCmd);
});
check('A13 falsy 入参(\'\' / null / undefined)→ 不抛错,且不得凭空造出路径', () => {
  for (const v of ['', null, undefined]) {
    let r;
    assert.doesNotThrow(() => { r = resolveSdkClaudeFrom(v, winOpts()); }, `入参 ${String(v)} 抛错了`);
    assert.ok(!r, `入参 ${String(v)} 应得 falsy,实得 ${JSON.stringify(r)}`);
  }
});
check('A14 命中项是大写 .EXE → 不抛错且不返回 null(大小写不敏感的 Windows 上不能判成"没装")', () => {
  let r;
  assert.doesNotThrow(() => { r = resolveSdkClaudeFrom(hitExeUpper, winOpts()); });
  assert.ok(r, `实得 ${JSON.stringify(r)};原样返回或推导到包内 exe 都行,唯独不能 null`);
});
check('A15 shim 路径本身不存在(SDK 给了个陈旧命中)→ 不抛错', () => {
  assert.doesNotThrow(() => resolveSdkClaudeFrom(join(TMP, 'no-such', 'claude.cmd'), winOpts()));
});
check('A16 opts 缺省 / 只给 platform → 不抛错(注入项可选,回落真实 fs)', () => {
  assert.doesNotThrow(() => resolveSdkClaudeFrom(good.shimCmd, { platform: 'darwin' }));
  assert.doesNotThrow(() => resolveSdkClaudeFrom(good.shimCmd, {}));
  assert.doesNotThrow(() => resolveSdkClaudeFrom(good.shimCmd));
});

console.log('\n[A] 接线与回归锁 server/utils/claude-resolver.js');
let RSRC = '';
try { RSRC = realReadFileSync(join(ROOT, 'server', 'utils', 'claude-resolver.js'), 'utf8'); } catch { RSRC = ''; }
check('A17 resolveSdkClaude() 是 resolveSdkClaudeFrom 的包装(源码里出现 ≥2 次:定义 + 被调用)', () => {
  assert.ok(RSRC.length > 0, 'claude-resolver.js 读不到');
  const n = (RSRC.match(/resolveSdkClaudeFrom/g) || []).length;
  assert.ok(n >= 2, `实得 ${n} 次;纯函数写了却没被 resolveSdkClaude 调用 = Windows 上等于没修`);
});
check('A18 既有导出未被本轮挪走(resolveSdkClaude/classifyShim/sniffBinaryKind/winLivePathDirs/resolveClaude)', () => {
  for (const n of ['resolveSdkClaude', 'classifyShim', 'sniffBinaryKind', 'winLivePathDirs', 'resolveClaude', 'claudeExecSpec']) {
    assert.equal(typeof RES?.[n], 'function', `既有导出 ${n} 必须还在(check-shim-detect / check-override-* 依赖)`);
  }
});
check('A19 回归锁:chat.js 仍用 resolveSdkClaude 喂 pathToClaudeCodeExecutable', () => {
  let C = '';
  try { C = realReadFileSync(join(ROOT, 'server', 'routes', 'chat.js'), 'utf8'); } catch { C = ''; }
  assert.ok(C.length > 0, 'chat.js 读不到');
  assert.ok(C.includes('pathToClaudeCodeExecutable'), 'SDK 入口参数不见了');
  assert.ok(/resolveSdkClaude\b/.test(C), 'chat.js 必须经 resolveSdkClaude 取路径(否则本轮修的东西接不上主聊天)');
});

// ══════════════════════════════════════════════════════════════════════════
// B. resolveWinCommand —— server/routes/mcp.js
// ══════════════════════════════════════════════════════════════════════════
console.log('\n[B] resolveWinCommand(command, { env, existsSync, readdirSync, liveDirs })');

let MCP = null;
let MCPERR = '';
try {
  MCP = await import('../../server/routes/mcp.js');
} catch (e) {
  MCPERR = String((e && e.message) || e);
}
const resolveWinCommand = MCP?.resolveWinCommand;

// 虚拟 fs:纯内存,键统一小写正斜杠;这样实现无论用 path.win32 还是手拼都能被找到。
const k = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const mkFs = (files = [], dirs = {}) => {
  const set = new Set(files.map(k));
  const dmap = {};
  for (const [d, entries] of Object.entries(dirs)) dmap[k(d)] = entries;
  return {
    existsSync: (p) => set.has(k(p)),
    // 真实 readdirSync 对不存在的目录会抛 ENOENT —— 候选目录大多不存在,实现必须吞掉
    readdirSync: (p, opts) => {
      const e = dmap[k(p)];
      if (!e) {
        const err = new Error(`ENOENT: no such file or directory, scandir '${p}'`);
        err.code = 'ENOENT';
        throw err;
      }
      return opts && opts.withFileTypes
        ? e.map((n) => ({ name: n, isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false }))
        : e.slice();
    },
  };
};
const ENV = {
  USERPROFILE: 'C:\\Users\\u',
  APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
};
const call = (cmd, { files = [], dirs = {}, liveDirs = [], env = ENV } = {}) =>
  resolveWinCommand(cmd, { env, liveDirs, ...mkFs(files, dirs) });

const LOCALBIN = 'C:\\Users\\u\\.local\\bin';
const CARGOBIN = 'C:\\Users\\u\\.cargo\\bin';
const NPMDIR = 'C:\\Users\\u\\AppData\\Roaming\\npm';
const SCOOP = 'C:\\Users\\u\\scoop\\shims';
const PYLOCAL = 'C:\\Users\\u\\AppData\\Local\\Programs\\Python';
const PYROAM = 'C:\\Users\\u\\AppData\\Roaming\\Python';
const PATHDIR1 = 'C:\\Program Files\\nodejs';
const PATHDIR2 = 'C:\\Windows\\System32';

check('B0 resolveWinCommand 已导出且是函数', () => {
  assert.ok(MCP, `mcp.js import 失败:${MCPERR}`);
  assert.equal(typeof resolveWinCommand, 'function');
});
// 【形态与行为分开断言】契约 ② 说命中返回 { file, viaCmd },未命中返回 null。
// 但"搜得对不对"和"包装成什么形状"是两件事,混在一条里会让形态一处不合把 20 条
// 搜索逻辑断言全染红、看不出覆盖到底有没有效。所以:
//   * 形态 → B-S1/B-S2/B-S3 三条专门锁(逐字对契约);
//   * 路径/顺序/优先级/反向 → 用 pathOf() 兼容 string 与 {file} 两种形态断言;
//   * viaCmd → 单独锁(它承载"要不要经 cmd.exe /c"这个信息,丢了就是真丢功能)。
const pathOf = (r) => (r && typeof r === 'object' ? String(r.file || '') : (typeof r === 'string' ? r : ''));
const samePath = (r, want, msg) =>
  assert.equal(norm(pathOf(r)).toLowerCase(), norm(want).toLowerCase(), msg);
const notFound = (r) => assert.ok(!pathOf(r), `应判定为"找不到",实得 ${JSON.stringify(r)}`);

check('B-S1 形态:命中返回 { file: string, viaCmd: boolean }(契约 ②)', () => {
  const r = call('uvx', { files: [`${PATHDIR1}\\uvx.exe`], liveDirs: [PATHDIR1] });
  assert.ok(r && typeof r === 'object' && !Array.isArray(r), `应返回对象,实得 ${JSON.stringify(r)}`);
  assert.equal(typeof r.file, 'string', 'file 必须是字符串路径');
  assert.equal(typeof r.viaCmd, 'boolean', 'viaCmd 必须是布尔 —— 调用方靠它决定要不要经 cmd.exe /c');
});
check('B-S2 形态:未命中返回 null(不是 \'\' / undefined / false)', () => {
  const r = call('uvx', { files: [`${LOCALBIN}\\other.exe`], liveDirs: [PATHDIR1] });
  assert.strictEqual(r, null, `实得 ${JSON.stringify(r)}`);
});
check('B-S3 形态:command 非法时同样返回 null', () => {
  for (const v of ['', null, undefined]) {
    assert.strictEqual(call(v, { files: [`${LOCALBIN}\\uvx.exe`], liveDirs: [] }), null, `command=${String(v)}`);
  }
});

check('B1 liveDirs 里有 uvx.exe → 命中该目录下的 uvx.exe', () => {
  samePath(call('uvx', { files: [`${PATHDIR1}\\uvx.exe`], liveDirs: [PATHDIR1] }), `${PATHDIR1}\\uvx.exe`);
});
check('B2 liveDirs 内按给定顺序取第一个命中(PATH 顺序即优先级)', () => {
  const files = [`${PATHDIR1}\\uvx.exe`, `${PATHDIR2}\\uvx.exe`];
  samePath(call('uvx', { files, liveDirs: [PATHDIR1, PATHDIR2] }), `${PATHDIR1}\\uvx.exe`);
  samePath(call('uvx', { files, liveDirs: [PATHDIR2, PATHDIR1] }), `${PATHDIR2}\\uvx.exe`,
    '换个顺序就该换个结果,否则说明根本没按 liveDirs 顺序找');
});
check('B3 liveDirs(实时 PATH)优先于补充候选目录', () => {
  samePath(call('uvx', { files: [`${PATHDIR1}\\uvx.exe`, `${LOCALBIN}\\uvx.exe`], liveDirs: [PATHDIR1] }),
    `${PATHDIR1}\\uvx.exe`, 'PATH 里有就用 PATH 里的,补充目录只是兜底');
});
check('B4 PATH 里没有但 %USERPROFILE%\\.local\\bin\\uvx.exe 存在 → 命中它(BRIEF 点名的验收场景)', () => {
  samePath(call('uvx', { files: [`${LOCALBIN}\\uvx.exe`], liveDirs: [] }), `${LOCALBIN}\\uvx.exe`);
});
check('B5 %USERPROFILE%\\.cargo\\bin 在候选目录里', () => {
  samePath(call('uvx', { files: [`${CARGOBIN}\\uvx.exe`], liveDirs: [] }), `${CARGOBIN}\\uvx.exe`);
});
check('B6 %APPDATA%\\npm 在候选目录里(npm 全局装的 .cmd)', () => {
  samePath(call('some-mcp', { files: [`${NPMDIR}\\some-mcp.cmd`], liveDirs: [] }), `${NPMDIR}\\some-mcp.cmd`);
});
check('B7 %USERPROFILE%\\scoop\\shims 在候选目录里', () => {
  samePath(call('uvx', { files: [`${SCOOP}\\uvx.exe`], liveDirs: [] }), `${SCOOP}\\uvx.exe`);
});
check('B8 %LOCALAPPDATA%\\Programs\\Python\\Python3*\\Scripts 按 glob 展开命中', () => {
  samePath(call('uvx', {
    files: [`${PYLOCAL}\\Python312\\Scripts\\uvx.exe`],
    dirs: { [PYLOCAL]: ['Python39', 'Python312', 'Launcher'] },
    liveDirs: [],
  }), `${PYLOCAL}\\Python312\\Scripts\\uvx.exe`, 'Python 版本目录名不固定,必须 readdirSync 后按 Python3* 展开');
});
check('B9 %APPDATA%\\Python\\Python3*\\Scripts 按 glob 展开命中(pip --user 装的)', () => {
  samePath(call('uvx', {
    files: [`${PYROAM}\\Python313\\Scripts\\uvx.exe`],
    dirs: { [PYROAM]: ['Python313'] },
    liveDirs: [],
  }), `${PYROAM}\\Python313\\Scripts\\uvx.exe`);
});
check('B10 同一目录内扩展名优先级 .exe > .cmd > .bat', () => {
  const files = [`${LOCALBIN}\\uvx.exe`, `${LOCALBIN}\\uvx.cmd`, `${LOCALBIN}\\uvx.bat`];
  assert.match(pathOf(call('uvx', { files, liveDirs: [] })), /uvx\.exe$/i, '三者都在时取 .exe');
  assert.match(pathOf(call('uvx', { files: files.slice(1), liveDirs: [] })), /uvx\.cmd$/i, '没 .exe 时取 .cmd');
  assert.match(pathOf(call('uvx', { files: files.slice(2), liveDirs: [] })), /uvx\.bat$/i, '只剩 .bat 时取 .bat');
});
check('B11 viaCmd:.exe → false(直接 spawn)', () => {
  const r = call('uvx', { files: [`${LOCALBIN}\\uvx.exe`], liveDirs: [] });
  assert.strictEqual(r?.viaCmd, false, `实得 ${JSON.stringify(r)}`);
});
check('B12 viaCmd:.cmd / .bat → true(必须经 cmd.exe /c,直接 spawn 在 Windows 上起不来)', () => {
  for (const ext of ['cmd', 'bat']) {
    const r = call('uvx', { files: [`${LOCALBIN}\\uvx.${ext}`], liveDirs: [] });
    assert.strictEqual(r?.viaCmd, true, `.${ext} 实得 ${JSON.stringify(r)}`);
  }
});
check('B13 不变式:viaCmd === (命中文件不是 .exe)', () => {
  const cases = [
    [`${LOCALBIN}\\uvx.exe`], [`${LOCALBIN}\\uvx.cmd`], [`${LOCALBIN}\\uvx.bat`],
    [`${PATHDIR1}\\uvx.cmd`], [`${SCOOP}\\uvx.bat`],
  ];
  for (const files of cases) {
    const r = call('uvx', { files, liveDirs: [PATHDIR1] });
    assert.ok(pathOf(r), `${files[0]} 应命中`);
    assert.strictEqual(r?.viaCmd, !/\.exe$/i.test(pathOf(r)),
      `${pathOf(r)} 的 viaCmd 与扩展名不一致 —— spawn 时会用错方式`);
  }
});
check('B14 命中的 file 必须是注入 existsSync 认可的完整路径(不许返回没验证过的拼接结果)', () => {
  const fs2 = mkFs([`${LOCALBIN}\\uvx.cmd`], {});
  const r = resolveWinCommand('uvx', { env: ENV, liveDirs: [], ...fs2 });
  assert.ok(pathOf(r), '应命中');
  assert.ok(fs2.existsSync(pathOf(r)), `返回的 ${pathOf(r)} 在注入 fs 里并不存在`);
});
check('B15 所有候选目录都没有 → 找不到', () => {
  notFound(call('uvx', { files: [`${LOCALBIN}\\other.exe`], liveDirs: [PATHDIR1] }));
});
check('B16 反向用例:同名但扩展名不在清单内(.ps1 / 无扩展 / .txt)→ 不命中', () => {
  notFound(call('uvx', {
    files: [`${LOCALBIN}\\uvx.ps1`, `${LOCALBIN}\\uvx`, `${LOCALBIN}\\uvx.txt`],
    liveDirs: [PATHDIR1],
  }));
});
check('B17 候选目录不存在(注入 readdirSync 抛 ENOENT)→ 吞掉,不外抛', () => {
  let r;
  assert.doesNotThrow(() => { r = call('uvx', { files: [], dirs: {}, liveDirs: [] }); },
    'Python 目录在绝大多数机器上不存在,readdirSync 必抛,实现必须 try/catch');
  notFound(r);
});
check('B18 env 为空对象(拿不到 USERPROFILE/APPDATA)→ 不抛错,liveDirs 仍能命中', () => {
  let r;
  assert.doesNotThrow(() => { r = call('uvx', { files: [`${PATHDIR1}\\uvx.exe`], liveDirs: [PATHDIR1], env: {} }); });
  samePath(r, `${PATHDIR1}\\uvx.exe`);
});
check('B19 env 为空且 liveDirs 为空 → 找不到(不许拼出 undefined\\.local\\bin 之类的路径)', () => {
  let r;
  assert.doesNotThrow(() => { r = call('uvx', { files: [], liveDirs: [], env: {} }); });
  notFound(r);
});
check('B20 liveDirs 非法(undefined / null / 字符串 / 含 null 与数字的数组)→ 不抛错,补充目录照常生效', () => {
  // 真实调用方是 winLivePathDirs():PowerShell 读 PATH 失败时可能给回 null/undefined,
  // 抛穿出去就等于 MCP 添加直接 500。
  for (const bad of [undefined, null, 'C:\\x', [null, 3, '']]) {
    let r;
    assert.doesNotThrow(() => {
      r = resolveWinCommand('uvx', { env: ENV, liveDirs: bad, ...mkFs([`${LOCALBIN}\\uvx.exe`], {}) });
    }, `liveDirs=${JSON.stringify(bad)} 抛错了`);
    samePath(r, `${LOCALBIN}\\uvx.exe`, `liveDirs=${JSON.stringify(bad)} 时补充目录该照常命中`);
  }
});
check('B21 不许偷用真实 fs/PATH:命令名 node 在空虚拟 fs 里必须找不到', () => {
  notFound(call('node', { files: [], liveDirs: [] }));
});
check('B22 opts 缺省 → 不抛错(纯函数被 spawnMcpCommand 用默认实参调用时不能崩)', () => {
  assert.doesNotThrow(() => resolveWinCommand('definitely-not-a-real-cmd-r106', {}));
  assert.doesNotThrow(() => resolveWinCommand('definitely-not-a-real-cmd-r106'));
});

console.log('\n[B] 接线与文案锁 server/routes/mcp.js');
let MSRC = '';
try { MSRC = realReadFileSync(join(ROOT, 'server', 'routes', 'mcp.js'), 'utf8'); } catch { MSRC = ''; }
check('B23 spawnMcpCommand 真的用上了 resolveWinCommand(源码出现 ≥2 次:定义 + 被调用)', () => {
  assert.ok(MSRC.length > 0, 'mcp.js 读不到');
  const n = (MSRC.match(/resolveWinCommand/g) || []).length;
  assert.ok(n >= 2, `实得 ${n} 次;纯函数没接进 spawn 路径 = 用户那边照旧 ENOENT`);
});
check('B24 错误文案人话:含"找不到命令"与"绝对路径",且在同一段文案里(≤400 字符窗口)', () => {
  assert.ok(MSRC.includes('找不到命令'), '缺"找不到命令"—— 不能再裸抛 ENOENT');
  assert.ok(MSRC.includes('绝对路径'), '缺"绝对路径"—— 要给用户可行动的出路');
  assert.match(MSRC, /找不到命令[\s\S]{0,400}绝对路径/,
    '两句要在同一条消息里,不能一个在错误里一个在别处的注释里');
});
check('B25 既有导出未被本轮挪走(buildAddArgs/parseHeadersFromDetails/HEADER_KEY_RE/listMcpTools)', () => {
  for (const n of ['buildAddArgs', 'parseHeadersFromDetails', 'listMcpTools', 'listToolsFromCfg']) {
    assert.equal(typeof MCP?.[n], 'function', `既有导出 ${n} 必须还在(check-mcp-add-headers 依赖)`);
  }
  assert.ok(MCP?.HEADER_KEY_RE instanceof RegExp, 'HEADER_KEY_RE 必须还在');
});
check('B26 Windows 三坑:mcp.js 不出现 wmic(Win11 24H2 已移除)', () => {
  assert.ok(!/\bwmic\b/.test(MSRC), '发现 wmic —— 必须用 Get-CimInstance');
});
check('B27 Windows 三坑:.cmd/.bat 有经 cmd.exe 的通道(cmd.exe 或 shell:true 任一即可)', () => {
  assert.ok(/cmd\.exe/.test(MSRC) || /shell:\s*true/.test(MSRC),
    'BRIEF §4:.cmd 直接 spawn 在 Windows 上起不来,必须经 cmd.exe /c(或 spawn 的 shell:true)');
});
check('B28 Windows 三坑:execFile 类参数不带内嵌双引号(引号交给 spawn 转义)', () => {
  const bad = (MSRC.match(/execFile[A-Za-z]*\([^\n]*\\"/g) || []);
  assert.equal(bad.length, 0, `发现内嵌双引号的 execFile 参数:\n      ${bad.join('\n      ')}`);
});

// ══════════════════════════════════════════════════════════════════════════
// C. 面板文案锁(不写死文件名:按锚点字串扫 client/src 与 server)
// ══════════════════════════════════════════════════════════════════════════
console.log('\n[C] 快照面板文案(Windows + cliSnapshotSupported=false 时的可行动指引)');

const walk = (dir, out = []) => {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(jsx?|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
};
const SRCS = [...walk(join(ROOT, 'client', 'src')), ...walk(join(ROOT, 'server'))]
  .map((p) => ({ p, s: (() => { try { return realReadFileSync(p, 'utf8'); } catch { return ''; } })() }));
const SNAP = SRCS.filter((f) => f.s.includes('系统提示快照'));
// 反斜杠在 JS 字面量里可能写成 \\,两种都认
const EXE_RE = /bin[\\/]{1,2}claude\.exe/;
const HIT = SNAP.filter((f) => EXE_RE.test(f.s) && /(重装|原生安装器)/.test(f.s));

check('C0 能定位到写"系统提示快照"文案的源文件', () => {
  assert.ok(SNAP.length > 0, '全仓找不到"系统提示快照"锚点字串,文案位置变了或被删');
});
check('C1 该文案所在文件含 bin\\claude.exe 路径指引 + "重装"或"原生安装器"', () => {
  assert.ok(HIT.length > 0,
    `没有一个文件同时满足;候选文件:\n      ${SNAP.map((f) => f.p.slice(ROOT.length + 1)).join('\n      ') || '(无)'}`);
});
check('C2 指引与 cliSnapshotSupported 在同一文件(说明是挂在"不支持"分支上,不是随手写的注释)', () => {
  assert.ok(HIT.some((f) => f.s.includes('cliSnapshotSupported')),
    `命中文件:${HIT.map((f) => f.p.slice(ROOT.length + 1)).join(', ') || '(无)'}`);
});
check('C3 指引受 Windows 门控(claude.exe 附近 ±800 字符出现 win32/isWin/Windows 标记)', () => {
  const ok = HIT.some((f) => {
    const i = f.s.search(EXE_RE);
    if (i < 0) return false;
    const w = f.s.slice(Math.max(0, i - 800), i + 800);
    return /win32|isWin|isWindows|Windows/.test(w);
  });
  assert.ok(ok, 'mac/Linux 用户不该看到"去找 %APPDATA%\\npm"这种 Windows 指引');
});
check('C4 指引给出完整 npm 包路径(同文件出现 @anthropic-ai)', () => {
  assert.ok(HIT.some((f) => f.s.includes('@anthropic-ai')),
    '只说 bin\\claude.exe 用户找不到;要给 …\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe');
});
check('C5 文案里不出现 window.confirm / alert(Tauri webview 里这俩是哑的)', () => {
  for (const f of HIT) {
    assert.ok(!f.s.includes('window.confirm'), `${f.p.slice(ROOT.length + 1)} 出现 window.confirm`);
  }
});

// ══════════════════════════════════════════════════════════════════════════
process.env.HOME = REAL_HOME;
if (REAL_USERPROFILE === undefined) delete process.env.USERPROFILE;
else process.env.USERPROFILE = REAL_USERPROFILE;
rmSync(TMP, { recursive: true, force: true });

console.log(`\n—— check-r106-windows-npm-sdk-exe: ${PASS} 绿 / ${FAILS} 红(共 ${PASS + FAILS} 条)——`);
if (FAILS) {
  console.log('红的条目:');
  for (const n of failed) console.log(`  ✗ ${n}`);
  process.exit(1);
}
console.log('✓ check-r106: SDK 真 exe 解析 + MCP 命令候选目录解析 + 面板指引文案 全绿');
