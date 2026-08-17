#!/usr/bin/env node
// 单测:r11-p1-1 焦点环去橙 —— Home 输入框与常规 composer 的焦点态改扁平中性弱化,
// 且键盘可达性焦点指示保留(细中性描边,不许整段删除)。
// 变异哨兵(实际验证过红):composer 焦点 ring 恢复 var(--color-accent-muted) → t1 红。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// t1 常规 composer:textarea 聚焦块存在(可达性保留),但不含任何 accent 描边
{
  const css = readFileSync(new URL('../../client/src/index.css', import.meta.url), 'utf8');
  const i = css.indexOf('.chat-composer:has(textarea:focus)');
  assert.ok(i > 0, 't1: 焦点态块仍存在(不许删除可达性指示)');
  const block = css.slice(i, css.indexOf('}', i) + 1);
  assert.doesNotMatch(block, /--color-accent/, 't1: 焦点环不含 accent(哨兵锚)');
  assert.match(block, /0 0 0 1px var\(--color-ink-faint\)/, 't1: 细中性描边(1px ink-faint,深浅两态可感知)');
}

// t2 Home 输入框:focus-within 不再 accent,改中性深一档;指示仍在
{
  const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
  const start = app.indexOf('function HomeState(');
  const end = app.indexOf('// ─── CLI-style spinner');
  assert.ok(start > 0 && end > start, 't2: HomeState 区段可定位');
  const home = app.slice(start, end);
  assert.doesNotMatch(home, /focus-within:border-accent/, 't2: Home 焦点态无 accent 描边');
  assert.match(home, /focus-within:border-ink-faint\/60/, 't2: Home 焦点态=中性 border 深一档(指示保留)');
}

console.log('check-focus-neutral: all passed');
