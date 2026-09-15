#!/usr/bin/env node
// 窗内检索:命中进视野的滚动决策(searchScrollDelta 纯函数)+ ChatSearch 的调用点接线。
// 背景:条带折叠那一轮把"用户导航(上一条/下一条、Enter)时居中"(rect.top - cr.top - cr.height/3)
// 整段删了,只留新增的"已在视野就不动" —— 前者是既有能力(命中只露一角时归位),被静默改掉且
// 无用例覆盖。现在两种模式分开:输入触发只保"不盲跳",用户导航恢复居中。
// 变异哨兵:导航分支改回"完全出视野才滚"→ t2/t3 红;go() 去掉 { center: true } → t4 红;
// 输入分支去掉"相交就不动"→ t1 红(验收 SF-402 也应红)。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { searchScrollDelta } from '../../client/src/utils/searchScroll.js';

// 容器高 600、可视带 [100, 700];rect 与之同坐标系(命中高 20)
const cr = { top: 100, bottom: 700, height: 600 };
const rect = (top, h = 20) => ({ top, bottom: top + h, width: 120, height: h });

// ── t1 输入触发(center 默认 false):与可视带相交就一个像素都不动 ──
{
  assert.equal(searchScrollDelta(rect(300), cr), null, '视野正中 → 不动');
  assert.equal(searchScrollDelta(rect(680), cr), null, '只露下缘一角 → 不动');
  assert.equal(searchScrollDelta(rect(95), cr), null, '只露上缘一角 → 不动');
  assert.equal(searchScrollDelta(rect(60), cr), -((100 - 60) + 40), '完全在上方 → 最小上移 + 40 余量');
  assert.equal(searchScrollDelta(rect(720), cr), (740 - 700) + 40, '完全在下方 → 最小下移 + 40 余量');
}

// ── t2 用户导航(center:true):恢复既有居中,公式逐字 = rect.top - cr.top - cr.height/3 ──
{
  assert.equal(searchScrollDelta(rect(680), cr, { center: true }), 680 - 100 - 600 / 3, '只露下角 → 归位到纵向 1/3 处');
  assert.equal(searchScrollDelta(rect(120), cr, { center: true }), 120 - 100 - 600 / 3, '贴上缘 → 同样归位');
  // 舒适带 = 距上下边各 40:带内导航也不动,边界两侧各钉一条
  assert.equal(searchScrollDelta(rect(140), cr, { center: true }), null, 'top=140(带内)→ 不动');
  assert.equal(searchScrollDelta(rect(139), cr, { center: true }), 139 - 100 - 600 / 3, 'top=139(带外)→ 动');
  assert.equal(searchScrollDelta(rect(640), cr, { center: true }), null, 'bottom=660(带内)→ 不动');
  assert.equal(searchScrollDelta(rect(645), cr, { center: true }), 645 - 100 - 600 / 3, 'bottom=665(带外)→ 动');
}

// ── t3 导航不等于"最小位移":出去多远都按 1/3 归位 —— 这正是两模式的区别 ──
{
  assert.equal(searchScrollDelta(rect(-200), cr, { center: true }), -200 - 100 - 600 / 3, '导航:上方 200px → 居中口径');
  assert.equal(searchScrollDelta(rect(-200), cr), -((100 - (-200)) + 40), '输入:同一矩形走最小位移(+40 余量)');
}

// ── t4 接线(源码哨兵):导航路径请求居中、输入路径不请求、展开后重试带得住 ──
{
  const src = readFileSync(new URL('../../client/src/components/ChatSearch.jsx', import.meta.url), 'utf8');
  assert.ok(src.includes('paintActive(rangesRef.current, next, { center: true })'), 'go(上一条/下一条/Enter)必须传 center: true');
  assert.ok(src.includes('scrollRangeIntoView(a, { center });'), 'center 一路传到滚动决策');
  assert.ok(src.includes('{ allowExpand: false, center }'), '折起段展开后的隔帧重试带着 center');
  assert.ok(src.includes('paintActive(ranges, first);'), '输入触发(首条命中)不传 center —— 仍走"不盲跳"');
}

console.log('check-search-scroll: all passed');
