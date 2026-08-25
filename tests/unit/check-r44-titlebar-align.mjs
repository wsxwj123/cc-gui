#!/usr/bin/env node
// r47:用户最终裁定 —— 标题栏【顶格靠左】(基础 padding 5-8px 即经典 XP/QQ 形态)。
// 历史:r42 定值 63px → r44 差值校正 → r45 实测系数 → r46 侧栏触发器,四轮"对齐 logo"
// 全是解错题;r47 停止武装,r49a 整段删除(见 t3)。
// 变异:任一退役函数/变量改回源码 → t3 红;恢复 63px 媒体规则 → t1 红。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

for (const skin of ['xp', 'miku']) {
  const css = readFileSync(new URL(`../../client/src/builtin-skins/${skin}/skin.css`, import.meta.url), 'utf-8');
  assert.ok(!/padding-left: 63px/.test(css), `t1[${skin}]: 63px 对齐补丁必须移除(顶格靠左)`);
  const js = readFileSync(new URL(`../../client/src/builtin-skins/${skin}/client.js`, import.meta.url), 'utf-8');
  const fit = js.match(/function fitDesk\(\) \{[^}]*\}/);
  assert.ok(fit && !fit[0].includes('alignTitlebar'), `t2[${skin}]: fitDesk 不再触发校准`);
  // r49a-⑤:退役机器【整段删除】。留着不武装等于每个读代码的人都要重新判断一次它是不是
  // 活的,还有人会顺手把它接回去;删了就没有"再武装"这种事。函数名与其句柄变量一个都不许剩,
  // 尤其 disposeAlign —— 卸载器里若还调它就是悬空引用,整张皮肤卸不掉。
  for (const gone of ['armAlign', 'settleTick', 'watchTopbar', 'alignTitlebar', 'disposeAlign',
    'alignRaf', 'settleTimer', 'settleLeft', 'topbarObserver', 'observedTopbar', 'topbarRaf', 'topbarRo']) {
    assert.ok(!new RegExp(`\\b${gone}\\b`).test(js), `t3[${skin}]: 对齐机器残留 ${gone}(定义或调用点没删干净)`);
  }
}
console.log('check-r44-titlebar-align: all passed (r47 顶格契约)');
