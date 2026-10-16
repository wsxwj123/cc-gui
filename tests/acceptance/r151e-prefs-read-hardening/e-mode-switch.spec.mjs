// r151e 行为清单 E(12–14):切档时会话进程 10 秒内没回应切档请求。
// "进程收到切档请求后一直不回应" = 本套件的假 claude 外壳 mute-claude.mjs:<CTL>/r151e-mute/<T> 里写着某个进程的 pid 时,
// 那个进程收到的 set_permission_mode 控制请求被吞掉(不回 control_response),其它输入照常;被吞的请求记进 r151e-muted.jsonl。
// 只"静音"测试点名的那个旧进程,之后新起的进程照常回应。
// 每条用例一个一次性实例。T = 假 CLI 会话,先跑一个回合,回合结束后进程常驻(进程列表里看得到)。
// 12、14 不涉及跨会话;13 的发送方 = 真 CLI 会话(「放任」),模型请求只到本地假接口。
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { seedSession, uniq, makeWorkspace, realCliPath } from '../r151b-xsession-p1/helpers/fixtures.mjs';
import { xs, waitFor, readStream, writeScript } from '../r151b-xsession-p1/helpers/api.mjs';
import { inboundOk, entry, startInstanceP2, msgs, wsT } from '../r151c-xsession-p2/helpers/p2.mjs';
import { sendFrom, waitNewMsg, permRequests, allowPerm } from '../r151d-xsession-hardening/helpers/d.mjs';
import { procPids, turnsOf, lastTurnPid, muteModeSwitch, mutedLog, switchMode, userTurn, sleep } from './helpers/e.mjs';

test.describe.configure({ timeout: 300_000 });

/** T 跑一个「放任」回合,回合结束后有一个存活的常驻进程。返回 { T, oldPid(这个进程的 pid) }。 */
async function residentT(inst, tag) {
  const T = seedSession(`${tag}-t-${uniq('')}`, { home: inst.home });
  const t = await userTurn(inst.c, T, { mode: 'bypassPermissions', note: '建立存活进程' });
  expect(t.status, `前置:T 跑一个回合(${String(t.text).slice(0, 200)})`).toBe(200);
  const oldPid = lastTurnPid(inst.ctl, T.sid);
  expect(oldPid, '前置:假 claude 记下了 T 这一回合的进程号').toBeTruthy();
  let pids = [];
  await waitFor(async () => { pids = await procPids(inst.c, T.sid); return pids.length === 1 && pids[0] === oldPid; }, 8_000, 200);
  expect(pids, `前置:进程列表里 T 恰有一个存活进程,就是跑这一回合的 ${oldPid}`).toEqual([oldPid]);
  return { T, oldPid };
}
const mutedSwitches = (inst, T, pid) => mutedLog(inst.ctl, T.sid).filter((x) => x.pid === pid && x.request && x.request.subtype === 'set_permission_mode');

test('E12a 切档请求没有回应:T 的存活进程收到切档请求一直不回应 → POST /api/chat/permission-mode {mode:"default"} 在 20 秒内回 409,不一直挂着', async () => {
  const inst = await startInstanceP2('e12a');
  try {
    const { T, oldPid } = await residentT(inst, 'e12a');
    muteModeSwitch(inst.ctl, T.sid, oldPid);
    const sw = await switchMode(inst.c, T.sid, 'default', 20_000);
    expect(mutedSwitches(inst, T, oldPid).length, `夹具生效:T 的进程 ${oldPid} 收到了切档请求、没有回应`).toBeGreaterThan(0);
    expect({ status: sw.status, within20s: sw.elapsed <= 20_000 }, `切档应答(原文:${String(sw.text).slice(0, 200)};用时 ${sw.elapsed}ms)`)
      .toEqual({ status: 409, within20s: true });
  } finally {
    await inst.stop();
  }
});

test('E12b 切档请求没有回应之后:给 T 发一条用户消息 → 由新进程处理(处理它的回合不是原进程跑的,进程列表里 T 的 pid 与原来不同)', async () => {
  const inst = await startInstanceP2('e12b');
  try {
    const { T, oldPid } = await residentT(inst, 'e12b');
    muteModeSwitch(inst.ctl, T.sid, oldPid);
    const sw = await switchMode(inst.c, T.sid, 'default', 25_000);
    expect(mutedSwitches(inst, T, oldPid).length, `夹具生效:T 的进程 ${oldPid} 收到了切档请求、没有回应`).toBeGreaterThan(0);
    // 切档没生效,界面回到原档位:下一条消息按原档位(「放任」)发
    const u = await userTurn(inst.c, T, { mode: 'bypassPermissions', note: '切档没回应之后的下一条', postMs: 30_000 });
    const turn = turnsOf(inst.ctl, T.sid).find((x) => String(x.text).includes(u.mark)) || null;
    let pids = [];
    await waitFor(async () => { pids = await procPids(inst.c, T.sid); return pids.length > 0 && !pids.includes(oldPid); }, 10_000, 250);
    expect({ chat: u.status, handled: Boolean(turn), byOldProcess: turn ? turn.pid === oldPid : null, oldListed: pids.includes(oldPid), listed: pids.length > 0 },
      `原进程 ${oldPid};切档应答 ${sw.status};处理这条消息的回合 ${JSON.stringify(turn)};进程列表里 T 的 pid ${JSON.stringify(pids)}`)
      .toEqual({ chat: 200, handled: true, byOldProcess: false, oldListed: false, listed: true });
  } finally {
    await inst.stop();
  }
});

