#!/usr/bin/env node
// r130 · 用量日历纯函数(server/utils/usage-calendar.js)。"本地" = 进程 TZ,所以先钉 TZ 再动态 import
// (静态 import 会提升到赋值之前)。Node ≥ 13 运行时改 process.env.TZ 即生效,开头自检一次。
import assert from 'node:assert/strict';

process.env.TZ = 'Asia/Shanghai';
assert.equal(new Date('2026-09-07T20:30:00Z').getHours(), 4, '自检:进程 TZ 必须已切到 +08:00');
const { dayKeyOf, localDayKey, localHour, shiftDayKey, mondayIndex, dayDiff, computeStreaks } =
  await import('../../server/utils/usage-calendar.js');

// ── 切日 / 小时:按本地(+08:00),不是 ISO 串前 10 位 ──────────────────────────
assert.equal(localDayKey('2026-09-07T20:30:00Z'), '2026-09-08', '20:30Z 在 +08:00 已是次日');
assert.equal(localDayKey('2026-09-07T15:59:59.999Z'), '2026-09-07', '15:59Z 仍是当日');
assert.equal(localDayKey('2026-09-07T16:00:00.000Z'), '2026-09-08', '16:00Z 正好跨日');
assert.equal(localDayKey(Date.UTC(2026, 8, 7, 20, 30)), '2026-09-08', '毫秒数同样可用');
for (const bad of [undefined, null, '', 'garbage', 'yesterday']) assert.equal(localDayKey(bad), null, `无 / 非法时间戳 → null(${bad})`);
assert.equal(localHour('2026-09-07T20:30:00Z'), 4);
assert.equal(localHour('2026-09-08T00:59:00Z'), 8);
assert.equal(localHour('2026-09-08T15:59:00Z'), 23);
assert.equal(localHour('x'), null);
assert.equal(localHour(undefined), null);
assert.equal(dayKeyOf(new Date(2026, 0, 5, 23, 59)), '2026-01-05', 'Date → 本地分量');
assert.equal(dayKeyOf(new Date(NaN)), null);
assert.equal(dayKeyOf('2026-01-05'), null, '非 Date 不猜');

// ── 日期加减:跨月 / 跨年 / 闰日 / 负数 / 零 / 非法 ─────────────────────────────
assert.equal(shiftDayKey('2026-02-28', 1), '2026-03-01', '2026 非闰年');
assert.equal(shiftDayKey('2024-02-28', 1), '2024-02-29', '2024 闰年');
assert.equal(shiftDayKey('2024-02-29', 1), '2024-03-01');
assert.equal(shiftDayKey('2025-12-31', 1), '2026-01-01', '跨年');
assert.equal(shiftDayKey('2026-01-01', -1), '2025-12-31', '负数跨年');
assert.equal(shiftDayKey('2026-03-01', -1), '2026-02-28');
assert.equal(shiftDayKey('2026-01-01', 0), '2026-01-01');
assert.equal(shiftDayKey('2026-01-01', 400), '2027-02-05', '400 天窗口的另一端');
assert.equal(shiftDayKey('bad', 1), null);
assert.equal(shiftDayKey(undefined, 1), null);
assert.equal(mondayIndex('2026-09-28'), 0, '2026-09-28 是周一');
assert.equal(mondayIndex('2026-09-27'), 6, '周日排最后一行');
assert.equal(mondayIndex('2026-02-26'), 3, '周四');
assert.equal(mondayIndex('unknown'), null);
assert.equal(dayDiff('2026-03-01', '2026-02-26'), 3);
assert.equal(dayDiff('2026-01-01', '2025-12-30'), 2);
assert.equal(dayDiff('2026-01-01', '2026-01-08'), -7);
assert.equal(dayDiff('2026-01-01', 'unknown'), null);

// ── 连续天数 ──────────────────────────────────────────────────────────────────
const T = '2026-09-28';
const ago = (n) => shiftDayKey(T, -n);
assert.deepEqual(computeStreaks([], T), { currentStreak: 0, longestStreak: 0 }, '全空');
assert.deepEqual(computeStreaks(['2026-05-10'], T), { currentStreak: 0, longestStreak: 1 }, '孤立一天 → longest 1');
assert.deepEqual(computeStreaks([ago(0), ago(1), ago(2), ago(4)], T), { currentStreak: 3, longestStreak: 3 }, '今天活跃:从今天往前数,断开不续');
assert.deepEqual(computeStreaks([ago(1), ago(2)], T), { currentStreak: 2, longestStreak: 2 }, '今天没有、昨天有 → 从昨天往前数');
assert.deepEqual(computeStreaks([ago(2), ago(3)], T), { currentStreak: 0, longestStreak: 2 }, '今天昨天都没有 → current 0,longest 仍算历史段');
assert.equal(computeStreaks(['2026-02-26', '2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02', '2026-05-10', '2026-05-11'], T).longestStreak, 5, '跨月(2 月 28 天)');
assert.equal(computeStreaks(['2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02', '2026-04-01'], T).longestStreak, 4, '跨年');
assert.equal(computeStreaks(['2024-02-28', '2024-02-29', '2024-03-01'], T).longestStreak, 3, '闰日不断段');
assert.equal(computeStreaks(['2026-01-02', '2026-01-01', '2026-01-02'], T).longestStreak, 2, '重复 + 乱序');
assert.deepEqual(computeStreaks(['unknown', '', null, '2026-01-01'], T), { currentStreak: 0, longestStreak: 1 }, '非法键静默忽略,不炸');
assert.deepEqual(computeStreaks([ago(0)], T), { currentStreak: 1, longestStreak: 1 }, '只有今天');
assert.deepEqual(computeStreaks([ago(1)], T), { currentStreak: 1, longestStreak: 1 }, '只有昨天');

console.log('check-r130-usage-calendar: PASS');
