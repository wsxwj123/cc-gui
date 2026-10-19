// r151h 静默看门狗与后台任务 —— 验收。H01–H04 依据 .devflow/r151h-stall-watchdog-接口.md 的"行为清单"(4 条),
// 用例与行为号一一对应:
//   H01(复现)有新鲜后台 shell 任务时不判卡死 · H02(相邻)没有后台任务时保持原行为 ·
//   H03(相邻)默认阈值仍是 300000 · H04(相邻)后台任务在静默窗口内结束后恢复原行为。
// H05–H07 依据 .devflow/r151i-bg-freshness-接口.md 的"行为清单"第 5–7 条,接在本套件后面:
//   H05(新)40 分钟仍豁免 · H06(新)env 接线 · H07(新)level-only。
//
// 每条用例一个一次性实例(临时 HOME、自挑端口、用例自己 stop);只走假 CLI(不产生模型请求,
// 模型请求在垫片层的真 CLI 车道才可能发生,本套件不建 real-* 工作区),静默阈值通过 startInstanceP2 的
// envExtra 以 CGUI_STALL_MS 传给服务进程。H01–H05、H07 的实例同时 --require 一个夹具垫片:
// 服务端若仍把 300000ms 定时器写死,垫片只把那一个定时器映射成 CGUI_STALL_MS(服务端自己读变量时,
// 垫片看到的延时不是 300000,不做任何事;断言不识别"是否修复过")。H06 故意不加载这个垫片,
// 断言设 1500 就必须按 1500 触发。断言写死修复后应有的行为。
import { test, expect } from '@playwright/test';
import { uniq } from '../r151b-xsession-p1/helpers/fixtures.mjs';
import { waitFor, writeScript } from '../r151b-xsession-p1/helpers/api.mjs';
import { startInstanceP2 } from './helpers/p2.mjs';
import {
  sleep, newT, procPids, turnsOf, lastTurnPid, waitTurn, releaseWait, armBgStart, armLevelOnly, streamT,
  isTaskToolUseEvent, stallNotices, stallText, bgTaskStopNotices,
} from './helpers/h.mjs';

test.describe.configure({ timeout: 120_000 });

const STALL_MS = 1500;
const SILENCE_MS = 5_000;
const THRESHOLD = { CGUI_STALL_MS: String(STALL_MS) };
const STALL_HEAD = '上游超过 5 分钟无后续输出';

/**
 * 起一次性实例并发出这一条消息,返回 { inst, T, pid, cliPid, stream }。
 * scriptName 同时是假 CLI 脚本名(消息里带 R151S:<scriptName>);steps 是脚本步骤。
 * bg 给了就摆 r151h 的 bgstart 控制文件(H01 / H04 / H05 用);levelOnly 给了就摆 r151i 的
 * levelonly 控制文件(H07 用,只发 background_tasks_changed、不发 task_started)。
 * clock:true 给服务进程挂时钟垫片(H05 用);stallMsShim 默认 true,H06 显式关掉它来验证 env 真实生效。
 */
