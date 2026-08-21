#!/usr/bin/env node
// r26-D13:Home 问候时段词不刷新(挂着过夜早上还显示「晚上好」)。
// 修法:HomeState 内 hour state + 60s setInterval 刷新。
// 组件级 fake-timers 断言需要 JSX 运行时(node 直跑不了 App.jsx),故:
//   ① 源码哨兵:时段词来源必须是 hour state(由 setInterval 驱动),不再是渲染期
//      new Date().getHours() 一次性求值;定时器卸载清理;
//   ② 纯函数层:homeGreetingParts 跨时段边界的输出确实不同(22→23、23→0 边界),
//      证明「拨时间 → 文案变」这条链路的纯函数半段真实存在(组件半段由 ① 钉住)。
// Run: node tests/unit/check-r26-home-greeting-refresh.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homeGreetingParts } from '../../client/src/utils/home.js';

const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');

// ① 源码哨兵:HomeState 挂 60s 定时器刷 hour,问候消费 hour 而非现取
{
  const homeStart = app.indexOf('function HomeState(');
  const homeEnd = app.indexOf('function EmptyState');
  const home = app.slice(homeStart, homeEnd > homeStart ? homeEnd : undefined);
  assert.ok(home.length > 100, 'D13: HomeState 切片失败(重构后同步本锚)');
  assert.match(home, /setInterval\(\(\) => setHour\(new Date\(\)\.getHours\(\)\), 60000\)/,
    'D13: HomeState 必须有 60s 定时器刷新 hour(否则过夜不跨时段)');
  assert.match(home, /return \(\) => clearInterval\(id\)/, 'D13: 定时器卸载必须清理');
  assert.match(home, /homeGreetingParts\(hour,/, 'D13: 问候必须消费 hour state(渲染期现取 = 不刷新)');
  assert.doesNotMatch(home, /homeGreetingParts\(new Date\(\)\.getHours\(\)/,
    'D13: 渲染期一次性取小时是 bug 本体,不许回退');
}

// ② 纯函数层:时段边界两侧输出不同(拨时间的可观测结果)。
//    timeWord 实际三档:5/12/18 切早上/下午/晚上 —— 22→23 同档不变是正确行为,
//    验收锚钉真实边界。
{
  const text = (h) => homeGreetingParts(h, null, '').map((p) => p.text).join('');
  assert.notEqual(text(4), text(5), 'D13: 4→5 点跨档(晚上→早上),问候语必须变(过夜不刷新的主诉时段)');
  assert.notEqual(text(11), text(12), 'D13: 11→12 点跨档(早上→下午)');
  assert.notEqual(text(17), text(18), 'D13: 17→18 点跨档(下午→晚上)');
  assert.equal(text(22), text(23), 'D13: 同档内(22/23 都是晚上)不变 —— 不变哨兵,防有人把定时器粒度误改');
}

console.log('PASS check-r26-home-greeting-refresh');
