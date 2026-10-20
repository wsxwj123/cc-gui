// 二期行为清单 7、15、16:模型工具 list_sessions / send_message 的返回、整次失败与单项失败、同一会话去重。
// 发送方是本机真 claude CLI(工作目录 ws/real-*,模型请求只到本地假接口),由假接口按脚本让"模型"调用工具;
// "模型看到的工具结果" = 下一次模型请求里这次调用的 tool_result 文字(假接口全文记录)。
import { test, expect } from '@playwright/test';
import { seedSession, uniq, makeWorkspace, realCliPath } from '../r151b-xsession-p1/helpers/fixtures.mjs';
import { xs, shared, cleanName, waitFor } from '../r151b-xsession-p1/helpers/api.mjs';
import { SM, LS, NOTE, SEND_NOTICE, ALL, laneReq, aiCalls, resultJson, entry, msgs, inboundOk, startInstanceP2, touchMock } from './helpers/p2.mjs';

test.describe.configure({ timeout: 360_000 });
test.beforeEach(() => { test.skip(!realCliPath(), '本机没有真 claude CLI'); });

test('P07 AI 调 list_sessions(非放任档)→ 不弹权限卡;返回 {self,sessions,truncated}:不含自己、按最近活动倒序、最多 30 项,name 按来源名规则清洗;query 过滤;query 超 100 字 → XS_INVALID_INPUT', async () => {
  const inst = await startInstanceP2('p07');
  try {
    const c = inst.c;
    expect((await c.put('/api/xsession/config', { enabled: true })).status, '前置:打开开关').toBe(200);
    const run = uniq('');
    const now = Date.now();
    for (let i = 0; i < 31; i += 1) seedSession(`p7-${i}-${run}`, { home: inst.home, title: `R151C p07 ${i} ${run}`, mtime: new Date(now - 60_000 * (i + 2)) });
    const dirty = seedSession(`p7-dirty-${run}`, { home: inst.home, title: `  R151C "引号"<尖>\t制表 ${run}  `, mtime: new Date(now - 30_000) });
    const cwd = makeWorkspace(`real-p07-${run}`);
    const r = await aiCalls(c, { cwd, mode: 'default', timeoutMs: 90_000, steps: [
      { name: LS, input: {} }, { name: LS, input: { query: 'R151C p07 1' } }, { name: LS, input: { query: '长'.repeat(101) } },
    ] });
    const all = resultJson(r, 0, 3);
    expect(r.results[0].is_error, '非放任档下调用成功、没有挂权限卡').toBe(false);
    const A = await entry(c, r.sid);
    const ref = (await c.get(`/api/xsession/sessions?exclude=${r.sid}&limit=30`)).body.sessions;
    expect(all && Object.keys(all).sort(), '返回的键').toEqual(['self', 'sessions', 'truncated']);
    expect(all.self.id, 'self.id = 自己的 shortId').toBe(A.shortId);
    expect.soft(all.self.name, 'self.name = 自己的标题(清洗后)').toBe(cleanName(A.title));
    expect(all.sessions.map((s) => s.id), '不含自己、按最近活动倒序、30 项(与会话列表同口径)').toEqual(ref.map((s) => s.shortId));
    expect(all.sessions.map((s) => s.id)).not.toContain(A.shortId);
    expect(all.truncated, '超过 30 个 → truncated:true').toBe(true);
    expect(all.sessions[0], '单项字段(inbound 没设置 → 默认 auto)').toEqual({ id: ref[0].shortId, name: cleanName(ref[0].title), project: ref[0].project, state: ref[0].state, inbound: 'auto' });
    const d = all.sessions.find((s) => s.id === (ref.find((x) => x.sessionId === dirty.sid) || {}).shortId);
    expect(d && d.name, '标题里的引号、尖括号、控制字符按来源名规则清洗').toBe(cleanName(dirty.title));
    const q = r.results[1].json;
    expect(q && q.sessions.map((s) => s.name).sort(), 'query 按标题过滤').toEqual([`R151C p07 1 ${run}`, ...Array.from({ length: 10 }, (_, i) => `R151C p07 1${i} ${run}`)].sort());
    expect(q.truncated).toBe(false);
    expect([r.results[2].is_error, r.results[2].json], 'query 超 100 字').toEqual([true, { error: 'XS_INVALID_INPUT', message: 'query 必须是不超过 100 字的字符串' }]);
  } finally { await inst.stop(); }
});

