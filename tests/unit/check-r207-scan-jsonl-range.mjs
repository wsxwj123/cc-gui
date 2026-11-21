#!/usr/bin/env node
// r207 自检:scanJsonlRange(快速扫描)。
//   ① 断行 / 空白行 / 坏行 / 末尾没换行 / 多字节 / U+2028 与 readline 版 parseJsonl 逐条相同(含被 4MB 块边界切开的 \r\n、
//      U+2028/U+2029、多字节字符,以及跨好几块的长行);requireNewline 两种取值;
//   ② 行首 type 跳过(不解析)、看不出就照常解析;leadingRecordType 各种写法;
//   ③ 范围:非法 → RangeError;越界按文件大小;start 在行中间 / 在 \r\n 中间;读的时候变短 → shortRead;
//      不存在 / 目录 / 命名管道 → 抛错且不阻塞;中止 → AbortError;进展回调;
//   ④ getSessionMessages:元数据行跳过后结果不变;「跳过类型 + 同 uuid」与逐条全解析时一样(后来那条被去重)。
// 临时 HOME,不起服务。node tests/unit/check-r207-scan-jsonl-range.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, truncateSync, realpathSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'cgui-r207-scan-')));
const HOME = join(TMP, 'home');
process.env.HOME = HOME; process.env.USERPROFILE = HOME; process.env.CGUI_DISABLE_FILE_WATCHER = '1';
const PROJECT = '-tmp-r207-scan';
const PROJECT_DIR = join(HOME, '.claude', 'projects', PROJECT);
mkdirSync(PROJECT_DIR, { recursive: true });

const { scanJsonlRange, parseJsonl, leadingRecordType, SCAN_CHUNK_BYTES: B } = await import('../../server/utils/jsonl-parser.js');
const { getSessionMessages } = await import('../../server/services/session-reader.js');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed += 1; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); passed += 1; };
let fileNo = 0;
const write = (content) => { const f = join(TMP, `f${fileNo++}.jsonl`); writeFileSync(f, content); return f; };
const scanAll = async (file, opts = {}) => {
  const records = [];
  const offsets = [];
  const res = await scanJsonlRange(file, { requireNewline: false, ...opts, onRecord: (r, off) => { records.push(r); offsets.push(off); } });
  return { records, offsets, ...res };
};
const sameAsReadline = async (content, msg) => {
  const file = typeof content === 'string' || Buffer.isBuffer(content) ? write(content) : content;
  const want = await parseJsonl(file);
  const got = await scanAll(file);
  eq(got.records, want, msg);
  return { file, got, want };
};
// 恰好 bytes 字节的一行 JSON(ASCII 填充,可选在末尾放一段多字节文字)
const padLine = (bytes, tail = '') => {
  const t = Buffer.byteLength(tail);
  return `{"pad":"${'x'.repeat(bytes - 10 - t)}${tail}"}`;
};

// ── ① 与 readline 同口径 ───────────────────────────────────────────────
{
  const rec = (i) => JSON.stringify({ i, text: `第${i}行「引用"内容"」😀` });
  const seps = ['\n', '\r\n', '\r', ' ', ' '];
  const parts = [];
  for (let i = 0; i < 60; i++) {
    parts.push(rec(i));
    parts.push(seps[i % seps.length]);
    if (i % 7 === 0) parts.push('   \n');          // 只有空白的行
    if (i % 11 === 0) parts.push('{坏行\n');         // 坏 JSON
    if (i % 13 === 0) parts.push('\n\r\n');          // 空行
  }
  parts.push(JSON.stringify({ last: true, s: 'a b' }));   // JSON.stringify 不转义 U+2028:readline 会把它切成两半(两半都是坏行)
  parts.push('\n{"tail":"末行没有换行"}');
  await sameAsReadline(parts.join(''), '混合断行、空白行、坏行、U+2028、末行没换行:与 readline 逐条相同');
  const { file } = await sameAsReadline('{"a":1}\n{"b":2}', '小文件末行没换行');
  const strict = await scanAll(file, { requireNewline: true });
  eq(strict.records, [{ a: 1 }], 'requireNewline:true → 没写完换行的末行不算');
  eq(strict.endOffset, 8, 'requireNewline:true → endOffset 停在最后一个换行之后');
  const loose = await scanAll(file);
  eq(loose.endOffset, 15, 'requireNewline:false → 末段算一行,endOffset = 文件尾');
  eq((await scanAll(write('{"a":1}\r'), { requireNewline: true })).records, [{ a: 1 }], '末尾单独的 \\r 也是换行');
  eq((await scanAll(write(''))).records, [], '空文件');
}

