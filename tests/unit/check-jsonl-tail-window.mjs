#!/usr/bin/env node
// 守卫:readTailWindow 从 EOF 向前回读时,**块边界落在行中间**产生的残片不许当整行 push。
//
// 旧实现在首次迭代(p===0)无条件把 region[0..首个断行符] 当一条完整行收下,可这段的
// 左半截还在更靠前的一块里 → 同一行被拆成两条"半行"(一条没闭合、一条没开头),两条都
// JSON.parse 失败。生产后果:tailRaw40 尾部丢记录 / messageCount 与实际消息视图对不上。
// 256KB 块不可能正好是行长整数倍 → 这不是罕见边界,是常态。
//
// 本文件锁住(全部对照"字节级参考实现"= readline(crlfDelay:Infinity) 语义):
//   ① 跨 1/2/3+ 块的尾窗每条都能 JSON.parse,且与 readJsonlEdges 的 tailRaw 逐字一致;
//   ② 恰好一块 / 多一字节 / 少一字节 / 恰两块 / 末行无 \n / 空文件 / size=0;
//   ③ blockBytes=1024 的 fuzz 对拍(行尾 \r\n、孤立 \r、U+2028、U+2029 都算断行符);
//   ④ startOffset = 返回首行的字节偏移(修前残片被当整行时它也一起偏)。
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTailWindow, readJsonlEdges } from '../../server/utils/jsonl-parser.js';

const dir = mkdtempSync(join(tmpdir(), 'cgui-tailwin-'));
let seq = 0;
const w = (buf) => { const p = join(dir, `f${seq++}.jsonl`); writeFileSync(p, buf); return p; };
const json = (o) => JSON.stringify(o);

/**
 * 字节级参考实现:与 readline(crlfDelay: Infinity) 同断行语义 —— \n、\r\n(算一次)、
 * 孤立 \r、U+2028、U+2029 都是行终止符。行尾 \r 被吃进断行符里,故正文不含尾 \r。
 * 返回 [{ off, text }](文件顺序,非空行)。
 */
function refLines(buf) {
  const out = [];
  let start = 0;
  for (let i = 0; i < buf.length;) {
    const b = buf[i];
    if (b === 0x0A) { out.push([start, i]); start = ++i; }
    else if (b === 0x0D) { out.push([start, i]); i += buf[i + 1] === 0x0A ? 2 : 1; start = i; }
    else if (b === 0xE2 && buf[i + 1] === 0x80 && (buf[i + 2] === 0xA8 || buf[i + 2] === 0xA9)) { out.push([start, i]); i += 3; start = i; }
    else i++;
  }
  if (start < buf.length) out.push([start, buf.length]);
  return out.map(([s, e]) => ({ off: s, text: buf.subarray(s, e).toString('utf-8') })).filter((l) => l.text.trim());
}

/** 参考实现的尾窗:最后 minLines 条非空行 + 首行偏移(一条都没取到 = size)。 */
function refTail(buf, minLines) {
  const all = refLines(buf);
  const t = all.slice(-minLines);
  return { lines: t.map((l) => l.text), startOffset: t.length ? t[0].off : buf.length };
}

/** 每行恰好 len 字节(含行尾 \n)的 JSON 行。 */
function mkLine(i, len) {
  const pad = len - 1 - json({ i, pad: '' }).length;
  return json({ i, pad: 'p'.repeat(pad) }) + '\n';
}
/** lens 指定每行字节数;trailingNewline=false 时末行不含 \n(长度 = lens 末项 - 1)。 */
function mkFile(lens, trailingNewline = true) {
  const last = lens.length - 1;
  const rows = lens.map((L, i) => mkLine(i, i === last && !trailingNewline ? L - 1 : L));
  return Buffer.from(rows.join(''));
}
const allParse = (lines, msg) => lines.forEach((l, i) => assert.doesNotThrow(() => JSON.parse(l), `${msg}: 第 ${i} 条不是完整行`));
// readJsonlEdges 的 tail 是**解析后**的记录(坏行直接丢,不占名额),故对拍要按同口径过滤。
const parsable = (lines) => lines.map((l) => { try { return JSON.parse(l); } catch { return undefined; } }).filter((x) => x !== undefined);