async function startScenario({
  tag, mark, scriptName, steps, bg = null, levelOnly = null,
  envExtra = THRESHOLD, clock = false, stallMsShim = true,
}) {
  let inst = null;
  try {
    // stallMsShim:让"阈值写死 300000"的未修复代码也按 CGUI_STALL_MS 跑(见 helpers/stall-ms-shim.cjs)。
    inst = await startInstanceP2(`h-${tag}`, { envExtra, clock, stallMsShim });
    const T = newT(inst, tag);
    writeScript(scriptName, steps, inst.ctl);
    if (bg) armBgStart(inst.ctl, T.sid, bg);
    if (levelOnly) armLevelOnly(inst.ctl, T.sid, levelOnly);
    const r = await inst.c.post('/api/chat', {
      sessionId: T.sid, cwd: T.cwd, permissionMode: 'default',
      prompt: `${mark} R151S:${scriptName}`,
    }, { timeoutMs: 30_000 });
    expect(r.status, `前置:发出这一条消息(${String(r.text).slice(0, 240)})`).toBe(200);
    const pid = r.body && r.body.pid;
    expect(pid, `前置:应答里有 chat 的 pid(${String(r.text).slice(0, 240)})`).toBeTruthy();
    const stream = streamT(inst.base, pid);
    await stream.ready;
    const turn = await waitTurn(inst, T.sid, mark);
    expect(turn, `前置:假 CLI 开始跑这一回合(回合记录:${JSON.stringify(turnsOf(inst.ctl, T.sid))})`).toBeTruthy();
    const cliPid = lastTurnPid(inst.ctl, T.sid);
    expect(cliPid, `前置:回合记录里有假 CLI 的 pid(记录:${JSON.stringify(turnsOf(inst.ctl, T.sid))})`).toBeTruthy();
    // 前置:进程列表里现在确实有这个 pid —— 后面"pid 消失"才是结果断言,而不是从没出现过。
    const listed = await waitFor(async () => {
      const pids = await procPids(inst.c, T.sid);
      return pids.includes(Number(cliPid)) ? true : null;
    }, 5_000, 100);
    expect(listed, `前置:进程列表里有假 CLI pid ${cliPid}(进程列表:${JSON.stringify(await procPids(inst.c, T.sid))})`).toBe(true);
    return { inst, T, pid, cliPid, stream, turn };
  } catch (e) {
    if (inst) await inst.stop().catch(() => null);
    throw e;
  }
}

const taskToolUse = (tag, run, description) => ({
  toolUse: {
    id: `toolu_${tag}_task_${run}`, name: 'Task',
    input: { subagent_type: 'general-purpose', description, prompt: '等一会儿再返回' },
  },
});

const releaseAndStop = async (s, waitName) => {
  if (!s) return;
  try { releaseWait(s.inst.ctl, waitName); } catch { /* 忽略 */ }
  try { s.stream.stop(); } catch { /* 忽略 */ }
  await s.inst.stop().catch(() => null);
};

// ============================ H01 复现:有新鲜后台 shell 任务时不判卡死 ============================
test('H01 行为1 回合里报过一条后台 shell 任务开始后静默 5 秒:不出现 stall_notice、进程仍活着、没有后台任务被停的通知', async () => {
  const run = uniq('');
  const tag = 'h01';
  const mark = `R151H-H01-${run}`;
  const scriptName = `h01-${run}`;
  const never = `${scriptName}-never`;
  const taskId = `h01task${run}`;
  const toolUseId = `toolu_h01_bg_${run}`;
  let s = null;
  try {
    s = await startScenario({
      tag, mark, scriptName,
      steps: [taskToolUse('h01', run, 'H01 起过的子代理'), { waitFile: never }],
      bg: { taskId, toolUseId, description: 'sleep 120' },
    });
    // 夹具生效:这一回合里先有 Task 工具调用,随后报出后台 shell 任务开始(之后脚本保持静默)。
    const taskEv = await s.stream.waitFor(isTaskToolUseEvent, 10_000);
    expect(taskEv, `夹具生效:SSE 里有带 Task 工具调用的 assistant 消息(事件类型:${JSON.stringify(s.stream.events.map((e) => e && e.type))})`).toBeTruthy();
    const bgEv = await s.stream.waitFor((e) => e && e.type === 'system' && e.subtype === 'task_started' && e.task_id === taskId, 10_000);
    expect(bgEv, `夹具生效:SSE 里有 task_started/local_bash(事件:${JSON.stringify(s.stream.events.filter((e) => e && e.type === 'system').map((e) => [e.subtype, e.task_id]))})`).toBeTruthy();
    expect({ taskType: bgEv.task_type, backgrounded: bgEv.is_backgrounded, toolUseId: bgEv.tool_use_id },
      '夹具生效:后台任务开始事件的形状是 local_bash / is_backgrounded:true / 同一 tool_use_id')
      .toEqual({ taskType: 'local_bash', backgrounded: true, toolUseId });
    // 从这个后台任务开始之后,连续静默 5 秒(阈值是 1500ms)。
    await sleep(SILENCE_MS);
    const events = s.stream.events.slice();
    const notices = stallNotices(events);
    const stopNotes = bgTaskStopNotices(events, taskId);
    const pids = await procPids(s.inst.c, s.T.sid);
    expect({
      stallNotices: notices.map(stallText),
      pidAlive: pids.includes(Number(s.cliPid)),
      bgTaskStopNotices: stopNotes.map((e) => ({ type: e.type, subtype: e.subtype, status: e.status, text: e.text })),
    }, `这一回合的 SSE 事件:${JSON.stringify(events.map((e) => ({ type: e.type, subtype: e.subtype, task_id: e.task_id, text: e.text })).slice(-20))};进程列表 pid:${JSON.stringify(pids)};假 CLI pid:${s.cliPid}`)
      .toEqual({ stallNotices: [], pidAlive: true, bgTaskStopNotices: [] });
  } finally {
    await releaseAndStop(s, never);
  }
});

