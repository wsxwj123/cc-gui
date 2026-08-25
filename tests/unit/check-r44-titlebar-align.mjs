#!/usr/bin/env node
// r44/r45:标题栏图标与 CC-GUI logo 机械对齐(xp/miku 皮肤 client.js)。
// r44 = 定值内边距证伪后改「运行时差值校正」,但差值是按 gBCR ÷ CSS zoom 换算的 —— 那是
// 拿「gBCR 是布局 px」当假设,用户机(系统 WebKit,zoom 1.2)实测仍偏。
// r45 = 引擎无关化:换算系数改成【实测】(gBCR.width ÷ offsetWidth),不假设任何坐标口径;
// 触发从「一次性测量」加固为四路(install/首帧 rAF/fitDesk + settle 轮询 + 字体就绪 +
// topbar 结构观察器),全部句柄进 disposeAlign;实际写入时经全局桥上报取证数。
// 静态钉形态(DOM 行为由协调者浏览器实测:zoom1.0/1.2 均 <1px、人为打偏 37px 一次 resize 拉回)。
// 变异(实际验证过红):
//   ① alignTitlebar 换回 r44 的 `/ z`(zoom 假设)→ a2/a3/a4 红;
//   ② disposeAlign 删 clearTimeout(settleTimer) → c1 红。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateT2Script } from '../../server/utils/skin-validate.js';

// 取证桥:皮肤脚本(Blob 经典脚本)拿不到 skins.js 模块作用域,且 T2 黑名单逐字禁
// navigator.sendBeacon / fetch( —— 内联上报会让整张皮肤被拒载,故只能走全局桥。
const skinsJs = readFileSync(new URL('../../client/src/utils/skins.js', import.meta.url), 'utf-8');
assert.match(skinsJs, /window\.__cguiSkinTrace = skinTrace/, 'g1: skins.js 必须挂出 __cguiSkinTrace 全局桥');

