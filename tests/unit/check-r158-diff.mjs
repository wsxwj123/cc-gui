#!/usr/bin/env node
// r158 字级 diff 纯函数自检 + DiffViewer 源码合同。跑法:node tests/unit/check-r158-diff.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wordDiffSegments, buildWordDiffMap } from '../../client/src/utils/wordDiff.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const changed = (segs) => segs.filter((s) => s.changed).map((s) => s.text);
const joined = (segs) => segs.map((s) => s.text).join('');

// ── wordDiffSegments:去掉头尾公共部分,只把中间不同的段标 changed ──
{
  const s = wordDiffSegments('其中 barium 的暴露剂量单位写成了 mg/L,与原文不符。', '其中 barium 的暴露剂量单位应为 µg/L,已按原文更正。');
  assert.deepEqual(changed(s.del), ['写成了 mg/L,与原文不符']);
  assert.deepEqual(changed(s.add), ['应为 µg/L,已按原文更正']);
  assert.equal(s.del[0].text, '其中 barium 的暴露剂量单位');
  assert.equal(s.del.at(-1).text, '。');
}
{
  const s = wordDiffSegments('暴露组血压显著降低(p = 0.07)。', '暴露组血压呈下降趋势(p = 0.07,未达显著)。');
  assert.deepEqual(changed(s.del), ['显著降低(p = 0.07']);
  assert.deepEqual(changed(s.add), ['呈下降趋势(p = 0.07,未达显著']);
}
// 相同的两行 → null(不做高亮)
assert.equal(wordDiffSegments('same', 'same'), null);
// 纯插入:旧行全是公共部分,只有新行有 changed 段;片段拼回去等于原文
{
  const s = wordDiffSegments('abc', 'abXc');
  assert.deepEqual(changed(s.del), []);
  assert.deepEqual(changed(s.add), ['X']);
  assert.equal(joined(s.del), 'abc');
  assert.equal(joined(s.add), 'abXc');
}
// 头尾重叠时不重复计:'aa' → 'aaa',前缀吃满短串后后缀不能再越界
{
  const s = wordDiffSegments('aa', 'aaa');
  assert.equal(joined(s.add), 'aaa');
  assert.deepEqual(changed(s.add), ['a']);
  assert.equal(joined(s.del), 'aa');
}
// 代理对不被切开(按码点比较)
{
  const s = wordDiffSegments('x😀y', 'x😃y');
  assert.deepEqual(changed(s.del), ['😀']);
  assert.deepEqual(changed(s.add), ['😃']);
}
// 空串与 null 不崩
assert.deepEqual(changed(wordDiffSegments(null, 'new').add), ['new']);

// ── buildWordDiffMap:成对按顺序配对,多出来的行不做高亮 ──
{
  const rows = [
    { type: 'del', content: 'a1' }, { type: 'del', content: 'b1' }, { type: 'del', content: 'c1' },
    { type: 'add', content: 'a2' }, { type: 'add', content: 'b2' },
    { type: 'ctx', content: 'keep' },
    { type: 'add', content: 'lonely' },
  ];
  const m = buildWordDiffMap(rows);
  assert.deepEqual([...m.keys()].sort((x, y) => x - y), [0, 1, 3, 4]);
  assert.deepEqual(changed(m.get(0)), ['1']);
  assert.deepEqual(changed(m.get(3)), ['2']);
  assert.equal(m.has(2), false, '多出来的删除行不做字级高亮');
  assert.equal(m.has(6), false, '没有配对的新增行不做字级高亮');
}
// 新增在前、删除在后不算一对(只认"删除段紧跟新增段")
assert.equal(buildWordDiffMap([{ type: 'add', content: 'x' }, { type: 'del', content: 'y' }]).size, 0);
assert.equal(buildWordDiffMap(null).size, 0);

// ── DiffViewer 源码合同:钩子、符号、变量、导出与签名 ──
{
  const src = fs.readFileSync(path.join(root, 'client/src/components/DiffViewer.jsx'), 'utf8');
  assert.match(src, /export function parseDiffLines\(/);
  assert.match(src, /export function DiffViewer\(\{ diff, maxHeight = /);
  for (const hook of ['data-diff-line=', 'data-diff-sign', 'data-diff-word=', 'data-diff-stat']) assert.ok(src.includes(hook), `缺 ${hook}`);
  assert.match(src, /del: '(−|\\u2212)'/, '删除符号用 U+2212');
  assert.match(src, /useMemo\(/, '字级 diff 用 useMemo');
  assert.doesNotMatch(src, /\b(bg|text)-(red|green|blue)-\d{2,3}\b/, 'DiffViewer 不再用调色板色');
  const css = fs.readFileSync(path.join(root, 'client/src/index.css'), 'utf8');
  assert.match(css, /\.tc-dl\[data-diff-line="add"\] \{ background: var\(--cg-add\); \}/);
  assert.match(css, /\.tc-wd-del \{ background: var\(--cg-del-2\);/);
}

console.log('check-r158-diff: ok');
