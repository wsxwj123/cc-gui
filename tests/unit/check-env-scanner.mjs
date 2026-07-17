// env-scanner 单测(mac 上跑,Windows 分支经注入 deps mock 覆盖)。
// Run: node tests/unit/check-env-scanner.mjs
// 覆盖:版本解析 / node 达标 / 候选生成(win 多盘 + mac 版本管理器)/ 通配展开(多段 *)/
// realpath 去重 / scanToolInstalls 全链路(win 模拟:D 盘 node + nvm 多版本 + Store 假垫片过滤)。
import assert from 'node:assert';
import {
  parseVersionOutput, nodeMeets, binNames, buildCandidates,
  expandPattern, dedupeByReal, scanToolInstalls, scanAllTools,
} from '../../server/utils/env-scanner.js';

// ---- parseVersionOutput:各工具真实输出形态 ----
assert.strictEqual(parseVersionOutput('v20.11.1'), '20.11.1');                       // node(v 前缀)
assert.strictEqual(parseVersionOutput('Python 3.12.4'), '3.12.4');                   // python(可能打 stderr,上游已合并)
assert.strictEqual(parseVersionOutput('git version 2.44.0.windows.1'), '2.44.0');    // git for windows 后缀
assert.strictEqual(parseVersionOutput('uv 0.5.9 (abcdef 2026-01-01)'), '0.5.9');
assert.strictEqual(parseVersionOutput('2.1.160 (Claude Code)'), '2.1.160');
assert.strictEqual(parseVersionOutput(''), null);
assert.strictEqual(parseVersionOutput('not a version'), null);

// ---- nodeMeets:≥20 硬性 ----
assert.strictEqual(nodeMeets('v20.0.0'), true);
assert.strictEqual(nodeMeets('22.4.1'), true);
assert.strictEqual(nodeMeets('v18.19.0'), false);
assert.strictEqual(nodeMeets(null), false);
assert.strictEqual(nodeMeets('garbage'), false);

// ---- binNames ----
assert.deepStrictEqual(binNames('python', 'win32'), ['python.exe', 'python3.exe']);
assert.deepStrictEqual(binNames('python', 'darwin'), ['python3', 'python']);
assert.deepStrictEqual(binNames('node', 'win32'), ['node.exe']);
assert.deepStrictEqual(binNames('uv', 'darwin'), ['uv']);

// ---- buildCandidates(win):每个固定盘都生成系统级落点(非 C 盘盲区的核心)----
const winCtx = {
  platform: 'win32', home: 'C:\\Users\\u',
  env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', APPDATA: 'C:\\Users\\u\\AppData\\Roaming', ProgramData: 'C:\\ProgramData' },
  drives: ['C:\\', 'D:\\', 'E:\\'],
};
const winNode = buildCandidates('node', winCtx).map((c) => c.pattern);
assert.ok(winNode.includes('D:\\Program Files\\nodejs\\node.exe'), 'D 盘 Program Files nodejs');
assert.ok(winNode.includes('E:\\nodejs\\node.exe'), 'E 盘裸 nodejs 目录');
assert.ok(winNode.includes('C:\\Users\\u\\AppData\\Roaming\\nvm\\v*\\node.exe'), 'nvm-windows');
assert.ok(winNode.includes('C:\\Users\\u\\AppData\\Local\\Volta\\bin\\node.exe'), 'volta');
assert.ok(winNode.includes('C:\\Users\\u\\scoop\\shims\\node.exe'), 'scoop');
assert.ok(winNode.includes('C:\\ProgramData\\chocolatey\\bin\\node.exe'), 'chocolatey');

const winPy = buildCandidates('python', winCtx).map((c) => c.pattern);
assert.ok(winPy.includes('D:\\Python3*\\python.exe'), 'D 盘 python.org 自定义根目录');
assert.ok(winPy.includes('E:\\Program Files\\Python3*\\python.exe'), 'E 盘全用户安装');
assert.ok(winPy.includes('C:\\Users\\u\\AppData\\Local\\Programs\\Python\\Python3*\\python.exe'), 'python.org 用户级默认');
assert.ok(winPy.includes('C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe'), 'Store 垫片(靠版本过滤)');

const winGit = buildCandidates('git', winCtx).map((c) => c.pattern);
assert.ok(winGit.includes('D:\\Program Files\\Git\\cmd\\git.exe'));
assert.ok(winGit.includes('D:\\Git\\cmd\\git.exe'));

const winUv = buildCandidates('uv', winCtx).map((c) => c.pattern);
assert.ok(winUv.includes('C:\\Users\\u\\.local\\bin\\uv.exe'), 'astral 默认');
assert.ok(winUv.includes('C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Links\\uv.exe'), 'winget');

