#!/usr/bin/env node
// r26-C7【单测】:缓存源按生效渠道分键。
// 背景:srcKey 与 fetch 选择原按安装方式(method)分键,用户显式选渠道后(如 npm 安装
// 选 native 渠道)版本检查仍按 npm 源取 latest,与更新命令实际走的源不一致。
// 验收点(PLAN C7):resolveSrcKey(channel, method) 纯函数四象限 + 未选跟随两例;
// 源码钉 fetch 选择与缓存分键同走 resolveSrcKey。
// Run: node tests/unit/check-r26-c7-src-key.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeTmpHome, cleanupDirs } from '../acceptance/r26/lib.mjs';

const TMP_HOME = makeTmpHome('c7-unit'); // version-check 顶层固化 PREFS_FILE,先隔离 HOME

try {
  const { resolveSrcKey } = await import('../../server/routes/version-check.js');

  // 四象限(显式渠道 × 安装方式):显式选择永远优先
  assert.equal(resolveSrcKey('native', 'npm'), 'native', 'C7: npm 安装显式选 native 渠道 → native 源(与更新命令同源)');
  assert.equal(resolveSrcKey('native', 'native'), 'native', 'C7: native × native → native');
  assert.equal(resolveSrcKey('npm', 'native'), 'npm', 'C7: native 安装显式选 npm 渠道 → npm 源');
  assert.equal(resolveSrcKey('npm', 'npm'), 'npm', 'C7: npm × npm → npm');
  // 未选跟随安装方式(两例)
  assert.equal(resolveSrcKey(null, 'native'), 'native', 'C7: 未选跟随 native 安装');
  assert.equal(resolveSrcKey(null, 'npm'), 'npm', 'C7: 未选跟随 npm 安装');
  // brew/unknown 未选 → 回落 native(与 effectiveChannel 同口径)
  assert.equal(resolveSrcKey(null, 'brew'), 'native', 'C7: brew 未选回落 native 源');

  // 源码钉:claude-version-check 路由的缓存分键与 fetch 选择都走 resolveSrcKey(防复活)
  const src = readFileSync(new URL('../../server/routes/version-check.js', import.meta.url), 'utf8');
  const start = src.indexOf("router.get('/claude-version-check'");
  const end = src.indexOf("router.post('/claude-update'");
  const routeBody = src.slice(start, end);
  assert.match(routeBody, /const channel = readUpdateChannel\(\);/, 'C7: 路由先读显式渠道');
  assert.match(routeBody, /resolveSrcKey\(channel, method\)/,
    'C7: 缓存分键必须按生效渠道(显式渠道 + 安装方式经 resolveSrcKey)');
  assert.match(routeBody, /srcKey === 'native'\s*\?\s*await fetchNativeLatest\(\)/,
    'C7: fetch 选择必须与缓存分键同键(srcKey 驱动,而非裸 method)');
  assert.ok(!/method === 'native' \? 'native' : 'npm'/.test(routeBody),
    'C7: 不得再按裸安装方式分键(旧 bug 形态防复活)');
} finally {
  cleanupDirs(TMP_HOME);
}

console.log('PASS check-r26-c7-src-key');
