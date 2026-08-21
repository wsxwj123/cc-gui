#!/usr/bin/env node
// r26-D12【单测·服务端半】:PUT /prefs/display-name 称呼按码点截断。
// 验收点(PLAN D12):
//   ①21 个 emoji → 截断后 20 个完整 emoji、无孤代理(lone surrogate 检测哨兵);
//   ②20 个内 CJK 不变;
//   ③混合形态(CJK+emoji 超 20 码点)截断后仍无孤代理、长度恰 20 码点;
//   ④落盘值与响应一致(持久化口径同一个截断结果)。
// 前端半(SettingsPanel DisplayNameInput onChange 辅助)归 PKG-6,契约 C-D12:
// 两侧截断对同输入等长 —— 本测试的期望值即前端辅助函数的同矩阵断言基准。
// Run: node tests/unit/check-r26-d12-display-name-codepoints.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmpHome, cleanupDirs, listenWithRetry, stopServer } from '../acceptance/r26/lib.mjs';

const TMP_HOME = makeTmpHome('d12-unit'); // prefs.js 顶层固化 PREFS_PATH,先隔离 HOME

// 孤代理 = 高代理后没跟低代理,或低代理前没有高代理(合法 emoji 是成对代理,不匹配)。
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const codePoints = (s) => [...s].length;

const express = (await import('express')).default;
const prefsRouter = (await import('../../server/routes/prefs.js')).default;

const app = express();
app.use(express.json());
app.use('/api', prefsRouter);

let server = null;
let failure = null;
try {
  server = await listenWithRetry(6703, (p) => app.listen(p, '127.0.0.1'));
  const BASE = 'http://127.0.0.1:6703';
  const putName = (displayName) => fetch(`${BASE}/api/prefs/display-name`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName }),
  }).then((r) => r.json());

  // ①孤代理哨兵:21 个 🙂(每个 2 码元)→ 20 个完整 emoji,无孤代理
  const emoji21 = '🙂'.repeat(21);
  const r1 = await putName(emoji21);
  assert.equal(r1.ok, true, 'D12: PUT 应成功');
  assert.equal(codePoints(r1.displayName), 20, `D12: 21 emoji 应截为 20 码点,实际 ${codePoints(r1.displayName)}`);
  assert.ok(!LONE_SURROGATE_RE.test(r1.displayName), 'D12: 截断结果不得含孤代理(修前 slice 按码元切必出)');
  assert.equal(r1.displayName, '🙂'.repeat(20), 'D12: 截断结果应为 20 个完整 emoji');

  // ②CJK 哨兵:20 个内汉字不变(BMP 字符码点=码元,不应被改动)
  const cjk = '柚子爱吃水果呀'; // 7 码点
  const r2 = await putName(cjk);
  assert.equal(r2.displayName, cjk, 'D12: 20 码点内 CJK 原样保留');
  // 恰 20 码点 CJK 边界
  const cjk20 = '一二三四五六七八九十一二三四五六七八九十';
  assert.equal(codePoints(cjk20), 20, 'D12 夹具:cjk20 应恰 20 码点');
  const r2b = await putName(cjk20);
  assert.equal(r2b.displayName, cjk20, 'D12: 恰 20 码点 CJK 不截断');

  // ③混合形态:10 CJK + 11 emoji = 21 码点 → 截 20 码点(10 CJK + 10 emoji),无孤代理
  const mixed = 'abcdefghij' + '🎉'.repeat(11);
  assert.equal(codePoints(mixed), 21, 'D12 夹具:mixed 应 21 码点');
  const r3 = await putName(mixed);
  assert.equal(codePoints(r3.displayName), 20, 'D12: 混合形态截为 20 码点');
  assert.ok(!LONE_SURROGATE_RE.test(r3.displayName), 'D12: 混合形态截断无孤代理');
  assert.equal(r3.displayName, 'abcdefghij' + '🎉'.repeat(10), 'D12: 混合截断内容精确');

  // ③b 孤代理真触发哨兵:19 BMP + 1 emoji = 21 码元,修前 slice(0,20) 恰把代理对劈开
  // (19 码元 + 高代理),本条断言在修前必然红;修后按码点截 = 19 BMP + 1 emoji 共 20 码点。
  const edge = 'x'.repeat(19) + '🙂';
  const r3c = await putName(edge);
  assert.equal(codePoints(r3c.displayName), 20, 'D12: 19BMP+emoji 应为 20 码点(修前切出孤代理)');
  assert.ok(!LONE_SURROGATE_RE.test(r3c.displayName), 'D12: 代理对边界截断不得含孤代理(修前本条必红)');
  assert.equal(r3c.displayName, edge, 'D12: 20 码点整好放下,内容应原样');

  // 前后空白先 trim 再截(既有语义保持)
  const r3b = await putName('  ' + '🙂'.repeat(21) + '  ');
  assert.equal(r3b.displayName, '🙂'.repeat(20), 'D12: trim 后截断语义不变');

  // ④落盘口径一致
  const raw = JSON.parse(readFileSync(join(TMP_HOME, '.claude-gui', 'prefs.json'), 'utf8'));
  assert.equal(raw.displayName, '🙂'.repeat(20), 'D12: 落盘值与响应一致(同一截断结果)');
  assert.ok(!LONE_SURROGATE_RE.test(raw.displayName), 'D12: 落盘值同样无孤代理');

  // 空串=清除(既有语义回归)
  const r4 = await putName('');
  assert.equal(r4.displayName, '', 'D12: 空串清除语义不变');
  const raw2 = JSON.parse(readFileSync(join(TMP_HOME, '.claude-gui', 'prefs.json'), 'utf8'));
  assert.equal(raw2.displayName, undefined, 'D12: 空串后 prefs 中 displayName 键应删除');
} catch (e) {
  failure = e;
} finally {
  await stopServer(server);
  cleanupDirs(TMP_HOME);
}
if (failure) throw failure;

console.log('PASS check-r26-d12-display-name-codepoints');
