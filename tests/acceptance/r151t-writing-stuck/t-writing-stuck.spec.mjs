// r151t 回合结束后命令行吐的信息事件不应让会话一直"在写" —— 验收。T01–T15 与 .devflow/r151t-writing-stuck-接口.md 行为清单 1–15 条一一对应
// (T10–T15 是修复前就应通过的相邻回归)。每条用例各起一次性实例(临时 HOME、自挑端口、用例自己 stop),全走假命令行(helpers/fx-cli.mjs),
// 只经 HTTP / SSE / WebSocket / 假命令行记录观察,断言写死修复后应有的行为,不识别代码是否已实现。
import { test, expect } from '@playwright/test';
import { startInstance, isAlive } from './helpers/inst.mjs';
import {
  sleep, sleepUntil, waitFor, wsOpen, newSession, start, waitIdle, sampleStatus, histogram, isText, isLife, isEv, IMMEDIATE_MS, TOL_MS,
} from './helpers/t.mjs';

test.describe.configure({ timeout: 120_000 });
const LIM = IMMEDIATE_MS + TOL_MS;   // "2 秒内"的判定线(含轮询误差)

/** 起实例 → 跑 fn(inst, track) → 无论成败都断开登记过的流 / 连接并 stop 实例(只停自己的 pid)。 */
async function withInst(tag, opts, fn) {
  const inst = await startInstance(tag, opts);
  const undo = [];
  try { await fn(inst, (x) => { undo.push(() => (x.abort ? x.abort() : x.close())); return x; }); } finally {
    for (const u of undo) { try { u(); } catch { /* 忽略 */ } }
    await inst.stop();
  }
}

const AGENT = (id, name = 'Agent') => ({ toolUse: { id, name, input: { description: 'T151 子代理', prompt: '等一会儿再返回', subagent_type: 'general-purpose' } } });
/** (甲):A-1 → [派子代理] → 等 holdA → 并入引导 → A-2 → result(→ completed)。 */
const mergeScript = (ses, { agentId = null, agentName, post, completedInPost } = {}) => ({
  steps: [{ say: 'A-1' }, ...(agentId ? [AGENT(agentId, agentName)] : []), { waitFile: ses.f('holdA') }, { mergeSteer: { say: 'A-merged' } }, { say: 'A-2' }],
  ...(post ? { post } : {}), ...(completedInPost ? { completedInPost: true } : {}),
});
/** (乙):第一回合 a(A-1 → 等 holdA → A-2),引导另起第二回合 b([等 gateB →] B-1 → 等 holdB → [B-2])。 */
function sepScripts(ses, { gate = true, endText = 'B-2' } = {}) {
  ses.script('a', { steps: [{ say: 'A-1' }, { waitFile: ses.f('holdA') }, { say: 'A-2' }] });
  ses.script('b', { steps: [...(gate ? [{ waitFile: ses.f('gateB') }] : []), { say: 'B-1' }, { waitFile: ses.f('holdB') }, ...(endText ? [{ say: endText }] : [])] });
}

/** 前置:回合进行中调引导接口,必须 200 且假命令行收到(吐出 queued)。 */
async function steerOk(ses, label, key) {
  const st = await ses.steer(label, key);
  expect({ status: st.status, body: st.body }, `前置:回合进行中调用引导接口应 200 并受理(${st.text})`).toMatchObject({ status: 200, body: { ok: true, accepted: true, duplicate: false } });
  const q = await ses.waitEmit(isLife('queued', st.uuid), 5_000);
  expect(q, `夹具生效:服务端把引导连同 uuid 推给了命令行(命令行 stdin 末尾:${JSON.stringify(ses.inst.stdinLines(ses.sid).slice(-2).map((x) => x.line.slice(0, 160)))})`).toBeTruthy();
  return st;
}
/** (乙)开场:发送 → 开流 S1 → 回合中调引导(带 b 脚本)→ 放行 holdA → 等假命令行另起第二回合(started)。 */
async function startSeparate(ses, track, label, opts) {
  sepScripts(ses, opts);
  const { s1 } = await start(ses, label, 'a');
  track(s1);
  const st = await steerOk(ses, `${label} 引导`, 'b');
  ses.release('holdA');
  const started = await ses.waitEmit(isLife('started', st.uuid), 8_000);
  expect(started, '夹具生效:第一回合 result 后假命令行另起了第二回合(started)').toBeTruthy();
  return { s1, st, started };
}

