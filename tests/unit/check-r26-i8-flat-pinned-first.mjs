#!/usr/bin/env node
// r26-I8 单测:平铺模式置顶会话前置(与分组模式 composePanelSessions 同语义)。
// 哨兵(实际验证过红):删掉 sort 里的 pinnedSet 分支 → t1 红。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { flattenSessionRows } from '../../client/src/utils/projectPanel.js';

const mk = (sessionId, t) => ({ sessionId, lastActivity: `2026-01-0${t}T00:00:00Z` });

// t1 前置哨兵:pinned=[B]、时间序 [C,B,A] → [B,C,A](B 提到最前,其余保持时间降序)
{
  const rows = flattenSessionRows({ h1: [mk('A', 1), mk('B', 2)], h2: [mk('C', 3)] }, null, new Set(['B']));
  assert.deepEqual(rows.map((r) => r.sessionId), ['B', 'C', 'A'], 't1: 置顶前置,其余时间降序');
}

// t2 多置顶:pinned 间保持时间降序
{
  const rows = flattenSessionRows({ h1: [mk('A', 1), mk('B', 2), mk('C', 3), mk('D', 4)] }, null, new Set(['B', 'D']));
  assert.deepEqual(rows.map((r) => r.sessionId), ['D', 'B', 'C', 'A'], 't2: pinned 间仍按时间降序');
}

// t3 不传 pinned → 纯时间序(旧调用方语义不变);数组形态 pinned 也认
{
  const rows = flattenSessionRows({ h1: [mk('A', 1), mk('B', 2)] });
  assert.deepEqual(rows.map((r) => r.sessionId), ['B', 'A'], 't3: 不传 pinned 纯时间序(回归)');
  const rows2 = flattenSessionRows({ h1: [mk('A', 3), mk('B', 2)] }, null, ['B']);
  assert.deepEqual(rows2.map((r) => r.sessionId), ['B', 'A'], 't3: 数组形态 pinned');
}

// t4 侧栏接线:平铺调用点传 pinnedSessSet
{
  const sb = readFileSync(new URL('../../client/src/components/UnifiedSidebar.jsx', import.meta.url), 'utf8');
  assert.match(sb, /flattenSessionRows\(sessionsByProject, visibleHashes, pinnedSessSet\)/, 't4: 平铺传置顶集');
}

console.log('check-r26-i8-flat-pinned-first: all passed');
