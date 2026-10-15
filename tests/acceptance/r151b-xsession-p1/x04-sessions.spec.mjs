// 行为清单 4、17:目标列表接口与待处理汇总接口。都在一次性实例里跑(会话集合从零开始,结果可逐项比对)。
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { startInstance } from './helpers/instance.mjs';
import { seedSession, uniq, newSid } from './helpers/fixtures.mjs';
import { xs, expectError, ID_RE } from './helpers/api.mjs';

const sorted = (x) => (Array.isArray(x) ? [...x].sort() : x);
const ids = (r) => (r.body && Array.isArray(r.body.sessions) ? r.body.sessions.map((s) => s.sessionId) : r.text.slice(0, 300));

test('X04 GET /api/xsession/sessions:按最近活动倒序;无标题为"未命名会话";shortId 取前 8 位(冲突加长);exclude/query/ids/limit 生效;参数非法 → 400', async () => {
  const inst = await startInstance('x04');
  try {
    const api = xs(inst.c, inst.home);
    await api.on();
    const home = inst.home;
    const now = Date.now();
    const mark = uniq('Q4m');
    const s1 = seedSession(`x04-new-${mark}`, { home, title: `R151B 新 ${mark}`, mtime: new Date(now - 1_000) });
    const s2 = seedSession(`x04-mid-${mark}`, { home, title: 'R151B 中间', mtime: new Date(now - 3_600_000) });
    // 没改过名、也没有自动标题(不写 summary 行),只有首条提问:标题应取首条提问。
    // 既有会话列表不认少于 3 行的记录文件,所以给它两轮问答(4 行,时间都不晚于修改时间);
    // 第二条提问与首条不同、也不含 mark,标题若错取成它,标题断言会直接显出来。
    const s3Prompt = `R151B 未改名会话的首条提问 ${mark}`;
    const s3Reply = 'R151B 无标题会话的回复';
    const s3Mtime = new Date(now - 7_200_000);
    const s3Sid = newSid();
    const s3At = (ms) => new Date(s3Mtime.getTime() - ms).toISOString();
    const s3Asst = (n, parentUuid, timestamp, text) => ({ type: 'assistant', uuid: `${s3Sid}-a${n}`, parentUuid, timestamp, requestId: `req_${s3Sid.slice(0, 8)}_${n}`,
      message: { id: `msg_${s3Sid.slice(0, 8)}_${n}`, type: 'message', role: 'assistant', model: 'r151-chat', content: [{ type: 'text', text }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } } });
    const s3 = seedSession(`x04-untitled-${mark}`, { home, sid: s3Sid, title: null, firstPrompt: s3Prompt, reply: s3Reply, mtime: s3Mtime, lines: [
      { type: 'user', uuid: `${s3Sid}-u0`, parentUuid: null, timestamp: s3At(3000), message: { role: 'user', content: s3Prompt } },
      s3Asst(1, `${s3Sid}-u0`, s3At(2000), s3Reply),
      { type: 'user', uuid: `${s3Sid}-u2`, parentUuid: `${s3Sid}-a1`, timestamp: s3At(1000), message: { role: 'user', content: 'R151B 未改名会话的第二条提问' } },
      s3Asst(3, `${s3Sid}-u2`, s3At(0), 'R151B 无标题会话的第二条回复'),
    ] });
    const c1 = seedSession(`x04-c1-${mark}`, { home, sid: 'abcdef12-0000-4000-8000-000000000001', title: 'R151B 冲突一', mtime: new Date(now - 10_800_000) });
    const c2 = seedSession(`x04-c2-${mark}`, { home, sid: 'abcdef12-0000-4000-8000-000000000002', title: 'R151B 冲突二', mtime: new Date(now - 14_400_000) });

    const r = await api.sessions();
    expect(r.status, `状态码(${r.text.slice(0, 200)})`).toBe(200);
    expect(ids(r), '按最近活动倒序').toEqual([s1.sid, s2.sid, s3.sid, c1.sid, c2.sid]);
    const by = Object.fromEntries(r.body.sessions.map((s) => [s.sessionId, s]));
    const { lastActivity, ...rest } = by[s1.sid];
    expect(rest, '单项字段(一期没有 inbound / hasProfile)').toEqual({
      sessionId: s1.sid, shortId: s1.sid.slice(0, 8), title: `R151B 新 ${mark}`, project: path.basename(s1.cwd), state: 'stopped', pending: 0,
    });
    expect(Number.isNaN(Date.parse(lastActivity)) ? lastActivity : 'ISO', 'lastActivity 是时间字符串').toBe('ISO');
    expect(by[s3.sid].title, '没改过名、也没有自动标题 → 取首条提问').toBe(s3Prompt);
    for (const c of [c1, c2]) {
      const sh = by[c.sid].shortId;
      expect(c.sid.startsWith(sh) && sh.length > 8, `前 8 位冲突时加长(${c.sid} → ${sh})`).toBe(true);
    }
    expect(by[c1.sid].shortId, '加长后两者不冲突').not.toBe(by[c2.sid].shortId);

    expect(ids(await api.sessions(`?exclude=${s2.sid}`)), 'exclude 生效').toEqual([s1.sid, s3.sid, c1.sid, c2.sid]);
    expect(sorted(ids(await api.sessions(`?query=${encodeURIComponent(mark.toUpperCase())}`))), 'query 按标题或目录名做不区分大小写的子串过滤')
      .toEqual([s1.sid, s2.sid, s3.sid, c1.sid, c2.sid].sort());
    expect(ids(await api.sessions(`?query=${encodeURIComponent(`r151b 新 ${mark}`.toUpperCase())}`)), 'query 命中标题').toEqual([s1.sid]);
    expect(ids(await api.sessions(`?query=${encodeURIComponent(`X04-MID-${mark}`)}`)), 'query 命中目录名').toEqual([s2.sid]);
    expect(ids(await api.sessions('?limit=2')), 'limit').toEqual([s1.sid, s2.sid]);
    expect(sorted(ids(await api.sessions(`?ids=${s3.sid},${newSid()},${s1.sid}&query=zzzz-none&limit=1`))), 'ids 生效、不存在的跳过、query/limit 不起作用')
      .toEqual([s1.sid, s3.sid].sort());
    expect((await api.sessions(`?query=${encodeURIComponent('长'.repeat(100))}`)).status, 'query 恰好 100 字可以').toBe(200);
    expect((await api.sessions('?limit=100')).status, 'limit=100 可以').toBe(200);
    expect((await api.sessions(`?ids=${Array.from({ length: 50 }, () => newSid()).join(',')}`)).status, 'ids 恰好 50 个可以').toBe(200);

    const bad = [
      ['query 超 100 字', `?query=${encodeURIComponent('长'.repeat(101))}`], ['limit=0', '?limit=0'], ['limit=101', '?limit=101'],
      ['limit=1.5', '?limit=1.5'], ['limit=abc', '?limit=abc'], ['exclude 形状不对', '?exclude=not-a-session-id'],
      ['ids 含形状不对的', `?ids=${s1.sid},zzz`], ['ids 超 50 个', `?ids=${Array.from({ length: 51 }, () => newSid()).join(',')}`],
    ];
    for (const [label, qs] of bad) expectError(await api.sessions(qs), 400, 'XS_INVALID_INPUT', undefined, label);
  } finally { await inst.stop(); }
});

