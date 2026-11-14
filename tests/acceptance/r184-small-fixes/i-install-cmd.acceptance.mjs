// r184 · I 组:npm 渠道安装 / 更新命令(只经 installCmdFor / updateCmdFor 两个公开函数取文本;darwin / linux 的安装命令用 bash + 假 npm 真执行)。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const suiteDir = path.dirname(fileURLToPath(import.meta.url));
const fakeNpmSource = path.join(suiteDir, 'helpers', 'fake-npm.sh');
const modulePath = path.resolve(suiteDir, '../../../server/routes/version-check.js');

// 导入模块之前先把 HOME / USERPROFILE 指到临时目录
const moduleHome = fs.mkdtempSync(path.join(os.tmpdir(), 'r184-modhome-'));
process.env.HOME = moduleHome;
process.env.USERPROFILE = moduleHome;
after(() => { /* 临时目录留给系统清理 */ });

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

async function installCommand(platform) {
  const { installCmdFor } = await loadFunctions();
  return withPlatform(platform, () => installCmdFor(null, 'npm'));
}

async function updateCommand(platform) {
  const { updateCmdFor } = await loadFunctions();
  return withPlatform(platform, () => updateCmdFor('npm-registry', ''));
}

// 每条用例一个临时目录:<root>/<homeName> 家目录、<root>/fakebin 假 npm、<root>/<globalName> npm 全局目录(执行前已建好且可写)
function makeSandbox({ homeName, globalName }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r184-i-'));
  const home = path.join(root, homeName);
  const fakeBin = path.join(root, 'fakebin');
  const globalDir = path.join(root, globalName);
  const logFile = path.join(root, 'npm.log');
  fs.mkdirSync(home);
  fs.mkdirSync(fakeBin);
  fs.mkdirSync(globalDir);
  fs.writeFileSync(logFile, '');
  const fakeNpm = path.join(fakeBin, 'npm');
  fs.copyFileSync(fakeNpmSource, fakeNpm);
  fs.chmodSync(fakeNpm, 0o755);
  fs.accessSync(globalDir, fs.constants.W_OK);
  return {
    root, home, globalDir,
    run(command) {
      return spawnSync('bash', ['-c', command], {
        env: {
          HOME: home,
          PATH: [fakeBin, '/usr/bin', '/bin'].join(':'),
          FAKE_NPM_MODE: 'strict',
          FAKE_NPM_DEFAULT_PREFIX: globalDir,
          FAKE_NPM_LOG: logFile,
        },
        encoding: 'utf8',
        timeout: 30_000,
      });
    },
  };
}

const combined = (r) => `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
const execSkip = process.platform === 'win32' ? '本用例要用 bash 真执行命令,Windows 上跳过' : false;

test('I1【复现】darwin / linux 的 npm 安装命令:用 npm config get prefix、不用 npm prefix -g,重定向目标带双引号', async () => {
  const expectedRc = { darwin: '.zshrc', linux: '.bashrc' };
  for (const platform of ['darwin', 'linux']) {
    const command = await installCommand(platform);
    assert.equal(typeof command, 'string', `${platform}:应返回字符串`);
    assert.ok(!command.includes('npm prefix -g'), `${platform}:不应含 "npm prefix -g",实际:${command}`);
    assert.ok(command.includes('npm config get prefix'), `${platform}:应含 "npm config get prefix",实际:${command}`);
    const redirect = `>> "$HOME/${expectedRc[platform]}"`;
    assert.ok(command.includes(redirect), `${platform}:应含 ${redirect},实际:${command}`);
    assert.ok(!command.includes('>> $HOME/'), `${platform}:不应含不带引号的 ">> $HOME/",实际:${command}`);
  }
});

test('I2【复现】darwin / linux 的 npm 渠道更新命令:用 npm config get prefix、不用 npm prefix -g', async () => {
  for (const platform of ['darwin', 'linux']) {
    const command = await updateCommand(platform);
    assert.equal(typeof command, 'string', `${platform}:应返回字符串`);
    assert.ok(!command.includes('npm prefix -g'), `${platform}:不应含 "npm prefix -g",实际:${command}`);
    assert.ok(command.includes('npm config get prefix'), `${platform}:应含 "npm config get prefix",实际:${command}`);
  }
});

test('I3【复现】家目录与 npm 全局目录路径都带空格:bash 执行整条 darwin 安装命令,退出码 0,.zshrc 里有含 <全局目录>/bin 的 export PATH= 行', { skip: execSkip }, async () => {
  const sandbox = makeSandbox({ homeName: 'home dir', globalName: 'npm global' });
  const command = await installCommand('darwin');
  const result = sandbox.run(command);
  assert.equal(result.status, 0, `命令退出码应为 0,实际 ${result.status},输出:\n${combined(result)}`);
  const zshrc = path.join(sandbox.home, '.zshrc');
  assert.ok(fs.existsSync(zshrc), `家目录下应有 .zshrc(${zshrc})`);
  const prefixBin = path.join(sandbox.globalDir, 'bin');
  const exportLines = fs.readFileSync(zshrc, 'utf8').split('\n').filter((line) => /^\s*export PATH=/.test(line));
  assert.equal(exportLines.length, 1, `.zshrc 应恰好有 1 行 export PATH=,实际:${JSON.stringify(exportLines)}`);
  assert.ok(exportLines[0].includes(prefixBin), `该行应含 ${prefixBin},实际:${exportLines[0]}`);
});

test('I4【守卫】win32 安装命令含 call npm install -g @anthropic-ai/claude-code 且不含 $HOME / .zshrc / .bashrc;win32 更新命令逐字不变', async () => {
  const install = await installCommand('win32');
  assert.equal(typeof install, 'string');
  assert.ok(install.includes('call npm install -g @anthropic-ai/claude-code'), `应含 "call npm install -g @anthropic-ai/claude-code",实际:${install}`);
  for (const forbidden of ['$HOME', '.zshrc', '.bashrc']) {
    assert.ok(!install.includes(forbidden), `win32 安装命令不应含 ${forbidden},实际:${install}`);
  }
  const update = await updateCommand('win32');
  assert.equal(update, 'call npm install -g @anthropic-ai/claude-code@latest --allow-scripts=@anthropic-ai/claude-code && call claude --version');
});

test('I5【守卫】路径都不带空格:bash 执行整条 linux 安装命令,退出码 0,.bashrc 有含 <全局目录>/bin 的 export PATH= 行,没有 .zshrc', { skip: execSkip }, async () => {
  const sandbox = makeSandbox({ homeName: 'home', globalName: 'npmglobal' });
  const command = await installCommand('linux');
  const result = sandbox.run(command);
  assert.equal(result.status, 0, `命令退出码应为 0,实际 ${result.status},输出:\n${combined(result)}`);
  const bashrc = path.join(sandbox.home, '.bashrc');
  assert.ok(fs.existsSync(bashrc), `家目录下应有 .bashrc(${bashrc})`);
  const prefixBin = path.join(sandbox.globalDir, 'bin');
  const exportLines = fs.readFileSync(bashrc, 'utf8').split('\n').filter((line) => /^\s*export PATH=/.test(line));
  assert.equal(exportLines.length, 1, `.bashrc 应恰好有 1 行 export PATH=,实际:${JSON.stringify(exportLines)}`);
  assert.ok(exportLines[0].includes(prefixBin), `该行应含 ${prefixBin},实际:${exportLines[0]}`);
  assert.ok(!fs.existsSync(path.join(sandbox.home, '.zshrc')), '家目录下不应有 .zshrc');
});
