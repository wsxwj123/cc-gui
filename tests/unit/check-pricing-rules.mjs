// 计价规则纯函数白盒单测(时段表 / periodFor / 阈值表 / 官方显示名归一与别名表)。
// Run: node tests/unit/check-pricing-rules.mjs   —— 无网络、零依赖。
import assert from 'node:assert/strict';
import {
  PERIOD_SCHEDULES, DEFAULT_SCHEDULE_KEY, periodFor, LONG_CONTEXT_THRESHOLDS,
  normalizeOfficialName, OFFICIAL_MODEL_ALIASES, AGGREGATE_PERIOD_AT, DEEPSEEK_PEAK_VALID_FROM,
} from '../../server/utils/pricing-rules.js';

// ── 1. 时段表:只有一个 key,内容逐字是契约那份 ────────────────────────────
assert.deepEqual(Object.keys(PERIOD_SCHEDULES), [DEFAULT_SCHEDULE_KEY], '当前只允许一个 schedule key');
const schedule = PERIOD_SCHEDULES[DEFAULT_SCHEDULE_KEY];
assert.equal(schedule.timezone, 'Asia/Shanghai');
assert.equal(schedule.utcOffsetMinutes, 480);
assert.deepEqual(schedule.weekdays, [1, 2, 3, 4, 5]);
assert.deepEqual(schedule.peakWindows, [[540, 720], [840, 1080]]);
assert.ok(schedule.note.length > 0, 'note 非空');

// ── 2. periodFor 边界(半开区间:09:00≤t<12:00、14:00≤t<18:00,周末全天空闲)─────
const BOUNDARIES = [
  ['2026-09-11T00:59:59.000Z', 'off-peak', '工作日北京 08:59:59(下界前一秒)'],
  ['2026-09-11T01:00:00.000Z', 'peak', '工作日北京 09:00:00 整(下界含)'],
  ['2026-09-11T03:59:59.000Z', 'peak', '工作日北京 11:59:59'],
  ['2026-09-11T04:00:00.000Z', 'off-peak', '工作日北京 12:00:00 整(上界不含)'],
  ['2026-09-11T05:59:59.000Z', 'off-peak', '工作日北京 13:59:59(午休)'],
  ['2026-09-11T06:00:00.000Z', 'peak', '工作日北京 14:00:00 整(下界含)'],
  ['2026-09-11T09:59:59.000Z', 'peak', '工作日北京 17:59:59'],
  ['2026-09-11T10:00:00.000Z', 'off-peak', '工作日北京 18:00:00 整(上界不含)'],
  ['2026-09-12T02:00:00.000Z', 'off-peak', '周六北京 10:00(UTC 还是周五)'],
  ['2026-09-13T02:00:00.000Z', 'off-peak', '周日北京 10:00'],
  ['2026-09-10T16:00:00.000Z', 'off-peak', '跨午夜:北京 00:00:00'],
  ['2026-09-10T15:59:59.000Z', 'off-peak', '北京 23:59:59'],
];
for (const [input, expected, label] of BOUNDARIES) {
  const result = periodFor(input);
  assert.equal(result.key, expected, `${label} (${input})`);
  assert.equal(typeof result.localISO, 'string', `${label} 必须带 localISO`);
}
// 带偏移输入与 Z 输入等价;epoch 毫秒与 ISO 等价
assert.deepEqual(periodFor('2026-09-11T01:00:00.000Z'), periodFor('2026-09-11T09:00:00+08:00'));
assert.equal(periodFor(Date.parse('2026-09-11T01:00:00.000Z')).key, 'peak');
// 判定只来自入参(不读「现在」):周一北京 10:00 与周六北京 10:00 必须各自成立
assert.equal(periodFor('2026-09-07T02:00:00.000Z').key, 'peak');
assert.equal(periodFor('2026-09-05T02:00:00.000Z').key, 'off-peak');
// 聚合用的代表时点常量确实落在各自那一档(改错一个字符会让面板金额整档偏移)
assert.equal(periodFor(AGGREGATE_PERIOD_AT.peak).key, 'peak');
assert.equal(periodFor(AGGREGATE_PERIOD_AT.offPeak).key, 'off-peak');

