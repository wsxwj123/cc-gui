#!/usr/bin/env node
// 单测:r11-p4-1 桌面侧栏通栏(dsh 式)—— 悬浮圆角卡(m-3+rounded-panel+glass 面)
// 退役:顶天立地贴左缘、零外边距零圆角、右缘发丝分隔、纯色面;观感全走既有 token
// (玻璃拟态经典家族经同批 token 恢复磨砂,同样通栏——布局归布局观感归 token)。
// 变异哨兵(实际验证过红):aside 恢复 m-3 圆角卡类 → t1 红。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../client/src/index.css', import.meta.url), 'utf8');

// t1 桌面侧栏 aside:通栏类在位,浮卡三件套(外边距/圆角/入场卡动画/glass 卡面)清零
{
  const i = app.indexOf('<UnifiedSidebar />');
  const aside = app.slice(app.lastIndexOf('<aside', i), i);
  assert.ok(aside.includes('sidebar-flank'), 't1: 通栏类挂上(哨兵锚)');
  assert.doesNotMatch(aside, /\bm-3\b|\bmr-0\b/, 't1: 外边距清零(顶天立地贴左缘)');
  assert.doesNotMatch(aside, /rounded-panel|rounded-lg|rounded-xl/, 't1: 圆角清零(不引新 token,直接去类)');
  assert.doesNotMatch(aside, /glass-thick/, 't1: 卡片玻璃面类退役(观感改走 .sidebar-flank token)');
  assert.doesNotMatch(aside, /animate-glass-rise/, 't1: 浮起卡入场动画退役(通栏非浮卡)');
}

// t2 .sidebar-flank:纯 token 观感——underlay 混色纯色面/仅右缘发丝/无投影/backdrop 走 token
{
  const i = css.indexOf('.sidebar-flank {');
  assert.ok(i > 0, 't2: 类定义存在');
  const block = css.slice(i, css.indexOf('}', i) + 1);
  assert.match(block, /background: color-mix\(in srgb, var\(--glass-thick-bg\) var\(--surface-alpha\), var\(--glass-underlay\)\);/, 't2: 纯色面=underlay 混画布(扁平),玻璃家族 transparent 自动透底');
  assert.match(block, /border-right: 0\.5px solid var\(--glass-edge\);/, 't2: 右缘发丝分隔(低对比 token)');
  assert.doesNotMatch(block, /\n\s*border:\s/, 't2: 无四边边框(卡片边退役)');
  assert.match(block, /box-shadow: var\(--shadow-bevel\);/, 't2: 无投影(bevel 扁平=无影,玻璃家族=内高光)');
  assert.match(block, /backdrop-filter: var\(--backdrop-glass\);/, 't2: 磨砂走 token(扁平 none/玻璃家族恢复,同样通栏)');
  assert.doesNotMatch(block, /border-radius|margin/, 't2: 类内零圆角零外边距(布局归布局)');
}

// t3 手机端抽屉不动:mobile 分支(fixed 面板/页式)不含通栏类,零涉入
{
  assert.equal((app.match(/className="sidebar-flank/g) || []).length, 1, 't3: 通栏类只挂桌面 aside 一处(注释提及不计)');
}

console.log('check-sidebar-flank: all passed');
