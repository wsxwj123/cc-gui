#!/usr/bin/env node
// r64 M3:CodeBlock 从 MarkdownRenderer.jsx 抽成 components/CodeBlock.jsx。
// 这是**重构不是重写** —— 抽的动机是断 genui 的循环依赖
// (MarkdownRenderer → GenuiFence → fence-render → host/primitives → MarkdownRenderer),
// 所以这里锁两件事:① 抽出去的那份渲染出的东西一字没变;② MarkdownRenderer 的分发路径没变。
// JSX 不能被裸 node import(ERR_UNKNOWN_FILE_EXTENSION),按仓内惯例走源码锁 + 变异验证。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const block = read('client/src/components/CodeBlock.jsx');
const md = read('client/src/components/MarkdownRenderer.jsx');

// ── 1. CodeBlock.jsx:导出 + 抽出前的原样式(逐字锁,改一个 class 就红)──────────
assert.ok(/export function CodeBlock\(\{ lang, code \}\)/.test(block),
  'CodeBlock 必须具名导出且签名不变(上游 advanced.tsx / fence-render.tsx 按 {code,lang} 调它)');
for (const frag of [
  'className="relative group my-3"',
  'className="flex items-center justify-between px-3.5 py-1.5 bg-[#2b2722] rounded-t-lg border border-[#3a342b] border-b-0"',
  'className="text-[11px] font-mono text-[#9a8e78]"',
  '{lang || \'code\'}',
  '<CopyButton text={code} />',
  'className="bg-[#211e19] border border-[#3a342b] border-t-0 p-4 overflow-x-auto text-[13px] leading-relaxed font-mono text-[#e8e2d6]"',
]) {
  assert.ok(block.includes(frag), `CodeBlock 渲染必须与抽出前逐字一致,缺: ${frag}`);
}
assert.ok(/<CollapsibleCode\b/.test(block), '长代码折叠仍走 ArtifactPreview 的 CollapsibleCode(防两处漂移)');
assert.ok(/from '\.\/ArtifactPreview\.jsx'/.test(block),
  '复制按钮与折叠件复用 ArtifactPreview 已导出的共用件,不再在本文件里重造一份');

// ── 2. 断环:CodeBlock.jsx 不许回指 MarkdownRenderer ─────────────────────────
const imports = (src) => src.split('\n').filter((l) => /^\s*(import|export)\b.*\bfrom\b/.test(l)).join('\n');
assert.ok(!/MarkdownRenderer/.test(imports(block)),
  'CodeBlock 一旦 import 回 MarkdownRenderer,抽这个文件就白抽了(环还在)');

// ── 3. MarkdownRenderer:本地定义已删,改成 import ────────────────────────────
assert.ok(!/^function CodeBlock\(/m.test(md), 'MarkdownRenderer 里不该再留一份 CodeBlock 定义');
assert.ok(!/^function CopyButton\(/m.test(md),
  'CopyButton 随 CodeBlock 一起搬走(它在本文件里只被 CodeBlock 用),留着就是死代码');
assert.ok(/import \{ CodeBlock \} from '\.\/CodeBlock\.jsx'/.test(md), 'MarkdownRenderer 必须 import 抽出去的 CodeBlock');
// 搬走后这三个 import 全成了死引用,留着会误导后来人(且 CopyButton 若被人复活会分叉)
for (const dead of ['/Icon.jsx', 'utils/clipboard.js', 'CollapsibleCode']) {
  assert.ok(!imports(md).includes(dead), `MarkdownRenderer 不该再 import ${dead}(随 CodeBlock 搬走后已无用)`);
}

// ── 4. 分发路径原样:可预览语言 → ArtifactPreview,其余 → CodeBlock,行内 → <code> ──
const rc = md.slice(md.indexOf('function renderCode('), md.indexOf('const markdownComponents'));
assert.ok(rc.length > 200, '没找到 renderCode 函数体');
assert.ok(/const isBlock = className\?\.includes\('language-'\) \|\| codeStr\.includes\('\\n'\)/.test(rc),
  '块级判定(有 language- 类名 或 含换行)不许动:它兜的是没标语言的裸围栏');
assert.ok(/if \(isPreviewable\(lang\)\) \{[\s\S]{0,200}?<ArtifactPreview /.test(rc),
  'html/svg/mermaid 仍先走 ArtifactPreview 的代码/预览切换');
assert.ok(/dockKeyFor\(dockKeyPrefix, node\?\.position\?\.start\?\.offset\)/.test(rc),
  '停靠身份 dockKeyFor(prefix, offset) 不许动');
assert.ok(/return <CodeBlock lang=\{lang\} code=\{codeStr\} \/>;/.test(rc), '其余语言仍落到 CodeBlock');
assert.ok(rc.indexOf('<ArtifactPreview') < rc.indexOf('<CodeBlock'),
  '顺序不许反:先判可预览再落普通代码块,反了 html/svg/mermaid 就没预览了');
assert.ok(/<code\b[\s\S]*\{\.\.\.props\}/.test(rc), '行内代码分支(非块级)仍原样渲染 <code>');

console.log('✅ CodeBlock 抽取无回归(渲染逐字一致 / 分发路径不变 / 不回指 MarkdownRenderer)');
