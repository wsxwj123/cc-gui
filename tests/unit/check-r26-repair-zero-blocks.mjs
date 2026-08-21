#!/usr/bin/env node
// 单测:r26-G7 原本就空的 content[] 行——只报不修。
// 根因:content 为 [] 的行被修复器静默跳过,体检报告也不提,用户不知道历史里有空壳行。
// 修法(设计决定):report 增加 zeroBlocks 计数(按 type 分桶),行原样保留——不自动删,
// 删行会让其子行变孤儿(parentUuid 链)。
// 变异哨兵(实际验证过红):S1 删掉 zeroBlocks 计数分支 → t1 红。
import assert from 'node:assert/strict';
import { repairOfficialCompat } from '../../server/utils/session-repair.js';

const L = (obj) => JSON.stringify(obj);
const msg = (type, uuid, parentUuid, content) =>
  L({ uuid, parentUuid, sessionId: 'S', type, message: { role: type, content } });

// t1 只报不修双哨兵:计数对 + 行原样保留(逐字)
{
  const empty1 = msg('assistant', 'a1', 'u1', []);
  const empty2 = msg('user', 'u2', 'a1', []);
  const normal = msg('user', 'u1', null, [{ type: 'text', text: 'q' }]);
  const { lines, report } = repairOfficialCompat([normal, empty1, empty2]);
  assert.equal(report.zeroBlocks, 2, 't1: 空 content[] 行计数');
  assert.equal(report.zeroBlocksByType.assistant, 1, 't1: assistant 分桶');
  assert.equal(report.zeroBlocksByType.user, 1, 't1: user 分桶');
  assert.equal(lines.length, 3, 't1: 行数不变(不修)');
  assert.ok(lines.includes(empty1) && lines.includes(empty2), 't1: 空行逐字保留');
  // 空壳行不触发任何修复计数
  assert.equal(report.emptyText + report.emptyThinking + report.droppedLines + report.relinked, 0,
    't1: 空 content[] 不算空块、不删行、不接骨');
}

// t2 指向空壳行的子行不重指(空壳行没被摘,引用保持原样)
{
  const { lines, report } = repairOfficialCompat([
    msg('user', 'u1', null, []),
    msg('assistant', 'a1', 'u1', [{ type: 'text', text: 'answer' }]),
  ]);
  const a1 = lines.map((l) => JSON.parse(l)).find((o) => o.uuid === 'a1');
  assert.equal(a1.parentUuid, 'u1', 't2: 空壳行仍在,子行引用不动');
  assert.equal(report.relinked, 0, 't2: 无接骨');
  assert.equal(report.zeroBlocks, 1);
}

// t3 空块清成空(清块所致)≠ 原本就空:前者照旧删行(R3),后者只计数
{
  const { lines, report } = repairOfficialCompat([
    msg('assistant', 'a1', null, [{ type: 'text', text: '  ' }]), // 清块致空 → 删行
    msg('assistant', 'a2', null, []),                              // 原本就空 → 只报
  ]);
  assert.equal(report.droppedLines, 1, 't3: 清块致空仍删行');
  assert.equal(report.zeroBlocks, 1, 't3: 原本就空只报');
  assert.equal(lines.length, 1, 't3: 删一留一');
  assert.equal(JSON.parse(lines[0]).uuid, 'a2', 't3: 留下的是空壳行(只报不修)');
}

// t4 幂等口径:二次跑 zeroBlocks 仍报出(存量观察计数),修复类计数全零
{
  const fixture = [msg('assistant', 'a1', null, [])];
  const first = repairOfficialCompat(fixture);
  const second = repairOfficialCompat(first.lines);
  assert.equal(second.report.zeroBlocks, 1, 't4: 二次跑仍报存量空壳(不修所以仍在)');
  assert.equal(second.report.emptyText + second.report.emptyThinking
    + second.report.droppedLines + second.report.relinked, 0, 't4: 修复类计数幂等全零');
}

console.log('PASS r26-g7-zero-blocks-report-only');
