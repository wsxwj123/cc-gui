// r130 · D 组(接口不变项,反向用例):既有字段的名字/语义/排序逐字节不变,根键只多 overview(INTERFACE §D)。
// 夹具是确定性的(helpers/d-fixture.mjs),修前在当前代码上生成过基线 helpers/d-baseline.json;修后必须与基线逐字节相等。
// 「修前」= 这组应当全绿(它们守的是现状)。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { caseRoot, suitePath, ROOT_KEYS, TOTAL_KEYS, BYDAY_OLD_KEYS, BYDAY_KEYS } from './helpers/fixtures.mjs';
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

test('D1a 根键只许是既有五键 + overview + byDayModel + ranges(r131 追加的两个),既有五键必在', async () => {
  const body = await run('d1a-root-keys');
  const keys = Object.keys(body);
  expect(keys.filter((k) => !ROOT_KEYS.includes(k)), '根上不许多出约定之外的键').toEqual([]);
  for (const k of ['total', 'byModel', 'byProject', 'byDay', 'meta']) expect(keys, `缺既有根键 ${k}`).toContain(k);
});
test('D1b total 恰好五键,数值 = 手算(子代理算 token 不算会话;同 id 副本去重)', async () => {
  const body = await run('d1b-total');
  expect(sorted(Object.keys(body.total))).toEqual(sorted(TOTAL_KEYS));
  expect(body.total).toEqual(D_EXPECTED.total);
});
test("D1c byDay 既有六键都在、没有八键之外的键;按 day 降序且 'unknown' 排最前;六键数值 = 手算", async () => {
  const body = await run('d1c-byday');
  expect(body.byDay.map((r) => r.day)).toEqual(D_EXPECTED.byDayDays);
  for (const r of body.byDay) {
    for (const k of BYDAY_OLD_KEYS) expect(Object.keys(r), `byDay[${r.day}] 缺既有键 ${k}`).toContain(k);
    expect(Object.keys(r).filter((k) => !BYDAY_KEYS.includes(k)), `byDay[${r.day}] 多出未约定的键`).toEqual([]);
    const { input, output, cacheRead, cacheWrite, calls } = r;
    expect({ input, output, cacheRead, cacheWrite, calls }, `byDay[${r.day}] 六键数值`).toEqual(D_EXPECTED.byDayRows[r.day]);
  }
});
test('D1d byModel 行含 model/input/output/cacheRead/cacheWrite/calls 与 byPeriod 对象;byProject ≤ 20 行且行含 hash + 五个数字', async () => {
  const body = await run('d1d-bymodel-byproject');
  expect(body.byModel.length).toBe(3);
  for (const m of body.byModel) {
    for (const k of ['model', 'input', 'output', 'cacheRead', 'cacheWrite', 'calls']) expect(m, `byModel 行缺 ${k}`).toHaveProperty(k);
    expect(m.byPeriod && typeof m.byPeriod, `byModel[${m.model}] 应带 byPeriod 对象`).toBe('object');
  }
  expect(body.byProject.length).toBeLessThanOrEqual(20);
  expect(body.byProject.length).toBe(2);
  for (const p of body.byProject) {
    expect(typeof p.hash).toBe('string');
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'calls']) expect(typeof p[k], `byProject[${p.hash}].${k}`).toBe('number');
  }
});
test('D1e meta 恰好两键:scannedAt(number)/ stale(boolean)', async () => {
  const body = await run('d1e-meta');
  expect(sorted(Object.keys(body.meta))).toEqual(['scannedAt', 'stale']);
  expect(typeof body.meta.scannedAt).toBe('number');
  expect(typeof body.meta.stale).toBe('boolean');
});
test('D1f 与修前基线 d-baseline.json 逐字节相等:total / byModel(含 byPeriod)/ byProject / byDay 既有六键', async () => {
  const file = suitePath('helpers', 'd-baseline.json');
  expect(fs.existsSync(file), '缺基线文件:先在修前代码上跑 helpers/snapshot.mjs').toBe(true);
  const baseline = JSON.parse(fs.readFileSync(file, 'utf8')).legacy;
  const body = await run('d1f-baseline');
  expect(legacyView(body)).toEqual(baseline);
});
