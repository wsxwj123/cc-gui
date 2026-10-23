// r151u 收尾等待窗内接着开始的回合不应被提前收尾 —— 验收。U01–U08 与 .devflow/r151u-prediction-early-done-接口.md 行为清单 1–8 条一一对应
// (U05–U08 是修复前就应通过的相邻回归)。每条用例各起一次性实例(临时 HOME、自挑端口、用例自己 stop),全走假命令行(helpers/fx-cli.mjs),
// 只经 HTTP / SSE / 假命令行记录观察,断言写死修复后应有的行为,不识别代码是否已实现。每次 POST /api/chat 都显式带 promptSuggestions(ses.send 强制)。
import { test, expect } from '@playwright/test';
import { sleep, sleepUntil, waitFor, newSession, start, waitIdle, isText, isEv } from './helpers/t.mjs';
import {
  LIM, NORMAL_WIN, SUB_WIN, withInst, PS, AGENT, startSeparate, sampleUntilResult, expectNotIdleDuring,
  expectNoDoneBefore, expectTexts, expectDoneWithin, expectIdleBy,
} from './helpers/u.mjs';

test.describe.configure({ timeout: 120_000 });
const kinds = (ses) => JSON.stringify(ses.emits().map((e) => `${e.ev}/${e.sub || ''}`));
const firstTurn = (ses, ...mid) => [{ say: 'A-1' }, ...mid, { waitFile: ses.f('holdA') }, { say: 'A-2' }];   // 第一回合:A-1 →(派子代理)→ 等 holdA → A-2
const suggestions = (ses) => ses.emits().filter(isEv('prompt_suggestion'));

test('U01 开预测、无子代理,(乙)第二回合 started 后静默 6 秒:期间不报 idle;约 5 秒时客户端先断开发送时开的流(断开前没收到 done)、再接一条不带游标的新流;新流在第二个 result 前没收到 done、收到 B-1/B-2;result 后 3.5–6 秒新流收到 done 并被关闭,随后 2 秒内 idle', async () => {
  await withInst('u01', async (inst, track) => {
    const ses = newSession(inst, 'u01');
    const { s1, started } = await startSeparate(ses, track, 'U01', true, firstTurn(ses), { steps: [{ sleep: 6_000 }, { say: 'B-1' }, { say: 'B-2' }] });
    const sampling = sampleUntilResult(ses, 2, started.t, started.t + 20_000);
    await sleepUntil(started.t + 5_000);
    // started 后约 5 秒(静默期间):同一会话同时只认一条流,所以先由客户端断开发送时开的流、再接新流(等同界面上切走再切回);任何时刻都没有两条流同时连着
    const s1DoneBeforeAbort = s1.doneEvent();   // 断开前一刻,发送时开的流是否已收到 done
    s1.abort();
    await Promise.race([s1.run, sleep(1_000)]);   // 等客户端这一侧确实断干净了再接新流
    const s2 = track(ses.stream());   // 不带游标的新流
    expect.soft(await s2.ready, '切回时接新流应 200').toBe(200);
    const samples = await sampling;
    const r2 = ses.results()[1];
    expect(r2, `夹具生效:第二回合吐出了自己的 result(${kinds(ses)})`).toBeTruthy();
    expectNotIdleDuring(samples, started.t, r2.t, 'started 到第二个 result 之间');
    expect.soft(s1DoneBeforeAbort, `发送时开的流:被客户端断开之前不应收到 done(${s1.summary()})`).toBeNull();
    expectNoDoneBefore(s2, r2.t, '切回后接的新流');
    await expectDoneWithin(s2, r2.t, ...NORMAL_WIN, '切回后接的新流');
    expectTexts(s2, ['B-1', 'B-2'], '切回后接的新流');
    await expectIdleBy(ses, Math.max(r2.t, s2.doneAt() || 0), '新流收到 done 之后');
  });
});

test('U02 开预测、无子代理,(乙)第二回合 started 后立刻吐 prompt_suggestion、1 秒后吐 B-1/B-2/result、再 1 秒吐第二条 prompt_suggestion:第二个 result 前流没收到 done、收到 B-1/B-2;第二条 prompt_suggestion 后 2 秒内收到 done 并被关闭', async () => {
  await withInst('u02', async (inst, track) => {
    const ses = newSession(inst, 'u02');
    const { s1, started } = await startSeparate(ses, track, 'U02', true, firstTurn(ses), {
      steps: [PS('U02-S1'), { sleep: 1_000 }, { say: 'B-1' }, { say: 'B-2' }], post: [{ sleep: 1_000 }, PS('U02-S2')],
    });
    const r2 = await ses.waitResult(2, 8_000);
    const ps2 = await waitFor(() => suggestions(ses)[1] || null, 8_000, 30);
    expect(r2 && ps2, `夹具生效:第二回合吐出 result,其后吐出第二条 prompt_suggestion(${kinds(ses)})`).toBeTruthy();
    const ps1 = suggestions(ses)[0];
    expect(ps1.t >= started.t && ps1.t < r2.t && ps2.t > r2.t, `夹具:第一条 prompt_suggestion 在 started 之后、result 之前,第二条在 result 之后(started ${started.t},ps1 ${ps1.t},result ${r2.t},ps2 ${ps2.t})`).toBe(true);
    expectNoDoneBefore(s1, r2.t, '发送时开的流');
    await expectDoneWithin(s1, ps2.t, 0, LIM, '发送时开的流(基准 = 第二条 prompt_suggestion 吐出)');
    expectTexts(s1, ['B-1', 'B-2'], '发送时开的流');
  });
});

