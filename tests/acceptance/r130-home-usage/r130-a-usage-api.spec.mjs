// r130 · A 组:GET /api/usage 的新字段(byDay.sessions/messages、overview)按 INTERFACE §A 用小夹具手算核对。
// 每条用例自己造隔离 HOME(几十字节的 jsonl)+ 起/停自己的实例;不起浏览器。依据只有 BRIEF/INTERFACE-r130;没看实现代码。
// 「修前」= 当前代码没有 sessions/messages/overview,且按 UTC 切日、byDay 只留 30 行 → 本组基本全红。
import { test, expect } from '@playwright/test';
import { caseRoot, sessionFile, subagentFile, workflowFile, writeJsonl, assistant, user, toolResultBlock, sid, STD, sum4,
  dayAgo, today, tsAgo, isoAt, dayRow, OVERVIEW_KEYS } from './helpers/fixtures.mjs';
import { startInstance, stopAll, getUsage } from './helpers/instance.mjs';

const S1 = sid(1); const S2 = sid(2); const S3 = sid(3);
test.afterEach(async () => { await stopAll(); });

/** 造现场 → 起实例 → 打一次 /api/usage。build(home) 负责写夹具。 */
async function run(slug, build, env = {}) {
  const { root, home } = caseRoot('a', slug);
  build(home);
  const inst = await startInstance({ root, home }, env, { label: slug });
  const r = await getUsage(inst.base);
  expect(r.status, `GET /api/usage 应 200:${r.text.slice(0, 200)}`).toBe(200);
  expect(r.json, '响应应是 JSON').toBeTruthy();
  return { inst, home, body: r.json };
}
const row = (body, day) => { const x = dayRow(body, day); expect(x, `byDay 里应有 ${day} 这一行;实际有:${(body.byDay || []).map((d) => d.day).join(',')}`).toBeTruthy(); return x; };

// ───────────── byDay.sessions / messages ─────────────

test('A1 同一天两个会话:messages = 用户条数 + 助手条数,sessions 按会话去重 = 2', async () => {
  const D = dayAgo(1);
  const { body } = await run('a1-two-sessions', (home) => {
    writeJsonl(sessionFile(home, S1), [user({ ts: isoAt(D, 10, 0) }), assistant({ ts: isoAt(D, 10, 1) }), user({ ts: isoAt(D, 10, 2) }), assistant({ ts: isoAt(D, 10, 3) })]);
    writeJsonl(sessionFile(home, S2), [user({ ts: isoAt(D, 11, 0) }), assistant({ ts: isoAt(D, 11, 1) })]);
  });
  const r = row(body, D);
  expect(r.calls, 'calls = 去重后 assistant 条数').toBe(3);
  expect(r.messages, 'messages = 3 user + 3 calls').toBe(6);
  expect(r.sessions, 'sessions = 两个文件 = 2').toBe(2);
  expect([r.input, r.output, r.cacheRead, r.cacheWrite]).toEqual(STD.map((v) => v * 3));
});

test('A2 只有 user 记录的天也成行:token 四项与 calls 为 0,messages=1,sessions=1', async () => {
  const D1 = dayAgo(1); const D2 = dayAgo(2);
  const { body } = await run('a2-user-only-day', (home) => {
    writeJsonl(sessionFile(home, S1), [user({ ts: isoAt(D2, 9) }), assistant({ ts: isoAt(D1, 9) })]);
  });
  const r = row(body, D2);
  expect([r.input, r.output, r.cacheRead, r.cacheWrite, r.calls]).toEqual([0, 0, 0, 0, 0]);
  expect(r.messages).toBe(1);
  expect(r.sessions).toBe(1);
});

test('A3a 顶层会话文件里 isSidechain=true 的 user 记录不算消息', async () => {
  const D = dayAgo(1);
  const { body } = await run('a3a-sidechain-flag', (home) => {
    writeJsonl(sessionFile(home, S1), [user({ ts: isoAt(D, 10) }), user({ ts: isoAt(D, 10, 1), sidechain: true }), assistant({ ts: isoAt(D, 10, 2) })]);
  });
  expect(row(body, D).messages, '1 个正常 user + 1 个 assistant;sidechain user 被排除').toBe(2);
});