/** 流在 tFrom 之后 limit 毫秒内收到 {"type":"done"},且随后被服务端关闭(不靠客户端超时)。 */
async function expectDoneClosedBy(s, tFrom, what, limit = LIM) {
  const d = await s.waitDone(Math.max(0, tFrom + limit + 500 - Date.now()));
  expect(d, `${what}:应收到 {"type":"done"}(${limit}ms 内没等到;${s.summary()})`).toBeTruthy();
  expect(s.doneAt() - tFrom, `${what}:done 应在 ${limit}ms 内到达`).toBeLessThanOrEqual(limit);
  expect(await s.waitClosed(2_000), `${what}:收到 done 后服务端应关闭这条流(${s.summary()})`).toBe(true);
}
/** 会话在 tFrom 之后 limit 毫秒内稳定报 idle。 */
async function expectIdleBy(ses, tFrom, what, settleFrom = tFrom, limit = LIM) {
  const r = await waitIdle(ses, { settleFrom, by: tFrom + limit });
  expect(r.ok, `${what}:应在 ${limit}ms 内报 idle(最后一次采样 ${JSON.stringify(r.last)};${await ses.diag()})`).toBe(true);
}
const expect409 = (r, what) => expect({ status: r.status, ok: r.body && r.body.ok, code: r.body && r.body.code, hasError: Boolean(r.body && typeof r.body.error === 'string' && r.body.error) },
  `${what}:空闲时调引导接口应 409 / no-active-turn(应答原文:${String(r.text).slice(0, 240)})`).toEqual({ status: 409, ok: false, code: 'no-active-turn', hasError: true });

test('T01 引导按(甲)并入当前回合、无子代理:result 后 2 秒内报 idle,发送时开的流收到 done 并被关闭;之后命令行再无输出,6 秒内始终 idle', async () => {
  await withInst('t01', {}, async (inst, track) => {
    const ses = newSession(inst, 's1');
    ses.script('a', mergeScript(ses));
    const { s1 } = await start(ses, 'T01', 'a'); track(s1);
    const st = await steerOk(ses, 'T01 引导');
    ses.release('holdA');
    const res = await ses.waitResult(1, 10_000);
    const cmp = await ses.waitEmit(isLife('completed', st.uuid), 5_000);
    expect(res && cmp, `夹具生效:并入后只有一个 result,其后紧接着 completed(假命令行记录:${JSON.stringify(ses.emits().map((e) => `${e.ev}/${e.sub || ''}`))})`).toBeTruthy();
    expect(ses.results(), '并入(甲):整个过程只有一个 result').toHaveLength(1);
    await expectIdleBy(ses, res.t, 'result 之后', cmp.t + 200);
    await expectDoneClosedBy(s1, res.t, '发送时开的流');
    const n0 = ses.emits().length;
    const samples = await sampleStatus(ses, Date.now(), Date.now() + 6_000, 150);
    expect(samples.every((x) => x.s === 'idle'), `之后 6 秒内应始终 idle(采样分布 ${histogram(samples)})`).toBe(true);
    expect(ses.emits().length, '夹具:这 6 秒里命令行没有再吐任何东西').toBe(n0);
  });
});

