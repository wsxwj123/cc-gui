#!/usr/bin/env node
// r169 修法 1:只有"用户真的离开了底部"才算在看历史。
// scrollTop 往上走、但挪完离底仍 ≤ 2px(浏览器钳位、内容缩几像素、滚动锚定补偿)不改变跟随状态;
// 往上走且离底 > 2px 仍立即进入"在看历史"。App.jsx 消息列表与 SubagentView 共用同一判据。
// 运行:node tests/unit/check-r169-bottom-tolerance.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BOTTOM_TOLERANCE_PX,
  advanceScrollTransaction,
  beginScrollTransaction,
  shouldPauseAutoScroll,
} from '../../client/src/utils/scroll.js';

assert.equal(BOTTOM_TOLERANCE_PX, 2, '容差约 2px(任务文件修法 1)');

// ── 浏览器钳位 / 锚定补偿:往上挪但仍贴底 → 不算用户上翻 ──────────────────────────
// 实测轨迹(分屏右窗格,Chromium):发送瞬间消息区变高,scrollTop 61368→61342、离底 −1;
// 之后内容每次缩 1px,scrollTop 61383→61382→61381→61380→61379,离底始终 0。
const clampTrace = [
  { previousTop: 61368, currentTop: 61342, distFromBottom: -1 },
  { previousTop: 61383, currentTop: 61382, distFromBottom: 0 },
  { previousTop: 61382, currentTop: 61381, distFromBottom: 0 },
  { previousTop: 61381, currentTop: 61380, distFromBottom: 0 },
  { previousTop: 61380, currentTop: 61379, distFromBottom: 0 },
];
for (const step of clampTrace) {
  assert.equal(shouldPauseAutoScroll(step), false,
    `浏览器为保持贴底往上挪(${step.previousTop}→${step.currentTop},离底 ${step.distFromBottom})不得判成用户上翻`);
}
// 视口拉高 150px:浏览器把 scrollTop 钳到新上限,离底 0
assert.equal(shouldPauseAutoScroll({ previousTop: 50000, currentTop: 49850, distFromBottom: 0 }), false,
  '消息区变高后的钳位不得判成用户上翻');
// 小数像素(界面缩放)下钳位后的离底在容差内
assert.equal(shouldPauseAutoScroll({ previousTop: 1000.4, currentTop: 998.6, distFromBottom: 1.6 }), false);
assert.equal(shouldPauseAutoScroll({ previousTop: 1000, currentTop: 990, distFromBottom: 2 }), false,
  '离底正好等于容差仍算贴底');

// ── 真实上翻:往上挪且挪完离开了底部 → 仍立即进入"在看历史" ───────────────────────
assert.equal(shouldPauseAutoScroll({ previousTop: 900, currentTop: 850, distFromBottom: 50 }), true,
  '往上翻 50px、离底 50 必须暂停跟随(不能等离底数百像素才锁)');
assert.equal(shouldPauseAutoScroll({ previousTop: 900, currentTop: 897, distFromBottom: 3 }), true,
  '离底刚超过容差也算离开底部');
assert.equal(shouldPauseAutoScroll({ previousTop: 61383, currentTop: 60783, distFromBottom: 600 }), true,
  '往上翻 600px 必须暂停跟随');
// 往下滚 / 不动:不是上翻
assert.equal(shouldPauseAutoScroll({ previousTop: 850, currentTop: 900, distFromBottom: 0 }), false);
assert.equal(shouldPauseAutoScroll({ previousTop: 850, currentTop: 850, distFromBottom: 300 }), false);
assert.equal(shouldPauseAutoScroll({ previousTop: 850, currentTop: 849.7, distFromBottom: 300 }), false,
  '不足 0.5px 的抖动不算移动');
// 不知道离底多少 → 旧口径只看方向(既有调用与单测保持原义)
assert.equal(shouldPauseAutoScroll({ previousTop: 900, currentTop: 850 }), true);
assert.equal(shouldPauseAutoScroll({ previousTop: 900, currentTop: 850, distFromBottom: NaN }), true);
assert.equal(shouldPauseAutoScroll({ previousTop: NaN, currentTop: 850, distFromBottom: 50 }), false);

// ── 程序滚动 transaction 期间的背离:同一容差 ─────────────────────────────────────
{
  // 恢复位置写到 5000 后,消息区变高,浏览器把 scrollTop 钳到 4850(离底 0)→ 不算用户上翻
  const clamped = advanceScrollTransaction(beginScrollTransaction('restore', 5000, 0), {
    previousTop: 5000, currentTop: 4850, target: 5000, now: 10, distFromBottom: 0,
  });
  assert.equal(clamped.handled, false);
  assert.equal(clamped.userMovedAway, false, 'transaction 期间的钳位上挪(仍贴底)不得判成用户离开');
  // 同样的上挪但挪完离底 300 → 用户真的往上翻了
  const moved = advanceScrollTransaction(beginScrollTransaction('restore', 5000, 0), {
    previousTop: 5000, currentTop: 4850, target: 5000, now: 10, distFromBottom: 300,
  });
  assert.equal(moved.userMovedAway, true, 'transaction 期间真实上翻必须立即进入"在看历史"');
  // 朝目标移动 / 到达目标的既有语义不变
  const toward = advanceScrollTransaction(beginScrollTransaction('follow', 100, 0), {
    previousTop: 0, currentTop: 40, target: 100, now: 10, distFromBottom: 60,
  });
  assert.equal(toward.handled, true);
}

// ── 源码守卫:两个调用方都把真实离底距离交给判据,行为一致 ─────────────────────────
{
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const app = readFileSync(join(root, 'client/src/App.jsx'), 'utf8');
  const hs = app.slice(app.indexOf('const handleScroll = () => {'), app.indexOf('// Restore the saved scroll position'));
  assert.ok(/const distFromBottom = scrollHeight - scrollTop - clientHeight;/.test(hs), 'handleScroll 要先算离底距离');
  assert.ok(hs.indexOf('const distFromBottom') < hs.indexOf('const movedUp'), '离底距离必须在上翻判据之前算好');
  assert.ok(/shouldPauseAutoScroll\(\{[^}]*distFromBottom[^}]*\}\)/.test(hs), 'App.jsx 上翻判据必须带离底距离');
  assert.ok(/advanceScrollTransaction\([\s\S]{0,240}distFromBottom,?\s*\}\)/.test(hs),
    'App.jsx transaction 背离判据必须带离底距离');
  assert.equal((hs.match(/const distFromBottom/g) || []).length, 1, 'handleScroll 里只算一次离底距离');

  const sub = readFileSync(join(root, 'client/src/components/SubagentView.jsx'), 'utf8');
  const shs = sub.slice(sub.indexOf('const handleScroll = () => {'), sub.indexOf('const markReading'));
  assert.ok(shs.indexOf('const distance') < shs.indexOf('const movedUp'), 'SubagentView 离底距离必须在判据之前算好');
  assert.ok(/shouldPauseAutoScroll\(\{[^}]*distFromBottom: distance[^}]*\}\)/.test(shs), 'SubagentView 上翻判据必须带离底距离');
  assert.ok(/advanceScrollTransaction\([\s\S]{0,240}distFromBottom: distance,?\s*\}\)/.test(shs),
    'SubagentView transaction 背离判据必须带离底距离');
}

console.log('✓ check-r169-bottom-tolerance: 钳位上挪不算上翻 / 真实上翻仍算 / 两个调用方同一判据');