test('A3b 子代理文件(路径含 /subagents/)里的 user 记录即使 isSidechain=false 也不算;其 assistant 照算且归母会话', async () => {
  const D = dayAgo(1);
  const { body } = await run('a3b-subagent-path', (home) => {
    writeJsonl(sessionFile(home, S1), [user({ ts: isoAt(D, 10) }), assistant({ ts: isoAt(D, 10, 1) })]);
    writeJsonl(subagentFile(home, S1, 'a'), [user({ ts: isoAt(D, 10, 2), sidechain: false }), assistant({ ts: isoAt(D, 10, 3) })]);
  });
  const r = row(body, D);
  expect(r.messages, '母会话 user 1 + assistant 2(子代理的 user 不算)').toBe(3);
  expect(r.sessions, '子代理归母会话,不另算一个会话').toBe(1);
});

test('A4 isMeta=true 的 user 记录不算消息', async () => {
  const D = dayAgo(1);
  const { body } = await run('a4-ismeta', (home) => {
    writeJsonl(sessionFile(home, S1), [user({ ts: isoAt(D, 10), isMeta: true }), user({ ts: isoAt(D, 10, 1) }), assistant({ ts: isoAt(D, 10, 2) })]);
  });
  expect(row(body, D).messages).toBe(2);
});

test('A5a 内容只有 tool_result 块的 user 记录不算消息', async () => {
  const D = dayAgo(1);
  const { body } = await run('a5a-toolresult-only', (home) => {
    writeJsonl(sessionFile(home, S1), [user({ ts: isoAt(D, 10), content: [toolResultBlock()] }), assistant({ ts: isoAt(D, 10, 1) })]);
  });
  expect(row(body, D).messages, '只有 assistant 那 1 条').toBe(1);
});

test('A5b tool_result 之外还有一个 text 块的 user 记录算消息', async () => {
  const D = dayAgo(1);
  const { body } = await run('a5b-toolresult-mixed', (home) => {
    writeJsonl(sessionFile(home, S1), [user({ ts: isoAt(D, 10), content: [toolResultBlock(), { type: 'text', text: '继续' }] }), assistant({ ts: isoAt(D, 10, 1) })]);
  });
  expect(row(body, D).messages).toBe(2);
});

test('A6 命令回显排除表:local-command-*/command-*/task-notification/cgui-tool-retry 开头不算;<bash-input>/<pasted_content> 开头算', async () => {
  // 每个变体独占一天(dayAgo(11) 起),按"那天有没有成行 / messages 是否为 1"逐个判定,失败信息里列出全部不符的变体。
  const variants = [
    ['<local-command-caveat>x</local-command-caveat>', false], ['<local-command-stdout>ok</local-command-stdout>', false],
    ['<local-command-stderr>err</local-command-stderr>', false], ['<command-name>/clear</command-name>', false],
    ['<command-message>clear</command-message>', false], ['<command-args>-a</command-args>', false],
    ['<task-notification>done</task-notification>', false], ['<cgui-tool-retry>1</cgui-tool-retry>', false],
    ['  \n<command-name>/help</command-name>', false], ['ARRAY:<command-name>/x</command-name>', false],
    ['<bash-input>ls -la</bash-input>', true], ['<pasted_content>粘贴的内容</pasted_content>', true], ['普通提问', true],
  ];
  const { body } = await run('a6-echo-table', (home) => {
    writeJsonl(sessionFile(home, S1), variants.map(([text], i) => {
      const ts = tsAgo(11 + i, 9);
      return text.startsWith('ARRAY:') ? user({ ts, content: [{ type: 'text', text: text.slice(6) }] }) : user({ ts, text });
    }));
  });
  const wrong = [];
  variants.forEach(([text, counted], i) => {
    const r = dayRow(body, dayAgo(11 + i));
    const got = r ? r.messages : 0;
    if (got !== (counted ? 1 : 0)) wrong.push(`${JSON.stringify(text.slice(0, 40))} 期望${counted ? '算' : '不算'} 实际 messages=${got}`);
  });
  expect(wrong, `不符的变体:\n${wrong.join('\n')}`).toEqual([]);
});

