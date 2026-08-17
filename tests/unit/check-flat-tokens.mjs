#!/usr/bin/env node
// 单测:r11-⑧ 全局扁平化 —— 形状 token 基建(默认=扁平)+ 玻璃拟态(经典)恢复块 +
// codemod 收敛源码守卫(禁新增裸 rounded-2xl/shadow-lg/backdrop-blur-sm 等)+ 红线。
// 变异哨兵(实际验证过红):@theme 默认 --backdrop-glass 改回 blur(18px)(删扁平值
// 回落玻璃)→ t1 红。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { globSync } from 'glob';
import { THEME_FAMILIES } from '../../client/src/stores/sessionStore.js';

const css = readFileSync(new URL('../../client/src/index.css', import.meta.url), 'utf8');

// t1 扁平默认值(@theme 圆角 + :root 形状块):小圆角/无阴影/不磨砂/面板底色补齐
{
  const theme = css.slice(css.indexOf('@theme {'), css.indexOf('}\n', css.indexOf('--glass-underlay')));
  assert.match(theme, /--radius-2xl: 8px/, 't1: 大档圆角收到 8px');
  assert.match(theme, /--radius-panel: 8px/, 't1: 面板圆角 token(6-8px 档)');
  assert.match(theme, /--radius-control: 6px/, 't1: 控件圆角 token');
  // 阴影 token 必须在 @theme 之外(TW v4 会把 @theme 阴影值烘死进工具类,
  // 运行时主题覆写失效——实测);扁平值 = 0 0 #0000(组合链列表安全的"无影")
  const themeOnly = css.slice(css.indexOf('@theme {'), css.indexOf('}', css.indexOf('--radius-control')));
  assert.doesNotMatch(themeOnly, /--shadow-panel:|--shadow-popover:/, 't1: 阴影 token 声明不进 @theme(防构建期烘死;注释提及不算)');
  assert.match(theme, /--shadow-panel: 0 0 #0000/, 't1: 面板默认无阴影');
  assert.match(theme, /--shadow-bevel: 0 0 #0000/, 't1: 内高光斜面默认关');
  assert.match(theme, /--shadow-accent: 0 0 #0000/, 't1: accent 按钮默认无投影');
  assert.match(theme, /--shadow-popover: 0 4px 16px rgba\(0, 0, 0, 0\.10\)/, 't1: 浮层保留轻投影(可读性)');
  assert.match(theme, /--backdrop-glass: none/, 't1: 面板级磨砂默认关(哨兵锚)');
  assert.match(theme, /--backdrop-soft: none/, 't1: 遮罩级磨砂默认关');
  assert.match(theme, /--glass-underlay: color-mix\(in srgb, var\(--color-canvas\) var\(--surface-alpha\), transparent\)/,
    't1: 玻璃面底色补齐=画布色(面板纯色;界面不透明度调低仍透底)');
  // 注释安全:全文件禁止「-星/」相邻序列(通配写法会提前闭合注释,把后文变成
  // 垃圾声明静默毒化 @theme 命名空间——rounded-panel 曾因此不生成,实测踩过)
  assert.equal(css.includes('-*' + '/'), false, 't1: 注释内无提前闭合序列');
  // 手写 shadow 工具类:引用 var + 保留 --tw-* 组合链(与 ring 共存)
  assert.match(css, /\.shadow-panel \{\s*--tw-shadow: var\(--shadow-panel\);/, 't1: shadow-panel 手写工具类(运行时可主题化)');
  assert.match(css, /\.shadow-popover \{\s*--tw-shadow: var\(--shadow-popover\);/, 't1: shadow-popover 手写工具类');
}

// t2 玻璃面消费 token(不再散写具体值);.glass-popover 不透底红线
{
  assert.match(css, /\.glass-thick \{[^}]*box-shadow: var\(--shadow-panel\)/s, 't2: thick 走 shadow-panel');
  assert.match(css, /\.glass-thin \{[^}]*box-shadow: var\(--shadow-bevel\)/s, 't2: thin 走 shadow-bevel');
  assert.match(css, /\.glass-bar \{[^}]*backdrop-filter: var\(--backdrop-glass\)/s, 't2: bar 磨砂走 token');
  assert.match(css, /\.glass-capsule \{[^}]*box-shadow: var\(--shadow-capsule\)/s, 't2: capsule 走 token');
  assert.match(css, /\.glass-popover \{[^}]*background: var\(--color-canvas\)/s, 't2: 红线——popover 恒画布纯色不透底');
  assert.match(css, /\.glass-popover \{[^}]*box-shadow: var\(--shadow-popover\)/s, 't2: popover 阴影走 token');
  // 五类玻璃面的 background 全部带 underlay 混合臂
  assert.equal((css.match(/var\(--surface-alpha\), var\(--glass-underlay\)\)/g) || []).length >= 5 ? true : false, true,
    't2: 玻璃面 background 均带 --glass-underlay 补齐臂(≥5 处)');
  assert.match(css, /\.btn-accent \{[^}]*border-radius: var\(--radius-control\)/s, 't2: 按钮圆角走 control token');
  assert.match(css, /\.btn-accent \{[^}]*box-shadow: var\(--shadow-accent\)/s, 't2: 按钮投影走 token');
  // 收敛 utility 存在
  assert.match(css, /\.backdrop-blur-soft \{[\s\S]*?backdrop-filter: var\(--backdrop-soft\)/, 't2: backdrop-blur-soft utility');
  assert.match(css, /\.backdrop-blur-glass \{[\s\S]*?backdrop-filter: var\(--backdrop-glass\)/, 't2: backdrop-blur-glass utility');
}

// t3 玻璃拟态(经典)恢复块:两变体选择器 + 全部形状现值恢复;深浅两态共用一块
{
  const i = css.indexOf(':root[data-cgui-theme="glass-classic"]');
  assert.ok(i > 0, 't3: glass-classic 恢复块存在');
  const block = css.slice(i, css.indexOf('}', i) + 1);
  assert.match(block, /:root\[data-cgui-theme="glass-classic-dark"\]/, 't3: 深色变体同块(深浅两态都恢复)');
  assert.match(block, /--radius-2xl: 12px/, 't3: 圆角恢复现值');
  assert.match(block, /--radius-panel: 12px/, 't3: 面板圆角恢复');
  assert.match(block, /--backdrop-glass: blur\(18px\)/, 't3: 磨砂恢复 18px');
  assert.match(block, /--backdrop-soft: blur\(4px\)/, 't3: 轻磨砂恢复 4px');
  assert.match(block, /--glass-underlay: transparent/, 't3: 透底恢复');
  assert.match(block, /--shadow-panel:\s*\n?\s*inset 0 1px 0 var\(--glass-specular\)/, 't3: 面板浮雕恢复');
  assert.match(block, /--shadow-accent-hover:/, 't3: 按钮 hover 投影恢复');
  // 色值不在 shape 块里重复(light 用 @theme 默认,dark 用 data-theme mixin)
  assert.doesNotMatch(block, /--color-canvas:/, 't3: shape 块不声明色值(配色正交)');
  // 深色 mixin 不碰形状 token(扁平在深色态同样成立)
  const darkMixin = css.slice(css.indexOf(':root[data-theme="dark"]'), css.indexOf('THEME PRESETS'));
  const mixinOnly = darkMixin.slice(0, darkMixin.indexOf('glass-classic'));
  assert.doesNotMatch(mixinOnly, /--shadow-panel|--radius-panel|--backdrop-glass/, 't3: 深色 mixin 零形状 token');
}

// t4 THEME_FAMILIES:玻璃拟态(经典)家族(import 真数据)
{
  const fam = THEME_FAMILIES.find((f) => f.id === 'glass');
  assert.ok(fam, 't4: glass 家族存在');
  assert.equal(fam.name, '玻璃拟态(经典)', 't4: 家族名');
  assert.equal(fam.light.id, 'glass-classic', 't4: 浅色变体 id');
  assert.equal(fam.dark.id, 'glass-classic-dark', 't4: 深色变体 id');
  assert.equal(THEME_FAMILIES.filter((f) => f.id === 'glass').length, 1, 't4: 不重复');
}

// t5 源码守卫:全仓组件禁裸 rounded-xl/2xl/3xl、shadow-sm..2xl、backdrop-blur-sm..xl
//    (白名单:当前无既有例外,残留=0;新增即红)
{
  const files = globSync('client/src/**/*.jsx', { cwd: fileURLToPath(new URL('../..', import.meta.url)) });
  assert.ok(files.length > 20, 't5: 扫描面正常');
  const bare = /\brounded-(?:xl|2xl|3xl)\b|\bshadow-(?:sm|md|lg|xl|2xl)\b|\bbackdrop-blur-(?:sm|md|lg|xl|2xl|3xl)\b/;
  const offenders = [];
  for (const f of files) {
    const src = readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
    if (bare.test(src)) offenders.push(f);
  }
  assert.deepEqual(offenders, [], `t5: 组件零裸形状工具类(收敛到 token),违例: ${offenders.join(',')}`);
}

// t6 红线:animate-glass-rise 与 glassRise keyframes 原样(scale 收尾/fill both 的
//    sticky/transform 规避语义不因扁平化回退)
{
  assert.match(css, /@keyframes glassRise \{\s*from \{ opacity: 0; transform: translateY\(12px\) scale\(0\.97\); \}\s*to \{ opacity: 1; transform: translateY\(0\) scale\(1\); \}\s*\}/, 't6: glassRise keyframes 原样');
  assert.match(css, /\.animate-glass-rise \{ animation: glassRise 0\.32s cubic-bezier\(0\.2, 0\.8, 0\.2, 1\) both; \}/, 't6: animate-glass-rise 原样');
}

console.log('check-flat-tokens: all passed');