test('T02 引导按(乙)另起一回合:第一回合 result 后会话重新报成在跑,接流收到第二回合正文,第二个 result 之后才收到 done;第二回合 completed 后 2 秒内报 idle', async () => {
  await withInst('t02', {}, async (inst, track) => {
    const ses = newSession(inst, 's2');
    await startSeparate(ses, track, 'T02');
    // 第二回合卡在 gateB:会话应一直报在跑(不是 idle)
    const during = await sampleStatus(ses, Date.now() + 300, Date.now() + 1_300, 100);
    expect(during.every((x) => x.s !== 'idle'), `第一回合 result 后会话应重新报成在跑(采样分布 ${histogram(during)})`).toBe(true);
    const s2 = track(ses.stream());
    expect(await s2.ready, '接流应 200').toBe(200);
    await sleep(600);
    expect(s2.doneEvent(), `第二回合还在进行,接上的流不应已收到 done(${s2.summary()})`).toBeNull();
    ses.release('gateB');
    expect(await s2.waitFor((e) => e.type === 'assistant' && JSON.stringify(e).includes('B-1'), 8_000), `接流应收到第二回合正文 B-1(${s2.summary()})`).toBeTruthy();
    ses.release('holdB');
    const r2 = await ses.waitResult(2, 8_000);
    const cmp = await ses.waitEmit((e) => isLife('completed')(e) && e.t >= (r2 ? r2.t : 0), 5_000);
    expect(r2 && cmp, `夹具生效:第二回合 result 之后吐出 completed(${JSON.stringify(ses.emits().map((e) => `${e.ev}/${e.sub || ''}`))})`).toBeTruthy();
    expect(s2.texts(), '接流应收到第二回合的全部正文').toEqual(expect.arrayContaining(['B-1', 'B-2']));
    await expectDoneClosedBy(s2, r2.t, '接上第二回合的流');
    expect(s2.doneAt(), `done 必须在第二个 result 之后(result 吐出于 ${r2.t},done 到达 ${s2.doneAt()})`).toBeGreaterThanOrEqual(r2.t);
    const types = s2.events.map((e) => e.type);
    expect(types.indexOf('done'), `流里 done 应排在 result 之后(事件顺序 ${JSON.stringify(types)})`).toBeGreaterThan(types.indexOf('result'));
    await expectIdleBy(ses, cmp.t, 'completed 之后', cmp.t + 200);
  });
});

test('T03 (甲)与(乙)结束后的空闲状态再调引导接口:HTTP 409,code=no-active-turn,且这条引导没被推给命令行', async () => {
  await withInst('t03', {}, async (inst, track) => {
    const a = newSession(inst, 's3a');   // 甲
    a.script('a', mergeScript(a));
    track((await start(a, 'T03甲', 'a')).s1);
    const sa = await steerOk(a, 'T03甲 引导');
    a.release('holdA');
    const ca = await a.waitEmit(isLife('completed', sa.uuid), 8_000);
    expect(ca, '夹具生效:(甲)completed 已吐出').toBeTruthy();
    await sleepUntil(ca.t + LIM);   // 结束后 2 秒是"应已空闲"的线,到线之后再调引导
    const ra = await a.steer('T03甲 空闲后的引导');
    expect409(ra, '(甲)结束后');
    expect(inst.stdinLines(a.sid).some((x) => x.line.includes(ra.uuid)), '(甲)被拒的引导不应被推给命令行').toBe(false);
    const b = newSession(inst, 's3b');   // 乙
    await startSeparate(b, track, 'T03乙', { gate: false });
    b.release('holdB');
    const r2 = await b.waitResult(2, 8_000);
    const cb = await b.waitEmit((e) => isLife('completed')(e) && b.results().length === 2, 5_000);
    expect(r2 && cb, '夹具生效:(乙)第二回合 result 与 completed 已吐出').toBeTruthy();
    await sleepUntil(cb.t + LIM);
    const rb = await b.steer('T03乙 空闲后的引导');
    expect409(rb, '(乙)结束后');
    expect(inst.stdinLines(b.sid).some((x) => x.line.includes(rb.uuid)), '(乙)被拒的引导不应被推给命令行').toBe(false);
  });
});

test('T04 (乙)第二回合进行中客户端断开流,第二回合结束且 completed 吐出后再开一条流(不带游标):2 秒内收到 done 并被服务端关闭', async () => {
  await withInst('t04', {}, async (inst, track) => {
    const ses = newSession(inst, 's4');
    const { s1 } = await startSeparate(ses, track, 'T04', { gate: false });
    s1.abort();   // 客户端主动断开(模拟切走)
    await sleep(300);
    ses.release('holdB');
    const r2 = await ses.waitResult(2, 8_000);
    const cmp = await ses.waitEmit((e) => isLife('completed')(e) && ses.results().length === 2, 5_000);
    expect(r2 && cmp, '夹具生效:第二回合 result 与 completed 都已吐出').toBeTruthy();
    await sleep(300);   // 让服务端读完这两行
    const tOpen = Date.now();
    const s3 = track(ses.stream());
    expect(await s3.ready, '再开流应 200').toBe(200);
    await expectDoneClosedBy(s3, tOpen, '第二回合结束后新开的流');
  });
});

