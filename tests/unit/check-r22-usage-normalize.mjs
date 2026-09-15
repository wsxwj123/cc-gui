// R22/R23/R24:用量归一的白盒单测(纯函数,不碰网络/UI)。
// Run: node tests/unit/check-r22-usage-normalize.mjs
//
// 覆盖:
//  - Chat Completions 口径(prompt_tokens 含读写):15000 总输入/read 12000/write 3000 →
//    普通 input 0 / read 12000 / write 3000;
//  - Anthropic 口径:input 已排除缓存,不再扣;
//  - 混合 TTL:5m/1h 分项保留,顶层 creation 与分项不重复相加,命中率分母只计一次 creation;
//  - 加权累计命中率(0/1000 与 9000/9000 → 90%,不是 50%);分母 0 → null(展示为 —);
//  - USAGE_INVALID(负数/超 MAX_SAFE)、USAGE_INCONSISTENT(分项超总量,保留原始数字);
//  - 缺 TTL 分配时写费只能未知(hasTtlSplit=false)。
import assert from 'node:assert/strict';
import { accumulateUsage, hitRatePercent, hasTtlSplit, normalizeUsageRecord } from '../../server/utils/usage-normalize.js';
import { normalizeOpenAIUsage } from '../../server/utils/openai-usage.js';

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} != ${b}`);

// ── 1. Chat Completions 缓存写量归一 ─────────────────────────────────────
const chatWrite = normalizeOpenAIUsage({
  prompt_tokens: 15000,
  prompt_tokens_details: { cached_tokens: 12000, cache_write_tokens: 3000 },
  completion_tokens: 4,
});
assert.equal(chatWrite.cache_read_input_tokens, 12000, 'read 12000');
assert.equal(chatWrite.cache_creation_input_tokens, 3000, 'write 3000');
assert.equal(chatWrite.input_tokens, 0, '总输入已含读写 → 普通 input 0(不是 3000)');
assert.equal(chatWrite.output_tokens, 4);

const chatTotals = accumulateUsage([chatWrite]);
assert.deepEqual(
  { input: chatTotals.input, cacheRead: chatTotals.cacheRead, cacheCreation: chatTotals.cacheCreation },
  { input: 0, cacheRead: 12000, cacheCreation: 3000 },
);
assert.equal(chatTotals.input + chatTotals.cacheRead + chatTotals.cacheCreation, 15000, '三项之和 = 总输入,不重复相加');

// 无 prompt_tokens 时回落 anthropic 命名的 input_tokens(本就只含未命中部分)
const anthropicFallback = normalizeOpenAIUsage({ input_tokens: 2679, output_tokens: 33, cache_read_input_tokens: 25472 });
assert.equal(anthropicFallback.input_tokens, 2679, 'Anthropic 命名的 input 不再扣缓存');

// ── 2. Anthropic 混合 TTL ────────────────────────────────────────────────
const mixed = normalizeUsageRecord({
  input_tokens: 0, output_tokens: 4,
  cache_read_input_tokens: 8000, cache_creation_input_tokens: 2000,
  cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 1000 },
});
assert.equal(mixed.cacheCreation, 2000, '顶层写量 2000');
assert.equal(mixed.cacheCreation5m, 1000, '5m 分项保留');
assert.equal(mixed.cacheCreation1h, 1000, '1h 分项保留');
assert.equal(mixed.cacheCreation + mixed.cacheCreation5m + mixed.cacheCreation1h, 4000, '聚合器不把分项加进顶层(4000 只作为反例存在)');
const mixedTotals = accumulateUsage([{
  input_tokens: 0, output_tokens: 4,
  cache_read_input_tokens: 8000, cache_creation_input_tokens: 2000,
  cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 1000 },
}]);
near(hitRatePercent(mixedTotals), 80, '命中率 = 8000/(0+8000+2000) = 80%');
assert.notEqual(Math.round(hitRatePercent(mixedTotals)), 67, 'creation 被重复相加(分母 12000)会得到 66.7%');
assert.equal(mixedTotals.cacheCreation5m, 1000, 'usageTotals 带 5m 分项');
assert.equal(mixedTotals.cacheCreation1h, 1000, 'usageTotals 带 1h 分项');

// ── 3. 加权累计命中率 ────────────────────────────────────────────────────
const cumulative = accumulateUsage([
  { input_tokens: 1000, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  { input_tokens: 0, output_tokens: 1, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 },
]);
near(hitRatePercent(cumulative), 90, '0/1000 与 9000/9000 累计 = 90%');
assert.ok(Math.abs(hitRatePercent(cumulative) - 50) > 5, '不得用两次百分比的算术平均(50%)');

// 分母 0 → null(展示层显示「—」,不是 0%)
assert.equal(hitRatePercent(accumulateUsage([{ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }])), null);
assert.equal(hitRatePercent(accumulateUsage([])), null);

// ── 4. 无效用量 ──────────────────────────────────────────────────────────
const negative = accumulateUsage([{ input_tokens: -5, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }]);
assert.ok(negative.codes.includes('USAGE_INVALID'), '负数标 USAGE_INVALID');
assert.equal(negative.input, -5, '原始数字保留(不静默改写为 0)');
assert.equal(negative.issues[0].raw.input_tokens, -5, '原始值可回读');
assert.ok(!(negative.input + negative.cacheRead > 0) || negative.codes.includes('USAGE_INVALID'), '带 INVALID 的数字不得被当成可计价用量');

const overflow = accumulateUsage([{ input_tokens: 9007199254740993, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }]);
assert.ok(overflow.codes.includes('USAGE_INVALID'), '超过 MAX_SAFE_INTEGER 标 USAGE_INVALID');

const nan = accumulateUsage([{ input_tokens: Number.NaN, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }]);
assert.ok(nan.codes.includes('USAGE_INVALID'), '非有限值标 USAGE_INVALID');

// ── 5. 分项与总量冲突 ────────────────────────────────────────────────────
const inconsistent = normalizeOpenAIUsage({
  prompt_tokens: 1000,
  prompt_tokens_details: { cached_tokens: 12000, cache_write_tokens: 3000 },
  completion_tokens: 4,
});
assert.deepEqual(inconsistent.ccgui_usage.codes, ['USAGE_INCONSISTENT'], '读写超总量 → USAGE_INCONSISTENT');
assert.equal(inconsistent.ccgui_usage.raw.prompt_tokens, 1000, '原始总量留档');
const inconsistentTotals = accumulateUsage([inconsistent]);
assert.ok(inconsistentTotals.codes.includes('USAGE_INCONSISTENT'), 'usageTotals 带上冲突 code');
assert.equal(inconsistentTotals.cacheRead, 12000, '冲突时原始数字保留可回读(12000)');
assert.equal(inconsistentTotals.issues.length, 1, '冲突条目进 issues 供展示说明');

// ── 6. 用量问题的服务端落点(不依赖 CLI 落盘)─────────────────────────────
// 上游报的原始数字只活在代理进程里:CLI 落盘只保留官方字段,自定义键会被丢掉,
// 所以结论存服务端自有存储,读会话时按 message.id 回读。这里验证整条回读链。
process.env.CGUI_USAGE_ISSUES_PATH = `/tmp/pr5-usage-issues-test-${process.pid}.json`;
const { recordUsageIssue, attachUsageIssues, __resetUsageIssueCache } =
  await import('../../server/services/usage-issue-log.js');

// PR-39 场景:上游 prompt_tokens = -5 → 转写里 input 被压成 0,说明靠回读补。
recordUsageIssue({
  messageId: 'msg_negative_1', model: 'pr5-stub-model', codes: ['USAGE_INVALID'],
  raw: { prompt_tokens: -5, completion_tokens: 4, cached_tokens: 0, cache_write_tokens: 0 },
  sent: { input_tokens: 0, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
});
__resetUsageIssueCache();
const negativeTurn = attachUsageIssues(
  { input_tokens: 0, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  { messageId: 'msg_negative_1' },
);
const negativeTotals = accumulateUsage([negativeTurn]);
assert.ok(negativeTotals.codes.includes('USAGE_INVALID'), 'PR-39:回读后 usageTotals 带 USAGE_INVALID');
assert.equal(negativeTotals.issues[0].raw.upstream.prompt_tokens, -5, '原始负数可回读');
assert.equal(negativeTotals.input, 0, 'CLI 写下的数字不改写');

// PR-41 场景:prompt 1000 / read 12000 / write 3000 → 冲突说明 + 原始数字都要在。
recordUsageIssue({
  messageId: 'msg_inconsistent_1', model: 'pr5-stub-model', codes: ['USAGE_INCONSISTENT'],
  raw: { prompt_tokens: 1000, completion_tokens: 4, cached_tokens: 12000, cache_write_tokens: 3000 },
  sent: { input_tokens: 0, output_tokens: 4, cache_read_input_tokens: 12000, cache_creation_input_tokens: 3000 },
});
__resetUsageIssueCache();
const inconsistentTurn = attachUsageIssues(
  { input_tokens: 0, output_tokens: 4, cache_read_input_tokens: 12000, cache_creation_input_tokens: 3000 },
  { messageId: 'msg_inconsistent_1' },
);
const readBackTotals = accumulateUsage([inconsistentTurn]);
assert.ok(readBackTotals.codes.includes('USAGE_INCONSISTENT'), 'PR-41:回读后 usageTotals 带 USAGE_INCONSISTENT');
assert.match(JSON.stringify(readBackTotals), /12000/, 'PR-41:原始读量可回读');
assert.equal(readBackTotals.issues[0].raw.upstream.prompt_tokens, 1000, 'PR-41:原始总量留档');

// 固定 id 的上游兜底:没命中 id 时按「模型 + 四个数字全等」复核。
const byNumbers = attachUsageIssues(
  { input_tokens: 0, output_tokens: 4, cache_read_input_tokens: 12000, cache_creation_input_tokens: 3000 },
  { messageId: 'msg_unknown_id', model: 'pr5-stub-model' },
);
assert.ok(byNumbers.ccgui_usage?.codes?.includes('USAGE_INCONSISTENT'), '固定 id 上游按数字兜底命中');

// 反向:没记录过的数字不得被错标。
const untouched = attachUsageIssues(
  { input_tokens: 123, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  { messageId: 'msg_unknown_id', model: 'pr5-stub-model' },
);
assert.equal(untouched.ccgui_usage, undefined, '没记录过的用量不得凭空带 code');

// ── 7. 缺 TTL 分配 → 写费只能未知 ────────────────────────────────────────
assert.equal(hasTtlSplit({ cacheCreation: 2000, cacheCreation5m: 0, cacheCreation1h: 0 }), false, '缺分配');
assert.equal(hasTtlSplit({ cacheCreation: 2000, cacheCreation5m: 1000, cacheCreation1h: 1000 }), true, '有分配');
assert.equal(hasTtlSplit({ cacheCreation: 0, cacheCreation5m: 0, cacheCreation1h: 0 }), false, '没有写量');

console.log('check-r22-usage-normalize: OK');
