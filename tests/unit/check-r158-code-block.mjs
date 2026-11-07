#!/usr/bin/env node
// r158 第三段:围栏代码块与 Markdown 跟随主题。JSX 不能被裸 node import,按仓内惯例走源码锁。
// 锁的是:共用件 tone 默认 dark(Artifact 深色视图不变);theme 档的 <pre> 带 data-code-block /
// data-code-tone,dark 档不带;强制白字的选区规则不再作用于主题块;行内代码不再用强调色;
// 引用块不再斜体;CodeBlock 走 theme 档。运行:node tests/unit/check-r158-code-block.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const art = read('client/src/components/ArtifactPreview.jsx');
const block = read('client/src/components/CodeBlock.jsx');
const md = read('client/src/components/MarkdownRenderer.jsx');
const css = read('client/src/index.css');
const ok = (m) => console.log(`  ✓ ${m}`);

// ── 1. 共用件 tone 默认 dark ──────────────────────────────────────────
const ccStart = art.indexOf('export function CollapsibleCode(');
assert.ok(ccStart > 0, '找不到 CollapsibleCode');
const cc = art.slice(ccStart, art.indexOf('\n}\n', ccStart));
assert.match(cc, /export function CollapsibleCode\(\{[^}]*tone = 'dark'[^}]*\}\)/, 'CollapsibleCode 的 tone 默认必须是 dark');
assert.match(art, /export function CopyButton\(\{[^}]*tone = 'dark'[^}]*\}\)/, 'CopyButton 的 tone 默认必须是 dark');
ok('CollapsibleCode / CopyButton 的 tone 默认 dark');

// ── 2. 只有 theme 档带 data-code-block / data-code-tone ────────────────────
assert.match(cc, /const theme = tone === 'theme'/, 'theme 判定要显式');
assert.match(cc, /const themeAttrs = theme \? \{ 'data-code-block': '', 'data-code-tone': 'theme' \} : \{\}/,
  'theme 档的 <pre> 带 data-code-block="" 与 data-code-tone="theme",dark 档给空对象(不带这两个属性)');
assert.match(cc, /<pre className=\{preClass\} \{\.\.\.themeAttrs\}>/, '属性落在 <pre> 上');
assert.equal((art.match(/'data-code-block'/g) || []).length, 1, 'ArtifactPreview 里 data-code-block 只在 theme 分支出现一次');
assert.equal((art.match(/'data-code-tone'/g) || []).length, 1, 'ArtifactPreview 里 data-code-tone 只在 theme 分支出现一次');
// dark 档 <pre> 类名逐字保留(与 check-code-fold-top-collapse 一致)
assert.ok(cc.includes("`${className} ${header ? 'flex flex-col overflow-hidden' : ''} ${collapsible ? '' : 'rounded-b-lg'}`"),
  'dark 档 <pre> 类名保持原样');
// Artifact 自己的代码视图不传 tone(仍走 dark)
const pb = art.slice(art.indexOf('export function PreviewBody('), art.indexOf('export function ArtifactPreview('));
const pbCall = pb.slice(pb.indexOf('<CollapsibleCode'), pb.indexOf('/>', pb.indexOf('<CollapsibleCode')));
assert.ok(pbCall.length > 0 && !/tone=/.test(pbCall), 'Artifact 代码视图调用 CollapsibleCode 不传 tone(保持深色)');
ok('只有 theme 档的 <pre> 带 data-code-block / data-code-tone;Artifact 视图仍 dark');

// ── 3. CodeBlock 走 theme 档 ──────────────────────────────────────────
assert.ok(block.includes('tone="theme"'), 'CodeBlock 必须传 tone="theme"');
assert.ok(/export function CodeBlock\(\{ lang, code \}\)/.test(block), 'CodeBlock 导出签名不变');
assert.ok(/data-code-lang/.test(block), '语言胶囊带 data-code-lang');
assert.ok(/requestTerminalRun/.test(block) && /isRunnableLang\(lang\)/.test(block), '运行沿用 isRunnableLang + requestTerminalRun');
ok('CodeBlock 传 tone="theme",签名与运行逻辑不变');

// ── 4. 选区:强制白字规则不再作用于主题块 ─────────────────────────────
const whiteSel = [...css.matchAll(/([^{}]+)\{\s*background:\s*rgba\(255, 255, 255, 0\.30\);\s*color:\s*#ffffff;\s*\}/g)].map((m) => m[1]);
assert.ok(whiteSel.length >= 2, '找不到强制白字的选区规则');
for (const sel of whiteSel) {
  for (const part of sel.split(',').map((x) => x.trim()).filter((x) => x.startsWith('.markdown-content pre'))) {
    assert.ok(part.startsWith('.markdown-content pre:not([data-code-tone="theme"])'),
      `选区白字规则必须排除主题块,出问题的选择器: ${part}`);
  }
  assert.ok(/\.cgui-dark-select/.test(sel), '.cgui-dark-select 仍保留白字选区');
}
ok('强制白字的选区规则排除 pre[data-code-tone="theme"],仍管 .cgui-dark-select 与深色块');

// ── 5. Markdown:行内代码不用强调色、引用块不斜体 ──────────────────────
const rc = md.slice(md.indexOf('function renderCode('), md.indexOf('const markdownComponents'));
const inline = rc.slice(rc.lastIndexOf('return ('));
assert.ok(/<code\b/.test(inline), '找不到行内代码分支');
assert.ok(!/text-accent/.test(inline), '行内代码分支不再含 text-accent(文字色与正文一致)');
const bq = md.slice(md.indexOf('blockquote: ('), md.indexOf('</blockquote>'));
assert.ok(bq.length > 0, '找不到 blockquote 映射');
assert.ok(!/italic/.test(bq), '引用块不再斜体');
assert.match(css, /\.md-quote\s*\{[^}]*border-left:\s*3px solid var\(--cg-line-2\)/, '引用块左竖线取 --cg-line-2');
assert.match(css, /\.md-quote\s*\{[^}]*color:\s*var\(--color-ink-soft\)/, '引用块文字 ink-soft');
assert.match(css, /\.markdown-content code\s*\{[^}]*background:\s*var\(--cg-fill-2\)/, '行内代码底取 --cg-fill-2');
assert.ok(!/@media \(prefers-color-scheme: dark\)\s*\{\s*\.markdown-content code\b/.test(css), '行内代码不再有另写死色的深色覆盖');
assert.match(css, /\.md-table tbody tr:nth-child\(even\) > \.md-td\s*\{[^}]*background:\s*var\(--cg-fill\)/, '表体偶数行淡底');
ok('行内代码 / 引用块 / 表格取主题变量,不用强调色、不斜体');

console.log('✓ check-r158-code-block: 代码块 tone 与 Markdown 跟随主题的源码锁全部通过');
