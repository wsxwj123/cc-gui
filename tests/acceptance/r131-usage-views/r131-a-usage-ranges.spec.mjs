// r131 · A 组:GET /api/usage 新增的 byDayModel(day × model)与 ranges(7d / 30d 范围内聚合)。
// 每条用例自己造隔离 HOME(几十字节 jsonl)+ 起/停自己的实例;不起浏览器。夹具是小 jsonl,期望值全部手算。
// 「修前」= 当前响应没有 byDayModel / ranges 两个根键 → 本组全红。
import { test, expect } from '@playwright/test';
import { caseRoot, sessionFile, subagentFile, writeJsonl, assistant, user, sid, STD, sum4,
  dayAgo, tsAgo, isoAt, dayRow, RANGE_KEYS, RANGE_FIELDS } from './helpers/fixtures.mjs';
import { startInstance, stopAll, getUsage } from './helpers/instance.mjs';

const S1 = sid(1); const S2 = sid(2); const S3 = sid(3);
test.afterEach(async () => { await stopAll(); });

async function run(slug, build, env = {}) {
  const { root, home } = caseRoot('a', slug);
  build(home);
  const inst = await startInstance({ root, home }, env, { label: slug });
  const r = await getUsage(inst.base);
  expect(r.status, `GET /api/usage 应 200:${r.text.slice(0, 200)}`).toBe(200);
  expect(r.json, '响应应是 JSON').toBeTruthy();
  return { inst, home, body: r.json };
}
const sorted = (a) => [...a].sort();
/** byDayModel[day] 里某个模型的行(缺 → null)。 */
const dmRow = (body, day, model) => body?.byDayModel?.[day]?.[model] ?? null;
const FOUR = ['input', 'output', 'cacheRead', 'cacheWrite'];
const four = (r) => (r ? FOUR.map((k) => r[k]) : null);

// ───────────── byDayModel 形状与去重口径 ─────────────

test('A1 byDayModel 是 day → model → 五项的对象;'+"'unknown'"+' 键成行;同 message.id 跨文件只算一次(取 token 最大那条)', async () => {
  const D1 = dayAgo(1); const D2 = dayAgo(2);
  const M1 = 'claude-sonnet-4-6'; const M2 = 'deepseek-v3.2';
  const { body } = await run('a1-shape', (home) => {
    const dupId = 'msg-r131-dup';
    writeJsonl(sessionFile(home, S1), [
      user({ ts: isoAt(D1, 10) }),
      // 同一次调用的两片:第一片未写完(total 小),第二片才是真数 —— 只许留后者的四项
      assistant({ id: dupId, ts: isoAt(D1, 10, 1), model: M1, u: [10, 0, 0, 0] }),
      assistant({ id: dupId, ts: isoAt(D1, 10, 2), model: M1, u: [100, 20, 300, 40] }),
      assistant({ ts: isoAt(D1, 11), model: M2, u: [7, 3, 0, 0] }),
    ]);
    // 续接会话把同一条调用整段抄进另一个文件(id 跨文件也要去重)
    writeJsonl(sessionFile(home, S2), [assistant({ id: dupId, ts: isoAt(D1, 10, 2), model: M1, u: [100, 20, 300, 40] })]);
    // 无 timestamp → 'unknown' 键
    writeJsonl(sessionFile(home, S3), [assistant({ ts: undefined, model: M2, u: [7, 3, 0, 0] })]);
  });
  expect(sorted(Object.keys(body.byDayModel)), '只许有夹具造出的两个日期 + unknown').toEqual(sorted([D1, 'unknown']));
  expect(sorted(Object.keys(body.byDayModel[D1]))).toEqual(sorted([M1, M2]));
  expect(sorted(Object.keys(body.byDayModel[D1][M1]))).toEqual(sorted([...FOUR, 'calls']));
  expect(four(dmRow(body, D1, M1)), `${M1} 在 ${D1} 的四项 = 收尾那片(去重后)`).toEqual([100, 20, 300, 40]);
  expect(dmRow(body, D1, M1).calls).toBe(1);
  expect(four(dmRow(body, D1, M2))).toEqual([7, 3, 0, 0]);
  expect(four(dmRow(body, 'unknown', M2)), '无时间戳的记录进 unknown 键').toEqual([7, 3, 0, 0]);
  // 与 byDay 的同日合计对得上(byDayModel 是 byDay 的按模型拆分)
  const day = dayRow(body, D1);
  const sum = FOUR.map((k) => dmRow(body, D1, M1)[k] + dmRow(body, D1, M2)[k]);
  expect(sum).toEqual(FOUR.map((k) => day[k]));
  expect(day.calls).toBe(dmRow(body, D1, M1).calls + dmRow(body, D1, M2).calls);
});

