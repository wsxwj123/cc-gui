#!/usr/bin/env node
// r79 单测:genui 正文字体跟随「对话正文字体」选择器的**接线锁**。
//
// 这条链路是靠"三个文件恰好一致"成立的,谁都没写下来 —— r79 立项时就因此被误诊成
// "genui 吃的是固定的 --font-ui"(实测不成立)。把链路钉在这里,以后改任一环当场红:
//
//   字体选择器 setReadingFont → applyReadingFont 往 :root 写 --font-reading
//     → index.css 的 .font-reading { font-family: var(--font-reading) }
//     → MarkdownRenderer 的容器带 .font-reading(genui 围栏的**唯一**挂载点)
//     → GenuiBlock/PlotBlock 的 .block **不声明 font-family** ⟹ 正文继承宿主
//   与之对偶的另一半:数字/代码刻意等宽,走 --ds-font-family-code → --font-mono,
//   规则特异性高于继承,换正文字体时不受影响(上游设计,不动)。
//
// 变异哨兵(逐条实际验证过红):
//   ① GenuiBlock.module.css 的 .block 里加一行 font-family: var(--font-ui) → t1 红
//   ② MarkdownRenderer 容器去掉 font-reading 类 → t2 红
//   ③ index.css 的 .font-reading 改成 var(--font-ui) → t3 红
//   ④ applyReadingFont 改写别的自定义属性名 → t3 红
//   ⑤ genui-tokens.css 的 --ds-font-family-code 不再映射 --font-mono → t4 红
// Run: node tests/unit/check-genui-font-follow.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
// 断言看**代码**不看注释:注释里正要写清楚"不声明 font-family",不剥就自己判红自己。
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
/** 取某个类选择器的规则体(只取第一处声明,足够覆盖块根)。 */
function ruleBody(css, selector) {
  const i = css.indexOf(`${selector} {`);
  assert.notEqual(i, -1, `找不到 \`${selector} {\` 规则 —— 选择器改名了就把本单测一起改`);
  return css.slice(i, css.indexOf('}', i));
}

// ── t1 块根不声明 font-family:这就是"正文跟宿主"的全部实现 ──────────────────
for (const file of [
  'client/src/genui/upstream/GenuiBlock.module.css',
  'client/src/genui/upstream/PlotBlock.module.css',
]) {
  const body = ruleBody(code(file), '.block');
  assert.doesNotMatch(body, /(^|[;{\s])font-family\s*:/,
    `t1: ${file} 的 .block 里出现了 font-family —— 块根一旦自己声明字体就切断了继承,\n`
    + '    "对话正文字体"选出来的 --font-reading 再也进不到 genui 正文里。上游设计就是不声明。');
}

// ── t2 唯一挂载点:genui 围栏只从 MarkdownRenderer 出来,容器必须带 font-reading ──
{
  const md = read('client/src/components/MarkdownRenderer.jsx');
  assert.match(md, /GenuiFenceGate/, 't2: MarkdownRenderer 仍是 genui 围栏的挂载点(前提没变)');
  assert.match(md, /className="markdown-content[^"]*\bfont-reading\b/,
    't2: MarkdownRenderer 的容器必须带 font-reading —— 它是 genui 正文继承到的那个字体;\n'
    + '    去掉的话整块 genui 会回落到 body 的 --font-ui,选字体不再有反应。');
  // 反向:别再冒出第二个不带 font-reading 的挂载点。
  const mounts = [...read('client/src/components/GenuiFence.jsx').matchAll(/GenuiBlock/g)].length;
  assert.ok(mounts > 0, 't2: GenuiFence 仍挂 GenuiBlock');
}

// ── t3 属性链:.font-reading 与 store 写的自定义属性名必须是同一个 ──────────────
{
  assert.match(ruleBody(code('client/src/index.css'), '.font-reading'), /font-family:\s*var\(--font-reading\)/,
    't3: .font-reading 必须解析到 var(--font-reading)');
  // 这里读原文不剥注释:sessionStore.js 里有正则字面量,CSS 那套块注释剥法会误吃一大段。
  assert.match(read('client/src/stores/sessionStore.js'), /setProperty\('--font-reading',\s*readingFontCss\(/,
    't3: applyReadingFont 必须写 --font-reading(改属性名就把整条链断在这里)');
}

// ── t4 对偶的另一半:数字/代码仍走等宽,换正文字体时不该跟着变 ────────────────
{
  assert.match(code('client/src/genui/host/genui-tokens.css'), /--ds-font-family-code:\s*var\(--font-mono\)/,
    't4: 等宽那半靠 --ds-font-family-code → --font-mono 映射');
  for (const file of [
    'client/src/genui/upstream/GenuiBlock.module.css',
    'client/src/genui/upstream/PlotBlock.module.css',
  ]) {
    assert.match(code(file), /--dsl-g-font-mono:\s*var\(--ds-font-family-code/,
      `t4: ${file} 的 --dsl-g-font-mono 必须接到 --ds-font-family-code`);
  }
}

console.log('check-genui-font-follow: all passed');