test('A7a 同一 uuid 的 user 记录出现在两个文件里只算一条消息', async () => {
  const D = dayAgo(1);
  const { body } = await run('a7a-uuid-dedup', (home) => {
    writeJsonl(sessionFile(home, S1), [user({ ts: isoAt(D, 10), uuid: 'r130-dup-user-uuid' })]);
    writeJsonl(sessionFile(home, S2), [user({ ts: isoAt(D, 10), uuid: 'r130-dup-user-uuid' })]);
  });
  expect(row(body, D).messages).toBe(1);
  expect(body.overview?.messages).toBe(1);
});

test('A7b 没有 uuid 的 user 记录无从去重,两条都计入', async () => {
  const D = dayAgo(1);
  const { body } = await run('a7b-no-uuid', (home) => {
    writeJsonl(sessionFile(home, S1), [user({ ts: isoAt(D, 10), uuid: null }), user({ ts: isoAt(D, 10, 1), uuid: null })]);
  });
  expect(row(body, D).messages).toBe(2);
});

test('A8a sessionKey 按文件路径,不读记录里的 sessionId 字段:两个文件同一 sessionId 字段 → sessions=2', async () => {
  const D = dayAgo(1);
  const { body } = await run('a8a-session-by-path', (home) => {
    writeJsonl(sessionFile(home, S1), [assistant({ ts: isoAt(D, 10), sessionId: 'same-field' })]);
    writeJsonl(sessionFile(home, S2), [assistant({ ts: isoAt(D, 11), sessionId: 'same-field' })]);
  });
  expect(row(body, D).sessions).toBe(2);
});

test('A8b 子代理与 workflow 深层文件都归母会话:三个文件 sessions=1,calls=3', async () => {
  const D = dayAgo(1);
  const { body } = await run('a8b-subagent-workflow-parent', (home) => {
    writeJsonl(sessionFile(home, S1), [assistant({ ts: isoAt(D, 10) })]);
    writeJsonl(subagentFile(home, S1, 'a'), [assistant({ ts: isoAt(D, 10, 1) })]);
    writeJsonl(workflowFile(home, S1, 'one', 'b'), [assistant({ ts: isoAt(D, 10, 2) })]);
  });
  const r = row(body, D);
  expect(r.calls).toBe(3);
  expect(r.sessions).toBe(1);
});

test('A26 assistant 按 message.id 跨文件去重留 token 最大的那条:calls=1、messages=1、sessions 取胜出文件', async () => {
  const D = dayAgo(1);
  const { body } = await run('a26-assistant-dedup', (home) => {
    writeJsonl(sessionFile(home, S1), [assistant({ ts: isoAt(D, 10), id: 'msg_r130_dup', u: [100, 20, 300, 40] })]);
    writeJsonl(sessionFile(home, S2), [assistant({ ts: isoAt(D, 10), id: 'msg_r130_dup', u: [1000, 0, 0, 0] })]);
  });
  const r = row(body, D);
  expect(r.calls).toBe(1);
  expect(r.input, '留合计最大(1000)的那条').toBe(1000);
  expect(r.messages).toBe(1);
  expect(r.sessions, '只有胜出那条所在的文件算会话').toBe(1);
});

// ───────────── overview:窗口 / 活跃天 / 连续天数 ─────────────

test('A9 byDay 只留前 400 行,overview 不受窗口影响:401 天各一条 user → byDay=400 行,overview.messages=401', async () => {
  const { body } = await run('a9-window-400', (home) => {
    writeJsonl(sessionFile(home, S1), Array.from({ length: 401 }, (_, i) => user({ ts: tsAgo(i + 1, 9) })));
  });
  expect(body.byDay.length).toBe(400);
  expect(dayRow(body, dayAgo(401)), '最老的一天被窗口截掉').toBeNull();
  expect(row(body, dayAgo(400)).messages).toBe(1);
  expect(body.overview?.messages).toBe(401);
  expect(body.overview?.activeDays).toBe(401);
  expect(body.overview?.firstDay).toBe(dayAgo(401));
});

test('A10 activeDays / firstDay / lastActiveDay:三天有消息(含只有 user 的天)', async () => {
  const { body } = await run('a10-active-days', (home) => {
    writeJsonl(sessionFile(home, S1), [user({ ts: tsAgo(10, 9) }), assistant({ ts: tsAgo(3, 9) }), user({ ts: tsAgo(1, 9) })]);
  });
  expect(body.overview?.activeDays).toBe(3);
  expect(body.overview?.firstDay).toBe(dayAgo(10));
  expect(body.overview?.lastActiveDay).toBe(dayAgo(1));
});

