#!/usr/bin/env node
// r162:聊天里的折叠行(工具调用组 ToolCallsGroup、思考 / 工作组 WorkGroup)与思考展开块去掉左侧灰条
// (2026-11-09 用户:「左边的这个灰色的竖条不要,如图 2 是 Claude 桌面版的样式」)。源码锁:node tests/unit/check-r162-fold-no-bar.mjs
//   F1 ToolCallsGroup / WorkGroup 两个函数体里不再有 border-l-2(灰条)的写法;
//   F2 两处头行都用 -ml-1.5 + pl-1.5(悬停底色向左多伸 6px、图标与正文左缘对齐)、rounded-md,宽度补上多伸的 6px,
//      不再有 pl-3 pr-3 + rounded-r-md 的旧写法;
//   F3 展开后的条目仍保留 pl-3 缩进(没有灰条之后,层级靠缩进表达);
//   F4 头行仍带 .cg-fold(淡色)与 aria-expanded(开合状态),ToolCallsGroup 默认收起(useState(false));
//   F5 index.css 的 .thinking-block(思考展开块)不再有 border-left,也没有悬停改 border-left-color 的规则。
// 真渲染覆盖:WorkGroup 见验收 r157-live-line/r162-fold-bar.spec.mjs;ToolCallsGroup 见 check-r151b-baseline-ui 的 tool-group 场景。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
// 注释里允许提到旧写法(说明为什么去掉),只查代码:去掉 // 行注释与 /* */、{/* */} 块注释
const stripComments = (s) => s
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const code = stripComments(read('client/src/components/TurnBubble.jsx'));

let n = 0;
const ok = (msg) => { n += 1; console.log(`  ✓ ${msg}`); };

// 取一个函数组件的函数体:从 `function <name>(` 到下一个顶层 function(含 export function)
function bodyOf(name) {
  const start = code.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `找不到 function ${name}`);
  const rest = code.slice(start + 1);
  const next = rest.search(/\n(?:export\s+)?function\s/);
  return next < 0 ? code.slice(start) : code.slice(start, start + 1 + next);
}

for (const name of ['ToolCallsGroup', 'WorkGroup']) {
  const body = bodyOf(name);
  assert.ok(!/border-l-2/.test(body), `F1 ${name} 不应再有 border-l-2(灰条)`);
  assert.ok(!/border-canvas-deep\/40/.test(body), `F1 ${name} 不应再有 border-canvas-deep/40(灰条的颜色)`);
}
ok('F1 两处折叠行函数体里没有左侧灰条的写法');

for (const name of ['ToolCallsGroup', 'WorkGroup']) {
  const body = bodyOf(name);
  assert.match(body, /-ml-1\.5\s+pl-1\.5/, `F2 ${name} 头行应带 -ml-1.5 pl-1.5`);
  assert.match(body, /w-\[calc\(100%\+0\.375rem\)\]/, `F2 ${name} 头行宽度应补上向左多伸的 6px`);
  assert.match(body, /hover:bg-canvas-warm\/40\s+rounded-md/, `F2 ${name} 头行应是 rounded-md 的悬停底色`);
  assert.ok(!/rounded-r-md/.test(body), `F2 ${name} 不应再有 rounded-r-md`);
  assert.ok(!/pl-3\s+pr-3\s+py-1\.5/.test(body), `F2 ${name} 头行不应再有 pl-3 pr-3 py-1.5 的旧写法`);
  assert.match(body, /pl-3\s+pr-2\s+pt-1\s+pb-2/, `F3 ${name} 展开后的条目应保留 pl-3 缩进`);
  assert.match(body, /cg-fold/, `F4 ${name} 头行应带 .cg-fold`);
  assert.match(body, /aria-expanded=\{expanded \? 'true' : 'false'\}/, `F4 ${name} 头行应带 aria-expanded`);
}
ok('F2 / F3 / F4 两处头行写法一致:-ml-1.5 pl-1.5 + rounded-md + 展开条目 pl-3 缩进 + cg-fold + aria-expanded');

assert.match(bodyOf('ToolCallsGroup'), /useState\(false\)/, 'F4 ToolCallsGroup 默认应收起');
ok('F4 ToolCallsGroup 默认收起');

// F5 .thinking-block 规则块(到下一个 `}` 为止)里没有 border-left;也没有 .thinking-block:hover 改 border-left-color 的规则
{
  const css = read('client/src/index.css').replace(/\/\*[\s\S]*?\*\//g, ''); // CSS 只有 /* */ 注释(不能套用 JSX 的 {/* */} 规则)
  const at = css.indexOf('.thinking-block {');
  assert.ok(at >= 0, '找不到 .thinking-block 规则');
  const block = css.slice(at, css.indexOf('}', at) + 1);
  assert.ok(!/border-left/.test(block), `F5 .thinking-block 不应再有 border-left:${block.replace(/\s+/g, ' ')}`);
  assert.ok(!/\.thinking-block:hover\s*\{[^}]*border-left/.test(css), 'F5 不应再有 .thinking-block:hover 改 border-left 的规则');
  ok('F5 .thinking-block 没有左边框');
}

console.log(`check-r162-fold-no-bar: ${n} 项全部通过`);