test('T05 普通回合正常结束、发送时开的流已收到 done 之后,再开一条流(不带游标):2 秒内收到 done 并被服务端关闭', async () => {
  await withInst('t05', {}, async (inst, track) => {
    const ses = newSession(inst, 's5');
    ses.script('a', { steps: [{ say: 'A-1' }, { say: 'A-2' }] });
    const { s1 } = await start(ses, 'T05', 'a'); track(s1);
    const res = await ses.waitResult(1, 8_000);
    expect(res, '夹具生效:普通回合吐出了 result').toBeTruthy();
    expect(await s1.waitDone(5_000), `前置:发送时开的流应已收到 done(${s1.summary()})`).toBeTruthy();
    await sleep(300);
    const tOpen = Date.now();
    const s2 = track(ses.stream());
    expect(await s2.ready, '再开流应 200').toBe(200);
    await expectDoneClosedBy(s2, tOpen, '回合结束后新开的流');
  });
});

test('T06 CGUI_STALL_MS=3000,按第 1 条场景结束后再等 6 秒:任何流都不出现 stall_notice,假命令行进程仍活着;随后同会话 POST /api/chat 返回 reused:true,该回合正常收到 done', async () => {
  await withInst('t06', { envExtra: { CGUI_STALL_MS: '3000' } }, async (inst, track) => {
    const ses = newSession(inst, 's6');
    ses.script('a', mergeScript(ses));
    ses.script('r', { steps: [{ say: 'R-1' }] });
    const { s1 } = await start(ses, 'T06', 'a'); track(s1);
    const st = await steerOk(ses, 'T06 引导');
    ses.release('holdA');
    const cmp = await ses.waitEmit(isLife('completed', st.uuid), 8_000);
    expect(cmp, '夹具生效:并入后的 completed 已吐出').toBeTruthy();
    await sleep(500);
    const s2 = track(ses.stream());   // 结束后再接一条流
    await s2.ready;
    await sleepUntil(cmp.t + 6_000);
    const notices = [...s1.stallNotices(), ...s2.stallNotices()];
    expect(notices, `结束后 6 秒内任何流都不应出现 stall_notice(S1:${s1.summary()};S2:${s2.summary()})`).toHaveLength(0);
    const fpid = ses.fakePid();
    expect(isAlive(fpid), `假命令行进程 ${fpid} 应仍然活着(没被静默超时中止)`).toBe(true);
    const r = await ses.send('T06 同会话的下一条', 'r');
    expect({ status: r.status, reused: r.body && r.body.reused }, `同会话再发消息应复用常驻进程(应答原文:${String(r.text).slice(0, 240)})`).toEqual({ status: 200, reused: true });
    expect(inst.fakePids(ses.sid), '复用 = 没有新起过命令行进程').toEqual([fpid]);
    const s3 = track(ses.stream());
    const d = await s3.waitDone(8_000);
    expect(d, `复用的这个回合应正常收到 done(${s3.summary()})`).toBeTruthy();
    expect(await s3.waitClosed(3_000), `done 之后服务端应关闭这条流(${s3.summary()})`).toBe(true);
    expect(s3.texts(), '该回合应收到正文 R-1').toContain('R-1');
  });
});

