#!/usr/bin/env node
// /api/usage 的 byModel[].byPeriod 分桶(契约 §3.3):按**每条记录自身时间戳**判北京时段,
// 三桶逐字段之和 === 行合计(不带时间戳的记录进 unknown 桶)。
// PROJECTS_DIR 在模块顶层由 homedir() 求值 → 先设 HOME 再用带 query 的 import 拿全新实例。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'cgui-pa-byperiod-'));
const proj = join(home, '.claude', 'projects', '-pa-byperiod');
mkdirSync(proj, { recursive: true });

const record = (id, timestamp, input, output = 0, cacheRead = 0, cacheWrite = 0) => JSON.stringify({
  type: 'assistant',
  ...(timestamp ? { timestamp } : {}),
  message: {
    id, model: 'deepseek-flash', role: 'assistant',
    usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite },
  },
});
const lines = [
  JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-09-11T01:00:00.000Z', message: { role: 'user', content: 'x' } }),
  record('m_peak', '2026-09-11T02:00:00.000Z', 100, 10, 1, 2),      // 周五北京 10:00
  record('m_weekend', '2026-09-12T02:00:00.000Z', 200, 20, 2, 4),   // 周六北京 10:00
  record('m_evening', '2026-09-11T12:00:00.000Z', 300, 30, 3, 6),   // 周五北京 20:00
  record('m_unknown', null, 400, 40, 4, 8),                          // 无时间戳
  record('m_tz', '2026-09-11T17:00:00.000Z', 500, 50, 5, 10),       // 北京周六 01:00(UTC 还是周五)
];
writeFileSync(join(proj, 'sid.jsonl'), `${lines.join('\n')}\n`, 'utf8');

process.env.HOME = home;
process.env.USERPROFILE = home;
const { getUsageStats } = await import(`../../server/services/usage-stats.js?case=byperiod`);
const stats = await getUsageStats();
const row = stats.byModel.find((item) => item.model === 'deepseek-flash');
assert.ok(row, '必须有 deepseek-flash 这一行');

const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'calls'];
const EXPECT = {
  peak: { input: 100, output: 10, cacheRead: 1, cacheWrite: 2, calls: 1 },
  offPeak: { input: 1000, output: 100, cacheRead: 10, cacheWrite: 20, calls: 3 },
  unknown: { input: 400, output: 40, cacheRead: 4, cacheWrite: 8, calls: 1 },
};
for (const bucket of ['peak', 'offPeak', 'unknown']) {
  for (const field of FIELDS) {
    assert.equal(row.byPeriod[bucket][field], EXPECT[bucket][field], `${bucket}.${field}`);
  }
}
// 恒等式:三桶之和 === 行合计(逐字段)
for (const field of FIELDS) {
  const sum = ['peak', 'offPeak', 'unknown'].reduce((acc, bucket) => acc + row.byPeriod[bucket][field], 0);
  assert.equal(sum, row[field], `${field} 恒等式不成立`);
}
// 反向:UTC 周五 17:00(= 北京周六凌晨)必须落 offPeak,不得落 peak
assert.equal(row.byPeriod.peak.input, 100, 'peak 桶只装工作日 09–12/14–18 的记录');
assert.equal(row.byPeriod.offPeak.input >= 500, true, '跨日那条按北京时间归 offPeak');

console.log('check-pricing-byperiod: OK');