for (const skin of ['xp', 'miku']) {
  const src = readFileSync(new URL(`../../client/src/builtin-skins/${skin}/client.js`, import.meta.url), 'utf-8');
  // 函数体切片:声明处 → 首个 2 空格缩进的 `}`(嵌套块缩进更深,不会误截)
  const cut = (name) => {
    const i = src.indexOf(`function ${name}(`);
    assert.ok(i >= 0, `t0[${skin}]: 必须有 ${name}`);
    return src.slice(i, src.indexOf('\n  }', i));
  };
  const align = cut('alignTitlebar');

  // ── a:实测换算系数(引擎无关化的灵魂)──────────────────────────
  assert.match(align, /titlebar\.getBoundingClientRect\(\)\.width \/ titlebar\.offsetWidth/,
    `a1[${skin}]: 换算系数必须是实测的 gBCR.width ÷ offsetWidth`);
  assert.ok(!/zoom/.test(align), `a2[${skin}]: 对齐不得再读 CSS zoom(引擎口径假设,r44 证伪)`);
  assert.match(align, /var target = brand\.getBoundingClientRect\(\)\.left;/,
    `a3[${skin}]: target 取原始 gBCR.left(不再除 zoom)`);
  assert.match(align, /var current = icon\.getBoundingClientRect\(\)\.left;/,
    `a3[${skin}]: current 取原始 gBCR.left(不再除 zoom)`);
  assert.match(align, /Math\.round\(pad \+ \(target - current\) \/ scale\)/,
    `a4[${skin}]: 修正量 ÷ 实测系数换回布局 px`);
  // 三道守卫原样保留
  assert.match(align, /Math\.abs\(target - current\) < 1\) return/, `a5[${skin}]: 幂等守卫(差<1px 跳过)`);
  assert.match(align, /target <= 0/, `a5[${skin}]: target<=0 守卫`);
  assert.match(align, /if \(next >= 6\)/, `a5[${skin}]: next>=6 守卫`);
  // 取证:只有真写入 padding 时才发,载荷含实测数
  assert.match(align, /titlebar\.style\.paddingLeft = next \+ 'px';\s*\n\s*trace\(\{/,
    `a6[${skin}]: 取证紧跟实际写入(跳过时不发)`);
  for (const k of ['target', 'current', 'scale', 'pad', 'next']) {
    assert.ok(new RegExp(`${k}: ${k}`).test(align), `a6[${skin}]: 取证载荷必须带 ${k}`);
  }
  assert.match(src, /window\.__cguiSkinTrace/, `a6[${skin}]: 经全局桥上报(不内联 sendBeacon/fetch)`);

  // ── b:触发加固四路 ────────────────────────────────────────────
  const fit = src.match(/function fitDesk\(\) \{[^}]*\}/);
  assert.ok(fit && fit[0].includes('alignTitlebar()'), `b1[${skin}]: fitDesk 必须调用 alignTitlebar(resize/缩放重校)`);
  const arm = cut('armAlign');
  assert.match(arm, /alignRaf = requestAnimationFrame\(alignTitlebar\)/, `b1[${skin}]: 首帧重校`);
  assert.match(arm, /settleTimer = setTimeout\(settleTick, 250\)/, `b2[${skin}]: settle 轮询起链`);
  assert.match(arm, /document\.fonts && document\.fonts\.ready/, `b3[${skin}]: 字体就绪重校`);
  assert.match(arm, /document\.fonts\.ready\.then\(alignTitlebar/, `b3[${skin}]: 字体就绪回调即重校`);
  const settle = cut('settleTick');
  assert.match(src, /var settleLeft = 12;/, `b2[${skin}]: settle 轮询 12 次`);
  assert.match(settle, /settleLeft -= 1/, `b2[${skin}]: 每跳扣余额`);
  assert.match(settle, /settleTimer = settleLeft > 0 \? setTimeout\(settleTick, 250\) : 0/,
    `b2[${skin}]: 余额耗尽自停(不常驻)`);
  assert.match(settle, /alignTitlebar\(\)/, `b2[${skin}]: 每跳重校`);
  const watch = cut('watchTopbar');
  assert.match(watch, /document\.querySelector\('\[data-cgui="topbar"\]'\)/, `b4[${skin}]: 观察 topbar 结构`);
  assert.match(watch, /new MutationObserver\(/, `b4[${skin}]: 结构观察器`);
  assert.match(watch, /observe\(topbar, \{ childList: true, subtree: true \}\)/, `b4[${skin}]: childList+subtree`);
  assert.match(watch, /topbarRaf = requestAnimationFrame\(/, `b4[${skin}]: rAF 合帧(一帧只重校一次)`);
  assert.ok(/零回环/.test(src), `b4[${skin}]: 观察 topbar / 只写 titlebar 的零回环论证必须留在注释里`);

  // ── c:句柄全进 dispose(穿脱两次无泄漏)────────────────────────
  const off = cut('disposeAlign');
  assert.match(off, /cancelAnimationFrame\(alignRaf\)/, `c1[${skin}]: 清首帧 rAF`);
  assert.match(off, /clearTimeout\(settleTimer\)/, `c1[${skin}]: 清 settle 链`);
  assert.match(off, /cancelAnimationFrame\(topbarRaf\)/, `c1[${skin}]: 清观察器合帧 rAF`);
  assert.match(off, /topbarObserver\.disconnect\(\)/, `c1[${skin}]: 断开 topbar 观察器`);
  // 接线:xp 走自写卸载器,miku 走引用计数 track
  const wired = skin === 'miku' ? /track\(disposeAlign\)/ : /__cguiSkinDispose = function \(\) \{\s*\n\s*disposeAlign\(\);/;
  assert.match(src, wired, `c2[${skin}]: disposeAlign 必须接进卸载链`);
  assert.ok(!/setInterval\s*\(/.test(src), `c3[${skin}]: 不得引入常驻定时器(settle 必须是自停的 setTimeout 链)`);

  // ── d:取证不得把整张皮肤送进黑名单(sendBeacon/fetch 即拒载)──
  assert.equal(validateT2Script(src).ok, true, `d1[${skin}]: client.js 仍过 T2 静态黑名单`);
}
// t6(r46): 侧栏开合平移 logo 但无 topbar 子树 mutation、无 window resize —— 必须有
// ResizeObserver 盯 topbar 自身尺寸(用户实报根因)。变异:删 ResizeObserver 段 → 红。
for (const skin of ['xp', 'miku']) {
  const src = readFileSync(new URL(`../../client/src/builtin-skins/${skin}/client.js`, import.meta.url), 'utf-8');
  assert.ok(/new ResizeObserver\(/.test(src), `t6[${skin}]: 必须有 ResizeObserver`);
  assert.ok(/topbarRo\.observe\(topbar\)/.test(src), `t6[${skin}]: ResizeObserver 必须盯 topbar`);
  assert.ok(/topbarRo\.disconnect\(\); topbarRo = null;/.test(src), `t6[${skin}]: dispose 清 ResizeObserver`);
  assert.ok(/window\.ResizeObserver/.test(src), `t6[${skin}]: 特性检测(老引擎兜底)`);
}

console.log('check-r44-titlebar-align: all passed');
