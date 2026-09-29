// r131 · D1(接口不变项):r131 只许在根上**新增** byDayModel / ranges 两个键;total / byModel / byProject /
// byDay(既有六键)/ overview / meta 的名字、语义、排序逐字节不变(与 r130 的 d-baseline.json 对照)。
// 注意:本组夹具是**绝对日期**(2026-09-10 ~ 09-15),所以不在这里断言 ranges 的数值 —— 那种断言会随当天日期漂移;
// 数值口径由 A 组(相对日期夹具)守,本组只守"键在、形状对、既有字段一个字节没动"。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { caseRoot, suitePath, ROOT_KEYS, TOTAL_KEYS, BYDAY_OLD_KEYS, BYDAY_KEYS, OVERVIEW_KEYS, RANGE_KEYS, RANGE_FIELDS } from './helpers/fixtures.mjs';
import { startInstance, stopAll, getUsage } from './helpers/instance.mjs';
import { dFixture, D_EXPECTED, legacyView } from './helpers/d-fixture.mjs';

test.afterEach(async () => { await stopAll(); });
async function run(slug) {
  const { root, home } = caseRoot('d', slug);
  dFixture(home);
  const inst = await startInstance({ root, home }, {}, { label: slug });
  const r = await getUsage(inst.base);
  expect(r.status, r.text.slice(0, 200)).toBe(200);
  return r.json;
}
const sorted = (a) => [...a].sort();

test('D1a 根键 = 既有五个 + overview + byDayModel + ranges,不多不少', async () => {
  const body = await run('d1a-root-keys');
  const keys = Object.keys(body);
  expect(keys.filter((k) => !ROOT_KEYS.includes(k)), '根上不许多出约定之外的键').toEqual([]);
  for (const k of ROOT_KEYS) expect(keys, `缺根键 ${k}`).toContain(k);
});

test('D1b total 恰好五键且数值 = 手算(与 r130 基线一致)', async () => {
  const body = await run('d1b-total');
  expect(sorted(Object.keys(body.total))).toEqual(sorted(TOTAL_KEYS));
  expect(body.total).toEqual(D_EXPECTED.total);
});

test("D1c byDay 仍是八键(既有六键 + sessions + messages),降序、'unknown' 最前,既有六键数值 = 手算", async () => {
  const body = await run('d1c-byday');
  expect(body.byDay.map((r) => r.day)).toEqual(D_EXPECTED.byDayDays);
  for (const r of body.byDay) {
    for (const k of BYDAY_OLD_KEYS) expect(Object.keys(r), `byDay[${r.day}] 缺既有键 ${k}`).toContain(k);
    expect(Object.keys(r).filter((k) => !BYDAY_KEYS.includes(k)), `byDay[${r.day}] 多出未约定的键`).toEqual([]);
    const { input, output, cacheRead, cacheWrite, calls } = r;
    expect({ input, output, cacheRead, cacheWrite, calls }, `byDay[${r.day}] 六键数值`).toEqual(D_EXPECTED.byDayRows[r.day]);
  }
});

test('D1d byModel / byProject 行形状不变;byProject ≤ 20 行', async () => {
  const body = await run('d1d-bymodel-byproject');
  expect(body.byModel.length).toBe(3);
  for (const m of body.byModel) {
    expect(sorted(Object.keys(m))).toEqual(sorted(['model', 'input', 'output', 'cacheRead', 'cacheWrite', 'calls', 'byPeriod']));
    expect(m.byPeriod && typeof m.byPeriod, `byModel[${m.model}] 应带 byPeriod 对象`).toBe('object');
    expect(sorted(Object.keys(m.byPeriod))).toEqual(sorted(['peak', 'offPeak', 'unknown']));
  }
  expect(body.byProject.length).toBeLessThanOrEqual(20);
  expect(body.byProject.length).toBe(2);
  for (const p of body.byProject) expect(sorted(Object.keys(p))).toEqual(sorted(['hash', 'input', 'output', 'cacheRead', 'cacheWrite', 'calls']));
});

test('D1e meta 恰好两键:scannedAt(number)/ stale(boolean)', async () => {
  const body = await run('d1e-meta');
  expect(sorted(Object.keys(body.meta))).toEqual(['scannedAt', 'stale']);
  expect(typeof body.meta.scannedAt).toBe('number');
  expect(typeof body.meta.stale).toBe('boolean');
});

test('D1f overview 键集与语义不变(九键)', async () => {
  const body = await run('d1f-overview');
  expect(sorted(Object.keys(body.overview))).toEqual(sorted(OVERVIEW_KEYS));
  expect(body.overview.hourCounts.length).toBe(24);
  expect(body.overview.peakHour, '09-10 的 02Z/14Z → 本地 10/22 点,09-12 的 14Z/14:00:01Z/14:30Z → 22 点:22 点 3 笔最多').toBe(22);
  expect(body.overview.favoriteModel).toBe('claude-opus-4-1-20250805');
});

