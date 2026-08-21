#!/usr/bin/env node
// r26-I4 单测:平铺 spread 抵消 memo → WeakMap 包装缓存。
// 哨兵(实际验证过红):wrapFlatRow 改回每次 {...s} → t1 红。
import assert from 'node:assert/strict';
import { flattenSessionRows } from '../../client/src/utils/projectPanel.js';

const s1 = { sessionId: 's1', lastActivity: '2026-01-02T00:00:00Z' };
const s2 = { sessionId: 's2', lastActivity: '2026-01-03T00:00:00Z' };
const byProj = { h1: [s1], h2: [s2] };

// t1 身份稳定哨兵:同输入对象两次调用 → 包装结果 ===(memo 不再被击穿)
{
  const a = flattenSessionRows(byProj);
  const b = flattenSessionRows(byProj);
  assert.equal(a.length, 2);
  assert.ok(a[0] === b[0] && a[1] === b[1], 't1: 同原对象的包装身份必须稳定(===)');
  assert.equal(a[0].projectHash, 'h2', 't1: projectHash 挂包装对象上');
}

// t2 原对象换新引用 → 新包装(内容变化必须可见,不许吃到旧包装)
{
  const s1v2 = { ...s1, firstPrompt: '改过标题' };
  const c = flattenSessionRows({ h1: [s1v2], h2: [s2] });
  const row = c.find((r) => r.sessionId === 's1');
  assert.equal(row.firstPrompt, '改过标题', 't2: 新引用出新包装,内容更新可见');
  const d = flattenSessionRows({ h1: [s1v2], h2: [s2] });
  assert.ok(c.find((r) => r.sessionId === 's1') === d.find((r) => r.sessionId === 's1'), 't2: 新引用自身也稳定');
}

// t3 旧调用方语义回归:不过滤/归档不进平铺/时间降序
{
  const flat = flattenSessionRows({
    h1: [{ sessionId: 'a', lastActivity: '2026-01-02T00:00:00Z' }, { sessionId: 'ar', archived: true, lastActivity: '2026-05-01T00:00:00Z' }],
    h2: [{ sessionId: 'b', lastActivity: '2026-01-03T00:00:00Z' }],
  });
  assert.deepEqual(flat.map((s) => s.sessionId), ['b', 'a'], 't3: 时间降序 + 归档不进');
  const vis = flattenSessionRows({
    h1: [{ sessionId: 'a', lastActivity: '2026-01-02T00:00:00Z' }],
    h2: [{ sessionId: 'b', lastActivity: '2026-01-03T00:00:00Z' }],
  }, new Set(['h2']));
  assert.deepEqual(vis.map((s) => s.sessionId), ['b'], 't3: visibleHashes 过滤保留');
}

console.log('check-r26-i4-flatten-wrap-cache: all passed');
