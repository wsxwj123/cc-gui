#!/usr/bin/env node
// 第六轮 ⑩(用户逐字需求):AI 回复里的代码块展开后,收起按钮只在最下方 —— 长代码要翻到底
// 才能收。要求顶部也有收起入口。改在共用组件 CollapsibleCode 一处,markdown 代码块与
// artifact 代码视图两个消费端自然都拿到。渲染点是 JSX 不能真 import,用源码锁 + 变异验证。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(join(root, 'client/src/components/ArtifactPreview.jsx'), 'utf8');
const md = readFileSync(join(root, 'client/src/components/MarkdownRenderer.jsx'), 'utf8');
const count = (s, sub) => s.split(sub).length - 1;

const start = src.indexOf('export function CollapsibleCode(');
assert.ok(start > 0, '折叠逻辑必须留在共用组件 CollapsibleCode 里,不许各消费端各写一份');
const body = src.slice(start, src.indexOf('\n}', start));

// ── 1. 顶部收起:只在"可折叠 且 已展开"时出现 ────────────────────────
assert.ok(/collapsible && expanded &&/.test(body),
  '顶部收起必须双条件门控:短代码块(不可折叠)不加没用的按钮,折叠态也不显示');
assert.ok(/收起 ▴/.test(body), '顶部控件文案是「收起」(箭头朝上,和底部展开的 ▾ 对称)');

// ── 2. 与底部收起同一个 state(不是第二套开关) ──────────────────────
assert.equal(count(body, 'const [expanded, setExpanded] = useState(false)'), 1,
  '展开态只能有一个 state,顶部/底部共用');
assert.ok(/const toggle = \(\) => setExpanded\(\(e\) => !e\)/.test(body),
  '顶底两个入口走同一个 toggle,行为必须完全一致');
assert.equal(count(body, 'onClick={toggle}'), 2, '顶部 + 底部两个入口都接 toggle');
assert.ok(/\{expanded \? '收起' : `展开剩余 \$\{lines\.length - collapseAt\} 行 ▾`\}/.test(body),
  '底部原有的展开/收起按钮保留不动');

// ── 3. 定位方式:绝对定位不占文档流,不挤消费端的工具条行 ──────────────
assert.ok(/<div className="relative">/.test(body), '需要 relative 容器给绝对定位的收起按钮做参照');
assert.ok(/absolute top-1\.5 right-2 z-10/.test(body),
  '顶部收起悬在代码区右上角(绝对定位),否则会插一行把头部挤成两条工具条');
assert.ok(/bg-\[#2b2722\]\/90 border border-\[#3a342b\]/.test(body),
  '按钮要有底色/描边,浮在代码上仍可读');
assert.ok(/text-\[10px\] font-mono text-\[#9a8e78\] hover:text-\[#cabba0\]/.test(body),
  '样式对齐现有头部按钮(复制按钮同款小字)');
// 折叠态的圆角逻辑不许被 relative 容器改掉
assert.ok(/\$\{collapsible \? '' : 'rounded-b-lg'\}/.test(body), '不可折叠时 <pre> 仍收 rounded-b-lg');

// ── 4. 两个消费端都从共用组件拿到,没有谁绕开自己写折叠 ────────────────
assert.equal(count(src, '<CollapsibleCode'), 1, 'artifact 代码视图必须用共用组件(PreviewBody 内联档)');
assert.equal(count(md, '<CollapsibleCode'), 1, 'markdown 代码块必须用共用组件');
assert.ok(/import \{ ArtifactPreview, isPreviewable, CollapsibleCode \}/.test(md),
  'MarkdownRenderer 从 ArtifactPreview 引共用组件(防两处折叠逻辑漂移)');
assert.ok(!/展开剩余/.test(md), 'MarkdownRenderer 里不许再出现第二份折叠 UI');

console.log('✓ check-code-fold-top-collapse: 展开态顶部收起(共用组件一处改,两个消费端同得)');