// ── ① 被块边界切开的断行 / 多字节,跨块长行 ─────────────────────────────────
{
  const after = '\n{"next":1}\n{"next":2}';
  // \r 是第一块最后一个字节,\n 是第二块第一个字节 → 一个断行
  await sameAsReadline(`${padLine(B - 1)}\r\n{"x":1}${after}`, '\\r\\n 被块边界切开');
  await sameAsReadline(`${padLine(B - 1)}\r{"x":1}${after}`, '块尾单独的 \\r');
  for (const sep of [' ', ' ']) {
    for (const k of [1, 2]) {   // E2 落在第一块倒数第 k 个字节
      await sameAsReadline(`${padLine(B - k)}${sep}{"x":1}${after}`, `U+${sep.charCodeAt(0).toString(16)} 从块尾倒数第 ${k} 个字节切开`);
    }
  }
  for (const [ch, size] of [['…', 3], ['中', 3], ['😀', 4]]) {   // 多字节字符跨块(… 的首字节也是 E2,但不是断行)
    for (let k = 1; k < size; k++) {
      const line = padLine(B + (size - k) + 2, ch);   // 让字符的第一个字节落在 B - k
      const head = Buffer.from(line).subarray(0, B);
      ok(head[B - k] >= 0xE0, `夹具:${ch} 的首字节在块尾倒数第 ${k} 个`);
      await sameAsReadline(`${line}${after}`, `${ch} 跨块(切在第 ${k} 个字节后)`);
    }
  }
  await sameAsReadline(`${padLine(B)}\n{"x":1}${after}`, '一行正好占满第一块,换行在第二块开头');
  const long = `${padLine(18 * 1024 * 1024 + 7, '尾巴😀')}\r\n${padLine(3 * B + 5)}\n{"y":2}`;
  const { file, got } = await sameAsReadline(long, '18MB 与 12MB 的长行跨好几块');
  eq(got.offsets, [0, Buffer.byteLength(long) - Buffer.byteLength(`${padLine(3 * B + 5)}\n{"y":2}`), Buffer.byteLength(long) - 7], '每条记录的行首偏移');
  const progress = [];
  await scanJsonlRange(file, { requireNewline: false, onProgress: (b) => progress.push(b) });
  ok(progress.length >= 8 && progress.every((b, i) => i === 0 || b > progress[i - 1]), `进展按块单调增加(${progress.length} 次)`);
  eq(progress.at(-1), Buffer.byteLength(long), '最后一次进展 = 读到的全部字节');
}