// ============================ H02 相邻:没有后台任务时保持原行为 ============================
test('H02 行为2 只有 Task 子代理、没有后台 shell 任务,静默超过 1500ms:收到 stall_notice(含固定开头)且进程被中止', async () => {
  const run = uniq('');
  const tag = 'h02';
  const mark = `R151H-H02-${run}`;
  const scriptName = `h02-${run}`;
  const never = `${scriptName}-never`;
  let s = null;
  try {
    s = await startScenario({
      tag, mark, scriptName,
      steps: [taskToolUse('h02', run, 'H02 起过的子代理'), { waitFile: never }],
    });
    const taskEv = await s.stream.waitFor(isTaskToolUseEvent, 10_000);
    expect(taskEv, `夹具生效:SSE 里有带 Task 工具调用的 assistant 消息(事件类型:${JSON.stringify(s.stream.events.map((e) => e && e.type))})`).toBeTruthy();
    // 最后一条输出就是这个 Task 工具调用;之后静默 5 秒(阈值 1500ms)。
    await sleep(SILENCE_MS);
    const notices = stallNotices(s.stream.events);
    expect(notices.length, `应收到 1 条 stall_notice(实际 ${notices.length} 条;SSE 事件:${JSON.stringify(s.stream.events.map((e) => ({ type: e.type, text: e.text })).slice(-20))})`)
      .toBeGreaterThanOrEqual(1);
    for (const n of notices) {
      expect(stallText(n), `stall_notice 的文案应含固定开头("${STALL_HEAD}"):${JSON.stringify(stallText(n))}`)
        .toContain(STALL_HEAD);
    }
    const gone = await waitFor(async () => {
      const pids = await procPids(s.inst.c, s.T.sid);
      return !pids.includes(Number(s.cliPid)) ? true : null;
    }, 5_000, 100);
    expect(gone, `看门狗应中止该进程:进程列表里不再有假 CLI pid ${s.cliPid}(进程列表:${JSON.stringify(await procPids(s.inst.c, s.T.sid))})`).toBe(true);
  } finally {
    await releaseAndStop(s, never);
  }
});

// ============================ H03 相邻:默认阈值仍是 300000 ============================
test('H03 行为3 不设 CGUI_STALL_MS:同样的静默场景 1 秒内不出现 stall_notice、进程仍活着(默认 300000)', async () => {
  const run = uniq('');
  const tag = 'h03';
  const mark = `R151H-H03-${run}`;
  const scriptName = `h03-${run}`;
  const never = `${scriptName}-never`;
  let s = null;
  try {
    s = await startScenario({
      tag, mark, scriptName,
      steps: [taskToolUse('h03', run, 'H03 起过的子代理'), { waitFile: never }],
      envExtra: {},
    });
    const taskEv = await s.stream.waitFor(isTaskToolUseEvent, 10_000);
    expect(taskEv, `夹具生效:SSE 里有带 Task 工具调用的 assistant 消息(事件类型:${JSON.stringify(s.stream.events.map((e) => e && e.type))})`).toBeTruthy();
    // 1 秒内不触发(故意多等 200ms 让"1 秒"这条断言不在临界点上)。
    await sleep(1_200);
    const notices = stallNotices(s.stream.events);
    const pids = await procPids(s.inst.c, s.T.sid);
    expect({
      stallNotices: notices.map(stallText),
      pidAlive: pids.includes(Number(s.cliPid)),
    }, `默认阈值下 1.2 秒内不应触发看门狗(进程列表:${JSON.stringify(pids)};假 CLI pid:${s.cliPid};SSE 事件:${JSON.stringify(s.stream.events.map((e) => ({ type: e.type, text: e.text })).slice(-20))})`)
      .toEqual({ stallNotices: [], pidAlive: true });
  } finally {
    await releaseAndStop(s, never);
  }
});

