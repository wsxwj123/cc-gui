#!/usr/bin/env node
// r26-I7② 单测:watcher 刷新目标跳过 hidden 展开组。
// 哨兵(实际验证过红):watcherRefreshTargets 删掉 filter → t1 红。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { watcherRefreshTargets } from '../../client/src/utils/projectPanel.js';

// t1 过滤矩阵
{
  assert.deepEqual(watcherRefreshTargets(['a', 'h1', 'b', 'h2'], new Set(['h1', 'h2'])), ['a', 'b'], 't1: hidden 组出列(Set)');
  assert.deepEqual(watcherRefreshTargets(['a', 'h1'], ['h1']), ['a'], 't1: 数组形态 hidden(store.hiddenProjects 契约形)');
  assert.deepEqual(watcherRefreshTargets(['a', 'b'], undefined), ['a', 'b'], 't1: 无 hidden 不过滤(回归)');
  assert.deepEqual(watcherRefreshTargets(undefined, new Set(['x'])), [], 't1: 非法 expanded 回落空');
  assert.deepEqual(watcherRefreshTargets(['h1'], new Set(['h1'])), [], 't1: 全隐藏 → 空(一个都不刷)');
}

// t2 侧栏接线:watcher 循环过 watcherRefreshTargets;hidden 读 store.hiddenProjects(C-I2
//    契约,PKG-2 产出)兜底组件本地集,不自拉
{
  const sb = readFileSync(new URL('../../client/src/components/UnifiedSidebar.jsx', import.meta.url), 'utf8');
  assert.match(sb, /for \(const h of watcherRefreshTargets\(st\.expandedProjects, st\.hiddenProjects \?\? hiddenRef\.current\)\) st\.fetchSessionsForPanel\(h\);/, 't2: watcher 跳过 hidden 展开组(r27-review2:?? —— store 水合前 null 才兜底,[] 不再骗过 ||)');
  assert.doesNotMatch(sb, /for \(const h of st\.expandedProjects\) st\.fetchSessionsForPanel/, 't2: 旧的无过滤循环已退役');
}

console.log('check-r26-i7-watcher-hidden: all passed');