test('U03 开预测、无子代理,命令行自己续跑:A-1 → result → 0.5 秒 C-1 → 0.5 秒 prompt_suggestion → 1 秒 C-2 → 续跑 result:续跑 result 前流没收到 done、收到 C-1/C-2;续跑 result 后 3.5–6 秒收到 done 并被关闭,随后 idle', async () => {
  await withInst('u03', async (inst, track) => {
    const ses = newSession(inst, 'u03');
    ses.script('a', { steps: [{ say: 'A-1' }], follow: [{ sleep: 500 }, { say: 'C-1' }, { sleep: 500 }, PS('U03-S'), { sleep: 1_000 }, { say: 'C-2' }] });
    const { s1 } = await start(ses, 'U03', 'a', true); track(s1);
    const r2 = await ses.waitResult(2, 10_000);
    expect(r2, `夹具生效:续跑吐出了自己的 result(${kinds(ses)})`).toBeTruthy();
    const c1 = ses.find(isText('C-1')); const c2 = ses.find(isText('C-2')); const ps = suggestions(ses);
    expect(c1 && c2 && ps.length === 1 && c1.t < ps[0].t && ps[0].t < c2.t && c2.t <= r2.t, `夹具:C-1 → prompt_suggestion(仅一条)→ C-2 → 续跑 result(${kinds(ses)})`).toBe(true);
    expectNoDoneBefore(s1, r2.t, '发送时开的流(基准 = 续跑的 result)');
    expectTexts(s1, ['C-1', 'C-2'], '发送时开的流');
    await expectDoneWithin(s1, r2.t, ...NORMAL_WIN, '发送时开的流');
    await expectIdleBy(ses, Math.max(r2.t, s1.doneAt() || 0), '续跑收尾 done 之后');
  });
});

test('U04 关预测、子代理回合,(乙)第二回合 started 后静默 6 秒:期间不报 idle;发送时开的流在第二个 result 前没收到 done、收到 B-1;result 后 3.5–9 秒收到 done 并被关闭', async () => {
  await withInst('u04', async (inst, track) => {
    const ses = newSession(inst, 'u04');
    const { s1, started } = await startSeparate(ses, track, 'U04', false, firstTurn(ses, AGENT('toolu_u04')), { steps: [{ sleep: 6_000 }, { say: 'B-1' }] });
    expect(ses.find((e) => e.toolUse === 'Agent'), '夹具生效:第一回合主 agent 派了子代理(Agent 工具调用)').toBeTruthy();
    const samples = await sampleUntilResult(ses, 2, started.t, started.t + 20_000);
    const r2 = ses.results()[1];
    expect(r2, `夹具生效:第二回合吐出了自己的 result(${kinds(ses)})`).toBeTruthy();
    expectNotIdleDuring(samples, started.t, r2.t, 'started 到第二个 result 之间');
    expectNoDoneBefore(s1, r2.t, '发送时开的流');
    expectTexts(s1, ['B-1'], '发送时开的流');
    await expectDoneWithin(s1, r2.t, ...SUB_WIN, '发送时开的流');
  });
});

test('U05 (回归)开预测、无子代理的普通回合,result 后 1 秒命令行吐 prompt_suggestion:流在 done 之前收到它;它吐出后 2 秒内收到 done 并被关闭,随后 2 秒内 idle', async () => {
  await withInst('u05', async (inst, track) => {
    const ses = newSession(inst, 'u05');
    ses.script('a', { steps: [{ say: 'A-1' }], post: [{ sleep: 1_000 }, PS('U05-S')] });
    const { s1 } = await start(ses, 'U05', 'a', true); track(s1);
    const res = await ses.waitResult(1, 8_000);
    const ps = await ses.waitEmit(isEv('prompt_suggestion'), 5_000);
    expect(res && ps && ps.t - res.t >= 900, `夹具生效:result 之后约 1 秒吐出 prompt_suggestion(${kinds(ses)})`).toBeTruthy();
    await expectDoneWithin(s1, ps.t, 0, LIM, '发送时开的流(基准 = prompt_suggestion 吐出)');
    const iPs = s1.events.findIndex((e) => e && e.type === 'prompt_suggestion' && JSON.stringify(e).includes('U05-S'));
    const iDone = s1.events.findIndex((e) => e && e.type === 'done');
    expect.soft(iPs >= 0 && iDone > iPs, `流应在 done 之前收到这条 prompt_suggestion(prompt_suggestion 下标 ${iPs},done 下标 ${iDone};${s1.summary()})`).toBe(true);
    await expectIdleBy(ses, s1.doneAt() || ps.t, 'done 之后');
  });
});