test('T07 (乙)第二回合进行中调用停止接口,命令行随后吐 result 与 completed:2 秒内报 idle,流收到 done 并被关闭;再调引导 → 409', async () => {
  await withInst('t07', {}, async (inst, track) => {
    const ses = newSession(inst, 's7');
    const { s1 } = await startSeparate(ses, track, 'T07', { gate: false, endText: null });
    const stop = await ses.stop();
    expect(stop.status, `前置:第二回合进行中调用停止接口应 200(应答原文:${String(stop.text).slice(0, 240)})`).toBe(200);
    ses.release('holdB');   // 命令行随后收尾:result 与 completed
    const r2 = await ses.waitResult(2, 8_000);
    const cmp = await ses.waitEmit((e) => isLife('completed')(e) && ses.results().length === 2, 5_000);
    expect(r2 && cmp, `夹具生效:停止之后命令行吐出了第二个 result 与 completed(假命令行进程 ${ses.fakePid()} 活着:${isAlive(ses.fakePid())};记录 ${JSON.stringify(ses.emits().map((e) => `${e.ev}/${e.sub || ''}`))})`).toBeTruthy();
    await expectIdleBy(ses, cmp.t, '停止并收尾后', cmp.t + 200);
    await expectDoneClosedBy(s1, cmp.t, '停止后收尾的流');
    expect409(await ses.steer('T07 停止后的引导'), '停止并收尾后');
  });
});

test('T08 回合 result 之后命令行接连吐 tool_use_summary、auth_status、一条未知类型事件(无子代理):会话保持 idle,流收到 done 并被关闭,之后 3 秒内始终不报在跑', async () => {
  await withInst('t08', {}, async (inst, track) => {
    const ses = newSession(inst, 's8');
    ses.script('a', { steps: [{ say: 'A-1' }], post: [{ info: 'tool_use_summary' }, { sleep: 150 }, { info: 'auth_status' }, { sleep: 150 }, { emit: { type: 'x_unknown_event', note: 'T151 未知类型' } }] });
    const { s1 } = await start(ses, 'T08', 'a'); track(s1);
    const res = await ses.waitResult(1, 8_000);
    const last = await ses.waitEmit(isEv('x_unknown_event'), 5_000);
    expect(res && last, `夹具生效:result 之后依次吐出三种信息事件(${JSON.stringify(ses.emits().map((e) => e.ev))})`).toBeTruthy();
    await expectIdleBy(ses, res.t, '信息事件之后', last.t + 200);
    await expectDoneClosedBy(s1, res.t, '发送时开的流');
    const samples = await sampleStatus(ses, Date.now(), Math.max(Date.now() + 1_000, last.t + 3_000), 100);
    expect(samples.every((x) => x.s === 'idle'), `三种信息事件之后 3 秒内应始终 idle(采样分布 ${histogram(samples)})`).toBe(true);
  });
});

test('T09 每个回合结束都向 /ws 广播一次 turn-complete:(乙)另起的回合共两次;命令行自己续跑的回合结束时也收到一次', async () => {
  await withInst('t09', {}, async (inst, track) => {
    const ws = track(await wsOpen(inst.base));
    const x = newSession(inst, 's9x');   // (乙):两个回合
    await startSeparate(x, track, 'T09乙', { gate: false });
    await sleep(1_500);   // 第二回合持续一会儿,让"第一回合结束"与"第二回合结束"在时间上分得开
    x.release('holdB');
    const xr2 = await x.waitResult(2, 8_000);
    expect(xr2, '夹具生效:(乙)第二个 result 已吐出').toBeTruthy();
    const y = newSession(inst, 's9y');   // 自己续跑:两个回合
    y.script('a', { steps: [{ say: 'Y-1' }], follow: [{ sleep: 1000 }, { say: 'Y-C1' }, { sleep: 1200 }, { say: 'Y-C2' }] });
    track((await start(y, 'T09续跑', 'a', 'Y-1')).s1);
    const yr2 = await y.waitResult(2, 10_000);
    expect(yr2, '夹具生效:命令行自己续跑并吐出了第二个 result').toBeTruthy();
    await sleep(6_000);   // 留出广播到达的时间(修复前的单次广播在最后一个 result 后约 4 秒才来)
    const [xr1, yr1] = [x.results()[0], y.results()[0]];
    const xs = ws.ofType('turn-complete', x.sid); const ys = ws.ofType('turn-complete', y.sid);
    const all = JSON.stringify(ws.msgs.map((m) => `${m.t - xr1.t}:${m.m.type}:${m.m.sessionId === x.sid ? 'X' : m.m.sessionId === y.sid ? 'Y' : (m.m.sessionId || '')}`));
    expect(xs.length, `(乙)两个回合各广播一次 turn-complete,共 2 次(/ws 收到的全部消息,时刻相对 X 第一个 result:${all})`).toBe(2);
    expect(xs[0].t >= xr1.t && xs[0].t <= xr2.t, '(乙)第一次 turn-complete 应出现在第一个 result 之后、第二个 result 之前').toBe(true);
    expect(xs[1].t, '(乙)第二次 turn-complete 应在第二个 result 之后').toBeGreaterThanOrEqual(xr2.t);
    expect(ys.length, `命令行自己续跑:原回合与续跑回合各广播一次,共 2 次(/ws 收到的全部消息,时刻相对 X 第一个 result:${all})`).toBe(2);
    expect(ys[0].t >= yr1.t && ys[0].t <= yr2.t, '续跑:第一次应出现在原回合 result 之后、续跑 result 之前').toBe(true);
    expect(ys[1].t, '续跑:第二次应在续跑回合的 result 之后').toBeGreaterThanOrEqual(yr2.t);
  });
});

