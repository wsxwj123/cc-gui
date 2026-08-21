#!/usr/bin/env node
// r26-C6【复现(源码钉)+幂等并发】:writeUpdateChannel 绕 prefs 队列。
// 场景:prefs.js 的所有写都走 withPrefsQueue 串行化(读-改-写整段排队);version-check 的
// writeUpdateChannel 却裸 readFileSync+writeFileSync 直写 prefs.json —— 与任何在途的
// 队列写互踩,后写覆盖先写(lost-update):手机端正在 PUT 侧栏偏好时桌面端切更新渠道,
// 其中一路的修改静默丢失。
// 修复后期望:writeUpdateChannel 不得再绕过共享写路径直写 prefs.json(走 prefs.js 的
// 队列/共享写函数)。可观测锚:函数体内不再有对 PREFS_FILE 的裸 readFileSync/writeFileSync。
// 注:lost-update 的确定性行为复现需要在「队列写的读-写之间」插入一次直写,纯 node 无从
// 稳定控制该窗口,故本条用源码钉锚在 bug 本体上;读写回环做行为佐证。
// Run: node tests/acceptance/r26/c6-update-channel-prefs-queue.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmpHome, cleanupDirs } from './lib.mjs';

const TMP_HOME = makeTmpHome('c6'); // 两个模块都在顶层固化 prefs 路径,先隔离 HOME

const vcSrc = readFileSync(new URL('../../../server/routes/version-check.js', import.meta.url), 'utf8');

try {
  const { writeUpdateChannel, readUpdateChannel } = await import('../../../server/routes/version-check.js');

  // 行为佐证:写读回环正常(修前修后都应绿,防修复把基本功能弄坏)
  assert.equal(writeUpdateChannel.length >= 0, true);
  const wr = await writeUpdateChannel('npm');
  assert.notEqual(wr, false, 'C6: 写渠道应成功');
  assert.equal(await readUpdateChannel(), 'npm', 'C6: 写完能读回');
  const raw = JSON.parse(readFileSync(join(TMP_HOME, '.claude-gui', 'prefs.json'), 'utf8'));
  assert.equal(raw.updateChannel, 'npm', 'C6: 落在隔离 HOME 的 prefs.json');

  // 源码钉(修前必红):函数体不得再裸直写 prefs.json
  const m = vcSrc.match(/export function writeUpdateChannel[\s\S]*?\n\}/)
    || vcSrc.match(/export async function writeUpdateChannel[\s\S]*?\n\}/);
  assert.ok(m, 'C6: writeUpdateChannel 应仍存在(改名则本钉子需换锚)');
  assert.ok(
    !/writeFileSync|readFileSync/.test(m[0]),
    'C6: writeUpdateChannel 仍裸 readFileSync/writeFileSync 直写 prefs.json,绕过 withPrefsQueue 与常规写互踩(lost-update)',
  );
} finally {
  cleanupDirs(TMP_HOME);
}

console.log('PASS r26-c6-update-channel-prefs-queue');
