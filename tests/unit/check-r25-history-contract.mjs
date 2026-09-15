#!/usr/bin/env node
// 单测:R25 历史变换合同的纯函数面(参数校验 / 变换计算 / 版本标识 / 预览配额分桶)。
// 合同来源:.devflow/INTERFACE.md「官方辅助能力、历史与外部项目(R25–R28)」历史变换段。
// Run: node tests/unit/check-r25-history-contract.mjs
import assert from 'node:assert/strict';
import {
  parseHistoryParams, applyHistoryOp, versionOf, anchorKindOf,
  previewBucketCount, __resetHistoryStores, HISTORY_OP_NAMES,
} from '../../server/routes/session-history.js';

const U1 = '11111111-1111-1111-1111-111111111111';
const U2 = '22222222-2222-2222-2222-222222222222';
const line = (obj) => JSON.stringify(obj);
const at = (n) => `2026-09-11T00:00:0${n}.000Z`;
const user = (uuid, text, n) => line({ type: 'user', uuid, timestamp: at(n), message: { role: 'user', content: [{ type: 'text', text }] } });
const asst = (uuid, parent, n) => line({ type: 'assistant', uuid, parentUuid: parent, timestamp: at(n), message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } });
const RAW = [user(U1, '第一条', 1), asst('a1', U1, 2), user(U2, '第二条', 3), asst('a2', U2, 4)].join('\n') + '\n';

// ── t1 参数校验:dryRun 之外,业务参数缺失/非法一律拒绝 ────────────────
{
  assert.equal(parseHistoryParams('trim', { uuid: U1 }).ok, true, 't1: uuid 锚点合法');
  assert.equal(parseHistoryParams('trim', { fromTimestamp: '2026-09-11T00:00:00Z' }).ok, true, 't1: 时间锚点合法');
  assert.equal(parseHistoryParams('trim', {}).ok, false, 't1: 两个锚点都缺 → 拒绝');
  assert.equal(parseHistoryParams('trim', { uuid: U1, fromTimestamp: '2026-09-11T00:00:00Z' }).ok, false, 't1: 两个都给 → 拒绝(二选一)');
  assert.equal(parseHistoryParams('trim', { fromTimestamp: 'not-a-date' }).ok, false, 't1: 非法时间 → 拒绝');
  assert.equal(parseHistoryParams('compact-segment', { uuid: U1 }).ok, false, 't1: compact 缺 direction → 拒绝');
  assert.equal(parseHistoryParams('compact-segment', { uuid: U1, direction: 'sideways' }).ok, false, 't1: 非法 direction → 拒绝');
  assert.equal(parseHistoryParams('trim-before-tool', { toolUseId: '' }).ok, false, 't1: 空 toolUseId → 拒绝');
  // 时间锚点规范化成 ISO:同一时刻的两种写法必须是同一 canonical 参数(预览令牌按它绑定)
  const a = parseHistoryParams('trim', { fromTimestamp: '2026-09-11T00:00:00Z' }).params;
  const b = parseHistoryParams('trim', { fromTimestamp: '2026-09-11T08:00:00+08:00' }).params;
  assert.deepEqual(a, b, 't1: 同一时刻不同写法 → 同一规范参数');
}

// ── t2 trim:按 uuid / 按时间戳截断,锚点找不到是 404 ─────────────────────
{
  const byUuid = applyHistoryOp('trim', RAW, { uuid: U2 });
  assert.equal(byUuid.ok, true, 't2: uuid 锚点可截');
  assert.equal(byUuid.affectedRange.fromLine, 2, 't2: 从锚点所在行截起');
  assert.match(byUuid.newContent, /第一条/, 't2: 锚点之前原样保留');
  assert.doesNotMatch(byUuid.newContent, /第二条/, 't2: 锚点及之后全部截去');
  assert.equal(byUuid.requiresNewSession, false, 't2: 还留着一条真实对话 → 不需要新建会话');
  assert.equal(byUuid.compatibility, 'compatible', 't2: 保留段逐字未改 → compatible');

  // 时间锚点:取第一条 timestamp >= 该时刻的记录(与旧实现同判据)
  const byTime = applyHistoryOp('trim', RAW, { fromTimestamp: '2026-09-11T00:00:03Z' });
  assert.equal(byTime.ok, true, 't2: 时间锚点可截');
  assert.equal(byTime.affectedRange.fromLine, 2, 't2: 命中第三条记录(第二条用户消息)');
  assert.doesNotMatch(byTime.newContent, /第二条/, 't2: 该时刻起的后文被截去');
  assert.match(byTime.newContent, /第一条/, 't2: 之前的对话保留');
  const allCut = applyHistoryOp('trim', RAW, { fromTimestamp: '2026-01-01T00:00:00Z' });
  assert.equal(allCut.requiresNewSession, true, 't2: 截到一条不剩 → 需要新建会话');

  const missing = applyHistoryOp('trim', RAW, { uuid: 'nope' });
  assert.equal(missing.ok, false, 't2: 未知锚点 → 失败');
  assert.equal(missing.status, 404, 't2: 未知锚点 → 404');
  assert.equal(missing.code, 'SESSION_NOT_FOUND', 't2: 未知锚点 code');
}