test('T10 (回归)不用引导的普通回合:结束后 idle,流收到 done 并被关闭;此时调引导 → 409', async () => {
  await withInst('t10', {}, async (inst, track) => {
    const ses = newSession(inst, 's10');
    ses.script('a', { steps: [{ say: 'A-1' }, { say: 'A-2' }] });
    const { s1 } = await start(ses, 'T10', 'a'); track(s1);
    const res = await ses.waitResult(1, 8_000);
    expect(res, '夹具生效:普通回合吐出了 result').toBeTruthy();
    // 接口文件对这一条没有时间要求(修复前普通回合 result 后约 4 秒才收尾),给 12 秒
    await expectIdleBy(ses, res.t, '普通回合结束后', res.t, 12_000);
    await expectDoneClosedBy(s1, res.t, '发送时开的流', 12_000);
    expect409(await ses.steer('T10 空闲后的引导'), '普通回合结束后');
  });
});

test('T11 (回归)命令行自己续跑:续跑期间不报 idle;报成在跑后接流收到续跑正文,只在续跑的 result 之后才收到 done;续跑结束后 idle', async () => {
  await withInst('t11', {}, async (inst, track) => {
    const ses = newSession(inst, 's11');
    ses.script('a', { steps: [{ say: 'A-1' }], follow: [{ sleep: 1000 }, { say: 'C-1' }, { sleep: 1500 }, { say: 'C-2' }, { sleep: 1500 }, { say: 'C-3' }] });
    track((await start(ses, 'T11', 'a')).s1);
    const c1 = await ses.waitEmit(isText('C-1'), 8_000);
    expect(c1, '夹具生效:命令行自己续跑吐出了 C-1').toBeTruthy();
    const up = await waitFor(async () => { const s = await ses.status(); return s && s !== 'idle' ? s : null; }, 3_000, 60);
    expect(up, `续跑开始后 agents/active 应报成在跑(${await ses.diag()})`).toBeTruthy();
    const s2 = track(ses.stream());   // 不带游标
    expect(await s2.ready, '接流应 200').toBe(200);
    const during = await sampleStatus(ses, Date.now(), c1.t + 2_800, 100);
    expect(during.every((x) => x.s !== 'idle'), `续跑期间不应报 idle(采样分布 ${histogram(during)})`).toBe(true);
    const r2 = await ses.waitResult(2, 8_000);
    expect(r2, '夹具生效:续跑吐出了自己的 result').toBeTruthy();
    // 接口文件对这一条没有时间要求(修复前 result 后约 4 秒才收尾),给 12 秒
    expect(await s2.waitDone(Math.max(0, r2.t + 12_000 - Date.now())), `续跑的 result 之后应收到 done(${s2.summary()})`).toBeTruthy();
    const iC3 = s2.events.findIndex((e) => e.type === 'assistant' && JSON.stringify(e).includes('C-3'));
    expect(s2.texts(), `接上的流应收到续跑正文(${s2.summary()})`).toEqual(expect.arrayContaining(['C-2', 'C-3']));
    expect(s2.events.findIndex((e) => e.type === 'done'), 'done 只能出现在续跑正文 C-3 之后').toBeGreaterThan(iC3);
    expect(s2.doneAt(), 'done 只能出现在续跑的 result 之后').toBeGreaterThanOrEqual(r2.t);
    expect(await s2.waitClosed(2_000), `done 之后服务端应关闭这条流(${s2.summary()})`).toBe(true);
    await expectIdleBy(ses, r2.t, '续跑结束后', r2.t, 12_000);
  });
});