// ============================ H04 相邻:后台任务在静默窗口内结束 ============================
test('H04 行为4 后台 shell 任务在静默窗口内报 completed 后再静默超过阈值:恢复原行为,收到 stall_notice 且进程被中止', async () => {
  const run = uniq('');
  const tag = 'h04';
  const mark = `R151H-H04-${run}`;
  const scriptName = `h04-${run}`;
  const never = `${scriptName}-never`;
  const taskId = `h04task${run}`;
  const toolUseId = `toolu_h04_bg_${run}`;
  let s = null;
  try {
    s = await startScenario({
      tag, mark, scriptName,
      steps: [taskToolUse('h04', run, 'H04 起过的子代理'), { waitFile: never }],
      bg: { taskId, toolUseId, description: 'sleep 1', notifyAfterMs: 400, notifyStatus: 'completed' },
    });
    const bgEv = await s.stream.waitFor((e) => e && e.type === 'system' && e.subtype === 'task_started' && e.task_id === taskId, 10_000);
    expect(bgEv, `夹具生效:SSE 里有 task_started/local_bash(事件:${JSON.stringify(s.stream.events.filter((e) => e && e.type === 'system').map((e) => [e.subtype, e.task_id]))})`).toBeTruthy();
    const noteEv = await s.stream.waitFor((e) => e && e.type === 'system' && e.subtype === 'task_notification' && e.task_id === taskId && e.status === 'completed', 5_000);
    expect(noteEv, `夹具生效:同一个后台任务在静默窗口内报了 completed(事件:${JSON.stringify(s.stream.events.filter((e) => e && e.type === 'system').map((e) => [e.subtype, e.task_id, e.status]))})`).toBeTruthy();
    // 从终态通知之后再静默 5 秒(阈值 1500ms),应恢复原行为。
    await sleep(SILENCE_MS);
    const notices = stallNotices(s.stream.events);
    expect(notices.length, `应收到 1 条 stall_notice(实际 ${notices.length} 条;SSE 事件:${JSON.stringify(s.stream.events.map((e) => ({ type: e.type, text: e.text })).slice(-20))})`)
      .toBeGreaterThanOrEqual(1);
    for (const n of notices) {
      expect(stallText(n), `stall_notice 的文案应含固定开头("${STALL_HEAD}"):${JSON.stringify(stallText(n))}`)
        .toContain(STALL_HEAD);
    }
    const gone = await waitFor(async () => {
      const pids = await procPids(s.inst.c, s.T.sid);
      return !pids.includes(Number(s.cliPid)) ? true : null;
    }, 5_000, 100);
    expect(gone, `看门狗应中止该进程:进程列表里不再有假 CLI pid ${s.cliPid}(进程列表:${JSON.stringify(await procPids(s.inst.c, s.T.sid))})`).toBe(true);
  } finally {
    await releaseAndStop(s, never);
  }
});

