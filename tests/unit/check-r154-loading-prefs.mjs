#!/usr/bin/env node
// r154 R3:加载动画偏好纯函数(loadingPrefs.js)。
//
// 锁的事:
//   P1 默认值:转速 slow、样式 random(r159 起;原 orbit3);转速取值只有 slow / normal / fast。
//   P2 normalizeLoadingSpeed:合法值原样,非法值(turbo / 空 / null / 大小写不符 / 非字符串)回 slow。
//   P3 readLoadingSpeed / readLoadingStyle:读对应键;读不到、storage 为空、getItem 抛错都回默认;
//      已存过的样式(包括 cli)原样保留。
//
// 跑法:node tests/unit/check-r154-loading-prefs.mjs
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeReport } from './q8-helpers/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const P = await import(pathToFileURL(join(ROOT, 'client', 'src', 'utils', 'loadingPrefs.js')).href);
const report = makeReport('check-r154-loading-prefs');
const mem = (obj) => ({ getItem: (k) => (Object.prototype.hasOwnProperty.call(obj, k) ? obj[k] : null) });
const throwing = { getItem() { throw new Error('SecurityError'); } };

await report.check('P1', '默认值与取值表', 'red', () => {
  assert.equal(P.DEFAULT_LOADING_SPEED, 'slow');
  assert.equal(P.DEFAULT_LOADING_STYLE, 'random'); // r159:默认改为随机
  assert.deepEqual([...P.LOADING_SPEEDS], ['slow', 'normal', 'fast']);
  assert.ok(Object.isFrozen(P.LOADING_SPEEDS));
});

await report.check('P2', 'normalizeLoadingSpeed 非法值回 slow', 'red', () => {
  for (const v of ['slow', 'normal', 'fast']) assert.equal(P.normalizeLoadingSpeed(v), v);
  for (const v of ['turbo', '', null, undefined, 'FAST', ' fast', 1, {}, ['fast']]) {
    assert.equal(P.normalizeLoadingSpeed(v), 'slow', JSON.stringify(v));
  }
});

await report.check('P3', 'readLoadingSpeed / readLoadingStyle 读键、回默认、getItem 抛错', 'red', () => {
  assert.equal(P.readLoadingSpeed(mem({ 'cgui-loading-speed': 'fast' })), 'fast');
  assert.equal(P.readLoadingSpeed(mem({ 'cgui-loading-speed': 'normal' })), 'normal');
  assert.equal(P.readLoadingSpeed(mem({ 'cgui-loading-speed': 'turbo' })), 'slow');
  assert.equal(P.readLoadingSpeed(mem({})), 'slow');
  assert.equal(P.readLoadingSpeed(null), 'slow');
  assert.equal(P.readLoadingSpeed(undefined), 'slow');
  assert.equal(P.readLoadingSpeed(throwing), 'slow');
  // 样式:没存过 → random(r159);存过任何值(包括 cli)→ 原样
  assert.equal(P.readLoadingStyle(mem({})), 'random');
  assert.equal(P.readLoadingStyle(mem({ 'cgui-loading-style': '' })), 'random');
  assert.equal(P.readLoadingStyle(mem({ 'cgui-loading-style': 'cli' })), 'cli');
  assert.equal(P.readLoadingStyle(mem({ 'cgui-loading-style': 'ring' })), 'ring');
  assert.equal(P.readLoadingStyle(mem({ 'cgui-loading-style': 'orbit4' })), 'orbit4');
  assert.equal(P.readLoadingStyle(mem({ 'cgui-loading-style': 'orbit3' })), 'orbit3');
  assert.equal(P.readLoadingStyle(null), 'random');
  assert.equal(P.readLoadingStyle(throwing), 'random');
  // 两个键互不串
  const both = mem({ 'cgui-loading-style': 'fast', 'cgui-loading-speed': 'ring' });
  assert.equal(P.readLoadingSpeed(both), 'slow');
  assert.equal(P.readLoadingStyle(both), 'fast');
});

process.exit(report.finish());
