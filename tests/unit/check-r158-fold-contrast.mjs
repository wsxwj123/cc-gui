#!/usr/bin/env node
// r158:折叠行淡色(--cg-fold-fg)在全部主题里都要「比正文淡、但仍看得清」。
// 读 client/src/index.css:解析每个主题块的 --color-canvas / --color-ink-soft / --color-ink-muted,
// 从 CSS 文本里解析 --cg-fold-fg 的混色公式(两个颜色变量 + 百分比,不写死)与按主题的覆写,
// 逐主题按 WCAG 对比度断言。运行:node tests/unit/check-r158-fold-contrast.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const css = readFileSync(join(root, 'client/src/index.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// ── 颜色工具 ────────────────────────────────────────────────────────
const rgb = (h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));
const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const mix = (a, b, t) => a.map((v, i) => Math.round(v * t + b[i] * (1 - t)));

// ── 解析顶层规则块:选择器 → 变量表 ────────────────────────────────────
const rules = [];
for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const vars = Object.fromEntries([...m[2].matchAll(/--([a-z0-9-]+):\s*([^;]+);/gi)].map((x) => [x[1], x[2].trim()]));
  rules.push({ sel: m[1].trim(), vars });
}
const hexVars = (vars) => Object.fromEntries(Object.entries(vars).filter(([, v]) => /^#[0-9a-f]{6}$/i.test(v)));
const NEED = ['color-canvas', 'color-ink-soft', 'color-ink-muted'];
const complete = (v) => NEED.every((k) => v[k]);

const themes = new Map();
// 默认浅色:@theme 里的值(:root 若覆写同名变量则以 :root 为准)
const themeBlock = css.match(/@theme\s*\{([^{}]*)\}/);
assert.ok(themeBlock, '找不到 @theme 块');
const lightBase = hexVars(Object.fromEntries([...themeBlock[1].matchAll(/--([a-z0-9-]+):\s*([^;]+);/gi)].map((x) => [x[1], x[2].trim()])));
const rootRule = rules.find((r) => r.sel === ':root' && r.vars['cg-fold-fg']);
assert.ok(rootRule, '找不到定义 --cg-fold-fg 的 :root 块');
themes.set('default-light', { ...lightBase, ...hexVars(rootRule.vars) });
// 默认深色
const darkRule = rules.find((r) => /^:root\[data-theme="dark"\]/.test(r.sel) && complete(hexVars(r.vars)));
assert.ok(darkRule, '找不到默认深色主题块');
themes.set('default-dark', hexVars(darkRule.vars));
// 命名主题(只收选择器全是 :root[data-cgui-theme="…"] 的块;同名多块按出现顺序合并)
for (const r of rules) {
  const parts = r.sel.split(',').map((s) => s.trim());
  const names = parts.map((p) => p.match(/^:root\[data-cgui-theme="([a-z0-9-]+)"\]$/)?.[1]);
  if (!names.length || names.some((n) => !n)) continue;
  const hv = hexVars(r.vars);
  if (!Object.keys(hv).length) continue;
  for (const n of names) themes.set(n, { ...(themes.get(n) || {}), ...hv });
}
for (const [n, v] of [...themes]) if (!complete(v)) themes.delete(n);
assert.ok(themes.size >= 30, `解析到的完整主题太少(${themes.size}),解析可能失效`);

// ── --cg-fold-fg 公式与按主题覆写 ────────────────────────────────────
const formula = rootRule.vars['cg-fold-fg'].match(/^color-mix\(in srgb,\s*var\(--([a-z0-9-]+)\)\s*([\d.]+)%,\s*var\(--([a-z0-9-]+)\)\s*\)$/);
assert.ok(formula, `--cg-fold-fg 应是两色 color-mix,实际: ${rootRule.vars['cg-fold-fg']}`);
const [, varA, pctA, varB] = formula;
const overrides = new Map();
for (const r of rules) {
  if (!r.vars['cg-fold-fg'] || r === rootRule) continue;
  const to = r.vars['cg-fold-fg'].match(/^var\(--([a-z0-9-]+)\)$/);
  assert.ok(to, `主题覆写的 --cg-fold-fg 只允许 var(--颜色变量),实际: ${r.vars['cg-fold-fg']}`);
  for (const p of r.sel.split(',')) {
    const n = p.trim().match(/^:root\[data-cgui-theme="([a-z0-9-]+)"\]$/)?.[1];
    assert.ok(n, `--cg-fold-fg 覆写的选择器应是主题选择器: ${p.trim()}`);
    overrides.set(n, to[1]);
  }
}

// 覆写里写到的主题必须真实存在(防拼错,或主题被删后覆写悬空)
for (const n of overrides.keys()) assert.ok(themes.has(n), `--cg-fold-fg 覆写了不存在的主题 ${n}`);

// ── 逐主题断言 ─────────────────────────────────────────────────────
const TESTED = ['default-light', 'claude-warm', 'github-light', 'default-dark', 'github-dark', 'nord', 'claude-dark'];
const problems = [];
for (const [name, v] of themes) {
  const canvas = rgb(v['color-canvas']);
  const pick = (k) => rgb(v[k] || v['color-ink-muted']);
  const fold = overrides.has(name) ? pick(overrides.get(name)) : mix(pick(varA), pick(varB), Number(pctA) / 100);
  const body = contrast(rgb(v['color-ink-soft']), canvas);
  const f = contrast(fold, canvas);
  const tag = `${name}(折叠 ${f.toFixed(2)} / 正文 ${body.toFixed(2)})`;
  if (f > body + 0.01) problems.push(`${tag}:折叠行比正文还醒目`);
  // 每个主题都有下限:正文 ≥ 4.5 的主题折叠行 ≥ 4.5;正文本身不到 4.5 的主题折叠行不许比正文更淡
  if (f < Math.min(body, 4.5) - 0.01) problems.push(`${tag}:折叠行低于下限 ${(Math.min(body, 4.5) - 0.01).toFixed(2)}`);
  if (body >= 4.8 && f < 4.5) problems.push(`${tag}:正文 ≥ 4.8 的主题折叠行应 ≥ 4.5`);
  if (body >= 7.5 && body - f < 1.2) problems.push(`${tag}:正文 ≥ 7.5 的主题折叠行与正文应差 ≥ 1.2`);
  if (TESTED.includes(name) && (body - f < 3.0 || f < 4.5)) problems.push(`${tag}:测试主题要求差 ≥ 3.0 且折叠行 ≥ 4.5`);
}
for (const n of TESTED) assert.ok(themes.has(n), `没解析到测试主题 ${n}`);
assert.deepEqual(problems, [], `折叠行对比度不合格:\n  ${problems.join('\n  ')}`);

console.log(`✓ check-r158-fold-contrast: ${themes.size} 个主题的折叠行淡色都合格(公式 ${varA} ${pctA}% + ${varB},覆写 ${overrides.size} 个主题)`);