// ============================ H05 新:40 分钟仍豁免 ============================
test('H05 行为5 后台 shell 任务开始后把服务端时钟推进 40 分钟,再静默超过阈值:不出现 stall_notice、进程仍活着、没有后台任务被停的通知', async () => {
  const run = uniq('');
  const tag = 'h05';
  const mark = `R151I-H05-${run}`;
  const scriptName = `h05-${run}`;
  const never = `${scriptName}-never`;
  const taskId = `h05task${run}`;
  const toolUseId = `toolu_h05_bg_${run}`;
  const CLOCK_ADVANCE_MS = 40 * 60 * 1000;
  let s = null;
  try {
    s = await startScenario({
      tag, mark, scriptName, clock: true,
      steps: [taskToolUse('h05', run, 'H05 起过的子代理'), { waitFile: never }],
      bg: { taskId, toolUseId, description: 'sleep 120' },
    });
    // 夹具生效:这一回合里先有 Task 工具调用,随后报出后台 shell 任务开始(之后脚本保持静默)。
    const taskEv = await s.stream.waitFor(isTaskToolUseEvent, 10_000);
    expect(taskEv, `夹具生效:SSE 里有带 Task 工具调用的 assistant 消息(事件类型:${JSON.stringify(s.stream.events.map((e) => e && e.type))})`).toBeTruthy();
    const bgEv = await s.stream.waitFor((e) => e && e.type === 'system' && e.subtype === 'task_started' && e.task_id === taskId, 10_000);
    expect(bgEv, `夹具生效:SSE 里有 task_started/local_bash(事件:${JSON.stringify(s.stream.events.filter((e) => e && e.type === 'system').map((e) => [e.subtype, e.task_id]))})`).toBeTruthy();
    // 条目已经建立:把服务端墙上时间推过 40 分钟(旧窗口 30 分钟),再静默 5 秒(阈值 1500ms)。
    // clock-shim 只平移 Date.now,不动定时器;看门狗会在推进后的下一个检查点重新算条目年龄。
    s.inst.setClock(CLOCK_ADVANCE_MS);
    await sleep(SILENCE_MS);
    const events = s.stream.events.slice();
    const notices = stallNotices(events);
    const stopNotes = bgTaskStopNotices(events, taskId);
    const pids = await procPids(s.inst.c, s.T.sid);
    expect({
      clockAdvanceMs: CLOCK_ADVANCE_MS,
      stallNotices: notices.map(stallText),
      pidAlive: pids.includes(Number(s.cliPid)),
      bgTaskStopNotices: stopNotes.map((e) => ({ type: e.type, subtype: e.subtype, status: e.status, text: e.text })),
    }, `时钟推进 ${CLOCK_ADVANCE_MS}ms 后,后台 shell 任务仍应视为活着;这一回合的 SSE 事件:${JSON.stringify(events.map((e) => ({ type: e.type, subtype: e.subtype, task_id: e.task_id, text: e.text })).slice(-20))};进程列表 pid:${JSON.stringify(pids)};假 CLI pid:${s.cliPid}`)
      .toEqual({ clockAdvanceMs: CLOCK_ADVANCE_MS, stallNotices: [], pidAlive: true, bgTaskStopNotices: [] });
  } finally {
    await releaseAndStop(s, never);
  }
});

// ============================ H06 新:env 接线真实生效 ============================
test('H06 行为6 一次性实例 CGUI_STALL_MS=1500 且不加载阈值垫片,只有 Task 子代理、没有后台任务:静默超过阈值后收到 stall_notice 且进程被中止', async () => {
  const run = uniq('');
  const tag = 'h06';
  const mark = `R151I-H06-${run}`;
  const scriptName = `h06-${run}`;
  const never = `${scriptName}-never`;
  let s = null;
  try {
    // 故意不挂 stall-ms-shim.cjs:断言服务端自己按 CGUI_STALL_MS=1500 触发看门狗。
    s = await startScenario({
      tag, mark, scriptName, stallMsShim: false,
      steps: [taskToolUse('h06', run, 'H06 起过的子代理'), { waitFile: never }],
    });
    const taskEv = await s.stream.waitFor(isTaskToolUseEvent, 10_000);
    expect(taskEv, `夹具生效:SSE 里有带 Task 工具调用的 assistant 消息(事件类型:${JSON.stringify(s.stream.events.map((e) => e && e.type))})`).toBeTruthy();
    // 最后一条输出就是这个 Task 工具调用;之后静默 5 秒(env 给的阈值是 1500ms)。
    await sleep(SILENCE_MS);
    const notices = stallNotices(s.stream.events);
    expect(notices.length, `不加载阈值垫片时,设了 CGUI_STALL_MS=1500 也应在 5 秒内收到 1 条 stall_notice(实际 ${notices.length} 条;SSE 事件:${JSON.stringify(s.stream.events.map((e) => ({ type: e.type, text: e.text })).slice(-20))})`)
      .toBeGreaterThanOrEqual(1);
    for (const n of notices) {
      expect(stallText(n), `stall_notice 的文案应含固定开头("${STALL_HEAD}"):${JSON.stringify(stallText(n))}`)
        .toContain(STALL_HEAD);
    }
    const gone = await waitFor(async () => {
      const pids = await procPids(s.inst.c, s.T.sid);
      return !pids.includes(Number(s.cliPid)) ? true : null;
    }, 5_000, 100);
    expect(gone, `看门狗应中止该进程:进程列表里不再有假 CLI pid ${s.cliPid}(进程列表:${JSON.stringify(await procPids(s.inst.c, s.T.sid))})`).toBe(true);
  } finally {
    await releaseAndStop(s, never);
  }
});

