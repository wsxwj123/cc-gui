#!/usr/bin/env node
// 单测:r27 有会话打开的项目禁止隐藏(弹窗提示,不静默执行)。
// 哨兵(验证过红):删掉守卫段 → t1 红;守卫改回静默执行 → t2 红。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../client/src/components/UnifiedSidebar.jsx', import.meta.url), 'utf8');

// t1 守卫接线:隐藏前查 paneSessions+selectedSession 的 projectHash
{
  assert.match(src, /有会话正在窗格中打开的项目不可隐藏/, 't1: 守卫注释在');
  assert.match(src, /\[\.\.\.\(st\.paneSessions \|\| \[\]\), st\.selectedSession\]\s*\n?\s*\.some\(\(s\) => s && s\.projectHash === hash\)/, 't1: 开着的窗格+选中会话都查 projectHash');
  assert.match(src, /confirmDialog\('该项目有会话正在窗格中打开/, 't1: 弹窗提示文案');
}

// t2 行为模拟:守卫判据逻辑(抽离同形验证)
{
  const guard = (paneSessions, selectedSession, hidden, hash) => {
    if (!hidden.has(hash)) {
      const openHere = [...(paneSessions || []), selectedSession].some((s) => s && s.projectHash === hash);
      if (openHere) return 'blocked';
    }
    return hidden.has(hash) ? 'unhide' : 'hide';
  };
  assert.equal(guard([{ projectHash: 'a' }], null, new Set(), 'a'), 'blocked', 't2: 窗格开着 → 拦');
  assert.equal(guard([null], { projectHash: 'a' }, new Set(), 'a'), 'blocked', 't2: 选中会话属该项目 → 拦');
  assert.equal(guard([{ projectHash: 'b' }], null, new Set(), 'a'), 'hide', 't2: 别的项目开着 → 放行');
  assert.equal(guard([{ projectHash: 'a' }], null, new Set(['a']), 'a'), 'unhide', 't2: 取消隐藏不受守卫管');
  assert.equal(guard([], null, new Set(), 'a'), 'hide', 't2: 无打开会话 → 放行');
}

console.log('check-r27-hide-guard: all passed');
