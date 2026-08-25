#!/usr/bin/env node
// r44:标题栏与 CC-GUI logo 机械对齐(定值内边距在不同缩放/布局下必偏,用户机 zoom1.2 实证)。
// 静态钉形态(DOM 行为已由协调者浏览器实测:zoom1.0/1.2 均 <1px、人为打偏 37px 一次 resize 拉回)。
// 变异:删 fitDesk 内的 alignTitlebar() 调用 → t2 红;删 dispose 的 cancelAnimationFrame → t3 红。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

for (const skin of ['xp', 'miku']) {
  const src = readFileSync(new URL(`../../client/src/builtin-skins/${skin}/client.js`, import.meta.url), 'utf-8');
  assert.ok(/function alignTitlebar\(\)/.test(src), `t1[${skin}]: 必须有 alignTitlebar`);
  assert.ok(/Math\.abs\(target - current\) < 1\) return/.test(src), `t1[${skin}]: 幂等守卫(差<1px 跳过,防重写风暴)`);
  const fit = src.match(/function fitDesk\(\) \{[^}]*\}/);
  assert.ok(fit && fit[0].includes('alignTitlebar()'), `t2[${skin}]: fitDesk 必须调用 alignTitlebar(resize/缩放重校)`);
  assert.ok(/var alignRaf = requestAnimationFrame\(alignTitlebar\)/.test(src), `t2[${skin}]: 首帧重校`);
  assert.ok(/cancelAnimationFrame\(alignRaf\)/.test(src), `t3[${skin}]: dispose 清 rAF`);
  assert.ok(!/setInterval/.test(src), `t3[${skin}]: 不得引入常驻定时器`);
}
console.log('check-r44-titlebar-align: all passed');
