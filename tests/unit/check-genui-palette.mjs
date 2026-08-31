#!/usr/bin/env node
// 单测:r64 M9 主题映射 —— genui 别名层的**值形态**与**分类色板对比度**双闸(PLAN §1.6 / §1.6.2)。
//
// 为什么要有这条:8 色分类色板是固定值(不绑 accent),而主题的画布色是各改各的。
// 手工按主题复核不可持续 —— 以后任何人加一个新主题、或改了某个主题的 --color-canvas,
// 只要与色板打架,本单测当场红并打印是哪一对,不需要有人记得复核。
//
// 变异哨兵(四条都实际验证过红):
//   ① --dsw-static-amber-400 浅色值改回 `hsl(38 82% 45%)` → t1 红(空格分隔 hsl 不是终值形态)
//   ② 删掉 --dsw-alias-bg-base 那行            → t1b 红(上游引用了却没映射)
//   ③ 浅色 amber 改成 #E8B84B(亮琥珀)         → t2 红,指名 github-light #FFFFFF 1.84:1
//                                                 / tokyonight-day #E1E2E7 1.43:1
//   ④ 往 index.css 追加一个 --color-canvas: #8A8A8A 的新主题 → t2 红并指名该主题
//      (这条就是"以后任何人加新主题、不需要有人记得复核"的机制本身)
//
// ponytail: 覆盖面 = 仓内 index.css 的全部主题变体。**不覆盖用户皮肤**(皮肤可在运行时
// 改 --color-canvas)。皮肤把画布改到与固定色板打架的概率低,真出现再加运行时校正。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { globSync } from 'glob';

const root = fileURLToPath(new URL('../..', import.meta.url));
const tokensCss = readFileSync(`${root}/client/src/genui/host/genui-tokens.css`, 'utf8');
const indexCss = readFileSync(`${root}/client/src/index.css`, 'utf8');

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
/** 逐块拆 `选择器 { 声明 }`(本仓两个 css 都是单层块,没有嵌套 at-rule 包着 :root)。 */
function blocks(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(strip(css)))) out.push({ sel: m[1].trim(), body: m[2] });
  return out;
}
const decls = (body) => [...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]);