// env 变量缺失时按 home 推导,不抛错
const winCtxNoEnv = { platform: 'win32', home: 'C:\\Users\\u', env: {}, drives: ['C:\\'] };
assert.ok(buildCandidates('python', winCtxNoEnv).some((c) => c.pattern.includes('AppData\\Local\\Programs\\Python')));

// ---- buildCandidates(mac):常见目录 + 版本管理器 ----
const macCtx = { platform: 'darwin', home: '/Users/u', env: {}, drives: [] };
const macNode = buildCandidates('node', macCtx).map((c) => c.pattern);
assert.ok(macNode.includes('/opt/homebrew/bin/node'));
assert.ok(macNode.includes('/Users/u/.nvm/versions/node/*/bin/node'), 'nvm 通配');
assert.ok(macNode.includes('/Users/u/.volta/bin/node'));
const macPy = buildCandidates('python', macCtx).map((c) => c.pattern);
assert.ok(macPy.includes('/Users/u/.pyenv/shims/python3'), 'pyenv shims');
assert.ok(macPy.includes('/Library/Frameworks/Python.framework/Versions/*/bin/python3'), 'python.org 官方 pkg');
const macUv = buildCandidates('uv', macCtx).map((c) => c.pattern);
assert.ok(macUv.includes('/Users/u/.local/bin/uv'));
assert.ok(macUv.includes('/Users/u/.cargo/bin/uv'));

// ---- expandPattern:单段 / 多段通配、盘符根、目录不存在 ----
const fakeTree = {
  'C:\\': ['Python312', 'Python39', 'Windows', 'Users'],
  '/Users/u/.nvm/versions/node': ['v18.19.0', 'v20.11.1'],
  '/Library/Frameworks/Python.framework/Versions': ['3.12', 'Current'],
};
const fakeReaddir = (dir) => {
  const key = dir.replace(/[\\/]$/, dir.includes('\\') ? '\\' : '');
  if (fakeTree[dir] !== undefined) return fakeTree[dir];
  if (fakeTree[key] !== undefined) return fakeTree[key];
  throw new Error('ENOENT: ' + dir);
};
assert.deepStrictEqual(
  expandPattern('C:\\Python3*\\python.exe', fakeReaddir).sort(),
  ['C:\\Python312\\python.exe', 'C:\\Python39\\python.exe'],
  '盘符根下的 Python3* 展开(裸盘符须补反斜杠)',
);
assert.deepStrictEqual(
  expandPattern('/Users/u/.nvm/versions/node/*/bin/node', fakeReaddir).sort(),
  ['/Users/u/.nvm/versions/node/v18.19.0/bin/node', '/Users/u/.nvm/versions/node/v20.11.1/bin/node'],
  'nvm 版本目录通配',
);
assert.deepStrictEqual(expandPattern('D:\\Python3*\\python.exe', fakeReaddir), [], '目录不存在返回空');
assert.deepStrictEqual(expandPattern('/usr/bin/git', fakeReaddir), ['/usr/bin/git'], '无通配原样返回');
assert.deepStrictEqual(
  expandPattern('/Library/Frameworks/Python.framework/Versions/*/bin/python3', fakeReaddir).sort(),
  ['/Library/Frameworks/Python.framework/Versions/3.12/bin/python3', '/Library/Frameworks/Python.framework/Versions/Current/bin/python3'],
);

// ---- dedupeByReal:软链归一 + win 大小写不敏感 ----
const dd = dedupeByReal(
  [
    { path: '/usr/local/bin/python3', via: 'PATH' },
    { path: '/Library/Frameworks/Python.framework/Versions/3.12/bin/python3', via: 'python.org' },
    { path: '/missing/python3', via: 'common-dir' },
  ],
  {
    platform: 'darwin',
    exists: (p) => p !== '/missing/python3',
    realpath: (p) => '/Library/Frameworks/Python.framework/Versions/3.12/bin/python3', // 两个入口同一 real
  },
);
assert.strictEqual(dd.length, 1, '软链与目标只算一个');
assert.strictEqual(dd[0].path, '/usr/local/bin/python3', '保留首次发现的入口路径');

const ddWin = dedupeByReal(
  [{ path: 'C:\\nodejs\\node.exe', via: 'drive-scan' }, { path: 'c:\\NODEJS\\node.exe', via: 'PATH' }],
  { platform: 'win32', exists: () => true, realpath: (p) => p },
);
assert.strictEqual(ddWin.length, 1, 'win 路径大小写归一去重');

