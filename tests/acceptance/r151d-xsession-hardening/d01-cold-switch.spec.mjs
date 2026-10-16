// r151d 行为清单 1、2:目标要关旧进程、新起进程才能自动处理时,在旧进程退出(新进程起来)之前切档 → 按切档后的档位重新判定。
// 每条用例一个一次性实例(全局设置从零开始)。发送方 = 真 CLI 会话(ws/real-*,模型请求只到本地假接口);
// 目标 T = 假 CLI 会话,它的进程由本套件的外壳 hold-claude.mjs 拉起:建了 <CTL>/r151d-hold/<T> 之后,
// T 的进程被要求退出时先不退、等放行(r151d-exit.jsonl 里记 exit-requested),测试就在这个窗口里切档,切完再放行。
// "旧进程是在全盘读取开着时起的":先让界面同步 globalRead:true,再让一条消息把 T 自动处理一次,这一回合的进程按"此刻的设置"起、回合后常驻。
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { seedSession, uniq, makeWorkspace, realCliPath } from '../r151b-xsession-p1/helpers/fixtures.mjs';
import { xs, waitFor, writeScript } from '../r151b-xsession-p1/helpers/api.mjs';
import { inboundOk, profileTurn, startInstanceP2, wsT, msgs } from '../r151c-xsession-p2/helpers/p2.mjs';
import {
  settings, newUiId, syncUi, setMode, holdExit, releaseExit, exitLog, sendFrom, waitNewMsg, waitSettled,
  residency, RESIDENT, permRequests, allowPerm, fromSession, sleep,
} from './helpers/d.mjs';

test.describe.configure({ timeout: 300_000 });
test.beforeEach(() => { test.skip(!realCliPath(), '本机没有真 claude CLI(发送方要用真 CLI 调 send_message)'); });
/** T 的工作目录(Edit 的目标文件放在它里面,「接受编辑」档只放行工作目录内的编辑)。 */
const tCwd = (run) => makeWorkspace(`d01-t-${run}`);
const editInput = (run) => ({ file_path: path.join(tCwd(run), 'r151d.txt'), old_string: 'a', new_string: 'b' });

/**
 * 摆好"T 自动处理、处于 mode 档、有一个全盘读取开着时起的空闲常驻进程,随后界面把全盘读取同步为关",并让 T 的旧进程推迟退出。
 * warmSteps:预热那条消息在 T 里跑的脚本(null = 默认回复)。返回 { c, T, S, ui }。
 */
async function stage(inst, run, mode, senderMode, warmSteps) {
  const c = inst.c;
  await xs(c, inst.home).on();
  const T = seedSession(`d01-t-${run}`, { home: inst.home, cwd: tCwd(run) });
  const ui = newUiId('a');
  await syncUi(c, settings(ui, { globalRead: true, keepAlive: true }), '前置:界面同步全盘读取=开、会话常驻进程=开');
  await profileTurn(c, T, mode, 'R151EXIT');
  await inboundOk(c, T.sid, 'auto');
  const S = { cwd: makeWorkspace(`real-d01-${run}`) };
  if (warmSteps) writeScript(`d01warm${run}`, warmSteps, inst.ctl);
  const warm = await sendFrom(c, S, T.sid, `R151D 预热 ${warmSteps ? `R151S:d01warm${run} ` : ''}${run}`, senderMode);
  expect(warm && warm.delivery, `前置:预热消息走自动处理(${JSON.stringify(warm)})`).toBe('auto');
  return { c, T, S, ui };
}