// ── t1 值形态:只许字面 hex / 逗号形式 rgba() / 单层 var(--color-*|--font-*) ──────
// 依据 §1.6.1 坑 A:readToken 读回的是**声明串**,直接进 ECharts option 走 zrender 解析器。
// color-mix() / 空格分隔 hsl() 的计算值是 `color(srgb …)` 这类 zrender 不一定认的形态。
{
  const OK = /^(?:#[0-9a-fA-F]{3,8}|rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*[\d.]+\s*)?\)|var\(--(?:color|font)-[\w-]+\))$/;
  const all = blocks(tokensCss).flatMap(({ body }) => decls(body));
  assert.ok(all.length >= 24, `t1: 别名层至少要定义 24 个 token(实际 ${all.length})`);
  for (const [name, value] of all) {
    assert.match(name, /^--(?:dsw|ds)-/, `t1: 别名层只该定义 --dsw-*/--ds-* token,越界: ${name}`);
    assert.ok(OK.test(value),
      `t1: ${name} 的值 \`${value}\` 不是终值形态。只许字面 hex / 逗号 rgba() / 单层 var(--color-*|--font-*);`
      + ' color-mix()、空格分隔 hsl()、calc() 套色都会让 readToken 交给 ECharts 一个解析不了的字符串(§1.6.1)。');
  }
}

// ── t1b 覆盖闭合:上游引用的每个 --dsw-*/--ds-* 都要有映射,否则静默回落上游写死的深色 ──
{
  const defined = new Set(blocks(tokensCss).flatMap(({ body }) => decls(body)).map(([n]) => n));
  // 上游只把这两个当"更上游的 fallback"用(`var(--dsw-alias-bg-layer-1, var(--dsw-alias-markdown-code-block))`
  // / `var(--dsw-alias-markdown-hr, var(--dsl-g-border))`),外层 token 已定义或兜底本身是变量,
  // 走不到硬编码色,故不要求映射。
  const EXEMPT = new Set(['--dsw-alias-markdown-code-block', '--dsw-alias-markdown-hr']);
  let src = '';
  for (const f of globSync('client/src/genui/upstream/**/*.{ts,tsx,css}', { cwd: root })) {
    src += readFileSync(`${root}/${f}`, 'utf8');
  }
  const referenced = new Set([...src.matchAll(/var\((--(?:dsw|ds)-[\w-]+)/g)].map((m) => m[1]));
  const missing = [...referenced].filter((t) => !defined.has(t) && !EXEMPT.has(t));
  assert.deepEqual(missing, [],
    `t1b: 上游引用了但别名层没映射的 token(会静默回落上游写死的深色): ${missing.join(', ')}`);
}

// ── t2 对比度:8 色 × 每个主题变体 × 明暗两套,任意一组 < 3:1 即红 ────────────────
const lum = (hex) => {
  const h = hex.replace('#', '').trim();
  const parts = h.length === 3 ? [...h].map((c) => c + c) : h.match(/../g);
  const [r, g, b] = parts.slice(0, 3).map((x) => parseInt(x, 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
{
  // 色板:`:root` 一套(浅)、`[data-theme="dark"]` 一套(深,只覆盖差异项)。
  const light = {};
  const dark = {};
  for (const { sel, body } of blocks(tokensCss)) {
    const target = /data-theme="dark"|data-theme-system="dark"/.test(sel) ? dark : light;
    for (const [n, v] of decls(body)) if (n.startsWith('--dsw-static-')) target[n] = v;
  }
  const darkFull = { ...light, ...dark };
  assert.equal(Object.keys(light).length, 8, 't2: 浅色色板必须是 8 色');
  assert.equal(Object.keys(darkFull).length, 8, 't2: 深色色板必须是 8 色');
  assert.equal(new Set(Object.values(light)).size, 8, 't2: 浅色 8 色必须两两不同');
  assert.equal(new Set(Object.values(darkFull)).size, 8, 't2: 深色 8 色必须两两不同');

  // 主题变体:index.css 里凡是定义了 --color-canvas 的块都算一个变体
  // (沿用 claude-gui-themes/scripts/build.js 的解析套路)。未重定义画布的变体
  // (如 glass-classic / glass-classic-dark)继承默认色,已被默认那两行覆盖。
  const variants = [];
  for (const { sel, body } of blocks(indexCss)) {
    const d = Object.fromEntries(decls(body));
    if (!d['--color-canvas']) continue;
    const canvas = d['--color-canvas'];
    // 明/暗判定:画布对白底更"显眼"还是对黑底更"显眼"。等价于本仓 THEME_FAMILIES
    // 里 light/dark 的分档(dark 变体的画布必然是深色),但不依赖 JS 侧注册表。
    const isDark = contrast(canvas, '#FFFFFF') > contrast(canvas, '#000000');
    variants.push({
      name: (sel.split(',').pop() || sel).trim(),
      isDark,
      surfaces: [canvas, d['--color-canvas-warm']].filter(Boolean),
    });
  }
  assert.ok(variants.length >= 30, `t2: 应当扫到 ≥30 个主题变体(实际 ${variants.length}),解析套路可能失配了`);

  const bad = [];
  for (const v of variants) {
    const palette = v.isDark ? darkFull : light;
    for (const [token, hex] of Object.entries(palette)) {
      for (const surface of v.surfaces) {
        const c = contrast(hex, surface);
        if (c < 3) bad.push(`${v.name} 的 ${surface} 上,${token}(${hex}) 只有 ${c.toFixed(2)}:1`);
      }
    }
  }
  assert.deepEqual(bad, [],
    't2: 分类色板与画布对比度不足 3:1(WCAG 非文本下限)。\n  '
    + bad.join('\n  ')
    + '\n  → 改这个色板的值(client/src/genui/host/genui-tokens.css),或把新主题的画布调开。');
}

console.log('check-genui-palette: all passed');
