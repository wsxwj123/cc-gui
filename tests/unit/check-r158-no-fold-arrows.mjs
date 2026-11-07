#!/usr/bin/env node
// r158:聊天里所有折叠行都不再有展开箭头(2026-11-07 用户追加:「所有的折叠行都不需要用折叠的那个箭头标签了」),
// 折叠行与正文靠 .cg-fold 淡色区分。源码锁:node tests/unit/check-r158-no-fold-arrows.mjs
//
// 豁免清单(不是聊天折叠行,保持原样,本文件不检查):
//   - 侧栏会话行的子任务展开钮、项目选择下拉(App.jsx 其它段落)
//   - 设置里的 ▴ ▾ 展开项(App.jsx / 设置组件)
//   - 右侧各面板(子代理监控 / 待办 / 目标条 / MCP 等)的展开箭头
//   - 「回到底部」按钮
//   - 代码块里的文字按钮「展开剩余 N 行 ▾」「收起 ▴」(CodeBlock / CollapsibleCode / ArtifactPreview)
// 所以 App.jsx 只截后台任务通知横幅 TaskNoticeRow 那一段来查。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
// 注释里允许提到旧写法(说明为什么去掉),只查代码:去掉 // 行注释与 /* */、{/* */} 块注释
const stripComments = (src) => src
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const FILES = [
  'client/src/components/TurnBubble.jsx',
  'client/src/components/MessageBubble.jsx',
  'client/src/components/ToolCallCard.jsx',
  'client/src/components/tools/TaskCard.jsx',
  'client/src/components/tools/WorkflowCard.jsx',
  'client/src/components/XsNoticeRow.jsx',
];

let n = 0;
const ok = (msg) => { n += 1; console.log(`  ✓ ${msg}`); };

function assertNoArrows(label, code) {
  assert.ok(!/\bChevron(Down|Right)\b/.test(code), `${label}:不应再 import / 使用 ChevronDown / ChevronRight`);
  assert.ok(!/data-strip-caret/.test(code), `${label}:不应再有 data-strip-caret`);
  assert.ok(!/[▾▸▴▶]/.test(code), `${label}:不应再有 ▾ ▸ ▴ ▶ 箭头字符`);
  assert.ok(!/rotate-90/.test(code), `${label}:不应再有旋转三角(rotate-90)`);
}

for (const rel of FILES) {
  assertNoArrows(rel, stripComments(read(rel)));
  ok(`${rel}:没有折叠箭头`);
}

// App.jsx 只查后台任务通知横幅 TaskNoticeRow 这一段
{
  const src = read('client/src/App.jsx');
  const start = src.indexOf('function TaskNoticeRow(');
  assert.ok(start >= 0, 'App.jsx:找不到 TaskNoticeRow');
  const nextFn = src.slice(start + 1).search(/\n(?:export\s+)?function\s/);
  const seg = nextFn < 0 ? src.slice(start) : src.slice(start, start + 1 + nextFn);
  assertNoArrows('App.jsx TaskNoticeRow', stripComments(seg));
  assert.match(seg, /aria-expanded=\{expanded \? 'true' : 'false'\}/, 'TaskNoticeRow:开合靠 aria-expanded 表达');
  ok('App.jsx 后台任务通知横幅:没有折叠箭头,带 aria-expanded');
}

// 折叠行带 .cg-fold(淡色、悬停回正文色),且样式类定义在 index.css,取 --cg-fold-fg / --cg-fold-fg-hover
{
  const css = read('client/src/index.css');
  assert.match(css, /\.cg-fold\s*\{[^}]*color:\s*var\(--cg-fold-fg\)/, 'index.css:.cg-fold 取 --cg-fold-fg');
  assert.match(css, /\.cg-fold:hover\s*\{[^}]*color:\s*var\(--cg-fold-fg-hover\)/, 'index.css:.cg-fold:hover 取 --cg-fold-fg-hover');
  ok('index.css:.cg-fold 与悬停色定义齐全');

  const tb = read('client/src/components/TurnBubble.jsx');
  const head = tb.slice(tb.indexOf('data-strip="head"'), tb.indexOf('data-strip="head"') + 1200);
  assert.match(head, /className="cg-fold /, '过程条摘要行带 cg-fold');
  assert.ok(!/text-ink-(soft|muted|faint)/.test(head.slice(0, head.indexOf('</button>'))), '过程条摘要行内部不再自带 ink 色类(继承 cg-fold)');
  const wg = tb.slice(tb.indexOf('data-work-group-head=""'), tb.indexOf('data-work-group-head=""') + 900);
  assert.match(wg, /cg-fold/, '工作组头带 cg-fold');
  const tf = tb.slice(tb.indexOf('function ThinkingFold('), tb.indexOf('function ThinkingFold(') + 1200);
  assert.match(tf, /cg-fold/, '思考折叠行带 cg-fold');
  assert.match(tf, /aria-expanded=\{open \? 'true' : 'false'\}/, '思考折叠行带 aria-expanded');
  assert.match(tb, /key="chat-fold"[^>]*>[\s\S]{0,200}cg-fold/, '聊天模式「执行了 N 步操作」折叠条带 cg-fold');
  assert.match(tb, /key="chat-unfold"[^>]*>[\s\S]{0,200}cg-fold/, '聊天模式「收起过程」折叠条带 cg-fold');
  ok('TurnBubble:摘要行 / 工作组头 / 思考折叠行 / 聊天折叠条都带 cg-fold');

  for (const rel of ['client/src/components/tools/TaskCard.jsx', 'client/src/components/tools/WorkflowCard.jsx']) {
    assert.match(read(rel), /cg-fold/, `${rel}:头行带 cg-fold`);
  }
  ok('TaskCard / WorkflowCard 头行带 cg-fold');
}

// TaskCard:去掉箭头后,悬停浮现的子代理窗口入口(Maximize2)保留
{
  const tc = read('client/src/components/tools/TaskCard.jsx');
  assert.match(tc, /<Maximize2 size=\{12\} \/>/, 'TaskCard:子代理窗口入口保留');
  ok('TaskCard:子代理窗口入口保留');
}

console.log(`\n✅ r158 折叠行无箭头:${n} 组断言全过`);
