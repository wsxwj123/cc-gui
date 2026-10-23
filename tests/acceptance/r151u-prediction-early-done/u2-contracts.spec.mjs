// r151u 错误契约回归 —— U09–U12 对应 .devflow/r151u-prediction-early-done-接口.md「错误契约(本轮不改,回归要守住)」三条(引导接口两个分支各一条用例),
// 修复前就应通过。每条用例各起一次性实例,只走 HTTP 与假命令行记录;POST /api/chat 经 ses.send,显式带 promptSuggestions。
import { test, expect } from '@playwright/test';
import { newSession, start, waitIdle, isLife } from './helpers/t.mjs';
import { withInst } from './helpers/u.mjs';

test.describe.configure({ timeout: 120_000 });

test('U09 (回归)引导接口:有进行中的回合 → 200,应答 {ok:true, accepted:true, duplicate:false} 且带 pid,命令行收到这条引导', async () => {
  await withInst('u09', async (inst, track) => {
    const ses = newSession(inst, 'u09');
    ses.script('a', [{ say: 'A-1' }, { waitFile: ses.f('holdA') }, { say: 'A-2' }]);
    ses.script('b', [{ say: 'B-1' }]);
    const { s1 } = await start(ses, 'U09', 'a', false); track(s1);
    const st = await ses.steer('U09 引导', 'b');
    expect({ status: st.status, body: st.body }, `回合进行中调引导接口应 200 并受理(应答原文:${st.text})`).toMatchObject({ status: 200, body: { ok: true, accepted: true, duplicate: false } });
    expect(st.body.pid ?? null, `应答应带 pid(应答原文:${st.text})`).not.toBeNull();
    expect(await ses.waitEmit(isLife('queued', st.uuid), 5_000), '这条引导应被推给命令行(命令行吐出 queued)').toBeTruthy();
    ses.release('holdA');
  });
});

test('U10 (回归)引导接口:没有进行中的回合(普通回合已结束并 idle)→ 409,应答 {ok:false, code:"no-active-turn"},且这条引导没被推给命令行', async () => {
  await withInst('u10', async (inst, track) => {
    const ses = newSession(inst, 'u10');
    ses.script('a', [{ say: 'A-1' }]);
    const { s1 } = await start(ses, 'U10', 'a', false); track(s1);
    const res = await ses.waitResult(1, 8_000);
    expect(res, '夹具生效:普通回合吐出了 result').toBeTruthy();
    const idle = await waitIdle(ses, { settleFrom: res.t, by: res.t + 5_000 });
    expect(idle.ok, `前置:普通回合结束后应报 idle(${await ses.diag()})`).toBe(true);
    const r = await ses.steer('U10 空闲后的引导');
    expect({ status: r.status, ok: r.body && r.body.ok, code: r.body && r.body.code }, `空闲时调引导接口应 409 / no-active-turn(应答原文:${String(r.text).slice(0, 240)})`).toEqual({ status: 409, ok: false, code: 'no-active-turn' });
    expect(inst.stdinLines(ses.sid).some((x) => x.line.includes(r.uuid)), '被拒的引导不应被推给命令行').toBe(false);
  });
});

test('U11 (回归)流接口:GET /api/chat/:pid/stream 的 pid 不存在 → 404,响应体是 JSON', async () => {
  await withInst('u11', async (inst) => {
    const r = await fetch(`${inst.base}/api/chat/987654/stream`, { signal: AbortSignal.timeout(10_000) });
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = null; }
    expect(r.status, `不存在的 pid 应 404(响应原文:${text.slice(0, 240)})`).toBe(404);
    expect(r.headers.get('content-type') || '', '404 的响应应声明为 JSON').toContain('application/json');
    expect(body !== null && typeof body === 'object', `404 的响应体应是可解析的 JSON 对象(响应原文:${text.slice(0, 240)})`).toBe(true);
  });
});

test('U12 (回归)聊天接口:同会话第一次 POST /api/chat(新起进程)→ 200 且带 pid,响应里没有 reused 这个键', async () => {
  await withInst('u12', async (inst) => {
    const ses = newSession(inst, 'u12');
    ses.script('a', [{ say: 'A-1' }]);
    const r = await ses.send('U12', 'a', false);
    expect(r.status, `新起进程应 200(应答原文:${String(r.text).slice(0, 240)})`).toBe(200);
    expect(r.body && r.body.pid, `应答应带 pid(应答原文:${String(r.text).slice(0, 240)})`).toBeTruthy();
    expect(Object.prototype.hasOwnProperty.call(r.body, 'reused'), `新起进程时响应里不应带 reused 键(应答原文:${String(r.text).slice(0, 240)})`).toBe(false);
  });
});