test('A2 byDayModel 覆盖子代理文件(路径含 /subagents/)的 token,且与顶层同 id 去重;user 记录不进 byDayModel', async () => {
  const D = dayAgo(1);
  const { body } = await run('a2-subagent', (home) => {
    writeJsonl(sessionFile(home, S1), [user({ ts: isoAt(D, 10) }), assistant({ ts: isoAt(D, 10, 1), model: 'r131-M1' })]);
    writeJsonl(subagentFile(home, S1, 'a'), [assistant({ ts: isoAt(D, 10, 2), model: 'r131-M2' })]);
  });
  expect(sorted(Object.keys(body.byDayModel[D]))).toEqual(sorted(['r131-M1', 'r131-M2']));
  expect(four(dmRow(body, D, 'r131-M2')), '子代理的调用是另一次真实请求,必须计入').toEqual(STD);
  expect(body.byDayModel[D]['r131-M1'].calls).toBe(1);
});

// ───────────── ranges:窗口边界 + 会话去重 ─────────────

test('A3 ranges 只有 7d / 30d 两个键,各含约定字段;7d 窗口 = 今天往前数 7 个本地日(不含第 8 天),30d 同口径', async () => {
  const M = 'r131-M1';
  const D = { d0: dayAgo(0), d1: dayAgo(1), d6: dayAgo(6), d7: dayAgo(7), d29: dayAgo(29), d30: dayAgo(30) };
  const { body } = await run('a3-window', (home) => {
    writeJsonl(sessionFile(home, S1), [
      assistant({ ts: isoAt(D.d0, 10), model: M }),      // 7d ✓ 30d ✓
      assistant({ ts: isoAt(D.d6, 10), model: M }),      // 7d ✓ 30d ✓
      assistant({ ts: isoAt(D.d7, 10), model: M }),      // 7d ✗ 30d ✓(窗口边界外面一天)
      assistant({ ts: isoAt(D.d29, 10), model: M }),     // 7d ✗ 30d ✓
      assistant({ ts: isoAt(D.d30, 10), model: M }),     // 7d ✗ 30d ✗
      assistant({ ts: undefined, model: M }),            // 两边都不计('unknown' 没有日期)
    ]);
  });
  expect(sorted(Object.keys(body.ranges)), 'ranges 只有两个窗口键').toEqual(sorted(RANGE_KEYS));
  for (const k of RANGE_KEYS) {
    const range = body.ranges[k];
    expect(sorted(Object.keys(range)), `ranges.${k} 字段`).toEqual(sorted(RANGE_FIELDS));
    expect(sorted(Object.keys(range.byModel[0]))).toEqual(sorted([...FOUR, 'calls', 'model']));
  }
  const t7 = sum4(STD) * 2; const t30 = sum4(STD) * 4;
  expect(body.ranges['7d'].input).toBe(STD[0] * 2);
  expect(body.ranges['7d'].calls).toBe(2);
  expect(body.ranges['30d'].input).toBe(STD[0] * 4);
  expect(body.ranges['30d'].calls).toBe(4);
  expect(body.ranges['7d'].calls + body.ranges['30d'].calls, '两个窗口各算各的,不互相裁').toBe(6);
  expect(t7).toBeLessThan(t30);
  // 全量口径不受窗口影响
  expect(body.total.input).toBe(STD[0] * 6);
  expect(body.ranges['7d'].byModel[0].model).toBe(M);
  expect(body.ranges['30d'].byModel.length).toBe(1);
});