// ── ② 行首 type 跳过 ────────────────────────────────────────────────────
{
  eq(leadingRecordType(Buffer.from('{"type":"api-request","x":1}')), 'api-request', '第一个键就是 type');
  eq(leadingRecordType(Buffer.from('{"parentUuid":null,"isSidechain":true,"promptId":"p\\"q","n":-1.5e3,"type":"user","message":{}}')), 'user', 'type 前都是标量(含转义字符串、null、数字)');
  eq(leadingRecordType(Buffer.from('{"parentUuid":"a","message":{"type":"x"},"type":"assistant"}')), null, 'type 前有对象值 → 看不出');
  eq(leadingRecordType(Buffer.from('{ "type":"x"}')), null, '有空白 → 看不出');
  eq(leadingRecordType(Buffer.from('{"a":1}')), null, '没有 type');
  eq(leadingRecordType(Buffer.from('{"ty\\u0070e":"x"}')), null, '键带转义 → 看不出');
  eq(leadingRecordType(Buffer.from('{"type":"a\\"b"}')), null, 'type 值带转义 → 看不出');
  eq(leadingRecordType(Buffer.from('{"type":null}')), null, 'type 不是字符串');
  eq(leadingRecordType(Buffer.from('[1]')), null, '不是对象');

  const lines = [
    '{"type":"api-request-blob","hash":"h","message":{"content":"大段"}}',
    '{"parentUuid":"p","isSidechain":false,"type":"user","uuid":"u1","message":{"role":"user","content":"问"}}',
    '{"parentUuid":"p","message":{"id":"m"},"type":"assistant","uuid":"a1"}',
    '{"type":"queue-operation","operation":"enqueue"}',
    '{"type":"user","uuid":"u2"}',
  ];
  const file = write(`${lines.join('\n')}\n`);
  const realParse = JSON.parse;
  let parsedTexts = [];
  JSON.parse = function patched(text, ...rest) { parsedTexts.push(text); return realParse.call(this, text, ...rest); };
  let got;
  try {
    got = await scanAll(file, { skipTypes: (t) => t !== 'user' && t !== 'assistant' });
  } finally { JSON.parse = realParse; }
  eq(got.records.map((r) => r.uuid), ['u1', 'a1', 'u2'], '跳过两条元数据行,其余照常');
  ok(!parsedTexts.some((t) => t.includes('api-request-blob') || t.includes('queue-operation')), '被跳过的行没有 JSON.parse');
  parsedTexts = [];
  JSON.parse = function patched(text, ...rest) { parsedTexts.push(text); return realParse.call(this, text, ...rest); };
  try {
    got = await scanAll(file, { skipTypes: (t) => t !== 'assistant' });
  } finally { JSON.parse = realParse; }
  eq(got.records.map((r) => r.uuid), ['a1'], '只留助手:行首看得出是 user 的也跳过,看不出的(type 在对象值后面)照常解析');
  eq(parsedTexts.length, 1, '只解析了一行');
}

// ── ③ 范围、变短、消失、非普通文件、中止 ───────────────────────────────────
{
  const content = '{"a":1}\n{"b":2}\r\n{"c":3} {"d":4}\n';
  const file = write(content);
  const len = Buffer.byteLength(content);
  for (const bad of [{ start: -1 }, { start: 1.5 }, { start: NaN }, { start: '1' }, { start: 2 ** 53 }, { start: 5, end: 4 }, { end: -1 }, { end: 2.5 }]) {
    await assert.rejects(scanJsonlRange(file, bad), RangeError, `非法范围 ${JSON.stringify(bad)} → RangeError`); passed += 1;
  }
  const whole = await scanAll(file, { end: len + 100 });
  eq(whole.records.length, 4, 'end 超过文件大小 → 按文件大小');
  eq(whole.endOffset, len, 'endOffset = 实际读到哪');
  eq((await scanAll(file, { start: 3 })).records, [{ b: 2 }, { c: 3 }, { d: 4 }], 'start 在行中间 → 第一行残片丢掉');
  eq((await scanAll(file, { start: 8 })).records, [{ b: 2 }, { c: 3 }, { d: 4 }], 'start 正好在行首');
  eq((await scanAll(file, { start: 16 })).records, [{ c: 3 }, { d: 4 }], 'start 落在 \\r\\n 中间(\\n 处)→ 下一行照常');
  eq((await scanAll(file, { start: 17, end: 24 })).records, [{ c: 3 }], '[行首, 行首) 只读这段');
  eq((await scanAll(file, { start: 27 })).records, [{ d: 4 }], 'start 紧跟 U+2028 → 行首');
  eq((await scanAll(file, { start: 26 })).records, [], 'start 落在 U+2028 的三个字节中间 → 那一行算残片');
  eq((await scanAll(file, { start: len, end: len })).records, [], '空范围');

  // 读的时候文件变短:第一块读完(进展回调)时把文件截到 1MB
  const big = write(`${Array.from({ length: 3000 }, (_, i) => padLine(3000 + (i % 7))).join('\n')}\n`);
  let truncated = false;
  const res = await scanJsonlRange(big, { requireNewline: true, onProgress: () => { if (!truncated) { truncated = true; truncateSync(big, 1024 * 1024); } } });
  ok(res.shortRead === true, '读时变短 → shortRead:true');
  ok(res.endOffset <= B, `停在实际读到的位置(${res.endOffset})`);

  await assert.rejects(scanJsonlRange(join(TMP, 'nope.jsonl')), { code: 'ENOENT' }); passed += 1;
  await assert.rejects(scanJsonlRange(TMP), { code: 'EISDIR' }); passed += 1;
  if (process.platform !== 'win32') {
    const { execFileSync } = await import('node:child_process');
    const fifo = join(TMP, 'pipe.jsonl');
    execFileSync('mkfifo', [fifo]);
    const t0 = Date.now();
    await assert.rejects(scanJsonlRange(fifo), { code: 'EINVAL' }); passed += 1;
    ok(Date.now() - t0 < 2000, '命名管道没有写入方也不阻塞');
    unlinkSync(fifo);
  }

  const pre = new AbortController();
  pre.abort();
  await assert.rejects(scanJsonlRange(file, { signal: pre.signal }), { name: 'AbortError' }); passed += 1;
  const mid = new AbortController();
  const seen = [];
  await assert.rejects(scanJsonlRange(file, { signal: mid.signal, onRecord: (r) => { seen.push(r); if (seen.length === 2) mid.abort(); } }), { name: 'AbortError' });
  eq(seen.length, 2, '中止后不再交出记录');
}

