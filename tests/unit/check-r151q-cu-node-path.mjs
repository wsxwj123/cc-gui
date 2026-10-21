// r151q 第 15 项:电脑操控状态接口的 nodePath —— 带版本号的安装目录下改给 PATH 上真实路径相同的稳定路径。
// 只测纯函数 stableNodePath(只读文件系统);布局全部造在本测试自己的临时目录里,不碰真实 node / 家目录。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';

const { stableNodePath } = await import('../../server/routes/computer-use.js');

const root = mkdtempSync(join(tmpdir(), 'cgui-r151q-cu-node-'));
const file = (p) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, '#!/bin/sh\n'); return p; };
const link = (target, p) => { mkdirSync(join(p, '..'), { recursive: true }); symlinkSync(target, p); return p; };
try {
  // Homebrew 式:Cellar 下带版本号的真身 + bin 下指向它的相对链接
  const cellarNode = file(join(root, 'opt', 'homebrew', 'Cellar', 'node', '25.9.0_1', 'bin', 'node'));
  const brewBin = join(root, 'opt', 'homebrew', 'bin');
  const stable = link(join('..', 'Cellar', 'node', '25.9.0_1', 'bin', 'node'), join(brewBin, 'node'));
  // 无关的另一个 node、断链、nvm 式带版本号目录、不带版本号的普通安装
  const otherBin = join(root, 'other', 'bin'); file(join(otherBin, 'node'));
  const brokenBin = join(root, 'broken', 'bin'); link(join(root, 'nope', 'node'), join(brokenBin, 'node'));
  const nvmBin = join(root, '.nvm', 'versions', 'node', 'v20.1.0', 'bin'); const nvmNode = file(join(nvmBin, 'node'));
  const plainNode = file(join(root, 'usr', 'local', 'bin', 'node'));
  const aliasBin = join(root, 'alias', 'bin'); link(plainNode, join(aliasBin, 'node'));
  const P = (...dirs) => dirs.join(delimiter);

  assert.equal(stableNodePath(cellarNode, P(brewBin), 'darwin'), stable, 'Cellar 下的 node + PATH 上的稳定链接 → 稳定路径');
  assert.equal(stableNodePath(cellarNode, P(otherBin, brokenBin, 'relative/bin', '', brewBin), 'darwin'), stable,
    '跳过真实路径不同的、断链的、相对的、空的 PATH 项,找到稳定链接');
  assert.equal(stableNodePath(cellarNode, P(otherBin), 'darwin'), cellarNode, 'PATH 上没有同一个 node → 照旧');
  assert.equal(stableNodePath(cellarNode, undefined, 'darwin'), cellarNode, '没有 PATH → 照旧');
  assert.equal(stableNodePath(cellarNode, P(brewBin), 'win32'), cellarNode, 'Windows 原样返回');
  assert.equal(stableNodePath(nvmNode, P(nvmBin), 'darwin'), nvmNode, 'nvm 式:PATH 上只有带版本号的同一路径 → 照旧');
  assert.equal(stableNodePath(plainNode, P(aliasBin), 'darwin'), plainNode, '不在带版本号的目录里 → 不改(不换成别处的链接)');
  const gone = join(root, 'opt', 'homebrew', 'Cellar', 'node', '24.0.0', 'bin', 'node');
  assert.equal(stableNodePath(gone, P(brewBin), 'darwin'), gone, 'execPath 不存在 → 照旧');
  assert.equal(stableNodePath('relative/25.1.0/node', P(brewBin), 'darwin'), 'relative/25.1.0/node', '相对 execPath → 照旧');
  console.log('PASS check-r151q-cu-node-path(9 项)');
} finally {
  rmSync(root, { recursive: true, force: true }); // 只清本测试自己 mkdtemp 出来的目录
}
