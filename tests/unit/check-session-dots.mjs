#!/usr/bin/env node
// 单测:r11-p2-3b 会话行状态点 —— 一行一点仲裁矩阵 + 完成未读边沿生命周期
// (import 真函数)+ dsh 定稿视觉的源码守卫(圆点结构/点阵/降级/aria)。
// 变异哨兵(实际验证过红):observe 删边沿条件(prev===true 判定,恒置位)→ t2 首观测红。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  resolveSessionDot, createCompletionTracker, RUN_MATRIX_CELLS, runCellDelayMs,
} from '../../client/src/utils/sessionDots.js';

// t1 一行一点仲裁:等待用户 > 运行中 > 完成未读 > 空闲
{
  assert.equal(resolveSessionDot({ waiting: true, running: true, completedUnread: true }), 'waiting', 't1: waiting 压 running/done');
  assert.equal(resolveSessionDot({ waiting: false, running: true, completedUnread: true }), 'running', 't1: running 压 done');
  assert.equal(resolveSessionDot({ waiting: false, running: false, completedUnread: true }), 'done', 't1: done');
  assert.equal(resolveSessionDot({ waiting: false, running: false, completedUnread: false }), null, 't1: 空闲无点');
  assert.equal(resolveSessionDot(), null, 't1: 无参安全');
}

// t2 边沿生命周期
{
  let changes = 0;
  const t = createCompletionTracker(() => { changes++; });
  // 首次观测(加载时已空闲)永不置位
  t.observe('a', false, false);
  assert.equal(t.has('a'), false, 't2: 首观测空闲不置位(哨兵锚)');
  // 真边沿:true→false 且非选中 → 置位
  t.observe('a', true, false);
  t.observe('a', false, false);
  assert.equal(t.has('a'), true, 't2: 运行→结束(未选中)置位');
  assert.equal(changes, 1, 't2: 置位触发一次订阅通知');
  // 选中清除
  t.observe('a', false, true);
  assert.equal(t.has('a'), false, 't2: 选中即已读清除');
  // true→false 但当时选中 → 不置位
  t.observe('b', true, false);
  t.observe('b', false, true);
  assert.equal(t.has('b'), false, 't2: 结束时正选中不置位');
  // 再次运行清除
  t.observe('c', true, false);
  t.observe('c', false, false);
  assert.equal(t.has('c'), true, 't2: c 置位');
  t.observe('c', true, false);
  assert.equal(t.has('c'), false, 't2: 再次运行清除');
  // 移除清理
  t.observe('d', true, false);
  t.observe('d', false, false);
  t.forget('d');
  assert.equal(t.has('d'), false, 't2: forget 清理');
  assert.equal(t._size(), 0, 't2: 无残留');
  // 重复置位不重复通知
  const before = changes;
  t.observe('e', true, false);
  t.observe('e', false, false);
  t.observe('e', false, false);
  assert.equal(changes, before + 1, 't2: 幂等观测不重复通知');
  // 空 sessionId(draft)安全
  t.observe(null, true, false);
  t.observe(null, false, false);
  assert.equal(t.has(null), false, 't2: 无 id 不记账');
}

// t3 点阵常量(dsh 逆向):3×3 顺时针 8 格 + 负延迟相位
{
  assert.deepEqual(RUN_MATRIX_CELLS, [[0, 0], [4, 0], [8, 0], [8, 4], [8, 8], [4, 8], [0, 8], [0, 4]], 't3: 8 格顺时针坐标');
  assert.equal(runCellDelayMs(0), -1000, 't3: 首格 -1000ms');
  assert.equal(runCellDelayMs(7), -125, 't3: 末格 -125ms(负延迟预置相位)');
}

// t4 视觉源码守卫:圆点结构/色值/动画台阶/降级/aria/一行一点/项目行不动
{
  const css = readFileSync(new URL('../../client/src/index.css', import.meta.url), 'utf8');
  const dot = css.slice(css.indexOf('.session-dot {'), css.indexOf('/* ── Thinking block'));
  assert.match(dot, /\.session-dot::before \{[^}]*inset: 0;[^}]*opacity: 0\.1;/s, 't4: 满尺寸光晕 .1');
  assert.match(dot, /\.session-dot::after \{[^}]*inset: 20%;/s, 't4: inset 20% 实心芯');
  assert.match(dot, /width: 10px;\s*height: 10px;/, 't4: 10×10');
  assert.match(dot, /\.session-dot-amber \{ --dot-c: rgb\(245, 158, 11\); \}/, 't4: 琥珀定稿色(明暗同值)');
  assert.match(dot, /\.session-dot-green \{ --dot-c: rgb\(34, 197, 94\); \}/, 't4: 绿定稿色');
  assert.match(dot, /0%, 12\.4% \{ opacity: 1; \}\s*12\.5%, 24\.9% \{ opacity: 0\.6; \}\s*25%, 37\.4% \{ opacity: 0\.35; \}\s*37\.5%, 100% \{ opacity: 0\.15; \}/, 't4: 四档透明度台阶');
  assert.match(dot, /\.session-dot-run rect \{ animation: cguiDotChase 1s infinite; \}/, 't4: 1s 循环追逐');
  assert.match(dot, /prefers-reduced-motion: reduce[\s\S]*?\.session-dot-run rect \{ animation: none; opacity: 0\.8; \}/, 't4: reduced-motion 降级静态点(dsh 未做我们做)');

  const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
  const comp = app.slice(app.indexOf('export function SessionRowStatus'), app.indexOf('export function StatusDot'));
  assert.match(comp, /resolveSessionDot\(\{ waiting, running: !!running, completedUnread/, 't4: 仲裁走数据层(一行一点)');
  assert.match(comp, /pendingPermissions\.some\(\(p\) => p\.sessionId === sessionId\)/, 't4: 等待判据=本会话 pending 卡');
  assert.match(comp, /completionTracker\.observe\(sessionId, !!running, !!isSelected\)/, 't4: 边沿观测接线');
  assert.match(comp, /shapeRendering="crispEdges"/, 't4: 点阵 crispEdges');
  assert.match(comp, /className="session-dot-run text-accent/, 't4: 点阵 accent 色融入主题');
  assert.match(comp, /runCellDelayMs\(i\)/, 't4: 相位延迟接线');
  assert.match(comp, /sr-only/, 't4: 屏幕阅读器补文本');
  assert.match(comp, /等待你确认|运行中|已完成,未查看/, 't4: aria 三态文案');
  // 项目行 StatusDot 本次不动(待统一)
  const sidebar = readFileSync(new URL('../../client/src/components/UnifiedSidebar.jsx', import.meta.url), 'utf8');
  assert.match(sidebar, /<StatusDot running=\{runningCwds\.has\(project\.path\)\}/, 't4: 项目行仍走 StatusDot');
  assert.match(sidebar, /completionTracker\.forget\(sid\)/, 't4: 删除流清边沿态');
}

console.log('check-session-dots: all passed');