test('T12 (回归)子代理回合中途引导按(甲)并入,result 后 1 秒内命令行吐 completed 与 tool_use_summary:流在 result 后 3.5–9 秒内收到 done 并被关闭,随后 idle', async () => {
  await withInst('t12', {}, async (inst, track) => {
    const ses = newSession(inst, 's12');
    ses.script('a', mergeScript(ses, { agentId: 'toolu_t12', agentName: 'Agent', completedInPost: true, post: [{ sleep: 400 }, { completed: true }, { sleep: 200 }, { info: 'tool_use_summary' }] }));
    const { s1 } = await start(ses, 'T12', 'a'); track(s1);
    expect(await ses.waitEmit((e) => e.toolUse === 'Agent', 5_000), '夹具生效:主 agent 派出了子代理(Agent 工具调用)').toBeTruthy();
    const st = await steerOk(ses, 'T12 引导');
    ses.release('holdA');
    const res = await ses.waitResult(1, 8_000);
    const cmp = await ses.waitEmit(isLife('completed', st.uuid), 5_000);
    const sum = await ses.waitEmit(isEv('tool_use_summary'), 5_000);
    expect(res && cmp && sum, `夹具生效:result 之后吐出该引导的 completed 与 tool_use_summary(${JSON.stringify(ses.emits().map((e) => `${e.ev}/${e.sub || ''}`))})`).toBeTruthy();
    expect(Math.max(cmp.t, sum.t) - res.t, '夹具:completed 与 tool_use_summary 都在 result 后 1 秒内').toBeLessThanOrEqual(1_000);
    const d = await s1.waitDone(Math.max(0, res.t + 9_500 - Date.now()));
    expect(d, `流应在 result 后 9 秒内收到 done(${s1.summary()})`).toBeTruthy();
    const delay = s1.doneAt() - res.t;
    expect(delay >= 3_500 && delay <= 9_000, `done 应在 result 后 3.5–9 秒内到达(实际 ${delay}ms)`).toBe(true);
    expect(await s1.waitClosed(2_000), `done 之后服务端应关闭这条流(${s1.summary()})`).toBe(true);
    await expectIdleBy(ses, s1.doneAt(), 'done 之后');
  });
});

test('T13 (回归)子代理回合,result 后 1 秒内主 agent 续跑吐 assistant(parent_tool_use_id 为空)再静默:这条 assistant 之后不足 3.5 秒时流里还没有 done;最终收到 done 并被关闭', async () => {
  await withInst('t13', {}, async (inst, track) => {
    const ses = newSession(inst, 's13');
    ses.script('a', { steps: [{ say: 'A-1' }, AGENT('toolu_t13', 'Task'), { say: 'A-2' }], post: [{ sleep: 900 }, { say: 'C-1' }] });
    const { s1 } = await start(ses, 'T13', 'a'); track(s1);
    const res = await ses.waitResult(1, 8_000);
    const c1 = await s1.waitFor((e) => e.type === 'assistant' && JSON.stringify(e).includes('C-1'), 8_000);
    expect(res && c1, `夹具生效:result 之后主 agent 续跑吐出 C-1,流里收到(${s1.summary()})`).toBeTruthy();
    expect(ses.find(isText('C-1')).t - res.t, '夹具:C-1 在 result 后 1 秒内').toBeLessThanOrEqual(1_000);
    const t1 = s1.stampOf(c1);
    await sleepUntil(t1 + 3_450);
    expect(s1.doneEvent(), `这条 assistant 之后不足 3.5 秒时流里还不应有 done(${s1.summary()})`).toBeNull();
    const d = await s1.waitDone(Math.max(0, t1 + 9_000 - Date.now()));
    expect(d, `最终应收到 done(${s1.summary()})`).toBeTruthy();
    expect(await s1.waitClosed(2_000), `done 之后服务端应关闭这条流(${s1.summary()})`).toBe(true);
  });
});

