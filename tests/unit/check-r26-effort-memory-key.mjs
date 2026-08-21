#!/usr/bin/env node
// r26-F6:per-model 力度记忆键跨 provider 串味 → 键加 provider 段。
// 哨兵:①同 modelId 不同 providerHint → 两个键不等(串味哨兵);
//       ②读写同键自洽(effortMemoryKey 是纯函数,同一输入同一键);
//       ③[1m] 后缀剥除(1M 变体与本体同记忆);
//       ④ChatInput 读/写两处都走 effortMemoryKey(源码哨兵,防一处漏换);
//       ⑤旧键形态 `cgui-effort-<id>`(无 provider 段)不再被读(一次性忽略语义)。
// Run: node tests/unit/check-r26-effort-memory-key.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { effortMemoryKey } from '../../client/src/utils/effortCaps.js';

// ①②③
assert.notEqual(effortMemoryKey('deepseek', 'm1'), effortMemoryKey('anthropic', 'm1'),
  'F6: 同 modelId 不同 provider 必须不同键(串味哨兵)');
assert.equal(effortMemoryKey('deepseek', 'm1'), effortMemoryKey('deepseek', 'm1'), 'F6: 读写同键自洽');
assert.equal(effortMemoryKey('deepseek', 'm1[1m]'), effortMemoryKey('deepseek', 'm1'),
  'F6: [1m] 后缀剥除(与 effortCapsFor 同口径)');
assert.equal(effortMemoryKey(undefined, 'm1'), 'cgui-effort-anthropic-m1', 'F6: 缺省 provider 回落 anthropic');
assert.equal(effortMemoryKey('deepseek', 'm1'), 'cgui-effort-deepseek-m1', 'F6: 键形态 cgui-effort-<provider>-<modelId>');

// ④⑤ ChatInput 源码锚
const src = readFileSync(new URL('../../client/src/components/ChatInput.jsx', import.meta.url), 'utf8');
const writeHit = (src.match(/localStorage\.setItem\(effortMemKey/g) || []).length;
const readHit = (src.match(/localStorage\.getItem\(effortMemKey/g) || []).length;
assert.equal(writeHit, 1, 'F6: 写记忆必须走 effortMemKey(恰好一处)');
assert.equal(readHit, 1, 'F6: 读记忆必须走 effortMemKey(恰好一处)');
assert.doesNotMatch(src, /localStorage\.(set|get)Item\(`cgui-effort-\$\{/,
  'F6: 旧键形态(无 provider 段)不得再读写');

console.log('PASS check-r26-effort-memory-key');