test('X17 GET /api/xsession/pending:只列有待处理的会话,total = 各项之和,不受会话列表 30 条上限影响;没有时 {total:0,sessions:[]}', async () => {
  const inst = await startInstance('x17');
  try {
    const api = xs(inst.c, inst.home);
    await api.on();
    const home = inst.home;
    const empty = await api.pending();
    expect(empty.status, `状态码(${empty.text.slice(0, 200)})`).toBe(200);
    expect(empty.body, '没有待处理时').toEqual({ total: 0, sessions: [] });

    const now = Date.now();
    const src = seedSession(`x17-src-${uniq('')}`, { home, mtime: new Date(now - 500) });
    const T = seedSession(`x17-oldest-${uniq('')}`, { home, mtime: new Date(now - 30 * 86_400_000) });
    const U = seedSession(`x17-u-${uniq('')}`, { home, mtime: new Date(now - 2_000) });
    for (let i = 0; i < 30; i += 1) seedSession(`x17-f${i}-${uniq('')}`, { home, mtime: new Date(now - 60_000 * (i + 1)) });
    const list = await api.sessions();
    expect(list.body && list.body.sessions.length, '前提:默认会话列表最多 30 项').toBe(30);
    expect(ids(list), '前提:最旧的会话 T 不在默认列表里').not.toContain(T.sid);

    await api.send(src.sid, [T.sid], 'R151B x17 一');
    await api.send(src.sid, [T.sid], 'R151B x17 二');
    await api.send(src.sid, [U.sid], 'R151B x17 三');
    const [mc] = await api.send(src.sid, [U.sid], 'R151B x17 认领后不算');
    expect(ID_RE.test(mc.id), '消息 id 形状').toBe(true);
    await api.claimOk(mc.id);

    const r = await api.pending();
    expect(r.status).toBe(200);
    const sort = (a) => [...a].sort((x, y) => x.sessionId.localeCompare(y.sessionId));
    expect(sort(r.body.sessions), '只列有待处理的会话,pending 只数 status=pending').toEqual(sort([
      { sessionId: T.sid, projectPath: T.cwd, pending: 2 }, { sessionId: U.sid, projectPath: U.cwd, pending: 1 },
    ]));
    expect(r.body.total, 'total = 各项之和').toBe(3);
    const both = await api.sessions(`?ids=${T.sid},${U.sid}`);
    expect(Object.fromEntries(both.body.sessions.map((s) => [s.sessionId, s.pending])), '与会话列表的 pending 同一口径')
      .toEqual({ [T.sid]: 2, [U.sid]: 1 });
  } finally { await inst.stop(); }
});
