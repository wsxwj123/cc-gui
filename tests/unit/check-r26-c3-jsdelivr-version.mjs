#!/usr/bin/env node
// r26-C3【单测】:jsDelivr 版本号剥 v。
// 验收点(PLAN C3):
//   ①哨兵输入 ['v0.2.318','0.2.317'] → '0.2.318'(剥 v + semver 最大);
//   ②['0.2.318'] → 不变;
//   ③非 semver 脏条目被滤除(原样采用会拼出 vv0.2.x → htmlUrl 404);
//   ④源码钉:fetchJsdelivrLatest 的 latest 必须经 normalizeJsdelivrVersions 计算(防复活)。
// 哨兵验证:修复前 normalizeJsdelivrVersions 不存在(import 即 undefined)→ 全红。
// Run: node tests/unit/check-r26-c3-jsdelivr-version.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeTmpHome, cleanupDirs } from '../acceptance/r26/lib.mjs';

const TMP_HOME = makeTmpHome('c3-unit'); // version-check 顶层固化 PREFS_FILE,先隔离 HOME

try {
  const { normalizeJsdelivrVersions } = await import('../../server/routes/version-check.js');

  // ①剥 v + semver 最大哨兵
  assert.equal(normalizeJsdelivrVersions(['v0.2.318', '0.2.317']), '0.2.318',
    'C3: 带 v 前缀的 tag 必须剥 v 后取 semver 最大(防 vv0.2.318)');
  // ②无 v 前缀不变
  assert.equal(normalizeJsdelivrVersions(['0.2.318']), '0.2.318', 'C3: 无 v 前缀原样');
  // 乱序输入仍取最大(接口号称降序,不轻信)
  assert.equal(normalizeJsdelivrVersions(['0.2.300', 'v0.2.318', '0.2.317']), '0.2.318',
    'C3: 乱序输入取 semver 最大');
  // ③脏条目滤除
  assert.equal(normalizeJsdelivrVersions(['v0.2.318', 'not-a-version', '']), '0.2.318',
    'C3: 非 semver 脏条目滤除');
  assert.equal(normalizeJsdelivrVersions([]), null, 'C3: 空列表 → null');
  assert.equal(normalizeJsdelivrVersions(null), null, 'C3: 非数组 → null(不抛)');
  // 全脏 → null(调用方抛「未返回版本」,不会拼出 vundefined)
  assert.equal(normalizeJsdelivrVersions(['foo']), null, 'C3: 全脏列表 → null');

  // ④源码钉:fetchJsdelivrLatest 必须走 normalizeJsdelivrVersions(剥 v 闸防复活)
  const src = readFileSync(new URL('../../server/routes/version-check.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function fetchJsdelivrLatest'), src.indexOf('async function fetchGitHubLatest'));
  assert.match(fn, /normalizeJsdelivrVersions\(versions\)/, 'C3: fetchJsdelivrLatest 必须经 normalizeJsdelivrVersions 剥 v(防复活哨兵)');
  assert.ok(!/`v\$\{latest\}`/.test(fn) || /normalizeJsdelivrVersions/.test(fn),
    'C3: 拼 tagName 前 latest 已剥 v');
} finally {
  cleanupDirs(TMP_HOME);
}

console.log('PASS check-r26-c3-jsdelivr-version');