/** 等 T 的旧进程被要求退出(推迟中),且新消息已进收件列表;返回这条新消息。 */
async function waitWindow(c, ctl, T, known, tHold) {
  const asked = await waitFor(() => exitLog(ctl).find((e) => e.sid === T.sid && e.ev === 'exit-requested' && e.t >= tHold) || null, 30_000, 50);
  expect(asked, `前置:T 的旧进程被要求退出、正推迟退出(退出记录:${JSON.stringify(exitLog(ctl).slice(-4))})`).toBeTruthy();
  const m = await waitNewMsg(c, T.sid, known, 15_000);
  expect(m, '前置:新消息已进 T 的收件列表').toBeTruthy();
  expect(exitLog(ctl).some((e) => e.sid === T.sid && e.ev === 'exit' && e.t >= tHold), '前置:切档时 T 的旧进程还没退出').toBe(false);
  return m;
}

test('D01 冷启等待期间切到不同类别:「放任」目标在旧进程退出前切到「逐步确认」→ 这条消息 pending / class-mismatch,没有回合处理它;之后「放任」发送方再发一条也落 class-mismatch', async () => {
  const inst = await startInstanceP2('d01');
  const ws = await wsT(inst.base);
  const run = uniq('');
  let T = null;
  try {
    const st = await stage(inst, run, 'bypassPermissions', 'bypassPermissions', null);
    const { c, S } = st; T = st.T;
    const m0 = await waitFor(async () => (await msgs(c, T.sid)).find((x) => fromSession(x) && x.status === 'done') || null, 30_000);
    expect(m0, '前置:预热消息已自动处理完').toMatchObject({ status: 'done', via: 'auto' });
    await sleep(1_500);
    expect(await residency(c, T.sid), '前置:T 有一个空闲的常驻进程').toEqual(RESIDENT);

    const known = new Set((await msgs(c, T.sid)).map((x) => x.id));
    const tHold = Date.now();
    holdExit(inst.ctl, T.sid);
    await syncUi(c, settings(st.ui, { globalRead: false, keepAlive: true }), '前置:界面把全盘读取同步为关');
    const sending = sendFrom(c, S, T.sid, `R151D d01 第一条 ${run}`);
    const m1 = await waitWindow(c, inst.ctl, T, known, tHold);

    const sw = await setMode(c, T.sid, 'default');
    expect(sw.status, `旧进程退出前把 T 切到「逐步确认」→ 200(${sw.text.slice(0, 200)})`).toBe(200);
    releaseExit(inst.ctl, T.sid);
    await sending;

    const fin = await waitSettled(c, T.sid, m1.id);
    expect(fin && { status: fin.status, heldReason: fin.heldReason }, `第一条最终落卡片 class-mismatch(实际:${JSON.stringify(fin)})`)
      .toEqual({ status: 'pending', heldReason: 'class-mismatch' });
    await sleep(3_000);
    expect((await waitSettled(c, T.sid, m1.id)).status, '之后也没有被自动处理').toBe('pending');
    expect(ws.ofType('xs:turn').filter((e) => e.messageId === m1.id), '事件流里没有任何处理第一条的回合').toEqual([]);

    const known2 = new Set((await msgs(c, T.sid)).map((x) => x.id));
    const r2 = await sendFrom(c, S, T.sid, `R151D d01 第二条 ${run}`);
    const m2 = await waitNewMsg(c, T.sid, known2);
    expect(m2, '第二条进了 T 的收件列表').toBeTruthy();
    const fin2 = await waitSettled(c, T.sid, m2.id);
    expect([r2 && r2.delivery, fin2 && fin2.status, fin2 && fin2.heldReason], '之后「放任」发送方再发一条 → 同样落卡片 class-mismatch(不回到旧档位)')
      .toEqual(['card', 'pending', 'class-mismatch']);
    expect(ws.ofType('xs:turn').filter((e) => e.messageId === m2.id), '事件流里没有处理第二条的回合').toEqual([]);
  } finally {
    if (T) releaseExit(inst.ctl, T.sid);
    ws.close();
    await inst.stop();
  }
});