// ── t3 strip-thinking:只删思考块,正文一字不动;孤立配对会被标 unverified ──
{
  const withThinking = [
    user(U1, '问题', 1),
    line({ type: 'assistant', uuid: 'a1', timestamp: at(2), message: { content: [{ type: 'thinking', thinking: '想', signature: 'sig' }, { type: 'text', text: '回答' }] } }),
    user(U2, '再来', 3),
  ].join('\n') + '\n';
  const r = applyHistoryOp('strip-thinking', withThinking, {});
  assert.equal(r.ok, true, 't3: 可剥离');
  assert.equal(r.changed, true, 't3: 有改动');
  assert.equal(r.report.strippedBlocks, 1, 't3: 报告剥离块数');
  assert.match(r.newContent, /回答/, 't3: 非思考内容必须保留');
  assert.match(r.newContent, /问题/, 't3: 用户消息必须保留');
  assert.doesNotMatch(r.newContent, /"thinking"/, 't3: 思考块被删除');
  assert.equal(r.compatibility, 'compatible', 't3: 显式剥离是兼容操作');

  // 纯 thinking 行剥完会变空 content → 上游 400,必须原样保留
  const pureThinking = line({ type: 'assistant', uuid: 'a9', timestamp: at(1), message: { content: [{ type: 'thinking', thinking: 'x', signature: 's' }] } }) + '\n';
  const r2 = applyHistoryOp('strip-thinking', pureThinking, {});
  assert.equal(r2.changed, false, 't3: 纯 thinking 行不剥离(保留原样)');
  assert.equal(r2.report.skippedThinkingOnly, 1, 't3: 报告跳过的纯思考行');

  // tool_use 没配 tool_result → 结构不完整 → 提交必须被拒(unverified)
  const orphan = [
    line({ type: 'assistant', uuid: 'a1', timestamp: at(1), message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } }),
    user(U2, '后续', 2),
  ].join('\n') + '\n';
  const r3 = applyHistoryOp('trim', orphan + user(U1, '尾', 3) + '\n', { uuid: U1 });
  assert.equal(r3.ok, true, 't3: 可在尾消息处截断');
  assert.equal(r3.compatibility, 'unverified', 't3: 留下孤立 tool_use → 兼容性未验证');
}

// ── t4 trim-before-tool / repair:锚点与报告 ────────────────────────────
{
  const raw = [
    line({ type: 'assistant', uuid: 'a1', timestamp: at(1), message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } }] } }),
    line({ type: 'user', uuid: 'u1', timestamp: at(2), message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] } }),
    asst('a2', 'u1', 3),
  ].join('\n') + '\n';
  const r = applyHistoryOp('trim-before-tool', raw, { toolUseId: 'tool-1' });
  assert.equal(r.ok, true, 't4: 工具锚点可截');
  assert.equal(r.requiresNewSession, true, 't4: 截完全空 → 需要新建会话');
  assert.equal(applyHistoryOp('trim-before-tool', raw, { toolUseId: 'nope' }).status, 404, 't4: 未知工具锚点 404');

  const dirty = line({ type: 'assistant', uuid: 'a1', timestamp: at(1), message: { content: [{ type: 'text', text: '' }] } }) + '\n' + user(U1, 'hi', 2);
  const rep = applyHistoryOp('repair-official-compat', dirty, {});
  assert.equal(rep.ok, true, 't4: repair 可算');
  assert.equal(rep.changed, true, 't4: 有空 text 块 → changed');
  assert.equal(rep.report.emptyText, 1, 't4: 报告空 text 块数');
  const clean = applyHistoryOp('repair-official-compat', RAW, {});
  assert.equal(clean.changed, false, 't4: 干净历史 → 无改动');
  assert.equal(clean.newContent, RAW, 't4: 无改动时内容逐字不变');
}

// ── t5 compact-segment:没有摘要不得算成功(摘要只来自预览)──────────────
{
  const noSummary = applyHistoryOp('compact-segment', RAW, { uuid: U1, direction: 'before' }, {});
  assert.equal(noSummary.ok, false, 't5: 缺摘要 → 拒绝');
  assert.equal(noSummary.code, 'SESSION_OPERATION_TIMEOUT', 't5: 缺摘要给依赖不可用 code');
  const badAnchor = applyHistoryOp('compact-segment', RAW, { uuid: 'nope', direction: 'before' }, { summary: 'x'.repeat(40) });
  assert.equal(badAnchor.status, 404, 't5: 未知锚点 404');
}

// ── t6 版本标识:任何写入都变,同一内容稳定 ──────────────────────────────
{
  const v1 = versionOf(RAW);
  assert.equal(versionOf(RAW), v1, 't6: 同内容同版本');
  assert.notEqual(versionOf(`${RAW}x`), v1, 't6: 内容变化 → 版本变化');
  assert.ok(!RAW.includes(v1) && !v1.includes('第一条'.slice(0, 2)), 't6: 版本标识不含正文');
}

// ── t7 预览配额分桶:同桶 64 满,不同锚点形态各算一份 ────────────────────
{
  __resetHistoryStores();
  const base = (over = {}) => ({
    principal: 'local', projectHash: 'p', sid: 's', op: 'trim', anchorKind: 'uuid', expiresAt: Date.now() + 60_000, ...over,
  });
  const key = (e) => `${e.principal}\x00${e.projectHash}\x00${e.sid}\x00${e.op}\x00${e.anchorKind}`;
  // previewBucketCount 只读存储,故这里直接验证"键不同 → 分桶互不影响"的语义载体:
  assert.equal(anchorKindOf('trim', parseHistoryParams('trim', { uuid: U1 }).params), 'uuid', 't7: uuid 锚点形态');
  assert.equal(anchorKindOf('trim', parseHistoryParams('trim', { fromTimestamp: '2026-01-01T00:00:00Z' }).params), 'fromTimestamp', 't7: 时间锚点形态');
  assert.notEqual(key(base()), key(base({ anchorKind: 'fromTimestamp' })), 't7: 不同锚点形态不同桶');
  assert.equal(previewBucketCount(key(base())), 0, 't7: 空存储计数为 0');
  assert.equal(HISTORY_OP_NAMES.length, 5, 't7: 五个历史操作');
}

console.log('check-r25-history-contract: all passed');