// ── 3. periodFor 的 localISO 是固定 +08:00(跨日也要对)───────────────────
assert.equal(periodFor('2026-09-10T16:00:00.000Z').localISO, '2026-09-11T00:00:00+08:00');
assert.equal(periodFor('2026-09-11T01:00:00.000Z').localISO, '2026-09-11T09:00:00+08:00');

// ── 4. periodFor 非法输入:一律 unknown/INVALID_TIMESTAMP,且不抛 ──────────
const BAD = [undefined, null, '', '   ', 'abc', '2026-13-45T99:99:99Z', NaN, Infinity, -Infinity, {}, []];
for (const value of BAD) {
  let result;
  assert.doesNotThrow(() => { result = periodFor(value); }, `periodFor(${String(value)}) 不得抛`);
  assert.deepEqual(result, { key: 'unknown', reason: 'INVALID_TIMESTAMP' }, `periodFor(${String(value)})`);
}

// ── 5. 长上下文阈值:三个有官方数据的模型登记,cyber 不登记 ────────────────
assert.equal(LONG_CONTEXT_THRESHOLDS['gpt-5.6-sol'], 272000);
assert.equal(LONG_CONTEXT_THRESHOLDS['gpt-5.6-terra'], 272000);
assert.equal(LONG_CONTEXT_THRESHOLDS['gpt-5.6-luna'], 272000);
assert.equal(LONG_CONTEXT_THRESHOLDS['gpt-5.6-cyber'], undefined, 'cyber 官方页长档为 "-" → 不登记');

// ── 6. normalizeOfficialName:只吃尾部括号段 ──────────────────────────────
assert.equal(
  normalizeOfficialName('Claude Mythos 5.1 ([limited availability](https://anthropic.com/glasswing))'),
  'Claude Mythos 5.1',
);
assert.equal(normalizeOfficialName('Claude   Opus   5'), 'Claude Opus 5');
assert.equal(normalizeOfficialName('  Claude Fable 5  '), 'Claude Fable 5');
assert.equal(normalizeOfficialName('Claude Sonnet 5'), 'Claude Sonnet 5');
assert.equal(normalizeOfficialName('Claude (Pro) Sonnet 5'), 'Claude (Pro) Sonnet 5', '中间括号不动');
for (const value of [null, undefined, 123, {}, []]) {
  let out;
  assert.doesNotThrow(() => { out = normalizeOfficialName(value); }, `normalizeOfficialName(${String(value)}) 不得抛`);
  assert.equal(out, '', `normalizeOfficialName(${String(value)}) 必须是空串`);
}

// ── 7. 别名表:只登记有证据的条目,同名模型不许伪造别名 ────────────────────
assert.equal(OFFICIAL_MODEL_ALIASES['claude-fable-5-1'], 'Claude Fable 5.1');
assert.equal(OFFICIAL_MODEL_ALIASES['claude-mythos-5-1'], 'Claude Mythos 5.1');
assert.equal(OFFICIAL_MODEL_ALIASES['claude-opus-5'], 'Claude Opus 5');
assert.equal(OFFICIAL_MODEL_ALIASES['deepseek-flash'], undefined);
assert.equal(OFFICIAL_MODEL_ALIASES['gpt-5.6-sol'], undefined, 'OpenAI 采集器直接给 modelId,不需要别名');

// 生效日常量(采集器给分时段报价打 validFrom 用同一个值):必须是北京时间 2026-08-17 00:00 = UTC 前一天 16:00
assert.equal(Date.parse(DEEPSEEK_PEAK_VALID_FROM), Date.parse('2026-08-16T16:00:00.000Z'));
assert.equal(periodFor(DEEPSEEK_PEAK_VALID_FROM).localISO, '2026-08-17T00:00:00+08:00');

console.log('check-pricing-rules: OK');