try {
  // ── 1. 复现用例:200 行 × 约 9KB(总 ~1.85MB,默认 256KB 块跨 8 次)──────────
  // 修前:返回 40 条里 2 条 JSON.parse 失败,且这两条是同一条记录的两半。
  {
    const buf = mkFile(Array.from({ length: 200 }, (_, i) => 9 * 1024 + (i % 7)));
    const p = w(buf);
    const got = await readTailWindow(p, buf.length, { minLines: 40 });
    assert.equal(got.lines.length, 40, '尾窗应取满 40 条非空行');
    allParse(got.lines, '9KB 行 × 200');
    assert.deepEqual(got, refTail(buf, 40), '与参考实现逐字一致');
    const edges = await readJsonlEdges(p, 40);
    assert.deepEqual(parsable(got.lines), edges.tail, '与 readJsonlEdges 的 tailRaw 逐字一致');
  }

  // ── 2. 跨两块 / 跨三块以上(默认 256KB 块)──────────────────────────────
  {
    for (const [nLines, size] of [[300, 2048], [900, 1024], [1200, 512]]) {
      const buf = mkFile(Array.from({ length: nLines }, (_, i) => size + (i * 37) % 64));
      const p = w(buf);
      const got = await readTailWindow(p, buf.length, { minLines: 40 });
      assert.equal(got.lines.length, 40, `${nLines} 行应取满 40 条`);
      allParse(got.lines, `${nLines} 行`);
      assert.deepEqual(got, refTail(buf, 40), `${nLines} 行对拍`);
      assert.deepEqual(parsable(got.lines), (await readJsonlEdges(p, 40)).tail, `${nLines} 行 vs readline`);
    }
  }

  // ── 3. 块边界 / 空文件 / size=0 ────────────────────────────────────────
  {
    const B = 1024;
    for (const lens of [
      [B],                          // 正好一块,单行
      [B - 1],                      // 比一块少一字节
      [B + 1],                      // 比一块多一字节
      Array.from({ length: 8 }, () => 128),      // 正好一块,8 行
      [...Array.from({ length: 7 }, () => 128), 129], // 一块多一字节
      [...Array.from({ length: 7 }, () => 128), 127], // 一块少一字节
      [...Array.from({ length: 16 }, () => 128), 33], // 正好两块
      [...Array.from({ length: 16 }, () => 128), 34], // 两块多一字节
      [300, 300, 300, 300],         // 跨 2 块,末行无 \n
      [3000],                       // 单行跨 3 块(整块都落在行内,p===0 分支)
      [1300, 4000, 130],            // 中间一行跨 4 块,前后都有正常行
    ]) {
      for (const trailingNewline of [true, false]) {
        const buf = mkFile(lens, trailingNewline);
        const p = w(buf);
        for (const minLines of [1, 3, 40]) {
          const got = await readTailWindow(p, buf.length, { minLines, blockBytes: B });
          allParse(got.lines, `边界 ${lens.length}行 ${buf.length}B minLines=${minLines}`);
          assert.deepEqual(got, refTail(buf, minLines), `边界 ${buf.length}B 末行\\n=${trailingNewline} minLines=${minLines}`);
        }
      }
    }
    const empty = w(Buffer.alloc(0));
    assert.deepEqual(await readTailWindow(empty, 0), { lines: [], startOffset: 0 }, 'size=0');
    assert.deepEqual(await readTailWindow(empty, 0, { minLines: 40, blockBytes: 1024 }), { lines: [], startOffset: 0 }, 'size=0 + blockBytes');
    const blank = w(Buffer.from('\n\n\n'));
    assert.deepEqual(await readTailWindow(blank, 3, { blockBytes: 1024 }), { lines: [], startOffset: 3 }, '全空白行');
  }

  // ── 4. U+2028 / U+2029 / 孤立 \r / \r\n 与 readline 同口径 ──────────────
  {
    const rows = [];
    for (let i = 0; i < 12; i++) rows.push(json({ i, pad: 'z'.repeat(80) }));
    const text = rows.join('\r\n') + '\r\n' + json({ u: ' sep x' }) + '\r' + json({ r: 1 }) + '\n'
      + json({ tail: 'y'.repeat(400) });
    const buf = Buffer.from(text);
    const p = w(buf);
    const got = await readTailWindow(p, buf.length, { minLines: 40, blockBytes: 1024 });
    assert.deepEqual(got, refTail(buf, 40), '混合断行符对拍');
    assert.deepEqual(parsable(got.lines), (await readJsonlEdges(p, 40)).tail, '混合断行符 vs readline');
  }

  // ── 5. fuzz:blockBytes=1024 随机文件对拍(含各种行尾/空行/无尾 \n)─────────
  {
    let seed = 20260913;
    const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    for (let round = 0; round < 300; round++) {
      const term = pick(['\n', '\n', '\n', '\n', '\r\n', '\r', ' ', ' ']);
      const rows = [];
      const nRows = 1 + Math.floor(rnd() * 60);
      for (let i = 0; i < nRows; i++) {
        const k = rnd();
        rows.push(k < 0.08 ? '' : k < 0.16 ? '   ' : json({ i, pad: 'q'.repeat(Math.floor(rnd() * 200)) }));
      }
      let text = rows.join(term);
      if (rnd() < 0.8) text += term;
      const buf = Buffer.from(text);
      const p = w(buf);
      for (const minLines of [1, 5, 40, 200]) {
        const got = await readTailWindow(p, buf.length, { minLines, blockBytes: 1024 });
        assert.deepEqual(got, refTail(buf, minLines), `fuzz #${round}(${buf.length}B, term=${JSON.stringify(term)}) minLines=${minLines}`);
      }
    }
  }

  console.log('check-jsonl-tail-window: PASS');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
