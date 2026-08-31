#!/usr/bin/env node
// r64:表格排序的数字词法(upstream/blocks/charts.tsx 的 parseSortableNumber)。
// 锁的是"什么算数字":该函数决定一格是按数值排还是按文本排,判错了整列顺序就是错的
// (锁定验收 B70/B71a 的第二条红因:`'b'` 被当成 10 亿的后缀 → 尾数空串 → Number('')===0
//  → 纯字母格变成数字 0 排到所有文本行前面)。
//
// charts.tsx 是 .tsx,裸 node 加载不了(ERR_UNKNOWN_FILE_EXTENSION,与语法无关);
// 但这个函数本身是零依赖纯函数,把它原样切到临时 .ts 里就能让 node 的类型擦除吃下去
// ——测的是**真源码**,不是抄一份(抄一份正是我第一次误判该 bug 的原因)。
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(join(root, 'client/src/genui/upstream/blocks/charts.tsx'), 'utf8');
const start = src.indexOf('export function parseSortableNumber');
assert.notEqual(start, -1, '找不到 parseSortableNumber —— 上游同步后改名了就来这里对齐');
const rest = src.slice(start + 10);
const end = start + 10 + rest.search(/\n(export |const |function )/);
const dir = mkdtempSync(join(tmpdir(), 'cgui-sortnum-'));
let num;
try {
  const file = join(dir, 'psn.ts');
  writeFileSync(file, src.slice(start, end));
  ({ parseSortableNumber: num } = await import(pathToFileURL(file).href));
} finally {
  rmSync(dir, { recursive: true, force: true });   // 临时目录不留(模块已加载进内存)
}

// ── 1. 正例:数字 + 数量级后缀的既有行为一个不许变 ────────────────────────────
{
  for (const [input, expected] of [
    ['3', 3], ['1.5', 1.5], ['-2', -2], ['1,234', 1234], ['1，234', 1234],
    ['3k', 3000], ['1.2m', 1_200_000], ['2b', 2e9], ['3K', 3000],
    ['3.5万', 35_000], ['2亿', 200_000_000],
    ['0.3%', 0.3], ['¥99', 99], ['$12', 12],
  ]) assert.equal(num(input), expected, `${JSON.stringify(input)} 该读成 ${expected}`);
}

// ── 2. 反例:串里一个数字都没有 → 必须按**文本**排(NaN),不许变成 0 ──────────
// 'b'/'k'/'m' 是 k/m/b 后缀的孤字母,'万'/'亿'/'%'/'¥' 是光杆装饰;它们剥完尾数是空串,
// 而 Number('') === 0 —— 这正是那条词法 bug 的形状。
{
  for (const input of ['b', 'k', 'm', 'B', 'M', '万', '亿', '%', '¥', '$']) {
    assert.ok(Number.isNaN(num(input)),
      `${JSON.stringify(input)} 里没有数字,必须按文本排(实际 ${num(input)});`
      + '当成 0 的话它会排在所有文本行前面 —— B70「Expected a / Received b」就是这么来的');
  }
  for (const input of ['a', 'c', 'x', 'ab', '名称', '中文', '']) {
    assert.ok(Number.isNaN(num(input)), `${JSON.stringify(input)} 也该按文本排`);
  }
  // 非字符串输入照旧
  assert.ok(Number.isNaN(num(null)) && Number.isNaN(num(undefined)) && Number.isNaN(num({})));
  assert.equal(num(42), 42, '数字原样通过');
  assert.ok(Number.isNaN(num(Infinity)), '非有限数当文本');
}

// ── 3. B70 那张表:['b','a','c'] 升序必须是 a,b,c ─────────────────────────────
// 用与 TableNode 同一套比较逻辑(数字在前、文本按字典序),证明修完首行是 'a'。
{
  const dir1 = 1;
  const cmp = (x, y) => {
    const an = num(x), bn = num(y);
    if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return (an - bn) * dir1;
    if (Number.isFinite(an) !== Number.isFinite(bn)) return Number.isFinite(an) ? -dir1 : dir1;
    return (x < y ? -1 : x > y ? 1 : 0) * dir1;
  };
  assert.deepEqual(['b', 'a', 'c'].sort(cmp), ['a', 'b', 'c'],
    'B70/B71a 的夹具:纯字母列升序就是字典序,首行是 a');
  // 混合列的既有约定不变:数字行在文本行前面
  assert.deepEqual(['x', '3k', 'a', '2'].sort(cmp), ['2', '3k', 'a', 'x'],
    '数字先按数值排,文本跟在后面(混合列的既有行为)');
}

console.log('check-genui-table-sort: all passed');
