#!/usr/bin/env node
// r26-I9 单测:sameSessionRow 字段清单补 customTitle/aiTitle。
// 哨兵(实际验证过红):清单删掉 customTitle → t1 红。
import assert from 'node:assert/strict';
import { sameSessionRow, mergeSessionList } from '../../client/src/utils/projectPanel.js';

const base = { sessionId: 's1', firstPrompt: 'hi', archived: false, messageCount: 3, model: 'm', lastActivity: '2026-01-01T00:00:00Z', projectPath: '/p', projectHash: 'h' };

// t1 仅 customTitle 不同 → false(变更可见哨兵)
assert.ok(!sameSessionRow(base, { ...base, customTitle: '新标题' }), 't1: customTitle 变更必须判不等');
// t2 仅 aiTitle 不同 → false
assert.ok(!sameSessionRow(base, { ...base, aiTitle: 'AI 标题' }), 't2: aiTitle 变更必须判不等');
// t3 全等 → true;同引用 → true
assert.ok(sameSessionRow(base, { ...base }), 't3: 全等判等(回归)');
assert.ok(sameSessionRow(base, base), 't3: 同引用判等');
// t4 mergeSessionList 接力:标题变的行换新身份,没变的行复用旧身份
{
  const prev = [base, { ...base, sessionId: 's2' }];
  const next = [{ ...base, customTitle: 'T' }, { ...base, sessionId: 's2' }];
  const merged = mergeSessionList(prev, next);
  assert.ok(merged[0] !== prev[0] && merged[0].customTitle === 'T', 't4: 标题变 → 新身份(重渲)');
  assert.ok(merged[1] === prev[1], 't4: 没变的行复用旧身份(memo 不破)');
}

console.log('check-r26-i9-same-row-titles: all passed');