test('P15 send_message 整次失败(超 8 个目标 / 正文超 32768 字节 / 长度超限 / 类型不对 / 本回合将超 16 条 / 开关已关)一条不发;单项失败(不存在 / 重名 / 自己 / 满 50)不影响其它目标', async () => {
  const inst = await startInstanceP2('p15');
  try {
    const c = inst.c;
    const api = xs(c, inst.home);
    await api.on();
    const run = uniq('');
    const mk = (n, o = {}) => seedSession(`p15-${n}-${run}`, { home: inst.home, ...o });
    const T = Array.from({ length: 9 }, (_, i) => mk(`t${i}`));
    const B = mk('b'); const C = mk('c');
    const dup = `R151C 重名 ${run}`;
    const D1 = mk('d1', { title: dup }); const D2 = mk('d2', { title: dup });
    for (let i = 0; i < 50; i += 1) await api.send(null, [C.sid], `R151C p15 填满 ${i}`);
    const cwd = makeWorkspace(`real-p15-${run}`);
    const first = await aiCalls(c, { cwd, steps: [] });
    const A = first.sid;
    const off = `p15-off-${run}`;
    const ok = 'R151C p15 正文';
    const steps = [
      { name: SM, input: { to: T.map((t) => t.sid), message: ok } },
      { name: SM, input: { to: [B.sid], message: 'a'.repeat(32769) } },
      { name: SM, input: { to: [B.sid], message: 'b'.repeat(65537) } },
      { name: SM, input: { to: [B.sid, ...Array.from({ length: 32 }, (_, i) => `R151C 不存在 ${i}`)], message: ok } },
      { name: SM, input: { to: ['长'.repeat(257)], message: ok } },
      { name: SM, input: { to: [B.sid], message: ' \n\t　 ' } },
      { name: SM, input: { to: [], message: ok } },
      { name: SM, input: { to: [B.sid], message: 12345 } },
      { name: SM, input: { to: [B.sid, 'R151C 没有这个会话', A, dup, C.sid], message: ok } },
      { name: SM, input: { to: T.slice(0, 8).map((t) => t.sid), message: ok } },
      { name: SM, input: { to: T.slice(0, 8).map((t) => t.sid), message: ok } },
      { name: SM, input: { to: [B.sid], message: ok }, waitFile: off },
    ];
    const k0 = laneReq('real').flatMap((q) => q.toolResults).length;
    const p = aiCalls(c, { cwd, sid: A, steps, timeoutMs: 200_000 });
    const reached = await waitFor(() => laneReq('real').flatMap((q) => q.toolResults).length - k0 >= 11, 150_000, 300);
    await api.off();
    touchMock(off);
    const r = await p;
    expect(reached, '前置:前 11 次调用都已返回').toBeTruthy();
    const whole = (i, code, label) => {
      expect(r.results[i] && r.results[i].is_error, `${label}:整次失败 is_error`).toBe(true);
      expect(r.results[i].json && r.results[i].json.error, `${label}:错误码(原文:${r.results[i].text.slice(0, 200)})`).toBe(code);
      expect(typeof r.results[i].json.message === 'string' && r.results[i].json.message.length > 0, `${label}:message`).toBe(true);
    };
    expect(r.results.length, `应有 12 个工具结果(实际 ${r.results.length})`).toBe(12);
    whole(0, 'XS_TOO_MANY_TARGETS', '去重后 9 个目标');
    whole(1, 'XS_BODY_TOO_LARGE', '正文 32769 字节');
    whole(2, 'XS_INVALID_INPUT', 'message 超 65536 字');
    whole(3, 'XS_INVALID_INPUT', 'to 超 32 项');
    whole(4, 'XS_INVALID_INPUT', 'to 单项超 256 字');
    whole(5, 'XS_INVALID_INPUT', 'message 去空白为空');
    whole(6, 'XS_INVALID_INPUT', 'to 为空');
    expect(r.results[7].is_error, 'message 类型不对:is_error').toBe(true);
    expect(r.results[7].text, 'message 类型不对:SDK 的参数校验错误').toContain('MCP error -32602: Input validation error');
    const mixed = r.results[8].json;
    expect(r.results[8].is_error, '单项失败整次不算报错').toBe(false);
    expect(mixed.results.map((x) => [x.ok, x.error || null]), '逐项结果').toEqual([
      [true, null], [false, 'XS_TARGET_NOT_FOUND'], [false, 'XS_SELF_TARGET'], [false, 'XS_TARGET_AMBIGUOUS'], [false, 'XS_INBOX_FULL'],
    ]);
    expect(mixed.results[3].candidates.map((x) => x.id).sort(), '重名附 candidates').toEqual([D1.sid.slice(0, 8), D2.sid.slice(0, 8)].sort());
    expect(r.results[9].is_error, '8 个目标(本回合累计 9 条)照发').toBe(false);
    whole(10, 'XS_TURN_SEND_LIMIT', '本回合 9 + 8 > 16');
    whole(11, 'XS_DISABLED', '回合中途关开关');
    // 总开关关着时 GET /api/xsession/messages 回 409(数出来恒为 0,验不出东西)。关开关不删收件箱(只有关着时的 clear 才删),
    // 所以等这一回合全部调用结束后重新打开再数;每次计数都要求接口 200,不让 409 被当成"0 条"。
    await api.on();
    const count = async (s) => {
      const res = await c.get(`/api/xsession/messages?sessionId=${s.sid}&status=${encodeURIComponent(ALL)}`);
      expect(res.status, `计数前置:重新打开后 GET /api/xsession/messages(${s.sid})应 200(${res.text.slice(0, 160)})`).toBe(200);
      return res.body.messages.filter((m) => m.from && m.from.kind === 'session').length;
    };
    expect(await count(B), 'B 只收到单项失败那次的 1 条').toBe(1);
    for (const t of T.slice(0, 8)) expect(await count(t), '前 8 个目标各 1 条').toBe(1);
    expect(await count(T[8]), '第 9 个目标 0 条').toBe(0);
    expect([await count(D1), await count(D2), await count(C)], '重名的两个与满 50 的都没收到').toEqual([0, 0, 0]);
  } finally { await inst.stop(); }
});