test("A11 无 timestamp 的记录落 'unknown' 行且排最前;'unknown' 不计入 activeDays/firstDay", async () => {
  const { body } = await run('a11-unknown-row', (home) => {
    writeJsonl(sessionFile(home, S1), [assistant({ ts: undefined }), user({ ts: tsAgo(1, 9) })]);
  });
  expect(body.byDay[0]?.day).toBe('unknown');
  expect(body.byDay[0]?.calls).toBe(1);
  expect(body.byDay[0]?.messages).toBe(1);
  expect(body.overview?.activeDays).toBe(1);
  expect(body.overview?.firstDay).toBe(dayAgo(1));
  expect(body.overview?.lastActiveDay).toBe(dayAgo(1));
});

test('A12 未来日的行留在 byDay 里,但不计 activeDays / lastActiveDay / 连续天数', async () => {
  const { body } = await run('a12-future-day', (home) => {
    writeJsonl(sessionFile(home, S1), [user({ ts: tsAgo(-5, 9) }), user({ ts: tsAgo(-4, 9) }), user({ ts: tsAgo(-3, 9) }), user({ ts: tsAgo(1, 9) })]);
  });
  expect(row(body, dayAgo(-5)).messages).toBe(1);
  expect(body.overview?.activeDays).toBe(1);
  expect(body.overview?.lastActiveDay).toBe(dayAgo(1));
  expect(body.overview?.currentStreak, '昨天活跃 → 1').toBe(1);
  expect(body.overview?.longestStreak, '未来 3 天连续段不算,最长仍是 1').toBe(1);
});

test('A13 currentStreak:今天活跃 → 从今天往前数(今天/昨天/前天=3,更早断开不续)', async () => {
  const { body } = await run('a13-streak-today', (home) => {
    writeJsonl(sessionFile(home, S1), [0, 1, 2, 4].map((n) => user({ ts: tsAgo(n, 9) })));
  });
  expect(body.overview?.currentStreak).toBe(3);
  expect(body.overview?.longestStreak).toBe(3);
  expect(body.overview?.lastActiveDay).toBe(today());
});

test('A14 currentStreak:今天没有、昨天有 → 从昨天往前数 = 2', async () => {
  const { body } = await run('a14-streak-yesterday', (home) => {
    writeJsonl(sessionFile(home, S1), [1, 2].map((n) => user({ ts: tsAgo(n, 9) })));
  });
  expect(body.overview?.currentStreak).toBe(2);
});

test('A15 currentStreak:今天昨天都没有 → 0(longestStreak 仍算历史段 = 2)', async () => {
  const { body } = await run('a15-streak-none', (home) => {
    writeJsonl(sessionFile(home, S1), [2, 3].map((n) => user({ ts: tsAgo(n, 9) })));
  });
  expect(body.overview?.currentStreak).toBe(0);
  expect(body.overview?.longestStreak).toBe(2);
});

test('A16 longestStreak:只有孤立的一天 → 1', async () => {
  const { body } = await run('a16-longest-single', (home) => {
    writeJsonl(sessionFile(home, S1), [user({ ts: tsAgo(5, 9) })]);
  });
  expect(body.overview?.longestStreak).toBe(1);
  expect(body.overview?.currentStreak).toBe(0);
});

test('A17a longestStreak 跨月:2026-02-26 → 03-02 连续 5 天(2 月只有 28 天)', async () => {
  const days = ['2026-02-26', '2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02', '2026-05-10', '2026-05-11'];
  const { body } = await run('a17a-longest-cross-month', (home) => {
    writeJsonl(sessionFile(home, S1), days.map((d) => user({ ts: isoAt(d, 9) })));
  });
  expect(body.overview?.longestStreak).toBe(5);
});

test('A17b longestStreak 跨年:2025-12-30 → 2026-01-02 连续 4 天', async () => {
  const days = ['2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02', '2026-04-01'];
  const { body } = await run('a17b-longest-cross-year', (home) => {
    writeJsonl(sessionFile(home, S1), days.map((d) => user({ ts: isoAt(d, 9) })));
  });
  expect(body.overview?.longestStreak).toBe(4);
});