test('E13 切档请求没有回应不卡住跨会话:「放任」、自动处理、有「放任」档案的 T,其存活进程吞掉切档请求;切到「逐步确认」→ 409;「放任」发送方发来的消息 60 秒内被自动处理(done、via:"auto")', async () => {
  test.skip(!realCliPath(), '本机没有真 claude CLI(发送方要用真 CLI 调 send_message)');
  const inst = await startInstanceP2('e13');
  try {
    await xs(inst.c, inst.home).on();
    const { T, oldPid } = await residentT(inst, 'e13');
    await inboundOk(inst.c, T.sid, 'auto');
    const e = await entry(inst.c, T.sid);
    expect(e && e.hasProfile, `前置:T 跑过「放任」回合,有发送档案(${JSON.stringify(e)})`).toBe(true);
    muteModeSwitch(inst.ctl, T.sid, oldPid);
    const S = { cwd: makeWorkspace(`real-e13-${uniq('')}`) };
    const known = new Set((await msgs(inst.c, T.sid)).map((x) => x.id));

    const switching = switchMode(inst.c, T.sid, 'default', 25_000);
    const muted = await waitFor(() => mutedSwitches(inst, T, oldPid)[0] || null, 8_000, 100);
    expect(muted, `夹具生效:T 的进程 ${oldPid} 收到了切档请求、没有回应`).toBeTruthy();
    const r = await sendFrom(inst.c, S, T.sid, `R151E e13 ${uniq('')}`);
    const m = await waitNewMsg(inst.c, T.sid, known);
    expect(m, `前置:消息进了 T 的收件列表(工具结果:${JSON.stringify(r)})`).toBeTruthy();
    let last = null;
    await waitFor(async () => { last = (await msgs(inst.c, T.sid)).find((x) => x.id === m.id) || null; return last && last.status === 'done'; }, 60_000, 500);
    const sw = await switching;
    expect({ switchStatus: sw.status, status: last && last.status, via: last && last.via },
      `切档应答原文:${String(sw.text).slice(0, 160)};这条消息最后的样子:${JSON.stringify(last)}`)
      .toEqual({ switchStatus: 409, status: 'done', via: 'auto' });
  } finally {
    await inst.stop();
  }
});

// "回合按哪个档位运行"的观测法同 r151d D02:回合里先请求 Edit(工作目录内)、再请求 Bash,看哪些要用户确认(事件流 permission:request)。
// 「接受编辑」= 只有 Bash 要确认;「放任」两个都不问;「逐步确认」两个都问。(假 claude 自己记下的档位不反映「接受编辑」,不用它判断。)
test('E14 进程正常回应切档(相邻回归):T 的存活进程照常回应 → 从「放任」切到「接受编辑」回 200;之后的回合按「接受编辑」运行(Edit 不用确认、Bash 要确认)', async () => {
  const inst = await startInstanceP2('e14');
  const ws = await wsT(inst.base);
  try {
    const { T } = await residentT(inst, 'e14');
    const sw = await switchMode(inst.c, T.sid, 'acceptEdits', 20_000);
    expect(sw.status, `切档应答(原文:${String(sw.text).slice(0, 200)};用时 ${sw.elapsed}ms)`).toBe(200);

    const run = uniq('');
    const editId = `toolu_e14_edit_${run}`; const bashId = `toolu_e14_bash_${run}`;
    writeScript(`e14m${run}`, [
      { canUseTool: { tool_name: 'Edit', tool_use_id: editId, input: { file_path: path.join(T.cwd, 'r151e.txt'), old_string: 'a', new_string: 'b' } } },
      { canUseTool: { tool_name: 'Bash', tool_use_id: bashId, input: { command: 'python3 -c "print(151)"' } } },
      { say: 'R151E e14 回合完' },
    ], inst.ctl);
    // 界面切档后发消息带的就是新档位;回合里出现的权限请求都替用户点"允许"(让回合跑完),同时记下哪些工具调用要了确认
    const chat = await inst.c.post('/api/chat', { sessionId: T.sid, cwd: T.cwd, prompt: `R151E e14 R151S:e14m${run}`, permissionMode: 'acceptEdits' });
    expect(chat.status, `前置:发出切档之后的第一条消息(${chat.text.slice(0, 200)})`).toBe(200);
    const answered = new Set();
    let reading = true;
    const stream = readStream(chat.body.pid, { timeoutMs: 60_000, base: inst.c.base }).finally(() => { reading = false; });
    while (reading) {
      for (const q of permRequests(ws, T.sid)) if (!answered.has(q.id)) { answered.add(q.id); await allowPerm(inst.c, q); }
      await sleep(150);
    }
    await stream;
    const asked = permRequests(ws, T.sid).map((q) => q.toolUseID).filter((id) => id === editId || id === bashId);
    expect(asked, '之后的回合按「接受编辑」:只有 Bash 要确认(「放任」两个都不问,「逐步确认」两个都问)').toEqual([bashId]);
  } finally {
    ws.close();
    await inst.stop();
  }
});
