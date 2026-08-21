#!/usr/bin/env node
// r26-D9 + r26-D10(前端半)【单测】:SkinPanel.jsx 源码哨兵 + detectInlineKind 行为矩阵。
//   D9:isBuiltin 死代码已除(变量/「· 示例」拼接/删按钮条件包壳零残留;删按钮恒渲染);
//   D10(契约 C-D10):dsw tab 自动识别——识别条件 parsed.format === 'cgui-skin/1',
//     skinjson 提交体 { kind:'skinjson', name, skinJson },占位文案双形态明示。
// detectInlineKind 是无 JSX 依赖的纯函数:从源码抽出真跑(非纯 grep),行为矩阵钉死。
// Run: node tests/unit/check-r26-d9-d10-skinpanel.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../client/src/components/SkinPanel.jsx', import.meta.url), 'utf8');

// ── D9:isBuiltin 死代码清除哨兵 ──
{
  assert.doesNotMatch(src, /const isBuiltin\b/, 'D9: isBuiltin 变量已删');
  assert.doesNotMatch(src, /[!{(]\s*isBuiltin\b/, 'D9: isBuiltin 消费点零残留(「· 示例」拼接/删按钮门控)');
  assert.match(src, /title="删除"/, 'D9: 删按钮仍在(恒渲染)');
  assert.doesNotMatch(src, /· 示例/, 'D9: 「· 示例」死分支已删');
}

// ── D10:detectInlineKind 抽出真跑(行为矩阵,非纯 grep) ──
{
  const m = src.match(/function detectInlineKind\(text\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'D10: detectInlineKind 函数存在(哨兵锚)');
  const detectInlineKind = eval(`(${m[0]})`);
  // 识别条件:parsed.format === 'cgui-skin/1'
  assert.ok(m[0].includes("parsed.format === 'cgui-skin/1'"), 'D10: 识别条件钉死(契约 C-D10)');
  assert.equal(detectInlineKind('{"format":"cgui-skin/1","name":"x","shared":{"vars":{}}}'), 'skinjson',
    'D10: cgui-skin/1 skin.json → skinjson 通道');
  assert.equal(detectInlineKind('{"vars":{"--dsw-bg":"#101010"}}'), 'dsw',
    'D10: dsh 主题 JSON → dsw 通道(原语义不串)');
  assert.equal(detectInlineKind('{"format":"other/9"}'), 'dsw', 'D10: 其它 format 不误判');
  assert.equal(detectInlineKind('not json at all'), 'dsw', 'D10: 非法 JSON 落 dsw(服务端报无法解析)');
  assert.equal(detectInlineKind('[1,2]'), 'dsw', 'D10: 数组不误判');
  assert.equal(detectInlineKind('"cgui-skin/1"'), 'dsw', 'D10: 裸字符串不误判');
}

// ── D10:提交体与占位文案哨兵(契约 C-D10 形状) ──
{
  assert.match(src, /body = \{ kind: 'skinjson', name, skinJson: dsw \}/,
    'D10: skinjson 提交体 = { kind, name, skinJson }(契约 C-D10)');
  assert.match(src, /body = \{ kind, name, dswJson: dsw \}/, 'D10: dsw 原通道保留');
  assert.ok(src.includes('粘贴 dsh 主题 JSON 或 cgui-skin/1 skin.json'), 'D10: 占位文案双形态明示');
  assert.match(src, /\/api\/skins\/import-inline/, 'D10: 仍走 import-inline 端点');
}

console.log('PASS check-r26-d9-d10-skinpanel');
