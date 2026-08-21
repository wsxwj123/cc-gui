#!/usr/bin/env node
// r26-C1【复现+错误路径】:跨渠道 npm 假成功。
// 场景:用户是原生安装(installMethod='native'),却选了 npm 渠道 →
// resolveUpdateMethod('npm','native') 直接回 'npm-registry' → `npm install -g` 装到
// npm 前缀的另一个安装里,而自检 `claude --version` 命中 PATH 上的旧原生安装仍返回 0 →
// UI 报「更新完成」但用户用的那个 CLI 根本没更新。
// 修复后期望:渠道与安装方式不一致时,未经显式确认的裸调用不得静默返回会写别的安装的
// 'npm-registry'(返回 null/抛错/带 mismatch 标记均可);一致的映射保持不变。
// 注意:tests/unit/check-update-channel.mjs t3 钉的是旧(buggy)期望,修复时该锚需同步换。
// Run: node tests/acceptance/r26/c1-npm-cross-channel.mjs
import assert from 'node:assert/strict';
import { makeTmpHome, cleanupDirs } from './lib.mjs';

const TMP_HOME = makeTmpHome('c1'); // version-check 模块顶层固化 PREFS_FILE,先隔离 HOME

const { resolveUpdateMethod } = await import('../../../server/routes/version-check.js');

try {
  // ① 核心:渠道 npm × 安装方式 native(非 npm)—— 不许静默跨安装写
  const cross = resolveUpdateMethod('npm', 'native');
  assert.notEqual(cross, 'npm-registry',
    'C1: 渠道(npm)与安装方式(native)不一致时仍静默走 npm-registry → 装到另一个安装里、自检命中旧版假成功');
  const cross2 = resolveUpdateMethod('npm', 'brew');
  assert.notEqual(cross2, 'npm-registry',
    'C1: brew 安装 + npm 渠道同样不许静默跨安装');

  // ② 一致组合照常(防把正常路径也砍了)
  assert.equal(resolveUpdateMethod('npm', 'npm'), 'npm-registry', 'C1: npm 安装 + npm 渠道必须走 npm');
  assert.equal(resolveUpdateMethod('native', 'native'), 'native', 'C1: 原生安装 + 原生渠道走原生');
  assert.equal(resolveUpdateMethod(null, 'npm'), 'npm-registry', 'C1: 未选渠道跟随 npm 安装方式');
  assert.equal(resolveUpdateMethod(null, 'native'), 'native', 'C1: 未选渠道跟随原生安装方式');
} finally {
  cleanupDirs(TMP_HOME);
}

console.log('PASS r26-c1-npm-cross-channel');
