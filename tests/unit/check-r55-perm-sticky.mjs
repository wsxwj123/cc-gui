#!/usr/bin/env node
// r55:权限卡「记住」下拉的选择跨卡粘滞 → 永久规则批量泄漏。
// PermissionCard 没有 key,React 把上一张卡的实例复用给下一个请求,remember state
// 不复位:用户只选过一次「始终允许」,之后每张卡的 Enter/允许都按 always 提交,
// 一路攒出几十条 settings.json 永久规则(用户实报四五十条)。
// 钉住两件事:
//   ① 每张新卡按 req.id 复位成 'none'(仅此次);
//   ② 允许按钮三态文案(允许 ↵ / 允许并本会话记住 ↵ / 允许并写入规则 ↵),
//      判据与 doAllow 一致 —— 提交前永远看得见这一击的真实后果。
// JSX 进不了 node,故从源码抠出表达式真跑,不是纯字符串 grep。
// Run: node tests/unit/check-r55-perm-sticky.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../client/src/components/PermissionPrompt.jsx', import.meta.url), 'utf8');

// ── ① 按请求复位 ──────────────────────────────────────────────
assert.match(
  src,
  /useEffect\(\s*\(\)\s*=>\s*\{\s*setRemember\('none'\);?\s*\}\s*,\s*\[\s*req\.id\s*\]\s*\)/,
  'r55-①: 必须有按 req.id 复位 remember 的 effect(体内 setRemember(\'none\')、deps 只认 req.id);删了它 = 上一张卡的「始终允许」带进下一张,每次允许都写永久规则',
);

// ── ② 允许按钮文案三态,且与 doAllow 同判据 ────────────────────
const m = src.match(/const allowLabel =([\s\S]*?);\n/);
assert.ok(m, 'r55-②: 找不到 allowLabel 表达式(按钮文案必须由 remember 推导,不能写死「允许 ↵」)');
const label = new Function('remember', 'noAlways', `return (${m[1].trim()});`);

assert.equal(label('none', false), '允许 ↵', 'r55-②: 仅此次 = 原文案');
assert.equal(label('session', false), '允许并本会话记住 ↵', 'r55-②: 会话级记住要写在按钮上');
assert.equal(label('always', false), '允许并写入规则 ↵', 'r55-②: 永久规则是后果最重的一击,必须在按钮上点明');
// noAlways(危险命令 / plan 写类 / 后台代理)时 doAllow 会退回普通 allow,文案不许撒谎
assert.equal(label('always', true), '允许 ↵', 'r55-②: noAlways 下 doAllow 不写规则,按钮不能声称写了');

// 按钮真的用了这个变量(而不是留着写死的文案)
assert.match(
  src,
  /\{processing && <Loader2[^>]*\/>\}\s*\n\s*\{allowLabel\}/,
  'r55-②: 允许按钮必须渲染 {allowLabel}',
);

// ── 红线:doAllow 的分发判据没被顺手改坏 ────────────────────────
assert.match(src, /if \(remember === 'session'\) onWhitelistAndAllow\(req\);/, 'r55: doAllow 分发逻辑不许动');
assert.match(src, /else if \(remember === 'always' && !noAlways\) onAlwaysAllow\(req\);/, 'r55: doAllow 分发逻辑不许动');

console.log('✓ check-r55-perm-sticky: 权限卡 remember 按 req.id 复位 + 允许按钮三态文案');