// ============================ H07 新:level-only ============================
test('H07 行为7 fake CLI 只发 background_tasks_changed(local_bash)、不发 task_started,静默超过阈值:不出现 stall_notice、进程仍活着', async () => {
  const run = uniq('');
  const tag = 'h07';
  const mark = `R151I-H07-${run}`;
  const scriptName = `h07-${run}`;
  const never = `${scriptName}-never`;
  const taskId = `h07task${run}`;
  const runId = `h07run${run}`;
  let s = null;
  try {
    s = await startScenario({
      tag, mark, scriptName,
      steps: [taskToolUse('h07', run, 'H07 起过的子代理'), { waitFile: never }],
      levelOnly: { taskId, runId, description: 'sleep 120' },
    });
    const taskEv = await s.stream.waitFor(isTaskToolUseEvent, 10_000);
    expect(taskEv, `夹具生效:SSE 里有带 Task 工具调用的 assistant 消息(事件类型:${JSON.stringify(s.stream.events.map((e) => e && e.type))})`).toBeTruthy();
    // 夹具生效:只来了 level 信号(background_tasks_changed),没有 task_started。
    const lvlEv = await s.stream.waitFor((e) => e && e.type === 'system' && e.subtype === 'background_tasks_changed'
      && Array.isArray(e.tasks) && e.tasks.some((t) => t && t.task_id === taskId), 10_000);
    expect(lvlEv, `夹具生效:SSE 里有 background_tasks_changed(含 ${taskId})(系统事件:${JSON.stringify(s.stream.events.filter((e) => e && e.type === 'system').map((e) => [e.subtype, e.task_id, (e.tasks || []).map((t) => t && t.task_id)]))})`).toBeTruthy();
    const lvlTask = (lvlEv.tasks || []).find((t) => t && t.task_id === taskId) || {};
    expect({ taskType: lvlTask.task_type, description: lvlTask.description },
      '夹具生效:level 信号里的任务是 local_bash,带 description')
      .toEqual({ taskType: 'local_bash', description: 'sleep 120' });
    const started = s.stream.events.filter((e) => e && e.type === 'system' && e.subtype === 'task_started' && e.task_id === taskId);
    expect(started, `夹具生效:level-only 模式不应出现 task_started(${JSON.stringify(started)})`).toEqual([]);
    // 之后静默 5 秒(阈值 1500ms):level 信号建出来的 shell 条目应算活着。
    await sleep(SILENCE_MS);
    const notices = stallNotices(s.stream.events);
    const pids = await procPids(s.inst.c, s.T.sid);
    expect({
      stallNotices: notices.map(stallText),
      pidAlive: pids.includes(Number(s.cliPid)),
    }, `level-only 的 shell 条目应让看门狗不触发;SSE 事件:${JSON.stringify(s.stream.events.map((e) => ({ type: e.type, subtype: e.subtype, task_id: e.task_id, text: e.text })).slice(-20))};进程列表 pid:${JSON.stringify(pids)};假 CLI pid:${s.cliPid}`)
      .toEqual({ stallNotices: [], pidAlive: true });
  } finally {
    await releaseAndStop(s, never);
  }
});
