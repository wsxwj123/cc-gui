#!/usr/bin/env node
// r168 白盒自检(后端):历史读取可在请求方断开时中途停下。
//   - parseJsonl 不传 signal / 传了但没中止:结果与旧行为一致;
//   - 开读前已中止:直接以 AbortError 拒绝;读到一半中止:以 AbortError 拒绝且提前结束。
import assert from 'node:assert/strict';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseJsonl } from '../../server/utils/jsonl-parser.js';

const file = join(tmpdir(), `r168-history-${process.pid}-${Date.now()}.jsonl`);
const LINES = 12000;
const pad = 'x'.repeat(4000);
writeFileSync(file, `${Array.from({ length: LINES }, (_, i) => JSON.stringify({ i, pad })).join('\n')}\n`);
try {
  // 不传 signal:逐字旧行为
  const t0 = performance.now();
  const all = await parseJsonl(file);
  const fullMs = performance.now() - t0;
  assert.equal(all.length, LINES);
  assert.equal(all[LINES - 1].i, LINES - 1);

  // 传了 signal 但没中止:结果相同;limit / skip 仍生效
  const idle = new AbortController();
  assert.equal((await parseJsonl(file, { signal: idle.signal })).length, LINES);
  const head = await parseJsonl(file, { limit: 10, skip: 5, signal: idle.signal });
  assert.deepEqual(head.map((r) => r.i), [5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);

  // 开读前已中止 → 直接拒绝
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(parseJsonl(file, { signal: pre.signal }), { name: 'AbortError' });

  // 读到一半中止 → 以 AbortError 拒绝(不给半截结果),且明显早于读完全量
  const mid = new AbortController();
  const t1 = performance.now();
  const pending = parseJsonl(file, { signal: mid.signal });
  setTimeout(() => mid.abort(), 5);
  await assert.rejects(pending, { name: 'AbortError' });
  const abortedMs = performance.now() - t1;
  assert.ok(abortedMs < Math.max(fullMs * 0.6, 5 + 30),
    `中止后应提前结束:中止用时 ${abortedMs.toFixed(1)}ms,读完全量 ${fullMs.toFixed(1)}ms`);
} finally {
  unlinkSync(file);
}

console.log('check-r168-history-server: OK');
