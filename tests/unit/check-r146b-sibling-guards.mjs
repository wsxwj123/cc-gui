#!/usr/bin/env node
// 单测:r146b(R3 返工)同族建议 —— handleSend 里三条"错误后自愈"支路的窗格复查(源码锚)。
//
// 背景:这三条支路在流里收到错误后同步执行,但会动【本窗格】:「No conversation found」把窗格换成
// 新 draft、1M 被拒 / auto 档回退弹提示条。错误到达与动窗格之间没有复查,窗格万一已不是发起会话
// (关左窗格位移、迟到事件等),就会把别的会话换成 draft、把提示挂在别的会话上。
// 为什么是源码锚:触发需要在错误到达那一刻窗格已经换走,而本端流在切会话时就被 detach,界面上
// 制造不出这个时序;只锁"动窗格之前先 paneStillOn 复查"这条结构。
// Run: node tests/unit/check-r146b-sibling-guards.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const app = readFileSync(fileURLToPath(new URL('../../client/src/App.jsx', import.meta.url)), 'utf8');
let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.log(`  ✗ ${name}\n      ${e.message}`); }
};
// r146c 加强(判官要求):原来只断言"支路里 sink 之前出现过 paneStillOn(",复查结果不管用不用、sink 在不在
// 它守住的块里都能过。现在要求 sink 确实被一个"条件里直接调用 paneStillOn( 的 if"守住:要么在它的 {} 块内
// (任意一层),要么是它的单语句体。
/** sink 必须被 if (paneStillOn(…)) 守住。 */
const guardedBefore = (branchAnchor, sink) => {
  const start = app.indexOf(branchAnchor);
  assert.ok(start > 0, `找不到支路:${branchAnchor}`);
  const at = app.indexOf(sink, start);
  assert.ok(at > start && at - start < 3000, `支路里找不到 ${sink}`);
  // ① 单语句体:同一行上 sink 前面紧挨着 if (paneStillOn(...))
  const line = app.slice(app.lastIndexOf('\n', at) + 1, at);
  if (/if \(paneStillOn\([^)]*\)\) $/.test(line)) return;
  // ② 块内:从 sink 往外逐层找包住它的 {,任一层 { 前面的 if 条件直接调用 paneStillOn( 即可(到支路起点为止)
  let depth = 0;
  for (let i = at - 1; i > start; i -= 1) {
    const ch = app[i];
    if (ch === '}') depth += 1;
    else if (ch === '{') {
      if (depth > 0) { depth -= 1; continue; }
      if (/if \(paneStillOn\([^{}]*\)\s*$/.test(app.slice(Math.max(start, i - 200), i))) return;
    }
  }
  assert.fail(`${sink} 不在 if (paneStillOn(…)) 守住的块里`);
};

console.log('r146b 同族支路的窗格复查');
check('「No conversation found」:把窗格换成新 draft 之前先复查窗格', () =>
  guardedBefore("if (/No conversation found/i.test(msg) && !opts.freshRetry && prompt) {", "setSelectedSession({ ..._s, sessionId: null, draft: true"));
check('「No conversation found」:提示条落地前复查窗格', () =>
  guardedBefore("if (/No conversation found/i.test(msg) && !opts.freshRetry && prompt) {", "setProviderSwitchNotice({ text: '原会话历史已失效"));
check('1M 被拒:提示条落地前复查窗格', () =>
  guardedBefore("if (/usage credits required for 1m context|long context beta is not (yet )?available/i.test(msg) && !opts.oneMRetry && prompt) {", "setProviderSwitchNotice({ text: '订阅未开通 1M"));
check('auto 档回退(结果报错那支):提示条落地前复查窗格', () =>
  guardedBefore("if (useStore.getState().getPermissionModeFor(sessionQueueKey) === 'auto' && !opts.autoRetry && prompt\n              && /auto/i.test(msg)", "setProviderSwitchNotice({ text: '当前模型 / 账户不支持「自动」权限档"));

if (failed) { console.log(`\n${failed} 项失败`); process.exit(1); }
console.log('\n全部通过');
