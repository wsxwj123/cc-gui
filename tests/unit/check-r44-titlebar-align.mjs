#!/usr/bin/env node
// r47:用户最终裁定 —— 标题栏【顶格靠左】(基础 padding 5-8px 即经典 XP/QQ 形态)。
// 历史:r42 定值 63px → r44 差值校正 → r45 实测系数 → r46 侧栏触发器,四轮"对齐 logo"
// 全是解错题;机器保留在源码中但【不再武装】(armAlign 不被调用,观察器/settle 永不启动)。
// 变异:恢复 armAlign() 调用 → t2 红;恢复 63px 媒体规则 → t1 红。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

for (const skin of ['xp', 'miku']) {
  const css = readFileSync(new URL(`../../client/src/builtin-skins/${skin}/skin.css`, import.meta.url), 'utf-8');
  assert.ok(!/padding-left: 63px/.test(css), `t1[${skin}]: 63px 对齐补丁必须移除(顶格靠左)`);
  const js = readFileSync(new URL(`../../client/src/builtin-skins/${skin}/client.js`, import.meta.url), 'utf-8');
  assert.ok(!/^\s*armAlign\(\);\s*$/m.test(js), `t2[${skin}]: 校准机器不得被武装(armAlign 无调用点)`);
  const fit = js.match(/function fitDesk\(\) \{[^}]*\}/);
  assert.ok(fit && !fit[0].includes('alignTitlebar'), `t2[${skin}]: fitDesk 不再触发校准`);
  assert.ok(/function disposeAlign\(\)/.test(js), `t3[${skin}]: 退役函数保留(dispose 引用安全)`);
}
console.log('check-r44-titlebar-align: all passed (r47 顶格契约)');