// ───────────── overview:小时分布 / 切日 / 常用模型 ─────────────

test('A18 hourCounts 长度 24、按本地小时(+08:00)计助手回复:20:30Z → 本地 4 时', async () => {
  const D = dayAgo(1);
  const { body } = await run('a18-hourcounts', (home) => {
    writeJsonl(sessionFile(home, S1), [assistant({ ts: isoAt(D, 4, 30) }), assistant({ ts: isoAt(D, 8, 0) }), assistant({ ts: isoAt(D, 8, 59) }), assistant({ ts: isoAt(D, 23, 59) }), user({ ts: isoAt(D, 9) })]);
  });
  expect(isoAt(D, 4, 30).endsWith('T20:30:00.000Z'), '夹具自检:本地 04:30 = 前一天 20:30Z').toBe(true);
  const hc = body.overview?.hourCounts;
  expect(Array.isArray(hc) && hc.length).toBe(24);
  expect(hc[4]).toBe(1);
  expect(hc[8]).toBe(2);
  expect(hc[23]).toBe(1);
  expect(hc.reduce((a, b) => a + b, 0), 'user 记录不进 hourCounts').toBe(4);
  expect(body.overview?.peakHour).toBe(8);
});

test('A19 切日按服务端本地时区:2026-09-07T20:30:00Z 记到 2026-09-08,而不是 09-07', async () => {
  const { body } = await run('a19-local-day-cut', (home) => {
    writeJsonl(sessionFile(home, S1), [assistant({ ts: '2026-09-07T20:30:00Z' })]);
  });
  expect(row(body, '2026-09-08').calls).toBe(1);
  expect(dayRow(body, '2026-09-07'), '不该再按 UTC 前 10 位切日').toBeNull();
});

test('A20 peakHour 并列取最小的小时:14 时×2、8 时×2、3 时×1 → 8', async () => {
  const D = dayAgo(1);
  const { body } = await run('a20-peakhour-tie', (home) => {
    writeJsonl(sessionFile(home, S1), [14, 14, 8, 8, 3].map((h, i) => assistant({ ts: isoAt(D, h, i) })));
  });
  expect(body.overview?.peakHour).toBe(8);
});

test('A21 只有 user 记录:hourCounts 全 0 → peakHour=null;byModel 为空 → favoriteModel=null', async () => {
  const { body } = await run('a21-all-zero', (home) => {
    writeJsonl(sessionFile(home, S1), [user({ ts: tsAgo(1, 9) })]);
  });
  expect(body.overview?.hourCounts).toEqual(Array(24).fill(0));
  expect(body.overview?.peakHour).toBeNull();
  expect(body.overview?.favoriteModel).toBeNull();
  expect(body.overview?.messages).toBe(1);
});

test('A22 无 timestamp 的 assistant 记录计 calls 但不进 hourCounts', async () => {
  const { body } = await run('a22-no-ts-hour', (home) => {
    writeJsonl(sessionFile(home, S1), [assistant({ ts: undefined }), assistant({ ts: tsAgo(1, 10) })]);
  });
  expect(body.overview?.hourCounts.reduce((a, b) => a + b, 0)).toBe(1);
  expect(body.byModel.reduce((a, m) => a + m.calls, 0)).toBe(2);
  expect(body.overview?.messages).toBe(2);
});

test("A23 favoriteModel 排除 'unknown'(无 model 字段)与 '<synthetic>':它们 token 再多也不当常用模型", async () => {
  const D = dayAgo(1);
  const { body } = await run('a23-fav-exclude', (home) => {
    writeJsonl(sessionFile(home, S1), [assistant({ ts: isoAt(D, 10), model: '<synthetic>', u: [10000, 0, 0, 0] }), assistant({ ts: isoAt(D, 10, 1), model: null, u: [9000, 0, 0, 0] }), assistant({ ts: isoAt(D, 10, 2), model: 'claude-sonnet-4-6', u: STD })]);
  });
  expect(body.overview?.favoriteModel).toBe('claude-sonnet-4-6');
});