test('D1g 与 r130 基线 d-baseline.json 逐字节相等:total / byModel(含 byPeriod)/ byProject / byDay 既有六键', async () => {
  const file = suitePath('helpers', 'd-baseline.json');
  expect(fs.existsSync(file), '缺基线文件').toBe(true);
  const baseline = JSON.parse(fs.readFileSync(file, 'utf8')).legacy;
  const body = await run('d1g-baseline');
  expect(legacyView(body)).toEqual(baseline);
});

test('D1h 新根键形状:byDayModel 是 day → model → 五项的对象(键序无关);ranges 是 7d/30d 两个窗口,字段集完整、类型对', async () => {
  const body = await run('d1h-new-keys-shape');
  expect(Array.isArray(body.byDayModel), 'byDayModel 不是数组(不用把行塞进 byDay)').toBe(false);
  expect(typeof body.byDayModel).toBe('object');
  const days = Object.keys(body.byDayModel);
  expect(days.length, '夹具里至少一个真实日期 + unknown').toBeGreaterThanOrEqual(1);
  for (const day of days) {
    expect(typeof body.byDayModel[day], `byDayModel[${day}]`).toBe('object');
    for (const [model, row] of Object.entries(body.byDayModel[day])) {
      expect(sorted(Object.keys(row)), `byDayModel[${day}][${model}] 五项`).toEqual(sorted(['input', 'output', 'cacheRead', 'cacheWrite', 'calls']));
      for (const v of Object.values(row)) expect(Number.isInteger(v) && v >= 0, `byDayModel[${day}][${model}] 应是非负整数`).toBe(true);
    }
  }
  // byDayModel 的每日合计必须与 byDay 对得上(byDayModel 只覆盖 byDay 窗口内的天)
  for (const r of body.byDay) {
    const perModel = body.byDayModel[r.day];
    expect(perModel, `byDay[${r.day}] 应在 byDayModel 里有对应行`).toBeTruthy();
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'calls']) {
      expect(Object.values(perModel).reduce((s, row) => s + row[k], 0), `byDay[${r.day}].${k} 应等于 byDayModel 同日各行之和`).toBe(r[k]);
    }
  }
  expect(sorted(Object.keys(body.ranges))).toEqual(sorted(RANGE_KEYS));
  for (const k of RANGE_KEYS) {
    const range = body.ranges[k];
    expect(sorted(Object.keys(range)), `ranges.${k} 字段集`).toEqual(sorted(RANGE_FIELDS));
    for (const f of ['sessions', 'messages', 'input', 'output', 'cacheRead', 'cacheWrite', 'calls', 'activeDays', 'currentStreak', 'longestStreak']) {
      expect(Number.isInteger(range[f]) && range[f] >= 0, `ranges.${k}.${f} 应是非负整数`).toBe(true);
    }
    expect(range.hourCounts.length).toBe(24);
    for (const f of ['firstDay', 'lastActiveDay']) expect(range[f] === null || /^\d{4}-\d{2}-\d{2}$/.test(range[f]), `ranges.${k}.${f}`).toBe(true);
    expect(range.peakHour === null || (Number.isInteger(range.peakHour) && range.peakHour >= 0 && range.peakHour <= 23)).toBe(true);
    expect(range.favoriteModel === null || typeof range.favoriteModel === 'string').toBe(true);
    for (const m of range.byModel) {
      expect(sorted(Object.keys(m)), `ranges.${k}.byModel 行`).toEqual(sorted(['model', 'input', 'output', 'cacheRead', 'cacheWrite', 'calls']));
      for (const f of ['input', 'output', 'cacheRead', 'cacheWrite', 'calls']) expect(Number.isInteger(m[f]) && m[f] >= 0).toBe(true);
    }
    // 7d ⊆ 30d:窗口嵌套 → 每个模型的四项与 calls 都不更大
    for (const m of range.byModel) {
      const big = body.ranges['30d'].byModel.find((x) => x.model === m.model);
      expect(big, `ranges.30d 应含 7d 里的模型 ${m.model}`).toBeTruthy();
      for (const f of ['input', 'output', 'cacheRead', 'cacheWrite', 'calls']) expect(m[f], `${m.model}.${f}:7d ≤ 30d`).toBeLessThanOrEqual(big[f]);
    }
  }
});

test('D1i ranges 里不含 "all"(全量直接用 total / overview / byModel,不再抄一份)', async () => {
  const body = await run('d1i-no-all');
  expect(body.ranges.all).toBeUndefined();
  expect(body.ranges.All).toBeUndefined();
});