// ---- scanToolInstalls 全链路(win 模拟):D 盘直扫命中 + nvm 多版本 + Store 假垫片被过滤 ----
{
  const files = new Set([
    'D:\\nodejs\\node.exe',                                                  // 非 C 盘、不在 PATH
    'C:\\Users\\u\\AppData\\Roaming\\nvm\\v18.19.0\\node.exe',
    'C:\\Users\\u\\AppData\\Roaming\\nvm\\v20.11.1\\node.exe',
  ]);
  const deps = {
    platform: 'win32', home: 'C:\\Users\\u',
    env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', ProgramData: 'C:\\ProgramData' },
    exists: (p) => files.has(p),
    readdir: (dir) => {
      if (dir === 'C:\\Users\\u\\AppData\\Roaming\\nvm') return ['v18.19.0', 'v20.11.1', 'settings.txt'];
      throw new Error('ENOENT');
    },
    realpath: (p) => p,
    getDrives: async () => ['C:\\', 'D:\\'],
    execOut: async (file, args) => {
      if (file === 'where') return '';                                       // PATH 上找不到(装了没配 PATH)
      if (file === 'D:\\nodejs\\node.exe') return 'v22.3.0';
      if (file.includes('v18.19.0')) return 'v18.19.0';
      if (file.includes('v20.11.1')) return 'v20.11.1';
      return '';
    },
  };
  const list = await scanToolInstalls('node', deps);
  const paths = list.map((i) => i.path);
  assert.ok(paths.includes('D:\\nodejs\\node.exe'), '非 C 盘 + 无 PATH 也能扫到');
  assert.strictEqual(list.find((i) => i.path === 'D:\\nodejs\\node.exe').version, '22.3.0');
  assert.strictEqual(paths.filter((p) => p.includes('nvm')).length, 2, 'nvm 两个版本都列出');
  assert.strictEqual(list.length, 3);
}
{
  // Store 假垫片:文件存在但 --version 无输出 → 不进安装列表
  const stub = 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe';
  const deps = {
    platform: 'win32', home: 'C:\\Users\\u',
    env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', ProgramData: 'C:\\ProgramData' },
    exists: (p) => p === stub || p === 'E:\\Python312\\python.exe',
    readdir: (dir) => { if (dir === 'E:\\') return ['Python312']; throw new Error('ENOENT'); },
    realpath: (p) => p,
    getDrives: async () => ['C:\\', 'E:\\'],
    execOut: async (file) => {
      if (file === stub) return '';                                          // 垫片跑不出版本
      if (file === 'E:\\Python312\\python.exe') return 'Python 3.12.4';      // 非 C 盘真身
      return '';
    },
  };
  const list = await scanToolInstalls('python', deps);
  assert.deepStrictEqual(list.map((i) => i.path), ['E:\\Python312\\python.exe'], 'Store 垫片被版本过滤,E 盘真身保留');
  assert.strictEqual(list[0].version, '3.12.4');
}
{
  // mac 链路:which -a 多命中 + brew/nvm 候选,软链去重
  const deps = {
    platform: 'darwin', home: '/Users/u', env: {},
    exists: (p) => ['/opt/homebrew/bin/node', '/Users/u/.nvm/versions/node/v20.11.1/bin/node'].includes(p),
    readdir: (dir) => { if (dir === '/Users/u/.nvm/versions/node') return ['v20.11.1']; throw new Error('ENOENT'); },
    realpath: (p) => p,
    execOut: async (file, args) => {
      if (file === 'which') return '/opt/homebrew/bin/node';                 // PATH 命中之一
      if (file === '/opt/homebrew/bin/node') return 'v22.1.0';
      if (file.includes('.nvm')) return 'v20.11.1';
      return '';
    },
  };
  const list = await scanToolInstalls('node', deps);
  assert.strictEqual(list.length, 2, 'PATH 命中与 nvm 各一条');
  assert.strictEqual(list.find((i) => i.via === 'PATH').path, '/opt/homebrew/bin/node');
}

// ---- scanAllTools 并发去重:并发首扫底层只 spawn 一轮,后到者共享 in-flight promise ----
{
  let calls = 0;
  const deps = {
    platform: 'darwin', home: '/Users/u', env: {},
    exists: () => false,
    readdir: () => { throw new Error('ENOENT'); },
    realpath: (p) => p,
    execOut: async () => { calls++; await new Promise((r) => setTimeout(r, 5)); return ''; },
  };
  // 基线:单独跑一轮,记录底层执行次数(which -a 每工具每 bin 名各一次)。
  await scanAllTools({ refresh: true, deps });
  const baseline = calls;
  assert.ok(baseline > 0, '单轮扫描应有底层执行');
  calls = 0;
  const [a, b] = await Promise.all([
    scanAllTools({ refresh: true, deps }),
    scanAllTools({ refresh: true, deps }),
  ]);
  assert.strictEqual(calls, baseline, '两次并发调用底层执行只跑一轮');
  assert.strictEqual(a, b, '后到者共享同一轮结果(同一对象)');
  // 完成后 in-flight 已清除:下次 refresh 真跑新一轮(不是永久钉死同一 promise)。
  calls = 0;
  await scanAllTools({ refresh: true, deps });
  assert.strictEqual(calls, baseline, '扫描完成后 in-flight 清除,后续 refresh 重新执行');
}

console.log('check-env-scanner: all assertions passed');
