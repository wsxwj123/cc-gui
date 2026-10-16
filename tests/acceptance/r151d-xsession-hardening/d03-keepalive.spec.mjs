// r151d 行为清单 3(对外行为变化 2):多个界面同步全局设置时,"会话常驻进程"取"最近一次发生变化的那个界面的值";
// 界面用相同的值定时重同步,不改变生效值。观测"目标进程是否常驻":自动处理回合结束后,
// 会话列表里该会话的 state(idle = 有空闲进程 / stopped = 没有进程)+ 进程列表(GET /api/processes)里还有没有它的进程。
// 每条用例一个一次性实例(界面同步记录从零开始)。目标 T = 假 CLI 会话,建档回合带 R151EXIT(建完档进程就退),
// 之后每条消息的自动处理都要按"此刻的设置"新起进程。发送方 = 真 CLI 会话(「放任」),模型请求只到本地假接口。
import { test, expect } from '@playwright/test';
import { seedSession, uniq, makeWorkspace, realCliPath } from '../r151b-xsession-p1/helpers/fixtures.mjs';
import { xs, waitFor } from '../r151b-xsession-p1/helpers/api.mjs';
import { inboundOk, profileTurn, startInstanceP2, msgs } from '../r151c-xsession-p2/helpers/p2.mjs';
import { settings, newUiId, syncUi, sendFrom, waitNewMsg, residency, waitResidency, RESIDENT, GONE, sleep } from './helpers/d.mjs';

test.describe.configure({ timeout: 300_000 });
test.beforeEach(() => { test.skip(!realCliPath(), '本机没有真 claude CLI(发送方要用真 CLI 调 send_message)'); });

async function setup(tag) {
  const inst = await startInstanceP2(tag);
  const c = inst.c;
  await xs(c, inst.home).on();
  const run = uniq('');
  const T = seedSession(`${tag}-t-${run}`, { home: inst.home });
  await profileTurn(c, T, 'bypassPermissions', 'R151EXIT');
  await inboundOk(c, T.sid, 'auto');
  const S = { cwd: makeWorkspace(`real-${tag}-${run}`) };
  return { inst, c, T, S, run };
}
/** 发一条消息给 T,等它被自动处理完(done / auto);返回这条消息。 */
async function autoTurn(c, S, T, text) {
  const known = new Set((await msgs(c, T.sid)).map((x) => x.id));
  const r = await sendFrom(c, S, T.sid, text);
  expect(r && r.delivery, `前置:「${text}」走自动处理(${JSON.stringify(r)})`).toBe('auto');
  const m = await waitNewMsg(c, T.sid, known);
  const done = await waitFor(async () => { const x = (await msgs(c, T.sid)).find((y) => y.id === (m && m.id)); return x && x.status === 'done' ? x : null; }, 30_000);
  expect(done, `前置:「${text}」被自动处理完`).toMatchObject({ status: 'done', via: 'auto' });
  return done;
}

test('D03 界面 A 同步 keepAlive:true、随后 B 同步 keepAlive:false → 自动处理回合后进程不常驻;A 原样重同步 → 仍不常驻;B 改为 true → 回合后进程常驻(进程列表可见、状态空闲)', async () => {
  const { inst, c, T, S, run } = await setup('d03');
  try {
    const A = newUiId('a'); const B = newUiId('b');
    const bodyA = settings(A, { keepAlive: true });
    await syncUi(c, bodyA, '界面 A 同步 keepAlive:true');
    await syncUi(c, settings(B, { keepAlive: false }), '界面 B 同步 keepAlive:false(其余键与 A 相同)');
    expect(await residency(c, T.sid), '前置:T 现在没有进程').toEqual(GONE);

    await autoTurn(c, S, T, `R151D d03 一 ${run}`);
    expect(await waitResidency(c, T.sid, GONE), 'B 最近改了 → keepAlive 生效值 false → 回合结束后目标进程不常驻').toEqual(GONE);

    await syncUi(c, bodyA, '界面 A 用与上次完全相同的请求体定时重同步');
    await autoTurn(c, S, T, `R151D d03 二 ${run}`);
    expect(await waitResidency(c, T.sid, GONE), 'A 的值没有变化 → 生效值仍是 B 的 false → 仍不常驻').toEqual(GONE);

    await syncUi(c, settings(B, { keepAlive: true }), '界面 B 改为 keepAlive:true');
    await autoTurn(c, S, T, `R151D d03 三 ${run}`);
    await sleep(2_500);
    expect(await residency(c, T.sid), 'B 最近改成 true → 回合结束后目标进程常驻:进程列表里仍可见、状态空闲').toEqual(RESIDENT);
  } finally { await inst.stop(); }
});

test('D03b "最近一次发生变化的那个界面"而不是"取最窄":A true / B false 之后 A 改 false、B 再改 true → 生效值是 B 的 true,回合后进程常驻', async () => {
  const { inst, c, T, S, run } = await setup('d03b');
  try {
    const A = newUiId('a'); const B = newUiId('b');
    await syncUi(c, settings(A, { keepAlive: true }), '界面 A 同步 keepAlive:true');
    await syncUi(c, settings(B, { keepAlive: false }), '界面 B 同步 keepAlive:false');
    await syncUi(c, settings(A, { keepAlive: false }), '界面 A 改为 keepAlive:false');
    await syncUi(c, settings(B, { keepAlive: true }), '界面 B 改为 keepAlive:true(两边里最近一次变化)');
    await autoTurn(c, S, T, `R151D d03b ${run}`);
    await sleep(2_500);
    expect(await residency(c, T.sid), '取最近一次变化的 B 的 true → 回合结束后目标进程常驻(若取最窄会是 false、不常驻)').toEqual(RESIDENT);
  } finally { await inst.stop(); }
});