test('P16 同一会话写两次(短 id / 去空白的标题 / 完整 id)只发一条,后者 note "与前面的目标是同一个会话，已合并";标题区分大小写、id 前缀不足 8 位不算 id', async () => {
  const api = xs();
  await api.on();
  const run = uniq('');
  const B = seedSession(`p16-b-${run}`, { title: `R151C p16 ${run}` });
  // r151k:入站默认已是自动处理;这里显式落 card,保留「发给等你确认的会话 → delivery:"card" / NOTE.card」这条覆盖。
  await inboundOk(shared, B.sid, 'card');
  const cwd = makeWorkspace(`real-p16-${run}`);
  const r = await aiCalls(shared, { cwd, steps: [
    { name: SM, input: { to: [B.sid.slice(0, 8), `  ${B.title}  `, B.sid, B.title.toUpperCase(), B.sid.slice(0, 7)], message: `R151C p16 ${run}` } },
  ] });
  const j = resultJson(r, 0, 1);
  expect(j && j.notice, 'notice 文案').toBe(SEND_NOTICE);
  expect(j.results[0], '第一项').toEqual({ to: B.sid.slice(0, 8), ok: true, id: (await entry(shared, B.sid)).shortId, name: B.title, delivery: 'card', note: NOTE.card });
  expect(j.results[1], '标题去首尾空白后命中同一会话 → 合并').toMatchObject({ ok: true, note: NOTE.merged });
  expect(j.results[2], '完整 id 命中同一会话 → 合并').toMatchObject({ ok: true, note: NOTE.merged });
  expect(j.results[3], '标题区分大小写').toMatchObject({ ok: false, error: 'XS_TARGET_NOT_FOUND' });
  expect(j.results[4], 'id 前缀不足 8 位不按 id 找').toMatchObject({ ok: false, error: 'XS_TARGET_NOT_FOUND' });
  const got = (await msgs(shared, B.sid)).filter((m) => m.from && m.from.kind === 'session');
  expect(got.length, 'B 只收到一条').toBe(1);
});
