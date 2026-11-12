#!/usr/bin/env node
// r168 白盒自检(后端):历史读取可在请求方断开时中途停下。
//   - parseJsonl 不传 signal / 传了但没中止:结果与旧行为一致;
//   - 开读前已中止:直接以 AbortError 拒绝;读到一半中止:以 AbortError 拒绝且提前结束
//     (r171:判据改成数实际解析的行数,不比耗时 —— 慢机器 / 高负载下耗时比例会误报)。
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
  const all = await parseJsonl(file);
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

  // 读到一半中止 → 以 AbortError 拒绝(不给半截结果),且提前结束:包一层 JSON.parse 数解析行数,
  // 解析到第 ABORT_AT 行时中止;之后最多再派发当前这一块里已缓冲的行(64KB / 每行约 4KB ≈ 16 行),
  // 中止后解析的行数应远少于全量。只观察,不改解析结果。
  const ABORT_AT = 200;
  const realParse = JSON.parse;
  let parsedLines = 0;
  const mid = new AbortController();
  JSON.parse = function countingParse(text, ...rest) {
    parsedLines += 1;
    if (parsedLines === ABORT_AT) mid.abort();
    return realParse.call(this, text, ...rest);
  };
  try {
    await assert.rejects(parseJsonl(file, { signal: mid.signal }), { name: 'AbortError' });
    // 多等几轮事件循环:读取若没真停,行数还会接着涨
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  } finally {
    JSON.parse = realParse;
  }
  assert.ok(parsedLines >= ABORT_AT && parsedLines < ABORT_AT + 200,
    `中止后应提前结束:共解析 ${parsedLines} 行(全量 ${LINES} 行,在第 ${ABORT_AT} 行中止)`);
} finally {
  unlinkSync(file);
}

// ── 单页大小上限(sliceMessagesForPage)─────────────────────────────────────
const { HISTORY_PAGE_MAX_BYTES, sliceMessagesForPage } = await import('../../server/utils/history-pagination.js');
const bytesOf = (m) => Buffer.byteLength(JSON.stringify(m), 'utf8');
const pageBytes = (msgs) => msgs.reduce((sum, m) => sum + bytesOf(m), 0);
assert.ok(HISTORY_PAGE_MAX_BYTES >= 7 * 1024 * 1024 && HISTORY_PAGE_MAX_BYTES <= 9 * 1024 * 1024, '上限约 8MB');

// 普通会话:条数到 limit 为止,窗口与原来一致
const small = Array.from({ length: 300 }, (_, i) => ({ uuid: `s${i}`, text: '短消息'.repeat(50) }));
const sp = sliceMessagesForPage(small, { limit: 120 });
assert.equal(sp.messages.length, 120);
assert.equal(sp.beforeCursor, 180);
assert.equal(sp.hasMore, true);
assert.equal(sp.total, 300);

// 大消息:从最新往前累计,下一条会超限就停;逐页翻完不重不漏,最后一页游标为 0
const big = Array.from({ length: 30 }, (_, i) => ({ uuid: `b${i}`, out: 'y'.repeat(1_000_000) }));
const first = sliceMessagesForPage(big, { limit: 120 });
assert.equal(first.messages.length, 8, '每条约 1MB → 8 条');
assert.ok(pageBytes(first.messages) <= HISTORY_PAGE_MAX_BYTES);
assert.equal(first.messages.at(-1).uuid, 'b29', '含最新一条');
assert.equal(first.beforeCursor, 22);
assert.equal(first.hasMore, true);
assert.equal(first.total, 30);
const seen = [...first.messages];
let cur = first;
while (cur.hasMore) {
  cur = sliceMessagesForPage(big, { limit: 120, before: cur.beforeCursor });
  assert.ok(pageBytes(cur.messages) <= HISTORY_PAGE_MAX_BYTES);
  assert.equal(cur.total, 30);
  seen.unshift(...cur.messages);
}
assert.equal(cur.beforeCursor, 0);
assert.deepEqual(seen.map((m) => m.uuid), big.map((m) => m.uuid), '拼起来等于全量、无重复');

// 中文按 UTF-8 字节算(每字 3 字节):每条约 3MB → 2 条;按字符数算会给到 8 条
const zh = Array.from({ length: 10 }, (_, i) => ({ uuid: `z${i}`, text: '中'.repeat(1_000_000) }));
assert.equal(sliceMessagesForPage(zh, { limit: 120 }).messages.length, 2);

// 最新一条自己就超限:至少给这 1 条;limit 仍是条数上限
const huge = [...small.slice(0, 5), { uuid: 'h', out: 'z'.repeat(HISTORY_PAGE_MAX_BYTES + 10) }];
const hp = sliceMessagesForPage(huge, { limit: 120 });
assert.deepEqual(hp.messages.map((m) => m.uuid), ['h']);
assert.equal(hp.beforeCursor, 5);
assert.equal(hp.hasMore, true);
assert.equal(sliceMessagesForPage(big, { limit: 3 }).messages.length, 3);

// 不带 limit:全量,不受大小上限影响
const fullPage = sliceMessagesForPage(big, {});
assert.equal(fullPage.messages.length, 30);
assert.equal(fullPage.hasMore, false);
assert.equal(fullPage.beforeCursor, 0);

// before=0 / 空列表:空窗口语义不变
assert.deepEqual(sliceMessagesForPage(big, { limit: 120, before: 0 }), { messages: [], hasMore: false, beforeCursor: null, total: 30 });
assert.deepEqual(sliceMessagesForPage([], { limit: 120 }), { messages: [], hasMore: false, beforeCursor: null, total: 0 });

console.log('check-r168-history-server: OK');