test('D02 冷启等待期间切到同类档位:「逐步确认」目标在旧进程退出前切到「接受编辑」→ 这条消息被自动处理(done、via:"auto"),处理它的回合按「接受编辑」档裁决权限', async () => {
  const inst = await startInstanceP2('d02');
  const ws = await wsT(inst.base);
  const run = uniq('');
  let T = null;
  const answered = new Set();
  // 回合里出现的权限请求都替用户点"允许"(让回合能跑完),同时记下是哪些工具调用要了确认
  const answerAll = async (c, sid) => { for (const q of permRequests(ws, sid)) if (!answered.has(q.id)) { answered.add(q.id); await allowPerm(c, q); } };
  try {
    // 预热回合里请求一次 Edit:「逐步确认」档下应要确认(用来证明"Edit 不用确认"确实说明档位变了)
    const e0 = `toolu_d02_e0_${run}`;
    const st = await stage(inst, run, 'default', 'default', [{ canUseTool: { tool_name: 'Edit', tool_use_id: e0, input: editInput(run) } }, { say: 'R151D d02 预热完' }]);
    const { c, S } = st; T = st.T;
    const asked0 = await waitFor(() => permRequests(ws, T.sid).find((q) => q.toolUseID === e0) || null, 30_000);
    expect(asked0, '前置:「逐步确认」档的回合里 Edit 要确认(事件流出现 permission:request)').toBeTruthy();
    await answerAll(c, T.sid);
    const m0 = await waitFor(async () => (await msgs(c, T.sid)).find((x) => fromSession(x) && x.status === 'done') || null, 30_000);
    expect(m0, '前置:预热消息已自动处理完').toMatchObject({ status: 'done', via: 'auto' });
    await sleep(1_500);
    expect(await residency(c, T.sid), '前置:T 有一个空闲的常驻进程').toEqual(RESIDENT);

    const e1 = `toolu_d02_e1_${run}`; const b1 = `toolu_d02_b1_${run}`;
    writeScript(`d02m1${run}`, [
      { canUseTool: { tool_name: 'Edit', tool_use_id: e1, input: editInput(run) } },
      { canUseTool: { tool_name: 'Bash', tool_use_id: b1, input: { command: 'python3 -c "print(151)"' } } },
      { say: 'R151D d02 第一条处理完' },
    ], inst.ctl);
    const known = new Set((await msgs(c, T.sid)).map((x) => x.id));
    const tHold = Date.now();
    holdExit(inst.ctl, T.sid);
    await syncUi(c, settings(st.ui, { globalRead: false, keepAlive: true }), '前置:界面把全盘读取同步为关');
    const sending = sendFrom(c, S, T.sid, `R151D d02 第一条 R151S:d02m1${run} ${run}`, 'default');
    const m1 = await waitWindow(c, inst.ctl, T, known, tHold);

    const sw = await setMode(c, T.sid, 'acceptEdits');
    expect(sw.status, `旧进程退出前把 T 切到「接受编辑」→ 200(${sw.text.slice(0, 200)})`).toBe(200);
    releaseExit(inst.ctl, T.sid);
    await sending;

    let fin = null;
    await waitFor(async () => { await answerAll(c, T.sid); fin = await waitSettled(c, T.sid, m1.id, 1); return fin && ['done', 'pending'].includes(fin.status); }, 60_000, 200);
    expect(fin && { status: fin.status, via: fin.via }, `第一条被自动处理(实际:${JSON.stringify(fin)})`).toEqual({ status: 'done', via: 'auto' });
    const turns = ws.ofType('xs:turn').filter((e) => e.messageId === m1.id);
    expect(turns.length, '事件流里恰有一个处理第一条的回合').toBe(1);
    const asked = permRequests(ws, T.sid).map((q) => q.toolUseID).filter((id) => id === e1 || id === b1);
    expect(asked, '处理它的回合按「接受编辑」档:Edit 不用确认、Bash 要确认(「逐步确认」会两个都问,「放任」两个都不问)').toEqual([b1]);
  } finally {
    if (T) releaseExit(inst.ctl, T.sid);
    ws.close();
    await inst.stop();
  }
});