test('A4 跨天的会话在 ranges.sessions 里按会话去重(不是把 byDay[].sessions 相加)', async () => {
  const M = 'r131-M1';
  const days = [dayAgo(1), dayAgo(2), dayAgo(3)];
  const { body } = await run('a4-session-dedup', (home) => {
    // S1 三天都有记录(同一天里两个 session 也各有记录);S2 只在前两天
    writeJsonl(sessionFile(home, S1), days.map((d, i) => assistant({ ts: isoAt(d, 10 + i), model: M })));
    writeJsonl(sessionFile(home, S2), [
      user({ ts: isoAt(days[0], 9) }), user({ ts: isoAt(days[1], 9) }),
    ]);
  });
  const byDaySum = days.reduce((s, d) => s + dayRow(body, d).sessions, 0);
  // 前提(不写死数字,免得夹具一改就假绿):逐日相加 = Σ 每天的会话数,必然 > 去重后的会话数
  expect(byDaySum, `前提:逐日相加会多算(得到 ${byDaySum},去重后只有 2)`,).toBeGreaterThan(2);
  expect(body.ranges['7d'].sessions, '7d 会话数 = 窗口内涉及的去重会话 = 2').toBe(2);
  expect(body.ranges['30d'].sessions).toBe(2);
  expect(body.total.sessionCount, '全量会话数 = 文件数 = 2').toBe(2);
});

test('A5 ranges 的 messages / activeDays / 连续天数 / 高峰时段 / 常用模型都按窗口内数据算', async () => {
  const M1 = 'r131-M1'; const M2 = 'r131-M2';
  const in7 = [dayAgo(0), dayAgo(1), dayAgo(2)];
  const out7in30 = [dayAgo(8), dayAgo(9)];
  const { body } = await run('a5-overview-by-range', (home) => {
    // 窗口内:M1 出现在 0/1/2 三天(第 0 天两笔),每天 21 点(本地)= 高峰时段判定用
    writeJsonl(sessionFile(home, S1), [
      user({ ts: isoAt(in7[0], 21) }), assistant({ ts: isoAt(in7[0], 21, 1), model: M1 }),
      assistant({ ts: isoAt(in7[0], 21, 2), model: M1 }),
      user({ ts: isoAt(in7[1], 21) }), assistant({ ts: isoAt(in7[1], 21, 1), model: M1 }),
      user({ ts: isoAt(in7[2], 21) }), assistant({ ts: isoAt(in7[2], 21, 1), model: M1 }),
    ]);
    // 30d 内但 7d 外:只有 M2,而且时段在 3 点
    writeJsonl(sessionFile(home, S2), out7in30.map((d) => assistant({ ts: isoAt(d, 3), model: M2 })));
  });
  const r7 = body.ranges['7d']; const r30 = body.ranges['30d'];
  expect(r7.sessions).toBe(1);
  expect(r7.messages, '7d 窗口:3 条 user + 4 条 assistant').toBe(7);
  expect(r7.activeDays, '7d:0/1/2 三天有消息').toBe(3);
  expect(r7.currentStreak, '今天、昨天、前天连续 → 3').toBe(3);
  expect(r7.firstDay).toBe(in7[2]);
  expect(r7.lastActiveDay).toBe(in7[0]);
  expect(r7.longestStreak).toBe(3);
  expect(r7.peakHour, '7d 窗口内 21 点 4 笔 > 其余').toBe(21);
  expect(r7.favoriteModel, '7d 窗口内 M1 独有').toBe(M1);
  expect(r7.hourCounts[21]).toBe(4);
  expect(r7.hourCounts[3], '7d 窗外(8/9 天前)的 3 点记录不该进 7d 的 hourCounts').toBe(0);
  // 30d 窗口把 S2 也纳进来
  expect(r30.sessions).toBe(2);
  expect(r30.messages).toBe(7 + 2);
  expect(r30.activeDays).toBe(5);
  expect(r30.currentStreak, '8/9 天前那两天与今天不连续 → 当前连续仍是 3').toBe(3);
  expect(r30.longestStreak).toBe(3);
  expect(r30.peakHour, '30d 窗口内 21 点 4 笔仍最多(3 点只有 2 笔)').toBe(21);
  expect(r30.favoriteModel).toBe(M1);
  expect(r30.firstDay).toBe(out7in30[1]);
  expect(r30.hourCounts[3]).toBe(2);
  // 全量口径:overview 不受任何窗口影响
  expect(body.overview.activeDays).toBe(5);
  expect(body.overview.messages).toBe(9);
});

