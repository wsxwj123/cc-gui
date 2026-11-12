// r180-npm12-allow-scripts 验收用例:只经 installCmdFor / updateCmdFor 两个公开函数,
// 其他平台的命令用 bash + 假 npm(fake-npm.sh)真执行,Windows 的命令只核对字符串。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const suiteDir = path.dirname(fileURLToPath(import.meta.url));
const fakeNpmSource = path.join(suiteDir, 'fake-npm.sh');
const modulePath = path.resolve(suiteDir, '../../../server/routes/version-check.js');

// 导入模块之前先把 HOME / USERPROFILE 指到临时目录
const moduleHome = fs.mkdtempSync(path.join(os.tmpdir(), 'r180-modhome-'));
process.env.HOME = moduleHome;
process.env.USERPROFILE = moduleHome;
after(() => {
  fs.rmSync(moduleHome, { recursive: true, force: true });
});

let moduleCache = null;
async function loadFunctions() {
  if (!moduleCache) {
    const m = await import(pathToFileURL(modulePath).href);
    const installCmdFor = m.installCmdFor ?? m.default?.installCmdFor;
    const updateCmdFor = m.updateCmdFor ?? m.default?.updateCmdFor;
    assert.equal(typeof installCmdFor, 'function', 'installCmdFor 应是导出的函数');
    assert.equal(typeof updateCmdFor, 'function', 'updateCmdFor 应是导出的函数');
    moduleCache = { installCmdFor, updateCmdFor };
  }
  return moduleCache;
}

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
function withPlatform(platform, fn) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', platformDescriptor);
  }
}

const ALLOW_FLAG = '--allow-scripts=@anthropic-ai/claude-code';
const CLAUDE_VERSION_OUTPUT = '9.9.9 (Claude Code)';

