#!/usr/bin/env node
// 单测:r11-p5-2 会话行 ⋯ 菜单弹层夹紧 —— 水平容器夹紧纯函数矩阵(窄栏/贴右缘/
// 回落视口)+ AnchoredPopover 扩参向后兼容(既有消费点零行为变化)+ 菜单接线。
// 变异哨兵(实际验证过红):clampPopoverX 删容器夹紧分支 → t1 贴右缘用例红。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clampPopoverX, popoverMaxWidth } from '../../client/src/utils/popover.js';

// t1 夹紧矩阵
{
  // 无容器 = 纯视口夹紧(既有行为)
  assert.equal(clampPopoverX({ left: 100, width: 176, pad: 8, vw: 1280, container: null }), 100, 't1: 无容器不动');
  assert.equal(clampPopoverX({ left: -30, width: 176, pad: 8, vw: 1280, container: null }), 8, 't1: 视口左夹紧');
  assert.equal(clampPopoverX({ left: 1200, width: 176, pad: 8, vw: 1280, container: null }), 1280 - 8 - 176, 't1: 视口右夹紧');
  // 贴右缘:菜单右缘必须 ≤ 容器右缘-8(⋯按钮在侧栏右缘,align=right 原位会溢出)
  const sidebar = { left: 0, right: 300, width: 300 };
  const l = clampPopoverX({ left: 290 - 176, width: 176, pad: 8, vw: 1280, container: sidebar });
  assert.ok(l + 176 <= sidebar.right - 8, 't1: 菜单右缘 ≤ 侧栏右缘-8(哨兵锚)');
  // 溢出更狠的情况(anchor 超出容器)同样拉回
  const l2 = clampPopoverX({ left: 400, width: 176, pad: 8, vw: 1280, container: sidebar });
  assert.equal(l2 + 176, sidebar.right - 8, 't1: 溢出容器整体拉回右缘内');
  // 左缘守卫:窄容器下不越左
  const l3 = clampPopoverX({ left: -100, width: 176, pad: 8, vw: 1280, container: sidebar });
  assert.ok(l3 >= sidebar.left + 8, 't1: 容器左缘+8 守卫');
  // 容器夹紧后仍受视口兜底(容器右缘超视口时)
  const offscreen = { left: 1200, right: 1500, width: 300 };
  const l4 = clampPopoverX({ left: 1400, width: 176, pad: 8, vw: 1280, container: offscreen });
  assert.ok(l4 + 176 <= 1280 - 8, 't1: 视口兜底压过容器');
  // 宽度上限:min(内容宽, 容器宽-16),floor 120;无容器 null
  assert.equal(popoverMaxWidth(300), 284, 't1: 宽容器 = 容器宽-16');
  assert.equal(popoverMaxWidth(120), 120, 't1: 窄容器 floor 120');
  assert.equal(popoverMaxWidth(0), null, 't1: 非法宽 null(不设上限)');
  assert.equal(popoverMaxWidth(NaN), null, 't1: NaN null');
}

// t2 组件接线:扩参默认向后兼容;容器缺失回落;菜单传参;既有消费点零变化
{
  const sel = readFileSync(new URL('../../client/src/components/SessionSelectors.jsx', import.meta.url), 'utf8');
  assert.match(sel, /gap: gapProp = 8, clampSelector = null/, 't2: 扩参默认值=旧行为(gap 8/无容器)');
  assert.match(sel, /document\.querySelector\(clampSelector\)\?\.getBoundingClientRect\(\) \|\| null/, 't2: 容器找不到回落 null=纯视口夹紧');
  assert.match(sel, /left = clampPopoverX\(\{ left, width: m\.width, pad, vw, container \}\);/, 't2: 水平夹紧走纯函数(单一改动点)');
  assert.match(sel, /popoverMaxWidth\(container\.width\)/, 't2: 窄栏宽度上限接线');
  assert.match(sel, /maxWidth: pos\.maxWidth/, 't2: 上限落到弹层 style');
  const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /gap=\{4\} clampSelector="\.sidebar-flank"/, 't2: ⋯ 菜单=行下 4px+侧栏容器夹紧');
  // 既有消费点零行为变化:HomeState 项目选择器不传新参(默认路径)
  const home = app.slice(app.indexOf('function HomeState('), app.indexOf('// ─── CLI-style spinner'));
  const homePopover = home.slice(home.indexOf('<AnchoredPopover'), home.indexOf('</AnchoredPopover>'));
  assert.doesNotMatch(homePopover, /clampSelector|gap=/, 't2: HomeState 消费点未传新参(零行为变化)');
  // 全仓 clampSelector 只有 ⋯ 菜单一个消费点
  assert.equal((app.match(/clampSelector="/g) || []).length, 1, 't2: 容器夹紧仅 ⋯ 菜单启用(注释提及不计)');
}

console.log('check-popover-clamp: all passed');