test('U06 (回归)开预测、无子代理的普通回合,命令行不吐 prompt_suggestion:result 后 3.5–6 秒流收到 done 并被关闭,随后 2 秒内 idle', async () => {
  await withInst('u06', async (inst, track) => {
    const ses = newSession(inst, 'u06');
    ses.script('a', { steps: [{ say: 'A-1' }] });
    const { s1 } = await start(ses, 'U06', 'a', true); track(s1);
    const res = await ses.waitResult(1, 8_000);
    expect(res, `夹具生效:吐出了 result(${kinds(ses)})`).toBeTruthy();
    await expectDoneWithin(s1, res.t, ...NORMAL_WIN, '发送时开的流');
    expect(suggestions(ses), '夹具:命令行全程没吐 prompt_suggestion').toHaveLength(0);
    await expectIdleBy(ses, s1.doneAt() || res.t, 'done 之后');
  });
});

test('U07 (回归)开预测、子代理回合(主 agent 派过子代理),result 后 1 秒命令行吐 prompt_suggestion:它吐出后 2 秒内流收到 done 并被关闭(不等满约 4 秒)', async () => {
  await withInst('u07', async (inst, track) => {
    const ses = newSession(inst, 'u07');
    ses.script('a', { steps: [{ say: 'A-1' }, AGENT('toolu_u07'), { say: 'A-2' }], post: [{ sleep: 1_000 }, PS('U07-S')] });
    const { s1 } = await start(ses, 'U07', 'a', true); track(s1);
    const res = await ses.waitResult(1, 8_000);
    const ps = await ses.waitEmit(isEv('prompt_suggestion'), 5_000);
    expect(res && ps && ses.find((e) => e.toolUse === 'Agent') && ps.t - res.t >= 900, `夹具生效:派过子代理,result 之后约 1 秒吐出 prompt_suggestion(${kinds(ses)})`).toBeTruthy();
    await expectDoneWithin(s1, ps.t, 0, LIM, '发送时开的流(基准 = prompt_suggestion 吐出)');
  });
});

test('U08 (回归)关预测,第一回合进行中断开流、结束并 idle 后同会话再发(reused:true):第二回合先等放行文件再吐 R-1 与 result,应答后立即接的流先收到 R-1、之后才收到 done(不在一接上就到),done 后被关闭', async () => {
  await withInst('u08', async (inst, track) => {
    const ses = newSession(inst, 'u08');
    ses.script('a', { steps: firstTurn(ses) });
    ses.script('r', { steps: [{ waitFile: ses.f('holdR') }, { say: 'R-1' }] });
    const { s1 } = await start(ses, 'U08', 'a', false);
    s1.abort();   // 第一回合进行中客户端断开发送时开的流:第一回合结束时没有流连着
    await sleep(300);
    ses.release('holdA');
    const res1 = await ses.waitResult(1, 8_000);
    expect(res1, `夹具生效:第一回合吐出了 result(${kinds(ses)})`).toBeTruthy();
    const idle = await waitIdle(ses, { settleFrom: res1.t, by: res1.t + 5_000 });
    expect(idle.ok, `前置:第一回合结束后应报 idle(${await ses.diag()})`).toBe(true);
    const r = await ses.send('U08 同会话下一条', 'r', false);
    expect({ status: r.status, reused: r.body && r.body.reused }, `同会话再发消息应复用常驻进程(应答原文:${String(r.text).slice(0, 240)})`).toEqual({ status: 200, reused: true });
    const s2 = track(ses.stream());   // 应答返回后立即接,不带游标;命令行还卡在放行文件上
    expect(await s2.ready, '接流应 200').toBe(200);
    await sleep(600);
    expect(s2.doneEvent(), `刚接上、第二回合还没放行,不应已收到 done(${s2.summary()})`).toBeNull();
    ses.release('holdR');
    const isR1 = (e) => e && e.type === 'assistant' && JSON.stringify(e).includes('R-1');
    expect(await s2.waitFor(isR1, 8_000), `流应收到 R-1(${s2.summary()})`).toBeTruthy();
    expect(await s2.waitDone(8_000), `R-1 之后流应收到 done(${s2.summary()})`).toBeTruthy();
    const r2 = ses.results()[1];
    expect(r2, `夹具生效:第二回合吐出了 result(${kinds(ses)})`).toBeTruthy();
    expect(s2.events.findIndex((e) => e && e.type === 'done'), `done 必须排在 R-1 之后(${s2.summary()})`).toBeGreaterThan(s2.events.findIndex(isR1));
    expect(s2.doneAt(), `done 不应早于第二回合的 result(result 吐出于 ${r2.t},done 到达 ${s2.doneAt()})`).toBeGreaterThanOrEqual(r2.t);
    expect(await s2.waitClosed(2_000), `收到 done 后服务端应关闭这条流(${s2.summary()})`).toBe(true);
  });
});
