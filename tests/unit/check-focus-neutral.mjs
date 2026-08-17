#!/usr/bin/env node
// 单测:r11-p3-1 输入框聚焦零装饰 —— composer 与 Home 输入框焦点态零视觉变化
// (用户明确拍板"不要任何描边";a11y 取舍由用户拍板,记录在 index.css 注释)。
// 变异哨兵(实际验证过红):恢复 .chat-composer:has(textarea:focus) 焦点块 → t1 红。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// t1 常规 composer:焦点态样式块整体不存在(聚焦与否外观完全一致)
{
  const css = readFileSync(new URL('../../client/src/index.css', import.meta.url), 'utf8');
  assert.equal(css.includes(':has(textarea:focus)'), false, 't1: 焦点态样式块已整体删除(哨兵锚)');
  assert.doesNotMatch(css, /chat-composer[^{]*focus[^{]*\{/, 't1: composer 无任何 focus 选择器');
  // 决策留痕:零装饰是用户拍板,注释在案防后人"好心补回"
  assert.match(css, /聚焦零装饰/, 't1: 拍板记录在案');
}

// t2 Home 输入框:无 focus-within 变色(外观恒定)
{
  const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
  const start = app.indexOf('function HomeState(');
  const end = app.indexOf('// ─── CLI-style spinner');
  assert.ok(start > 0 && end > start, 't2: HomeState 区段可定位');
  const home = app.slice(start, end);
  assert.doesNotMatch(home, /focus-within:border/, 't2: Home 输入框零焦点描边');
  assert.match(home, /border border-canvas-deep\/70 bg-canvas-warm\/60"/, 't2: 静置外观保留(仅焦点装饰移除)');
}

console.log('check-focus-neutral: all passed');