test('A6 ranges 的 byModel 按模型分组、只含窗口内的记录;不在窗口内的模型不出现', async () => {
  const { body } = await run('a6-range-bymodel', (home) => {
    writeJsonl(sessionFile(home, S1), [
      assistant({ ts: tsAgo(1, 10), model: 'r131-in7', u: [1, 1, 1, 1] }),
      assistant({ ts: tsAgo(2, 10), model: 'r131-in7', u: [2, 2, 2, 2] }),
      assistant({ ts: tsAgo(20, 10), model: 'r131-in30', u: [10, 10, 10, 10] }),
      assistant({ ts: tsAgo(100, 10), model: 'r131-old', u: [100, 100, 100, 100] }),
    ]);
  });
  expect(body.ranges['7d'].byModel.map((m) => m.model)).toEqual(['r131-in7']);
  expect(four(body.ranges['7d'].byModel[0])).toEqual([3, 3, 3, 3]);
  expect(body.ranges['7d'].byModel[0].calls).toBe(2);
  expect(sorted(body.ranges['30d'].byModel.map((m) => m.model))).toEqual(sorted(['r131-in30', 'r131-in7']));
  const in30 = Object.fromEntries(body.ranges['30d'].byModel.map((m) => [m.model, m]));
  expect(four(in30['r131-in7'])).toEqual([3, 3, 3, 3]);
  expect(four(in30['r131-in30'])).toEqual([10, 10, 10, 10]);
  // 全量 byModel 仍有三个(既有字段不变)
  expect(sorted(body.byModel.map((m) => m.model))).toEqual(sorted(['r131-in7', 'r131-in30', 'r131-old']));
});

test("A7 空目录:byDayModel 是 {}、ranges 两个窗口都是空账(sessions/messages/四个 token/calls 为 0,activeDays 0,取值为 null 的字段为 null,hourCounts 24 个 0)", async () => {
  const { body } = await run('a7-empty', () => {});
  expect(body.byDayModel, '没有 projects 目录 → byDayModel 是空对象').toEqual({});
  expect(sorted(Object.keys(body.ranges))).toEqual(sorted(RANGE_KEYS));
  for (const k of RANGE_KEYS) {
    const r = body.ranges[k];
    expect(r.sessions).toBe(0);
    expect(r.messages).toBe(0);
    expect([r.input, r.output, r.cacheRead, r.cacheWrite, r.calls]).toEqual([0, 0, 0, 0, 0]);
    expect([r.activeDays, r.currentStreak, r.longestStreak]).toEqual([0, 0, 0]);
    expect([r.firstDay, r.lastActiveDay, r.peakHour, r.favoriteModel]).toEqual([null, null, null, null]);
    expect(r.hourCounts).toEqual(Array(24).fill(0));
    expect(r.byModel).toEqual([]);
  }
});

test('A8 特殊模型名走普通键(不进原型链):byDayModel 里能查到自己,Object.prototype 不被污染', async () => {
  const D = dayAgo(1);
  const { body } = await run('a8-proto', (home) => {
    writeJsonl(sessionFile(home, S1), [assistant({ ts: isoAt(D, 10), model: '__proto__' }), assistant({ ts: isoAt(D, 11), model: 'constructor' })]);
  });
  expect(Object.prototype.polluted, 'Object.prototype 不该多出字段').toBeUndefined();
  expect(Object.getOwnPropertyNames(body.byDayModel[D]), '两个名字都必须是自己键').toEqual(expect.arrayContaining(['__proto__', 'constructor']));
  expect(four(dmRow(body, D, '__proto__'))).toEqual(STD);
  expect(body.byDayModel[D].constructor.calls).toBe(1);
  expect(body.ranges['7d'].byModel.map((m) => m.model)).toEqual(expect.arrayContaining(['__proto__', 'constructor']));
});
