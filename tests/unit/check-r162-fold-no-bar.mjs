#!/usr/bin/env node
// r162:聊天里的折叠行(工具调用组 ToolCallsGroup、思考 / 工作组 WorkGroup)去掉左侧灰条
// (2026-11-09 用户:「左边的这个灰色的竖条不要,如图 2 是 Claude 桌面版的样式」)。源码锁:node tests/unit/check-r162-fold-no-bar.mjs
//   F1 TurnBubble.jsx 里不再有 border-l-2(灰条)的写法;
//   F2 两处头行都用 -ml-1.5 + pl-1.5(悬停底色向左多伸 6px、图标与正文左缘对齐)、rounded-md,宽度补上多伸的 6px,
//      不再有 pl-3 pr-3 + rounded-r-md 的旧写法;
//   F3 展开后的条目仍保留 pl-3 缩进(没有灰条之后,层级靠缩进表达);
//   F4 头行仍带 .cg-fold(淡色)与 aria-expanded(开合状态),两处默认收起(useState(false) / 由父级 expanded 传入)。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const src = fs.readFileSync(path.join(root, 'client/src/components/TurnBubble.jsx'), 'utf8');
// 注释里允许提到旧写法(说明为什么去掉),只查代码
const stripComments = (s) => s
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const code = stripComments(src);

let n = 0;
const ok = (msg) => { n += 1; console.log(`  ✓ ${msg}`); };

// 取一个函数组件的函数体(到下一个顶层 function / export / 注释分隔线为止)
function bodyOf(name) {
  const start = code.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `找不到 function ${name}`);
  const rest = code.slice(start + 1);
  const next = rest.search(/\n(?:export\s+)?function\s|\n\/\/ ─── /);
  return next < 0 ? code.slice(start) : code.slice(start, start + 1 + next);
}

assert.ok(!/border-l-2/.test(code), 'F1 TurnBubble.jsx 不应再有 border-l-2(灰条)');
assert.ok(!/border-canvas-deep\/40/.test(code), 'F1 TurnBubble.jsx 不应再有 border-canvas-deep/40(灰条的颜色)');
ok('F1 TurnBubble.jsx 没有左侧灰条的写法');

for (const name of ['ToolCallsGroup', 'WorkGroup']) {
  const body = bodyOf(name);
  assert.match(body, /-ml-1\.5 pl-1\.5/, `F2 ${name} 头行应带 -ml-1.5 pl-1.5`);
  assert.match(body, /w-\[calc\(100%\+0\.375rem\)\]/, `F2 ${name} 头行宽度应补上向左多伸的 6px`);
  assert.match(body, /hover:bg-canvas-warm\/40 rounded-md/, `F2 ${name} 头行应是 rounded-md 的悬停底色`);
  assert.ok(!/rounded-r-md/.test(body), `F2 ${name} 不应再有 rounded-r-md`);
  assert.ok(!/pl-3 pr-3 py-1\.5/.test(body), `F2 ${name} 头行不应再有 pl-3 pr-3 py-1.5 的旧写法`);
  assert.match(body, /pl-3 pr-2 pt-1 pb-2/, `F3 ${name} 展开后的条目应保留 pl-3 缩进`);
  assert.match(body, /cg-fold/, `F4 ${name} 头行应带 .cg-fold`);
  assert.match(body, /aria-expanded=\{expanded \? 'true' : 'false'\}/, `F4 ${name} 头行应带 aria-expanded`);
}
ok('F2 / F3 / F4 两处头行写法一致:-ml-1.5 pl-1.5 + rounded-md + 展开条目 pl-3 缩进 + cg-fold + aria-expanded');

assert.match(bodyOf('ToolCallsGroup'), /useState\(false\)/, 'F4 ToolCallsGroup 默认应收起');
ok('F4 ToolCallsGroup 默认收起');

console.log(`check-r162-fold-no-bar: ${n} 项全部通过`);