test('T14 (回归)回合 result 之后 4 秒窗内只有带非空 parent_tool_use_id 的消息(后台子代理)继续输出:不影响收尾,流在 result 后 9 秒内收到 done 并被关闭', async () => {
  await withInst('t14', {}, async (inst, track) => {
    const ses = newSession(inst, 's14');
    const sub = (t) => ({ sub: { parent: 'toolu_t14', say: t } });
    ses.script('a', { steps: [{ say: 'A-1' }, AGENT('toolu_t14', 'Agent'), { say: 'A-2' }], post: [{ sleep: 600 }, sub('S-1'), { sleep: 900 }, sub('S-2'), { sleep: 900 }, sub('S-3'), { sleep: 900 }, sub('S-4')] });
    const { s1 } = await start(ses, 'T14', 'a'); track(s1);
    const res = await ses.waitResult(1, 8_000);
    expect(res && await ses.waitEmit(isText('S-4'), 6_000), '夹具生效:result 之后 4 秒窗内子代理持续输出').toBeTruthy();
    const subs = ses.emits().filter((e) => /^S-\d$/.test(e.text || ''));
    expect(subs.map((e) => e.parent), '夹具:子代理消息的 parent_tool_use_id 都是派它的那个 tool_use 的 id').toEqual(Array(4).fill('toolu_t14'));
    const d = await s1.waitDone(Math.max(0, res.t + 9_500 - Date.now()));
    expect(d, `流应在 result 后 9 秒内收到 done(${s1.summary()})`).toBeTruthy();
    expect(s1.doneAt() - res.t, '流应在 result 后 9 秒内收到 done').toBeLessThanOrEqual(9_000);
    expect(await s1.waitClosed(2_000), `done 之后服务端应关闭这条流(${s1.summary()})`).toBe(true);
  });
});

test('T15 (回归)CGUI_STALL_MS=3000,result 之后命令行自己续跑吐一条 assistant 后静默:报成在跑后接流,约 3 秒(2–8 秒内)收到 stall_notice,随后收到 done 并被关闭', async () => {
  await withInst('t15', { envExtra: { CGUI_STALL_MS: '3000' } }, async (inst, track) => {
    const ses = newSession(inst, 's15');
    ses.script('a', { steps: [{ say: 'A-1' }], follow: [{ sleep: 1000 }, { say: 'C-1' }], followNoResult: true });
    track((await start(ses, 'T15', 'a')).s1);
    const c1 = await ses.waitEmit(isText('C-1'), 8_000);
    expect(c1, '夹具生效:命令行自己续跑吐出了 C-1').toBeTruthy();
    const up = await waitFor(async () => { const s = await ses.status(); return s && s !== 'idle' ? s : null; }, 3_000, 60);
    expect(up, `续跑开始后 agents/active 应报成在跑(${await ses.diag()})`).toBeTruthy();
    const s2 = track(ses.stream());   // 不带游标
    expect(await s2.ready, '接流应 200').toBe(200);
    const n = await s2.waitFor((e) => e.type === 'stall_notice', 10_000);
    expect(n, `续跑静默后应收到 stall_notice(${s2.summary()})`).toBeTruthy();
    const off = s2.stampOf(n) - c1.t;
    expect(off >= 2_000 && off <= 8_000, `stall_notice 应在续跑那条 assistant 之后约 3 秒(2–8 秒内)到达(实际 ${off}ms)`).toBe(true);
    expect(await s2.waitDone(8_000), `stall_notice 之后应收到 done(${s2.summary()})`).toBeTruthy();
    expect(await s2.waitClosed(2_000), `done 之后服务端应关闭这条流(${s2.summary()})`).toBe(true);
  });
});
