#!/usr/bin/env node
// r158:DiffViewer 的行列表外套了一层内层网格(.tc-diff-inner,宽 = 最宽那一行,至少铺满容器),
// 横向滚动时短行的红绿底也铺到最右。源码锁:内层网格在、各 data-diff-* 钩子仍在渲染里、对外签名不变。
// 运行:node tests/unit/check-r158-diff-layout.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const src = fs.readFileSync(path.join(root, 'client/src/components/DiffViewer.jsx'), 'utf8');
const css = fs.readFileSync(path.join(root, 'client/src/index.css'), 'utf8');

// 对外签名
assert.match(src, /export function DiffViewer\(\{ diff, maxHeight = 'max-h-72' \}\)/, 'DiffViewer 签名(diff、maxHeight 默认值)不变');
assert.match(src, /export function parseDiffLines\(diffText\)/, 'parseDiffLines 导出签名不变');

// 内层网格:在滚动容器里、包住全部行
const rowsAt = src.indexOf('className={`tc-diff-rows ${maxHeight}`}');
assert.ok(rowsAt > 0, '滚动容器 tc-diff-rows 仍带 maxHeight');
const innerAt = src.indexOf('<div className="tc-diff-inner">', rowsAt);
assert.ok(innerAt > rowsAt, '滚动容器里有内层网格 tc-diff-inner');
assert.ok(src.indexOf('{rows.map(', innerAt) > innerAt, '行列表在内层网格里面');
assert.match(css, /\.tc-diff-inner\s*\{[^}]*display:\s*grid[^}]*min-width:\s*100%[^}]*width:\s*max-content/,
  '内层网格:grid + 至少铺满容器 + 宽度跟最宽那一行');

// 钩子仍在渲染里
for (const hook of ['data-diff-line={row.type}', 'data-diff-sign=""', 'data-diff-word={row.type}', 'data-diff-stat=""']) {
  assert.ok(src.includes(hook), `DiffViewer 渲染里缺钩子 ${hook}`);
}

console.log('check-r158-diff-layout: ok');