// 每条用例自己的隔离环境:家目录、假 npm、默认前缀、调用日志
function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r180-'));
  const home = path.join(root, 'home');
  const fakeBin = path.join(root, 'fakebin');
  const defaultPrefix = path.join(root, 'default-prefix');
  const logFile = path.join(root, 'npm.log');
  fs.mkdirSync(home);
  fs.mkdirSync(fakeBin);
  fs.mkdirSync(defaultPrefix);
  fs.writeFileSync(logFile, '');
  const fakeNpm = path.join(fakeBin, 'npm');
  fs.copyFileSync(fakeNpmSource, fakeNpm);
  fs.chmodSync(fakeNpm, 0o755);
  return {
    root, home, fakeBin, defaultPrefix, logFile,
    run(command, { mode, extraPath = [] }) {
      return spawnSync('bash', ['-c', command], {
        env: {
          HOME: home,
          PATH: [...extraPath, fakeBin, '/usr/bin', '/bin'].join(':'),
          FAKE_NPM_MODE: mode,
          FAKE_NPM_DEFAULT_PREFIX: defaultPrefix,
          FAKE_NPM_LOG: logFile,
        },
        encoding: 'utf8',
        timeout: 30000,
      });
    },
    logLines() {
      return fs.readFileSync(logFile, 'utf8').split('\n').filter((line) => line.trim() !== '');
    },
    cleanup() {
      try { fs.chmodSync(defaultPrefix, 0o755); } catch { /* 已不存在则忽略 */ }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function installCalls(sandbox) {
  return sandbox.logLines().filter((line) => /^(install|i)\s/.test(line));
}

// 取唯一一次 install 调用并拆成参数
function singleInstallTokens(sandbox) {
  const calls = installCalls(sandbox);
  assert.equal(calls.length, 1, `应恰好有 1 次 npm install 调用,日志:\n${sandbox.logLines().join('\n')}`);
  return calls[0].split(/\s+/);
}

function allowScriptsList(tokens) {
  const flags = tokens.filter((t) => t.startsWith('--allow-scripts'));
  assert.equal(flags.length, 1, `应恰好有 1 个 --allow-scripts 参数,实际参数:${tokens.join(' ')}`);
  assert.ok(flags[0].startsWith('--allow-scripts='), `--allow-scripts 应写成 --allow-scripts=<名单>,实际:${flags[0]}`);
  return flags[0].slice('--allow-scripts='.length).split(',');
}

function prefixOf(tokens) {
  const eq = tokens.find((t) => t.startsWith('--prefix='));
  if (eq) return eq.slice('--prefix='.length);
  const idx = tokens.indexOf('--prefix');
  return idx >= 0 ? tokens[idx + 1] : null;
}

function claudeVersionAt(prefix) {
  return spawnSync(path.join(prefix, 'bin', 'claude'), ['--version'], { encoding: 'utf8', timeout: 10000 });
}

function combinedOutput(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

async function installCommandOnDarwin() {
  const { installCmdFor } = await loadFunctions();
  return withPlatform('darwin', () => installCmdFor(null, 'npm'));
}

async function updateCommandOnDarwin() {
  const { updateCmdFor } = await loadFunctions();
  return withPlatform('darwin', () => updateCmdFor('npm-registry', ''));
}

// ---------------- 安装命令,其他平台 ----------------

test('I1 strict 且默认前缀可写:安装命令退出码 0,装出来的 claude --version 输出 9.9.9 (Claude Code)', async () => {
  const sandbox = makeSandbox();
  try {
    const command = await installCommandOnDarwin();
    const result = sandbox.run(command, { mode: 'strict' });
    assert.equal(result.status, 0, `命令退出码应为 0,输出:\n${combinedOutput(result)}`);
    const version = claudeVersionAt(sandbox.defaultPrefix);
    assert.equal(version.status, 0, `claude --version 退出码应为 0,stderr:${version.stderr}`);
    assert.equal(version.stdout.trim(), CLAUDE_VERSION_OUTPUT);
  } finally {
    sandbox.cleanup();
  }
});

test('I2 strict 且默认前缀可写:install 调用的 --allow-scripts 名单恰好只有 @anthropic-ai/claude-code', async () => {
  const sandbox = makeSandbox();
  try {
    const command = await installCommandOnDarwin();
    sandbox.run(command, { mode: 'strict' });
    const tokens = singleInstallTokens(sandbox);
    assert.deepEqual(allowScriptsList(tokens), ['@anthropic-ai/claude-code']);
  } finally {
    sandbox.cleanup();
  }
});

test('I3 legacy 旧版 npm:安装命令退出码 0,claude --version 输出 9.9.9 (Claude Code)', async () => {
  const sandbox = makeSandbox();
  try {
    const command = await installCommandOnDarwin();
    const result = sandbox.run(command, { mode: 'legacy' });
    assert.equal(result.status, 0, `命令退出码应为 0,输出:\n${combinedOutput(result)}`);
    const version = claudeVersionAt(sandbox.defaultPrefix);
    assert.equal(version.status, 0, `claude --version 退出码应为 0,stderr:${version.stderr}`);
    assert.equal(version.stdout.trim(), CLAUDE_VERSION_OUTPUT);
  } finally {
    sandbox.cleanup();
  }
});

test('I4 broken 装出占位文件:退出码非零,提示「没有装完整」并给出带 allow-scripts 的补救命令,不出现成功话术', async () => {
  const sandbox = makeSandbox();
  try {
    const command = await installCommandOnDarwin();
    const result = sandbox.run(command, { mode: 'broken' });
    const output = combinedOutput(result);
    assert.notEqual(result.status, null, `命令不应超时或被信号杀掉,输出:\n${output}`);
    assert.notEqual(result.status, 0, `自检失败时退出码应非零,输出:\n${output}`);
    assert.ok(output.includes('没有装完整'), `输出应含「没有装完整」,实际输出:\n${output}`);
    const remedyLines = output.split('\n').filter((line) => line.includes(ALLOW_FLAG) && line.includes('npm'));
    assert.ok(remedyLines.length >= 1, `输出应有一行含 npm 与 ${ALLOW_FLAG} 的补救命令,实际输出:\n${output}`);
    assert.ok(!output.includes('已完成'), `失败时不应出现「已完成」,实际输出:\n${output}`);
    assert.ok(!output.includes('安装成功'), `失败时不应出现「安装成功」,实际输出:\n${output}`);
  } finally {
    sandbox.cleanup();
  }
});

test('I5 默认前缀不可写(555):改装到 <家目录>/.npm-global,名单同 I2,退出码 0,claude 可运行', async () => {
  const sandbox = makeSandbox();
  try {
    fs.chmodSync(sandbox.defaultPrefix, 0o555);
    const command = await installCommandOnDarwin();
    const result = sandbox.run(command, { mode: 'strict' });
    assert.equal(result.status, 0, `命令退出码应为 0,输出:\n${combinedOutput(result)}`);
    const tokens = singleInstallTokens(sandbox);
    assert.equal(prefixOf(tokens), path.join(sandbox.home, '.npm-global'));
    assert.deepEqual(allowScriptsList(tokens), ['@anthropic-ai/claude-code']);
    const version = claudeVersionAt(path.join(sandbox.home, '.npm-global'));
    assert.equal(version.status, 0, `claude --version 退出码应为 0,stderr:${version.stderr}`);
    assert.equal(version.stdout.trim(), CLAUDE_VERSION_OUTPUT);
  } finally {
    sandbox.cleanup();
  }
});

test('I6 写 PATH:PATH 不含前缀 bin 时 .zshrc 恰好一行 export PATH= 且含前缀 bin;PATH 已含时再执行行数不变', async () => {
  const sandbox = makeSandbox();
  try {
    const command = await installCommandOnDarwin();
    const prefixBin = path.join(sandbox.defaultPrefix, 'bin');
    const zshrc = path.join(sandbox.home, '.zshrc');
    const exportLines = () => fs.readFileSync(zshrc, 'utf8').split('\n').filter((line) => /^\s*export PATH=/.test(line));

    const first = sandbox.run(command, { mode: 'strict' });
    assert.equal(first.status, 0, `第一次执行退出码应为 0,输出:\n${combinedOutput(first)}`);
    assert.ok(fs.existsSync(zshrc), '第一次执行后 ~/.zshrc 应存在');
    const afterFirst = exportLines();
    assert.equal(afterFirst.length, 1, `.zshrc 应恰好一行 export PATH=,实际:${JSON.stringify(afterFirst)}`);
    assert.ok(afterFirst[0].includes(prefixBin), `该行应含 ${prefixBin},实际:${afterFirst[0]}`);

    const second = sandbox.run(command, { mode: 'strict', extraPath: [prefixBin] });
    assert.equal(second.status, 0, `第二次执行退出码应为 0,输出:\n${combinedOutput(second)}`);
    assert.equal(exportLines().length, 1, '前缀 bin 已在 PATH 里时再执行,export PATH= 行数应不变');
  } finally {
    sandbox.cleanup();
  }
});

test('I7 strict 安装不改用户 npm 配置:家目录没有 .npmrc,假 npm 日志没有 config set', async () => {
  const sandbox = makeSandbox();
  try {
    const command = await installCommandOnDarwin();
    sandbox.run(command, { mode: 'strict' });
    assert.ok(!fs.existsSync(path.join(sandbox.home, '.npmrc')), '家目录下不应出现 .npmrc');
    const configSetCalls = sandbox.logLines().filter((line) => /^config\s+set\b/.test(line) || line.includes('config set'));
    assert.deepEqual(configSetCalls, []);
  } finally {
    sandbox.cleanup();
  }
});

// ---------------- 更新命令,其他平台 ----------------

test('U1 npm-registry 更新(strict):退出码 0,输出里有 9.9.9 (Claude Code)', async () => {
  const sandbox = makeSandbox();
  try {
    const command = await updateCommandOnDarwin();
    const result = sandbox.run(command, { mode: 'strict' });
    assert.equal(result.status, 0, `命令退出码应为 0,输出:\n${combinedOutput(result)}`);
    assert.ok(combinedOutput(result).includes(CLAUDE_VERSION_OUTPUT), `输出应含 ${CLAUDE_VERSION_OUTPUT},实际输出:\n${combinedOutput(result)}`);
  } finally {
    sandbox.cleanup();
  }
});

test('U2 npm-registry 更新(strict):包说明符是 @anthropic-ai/claude-code@latest,--allow-scripts 名单恰好只有该包', async () => {
  const sandbox = makeSandbox();
  try {
    const command = await updateCommandOnDarwin();
    sandbox.run(command, { mode: 'strict' });
    const tokens = singleInstallTokens(sandbox);
    assert.ok(tokens.includes('@anthropic-ai/claude-code@latest'), `包说明符应为 @anthropic-ai/claude-code@latest,实际参数:${tokens.join(' ')}`);
    assert.deepEqual(allowScriptsList(tokens), ['@anthropic-ai/claude-code']);
  } finally {
    sandbox.cleanup();
  }
});

test('U3 npm 与 native 两种更新方式的命令不含 npm install、不含 allow-scripts', async () => {
  const { updateCmdFor } = await loadFunctions();
  const commands = withPlatform('darwin', () => ({
    npm: updateCmdFor('npm', '/Users/u/.npm-global/bin/claude'),
    native: updateCmdFor('native', '/usr/local/bin/claude'),
  }));
  for (const [method, command] of Object.entries(commands)) {
    assert.equal(typeof command, 'string', `${method} 应返回字符串`);
    assert.ok(command.length > 0, `${method} 命令不应为空`);
    assert.ok(!command.includes('npm install'), `${method} 命令不应含 npm install,实际:${command}`);
    assert.ok(!command.includes('allow-scripts'), `${method} 命令不应含 allow-scripts,实际:${command}`);
  }
});

// ---------------- Windows 命令(只核对字符串) ----------------

test('W1 Windows 安装命令:以 call npm install -g 开头,含放行参数,仍含 powershell / -ExecutionPolicy Bypass / npm.cmd config get prefix', async () => {
  const { installCmdFor } = await loadFunctions();
  const command = withPlatform('win32', () => installCmdFor(null, 'npm'));
  assert.equal(typeof command, 'string');
  assert.ok(command.startsWith('call npm install -g'), `应以 "call npm install -g" 开头,实际:${command}`);
  assert.ok(command.includes(ALLOW_FLAG), `应含 ${ALLOW_FLAG},实际:${command}`);
  assert.ok(command.includes('powershell'), `应含 powershell,实际:${command}`);
  assert.ok(command.includes('-ExecutionPolicy Bypass'), `应含 -ExecutionPolicy Bypass,实际:${command}`);
  assert.ok(command.includes('npm.cmd config get prefix'), `应含 npm.cmd config get prefix,实际:${command}`);
});

test('W2 Windows 安装命令含装后自检:PowerShell 段内出现 claude.cmd 与 --version,并有「没有装完整」或 not fully installed 说明', async () => {
  const { installCmdFor } = await loadFunctions();
  const command = withPlatform('win32', () => installCmdFor(null, 'npm'));
  const powershellStart = command.indexOf('powershell');
  assert.ok(powershellStart >= 0, `应含 powershell,实际:${command}`);
  const claudeCmdIndex = command.indexOf('claude.cmd', powershellStart);
  assert.ok(claudeCmdIndex >= 0, `PowerShell 段内应出现 claude.cmd,实际:${command}`);
  assert.ok(command.indexOf('--version', claudeCmdIndex) >= 0, `claude.cmd 之后应出现 --version,实际:${command}`);
  assert.ok(
    command.includes('没有装完整') || command.includes('not fully installed'),
    `应含「没有装完整」或 not fully installed,实际:${command}`,
  );
});

test('W3 Windows npm-registry 更新命令:以 call npm install -g 开头,含放行参数与 @latest,以 call claude --version 结尾', async () => {
  const { updateCmdFor } = await loadFunctions();
  const command = withPlatform('win32', () => updateCmdFor('npm-registry', ''));
  assert.equal(typeof command, 'string');
  assert.ok(command.startsWith('call npm install -g'), `应以 "call npm install -g" 开头,实际:${command}`);
  assert.ok(command.includes(ALLOW_FLAG), `应含 ${ALLOW_FLAG},实际:${command}`);
  assert.ok(command.includes('@anthropic-ai/claude-code@latest'), `应含 @anthropic-ai/claude-code@latest,实际:${command}`);
  assert.ok(command.trimEnd().endsWith('call claude --version'), `应以 "call claude --version" 结尾,实际:${command}`);
});

// ---------------- 原生安装器 ----------------

test('N1 原生安装命令在 darwin 与 win32 下都不含 npm install、不含 allow-scripts', async () => {
  const { installCmdFor } = await loadFunctions();
  for (const platform of ['darwin', 'win32']) {
    const command = withPlatform(platform, () => installCmdFor(null, 'native'));
    assert.equal(typeof command, 'string', `${platform} 应返回字符串`);
    assert.ok(command.length > 0, `${platform} 命令不应为空`);
    assert.ok(!command.includes('npm install'), `${platform} 原生安装命令不应含 npm install,实际:${command}`);
    assert.ok(!command.includes('allow-scripts'), `${platform} 原生安装命令不应含 allow-scripts,实际:${command}`);
  }
});