// ── ④ getSessionMessages:元数据行跳过,结果不变;跳过类型 + 同 uuid ───────────────
{
  const sid = '20720720-0000-4000-8000-000000000001';
  const ts = (n) => new Date(Date.parse('2026-11-21T08:00:00.000Z') + n * 1000).toISOString();
  const user = (i, uuid, text) => ({ parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: text }, uuid, timestamp: ts(i), sessionId: sid });
  const asst = (i, uuid) => ({ parentUuid: null, isSidechain: false, message: { id: `m${i}`, type: 'message', role: 'assistant', model: 'r207-model', content: [{ type: 'text', text: `答${i}` }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }, type: 'assistant', uuid, timestamp: ts(i), sessionId: sid });
  const meta = { type: 'queue-operation', operation: 'enqueue', timestamp: ts(0), sessionId: sid, content: '排队' };
  const plain = [user(1, 'u1', '问一'), asst(2, 'a1'), user(3, 'u2', '问二'), asst(4, 'a2')];
  const withMeta = plain.flatMap((r) => [{ type: 'api-request-shape', sessionId: sid, shapeHash: 'x' }, r, meta]);
  writeFileSync(join(PROJECT_DIR, `${sid}.jsonl`), `${plain.map((r) => JSON.stringify(r)).join('\n')}\n`);
  const a = await getSessionMessages(sid, PROJECT, { limit: 120 });
  writeFileSync(join(PROJECT_DIR, `${sid}.jsonl`), `${withMeta.map((r) => JSON.stringify(r)).join('\n')}\n`);
  const b = await getSessionMessages(sid, PROJECT, { limit: 120 });
  eq(b, a, '插了元数据行的会话,返回与没插时逐字段相同');
  // 元数据行带着与后面一条用户记录相同的 uuid:逐条全解析时,先见到的元数据行占住 uuid,后面那条用户记录被去重
  const dup = [{ type: 'queue-operation', operation: 'enqueue', uuid: 'u2', sessionId: sid }, ...plain];
  writeFileSync(join(PROJECT_DIR, `${sid}.jsonl`), `${dup.map((r) => JSON.stringify(r)).join('\n')}\n`);
  const c = await getSessionMessages(sid, PROJECT);
  const texts = c.messages.filter((m) => m.type === 'user').map((m) => m.text);
  eq(texts, ['问一'], '跳过类型的行带 uuid → 照常解析,去重结果与原来相同(「问二」被去重)');
  const events = [];
  await getSessionMessages(sid, PROJECT, { onProgress: (e) => events.push(e) });
  eq(events[0], { step: 'open', regularFile: true, bytes: 0 }, '先报一次 open(普通文件)');
  eq(events.map((e) => e.step).filter((s, i, arr) => arr.indexOf(s) === i), ['open', 'read', 'sidecar', 'assemble', 'subagents', 'page'], '各步依次回报');
}

console.log(`check-r207-scan-jsonl-range: OK (${passed} assertions)`);