test('A24 favoriteModel 并列取 model 字符串较小者:claude-b 与 claude-a 等量 → claude-a', async () => {
  const D = dayAgo(1);
  const { body } = await run('a24-fav-tie', (home) => {
    writeJsonl(sessionFile(home, S1), [assistant({ ts: isoAt(D, 10), model: 'claude-b', u: STD }), assistant({ ts: isoAt(D, 10, 1), model: 'claude-a', u: STD })]);
  });
  expect(body.overview?.favoriteModel).toBe('claude-a');
});

test('A25 favoriteModel 按四项合计(含缓存读写)而不是 input+output:model-y(10+200) > model-x(100)', async () => {
  const D = dayAgo(1);
  const { body } = await run('a25-fav-four-sum', (home) => {
    writeJsonl(sessionFile(home, S1), [assistant({ ts: isoAt(D, 10), model: 'model-x', u: [100, 0, 0, 0] }), assistant({ ts: isoAt(D, 10, 1), model: 'model-y', u: [10, 0, 200, 0] })]);
  });
  expect(body.overview?.favoriteModel).toBe('model-y');
});

test('A27 类型:overview 九键齐全,数字全为非负整数,日期为 YYYY-MM-DD,peakHour 0–23,favoriteModel 为字符串', async () => {
  const D = dayAgo(1);
  const { body } = await run('a27-types', (home) => {
    writeJsonl(sessionFile(home, S1), [user({ ts: isoAt(D, 10) }), assistant({ ts: isoAt(D, 10, 1) }), assistant({ ts: undefined })]);
  });
  const ov = body.overview;
  expect(ov && typeof ov === 'object', 'overview 应是对象').toBeTruthy();
  expect(Object.keys(ov).sort()).toEqual([...OVERVIEW_KEYS].sort());
  const nonNeg = (v) => Number.isInteger(v) && v >= 0;
  for (const k of ['messages', 'activeDays', 'currentStreak', 'longestStreak']) expect(nonNeg(ov[k]), `${k}=${ov[k]} 应为非负整数`).toBe(true);
  expect(ov.hourCounts.every(nonNeg)).toBe(true);
  expect(ov.firstDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(ov.lastActiveDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(Number.isInteger(ov.peakHour) && ov.peakHour >= 0 && ov.peakHour <= 23).toBe(true);
  expect(typeof ov.favoriteModel).toBe('string');
  for (const r of body.byDay) for (const k of ['sessions', 'messages', 'calls']) expect(nonNeg(r[k]), `byDay[${r.day}].${k}=${r[k]}`).toBe(true);
});

test('A28 hourCounts 的合计 = 全部去重后的助手回复数(跨文件、含子代理)', async () => {
  const D = dayAgo(1);
  const { body } = await run('a28-hour-sum', (home) => {
    writeJsonl(sessionFile(home, S1), [assistant({ ts: isoAt(D, 10), id: 'msg_r130_same' }), assistant({ ts: isoAt(D, 11) })]);
    writeJsonl(sessionFile(home, S2), [assistant({ ts: isoAt(D, 10), id: 'msg_r130_same' })]);
    writeJsonl(subagentFile(home, S2, 'a'), [assistant({ ts: isoAt(D, 12) })]);
  });
  expect(body.overview?.hourCounts.reduce((a, b) => a + b, 0), '去重后 3 条').toBe(3);
  expect(body.overview?.messages).toBe(3);
});

test('A29 overview.messages 全历史 = 全部 user 消息 + Σ byModel[].calls(与 byDay 各行 messages 之和一致)', async () => {
  const { body } = await run('a29-messages-total', (home) => {
    writeJsonl(sessionFile(home, S1), [user({ ts: tsAgo(1, 9) }), assistant({ ts: tsAgo(1, 9, 1) }), user({ ts: tsAgo(40, 9) }), assistant({ ts: tsAgo(40, 9, 1) }), assistant({ ts: tsAgo(40, 9, 2) })]);
    writeJsonl(sessionFile(home, S3), [user({ ts: tsAgo(2, 9) })]);
  });
  const calls = body.byModel.reduce((a, m) => a + m.calls, 0);
  expect(calls).toBe(3);
  expect(body.overview?.messages).toBe(3 + 3);
  expect(body.byDay.reduce((a, r) => a + (r.messages || 0), 0)).toBe(6);
});
