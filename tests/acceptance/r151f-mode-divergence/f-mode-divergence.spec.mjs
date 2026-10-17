// r151f 切档没切成时怎么处理 —— 验收。依据 .devflow/r151f-mode-divergence-接口.md 的"行为清单"(9 条),用例 F01–F09 与行为号一一对应:
//   A 双进程 F01–F03 · B 单进程不回应 F04 · C 被拒 F05 · D 只有在等退出的进程 F06(+F06b) · E 复用时切档没回应 F07 · F 连续切档 F08 · G 确认卡挂着时切档 F09。
//   (相邻)= 接口文件标明的相邻行为(本轮不改,当前代码上应是绿的):F03 / F05 / F06 / F09。
//   F06b 是行为 6 拆出来的一条:接口"错误契约"写明"没有能接新消息的进程 → 200、attempted 为 0",而 F06 按清单只断言"5 秒内回 200"(当前代码上应绿),
//   把 attempted 断言放进 F06 会让它在当前代码上变红,所以单列。
//
// 场景夹具(都在本套件 helpers/ 里,不改已有套件):
//   fx-claude.mjs = 假 claude 外壳:让指定进程吞掉 / 压住 / 拒绝切档请求;让旧进程"被后台命令吊着"(被关 stdin 后先不退,可选同时无视 SIGTERM;SIGKILL 拦不住);
//   "客气退出"(关 stdin)时先跑完手上的回合再退(真命令行的做法);可在指定回合里照 SDK 公开类型 SDKTaskStartedMessage 报一条后台任务开始(F07 用);到点由进程"直接执行"一条命令(自认为在 auto 档才执行);宿主答 allow 时把 Write 的文件真的写出来。
//   "假模型压着这一回合" = 假 claude 脚本里的 waitFile 步骤(见一期假 claude)。
//   "双进程"(2026-10-17 在当前代码上实测出的造法,与接口文件的差别见 helpers/f.mjs 的 prepareOld / swapIn):老进程回合后空闲 8 秒 → 改 settings.json →
//   再发一条消息:宿主关老进程的 stdin、等它最多约 5 秒、起新进程跑这条;老进程被我们的外壳拦住不退(宿主之后约 6 秒发 SIGTERM、约 12 秒 SIGKILL,
//   所以老进程至多再活约 12 秒);压着的是新进程的第一个回合(接口文件写的是第二个:新进程刚起时下一条消息不会复用它,等不到"空闲后复用")。
//   实测另有两点影响造场景:① 宿主要等回合结束约 5 秒后才把进程当"空闲进程"(否则下一条消息另起新进程,不复用);② 「放任」「接受编辑」是宿主层面的放行,
//   进程是以 --permission-mode default 起的、不会收到切档,「规划」「自动」才是命令行层面的档位。
// 每条用例一个一次性实例(临时 HOME、自己的端口)。「放任」发送方 = 真 CLI 会话(ws/real-*,模型请求只到本地假接口)。
// 断言一律把几个可观察的事实收进一个对象一次比较,失败时能一眼看出是哪几项不对。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { uniq, realCliPath } from '../r151b-xsession-p1/helpers/fixtures.mjs';
import { xs, waitFor, spawnRecords, writeScript, touchCtl } from '../r151b-xsession-p1/helpers/api.mjs';
import { inboundOk, startInstanceP2, wsT, entry } from '../r151c-xsession-p2/helpers/p2.mjs';
import { permRequests, allowPerm } from '../r151d-xsession-hardening/helpers/d.mjs';
import {
  sleep, settle, procPids, turnsOf, lastTurnPid, switchMode, userTurn,
  newT, chatStart, writeHeldScript, writeFileScript, waitTurn, prepareOld, swapIn, thirdPartyAuto, senderSend, killPid, releaseAll, failedOf,
  fxMute, fxDelayFirst, fxReject, fxHold, fxExec, fxBgTask, switchLog, execLog, bgTaskLog,
} from './helpers/f.mjs';

test.describe.configure({ timeout: 300_000 });

const needReal = () => test.skip(!realCliPath(), '本机没有真 claude CLI(「放任」发送方要用真 CLI 调 send_message)');
const waitCard = (ws, sid, toolUseID, ms = 20_000) => waitFor(() => permRequests(ws, sid).find((q) => q.toolUseID === toolUseID) || null, ms, 100);
const mutedCount = (inst, T, pid) => switchLog(inst.ctl, T.sid).filter((x) => x.pid === pid && x.action === 'muted').length;

// ============================ A. 双进程 ============================

test('F01 行为1 双进程·新进程不回应切档(放任→逐步确认):20 秒内回 409、failed 里带 aborted:true;409 后 5 秒内新进程退出(不等模型说完);之后「放任」发送方的消息按界面档位(放任)被自动处理(done、via:"auto")', async () => {
  needReal();
  const inst = await startInstanceP2('f01');
  const run = uniq('');
  let T = null; let held = null;
  try {
    await xs(inst.c, inst.home).on();
    T = newT(inst, 'f01');
    const oldPid = await prepareOld(inst, T, { mode: 'bypassPermissions' });
    await inboundOk(inst.c, T.sid, 'auto');
    const e = await entry(inst.c, T.sid);
    expect(e && e.hasProfile, `前置:T 跑过「放任」回合,有「放任」发送档案(${JSON.stringify(e)})`).toBe(true);

    held = writeHeldScript(inst, `f01h${run}`);
    const { newPid } = await swapIn(inst, T, oldPid, { mode: 'bypassPermissions', prompt: `R151F f01 新进程的回合 R151S:${held.name}`, marker: held.name });
    fxMute(inst.ctl, T.sid, newPid);

    const sw = await switchMode(inst.c, T.sid, 'default', 25_000);
    let listed = [];
    await waitFor(async () => { listed = await procPids(inst.c, T.sid); return !listed.includes(newPid); }, 5_000, 200);
    expect(mutedCount(inst, T, newPid), `夹具生效:新进程 ${newPid} 收到了切档请求、没有回应(切档记录:${JSON.stringify(switchLog(inst.ctl, T.sid))})`).toBeGreaterThan(0);

    const after = await senderSend(inst, T, 'f01');
    const failed = failedOf(sw);
    expect({
      status: sw.status,
      within20s: sw.elapsed <= 20_000,
      attempted: sw.body && sw.body.attempted,
      delivered: sw.body && sw.body.delivered,
      abortedItem: Boolean(failed && failed.length === 1 && failed[0].sessionId === T.sid && failed[0].aborted === true),
      newPidGoneWithin5sOfReply: !listed.includes(newPid),
      crossSession: after.fin && { status: after.fin.status, via: after.fin.via },
    }, `切档应答原文:${String(sw.text).slice(0, 300)};用时 ${sw.elapsed}ms;409 后 5 秒时进程列表 ${JSON.stringify(listed)}(旧 ${oldPid} / 新 ${newPid});发送方的消息最后:${JSON.stringify(after.fin)}`)
      .toEqual({ status: 409, within20s: true, attempted: 1, delivered: 0, abortedItem: true, newPidGoneWithin5sOfReply: true, crossSession: { status: 'done', via: 'auto' } });
  } finally {
    if (T) releaseAll(inst, T.sid);
    if (held) held.release();
    await inst.stop();
  }
});

test('F02 行为2 第三方 provider「自动」档、双进程,新进程不回应切档(自动→逐步确认):409;一直等到切档后 24 秒,切档 16 秒后本该由新进程直接执行的命令没有执行(副作用没出现)', async () => {
  const inst = await startInstanceP2('f02');
  const run = uniq('');
  const marker = path.join(inst.root, `f02-effect-${run}.txt`);
  let T = null; let held = null;
  try {
    await thirdPartyAuto(inst);
    T = newT(inst, 'f02');
    const oldPid = await prepareOld(inst, T, { mode: 'auto' });
    held = writeHeldScript(inst, `f02h${run}`);
    const { newPid } = await swapIn(inst, T, oldPid, { mode: 'auto', prompt: `R151F f02 新进程的回合 R151S:${held.name}`, marker: held.name });
    const spawned = spawnRecords(inst.ctl).filter((r) => r.sid === T.sid && r.interactive).map((r) => [r.pid, r.mode]);
    expect(spawned, '前置:T 的两个进程都按「自动」档起(第三方 provider 的「自动」档已开)').toEqual([[oldPid, 'auto'], [newPid, 'auto']]);
    fxMute(inst.ctl, T.sid, newPid);
    // 假模型安排:切档 16 秒后(晚于 10 秒超时,再加约 2 秒中止收尾:SDK 先断开通信、约 2 秒后才结束进程),新进程执行一条(命中危险命令规则、审核判为可以执行的)命令;
    // 只要新进程还活着且自认为在「自动」档,它就直接执行。以切档发出的时刻为 0 秒:16 秒执行,一直等到 24 秒再看副作用有没有出现。
    const switchAt = Date.now();
    fxExec(inst.ctl, T.sid, { pid: newPid, runAt: switchAt + 16_000, cmd: `touch '${marker}'` });

    const sw = await switchMode(inst.c, T.sid, 'default', 25_000);
    await sleep(Math.max(0, switchAt + 24_000 - Date.now()));
    expect(mutedCount(inst, T, newPid), `夹具生效:新进程 ${newPid} 收到了切档请求、没有回应`).toBeGreaterThan(0);
    expect({ status: sw.status, commandExecuted: fs.existsSync(marker) },
      `切档应答原文:${String(sw.text).slice(0, 300)};用时 ${sw.elapsed}ms;检查时刻在切档后 ${Date.now() - switchAt}ms;定时命令记录 ${JSON.stringify(execLog(inst.ctl, T.sid))}(只有新进程活到 16 秒后且自认为在「自动」档才会执行)`)
      .toEqual({ status: 409, commandExecuted: false });
  } finally {
    if (T) releaseAll(inst, T.sid);
    if (held) held.release();
    await inst.stop();
  }
});

test('F03 (相邻)行为3 双进程·新进程正常回应切档(放任→逐步确认):回 200;之后新进程手上这一回合里模型要写文件 → 出现确认卡,确认前文件不存在', async () => {
  const inst = await startInstanceP2('f03');
  const ws = await wsT(inst.base);
  const run = uniq('');
  let T = null; let held = null;
  try {
    T = newT(inst, 'f03');
    const oldPid = await prepareOld(inst, T, { mode: 'bypassPermissions' });
    const go = `f03-go-${run}`; const wid = `toolu_f03_w_${run}`; const file = path.join(T.cwd, `r151f-f03-${run}.txt`);
    held = { release: () => touchCtl(go, inst.ctl) };
    writeScript(`f03m${run}`, [
      { waitFile: go },
      { canUseTool: { tool_name: 'Write', tool_use_id: wid, input: { file_path: file, content: 'R151F' } } },
      { say: 'R151F f03 回合完' },
    ], inst.ctl);
    const { newPid } = await swapIn(inst, T, oldPid, { mode: 'bypassPermissions', prompt: `R151F f03 新进程的回合 R151S:f03m${run}`, marker: `f03m${run}` });

    const sw = await switchMode(inst.c, T.sid, 'default', 20_000);
    touchCtl(go, inst.ctl);   // 假模型放行,接着请求写文件
    const card = await waitCard(ws, T.sid, wid);
    const fileBeforeConfirm = fs.existsSync(file);
    expect({ status: sw.status, card: Boolean(card), fileBeforeConfirm },
      `切档应答原文:${String(sw.text).slice(0, 300)};旧进程 ${oldPid} / 新进程 ${newPid}`)
      .toEqual({ status: 200, card: true, fileBeforeConfirm: false });
    if (card) await allowPerm(inst.c, card);
  } finally {
    ws.close();
    if (T) releaseAll(inst, T.sid);
    if (held) held.release();
    await inst.stop();
  }
});

// ============================ B. 单进程不回应 ============================

test('F04 行为4 单进程正在跑第二个回合(被压着)、不回应切档(逐步确认→放任):20 秒内回 409(failed 带 aborted:true);409 后 5 秒内进程退出;下一条消息由新进程(pid 不同)按逐步确认运行,模型要写文件时出现确认卡', async () => {
  const inst = await startInstanceP2('f04');
  const ws = await wsT(inst.base);
  const run = uniq('');
  let T = null; let held = null;
  try {
    T = newT(inst, 'f04');
    const t1 = await userTurn(inst.c, T, { mode: 'default', note: 'F04 第一个回合' });
    expect(t1.status, `前置:T 在「逐步确认」档跑第一个回合(${String(t1.text).slice(0, 200)})`).toBe(200);
    const p1 = lastTurnPid(inst.ctl, T.sid);
    expect(p1, '前置:假 claude 记下了第一个回合的进程号').toBeTruthy();
    await settle();

    held = writeHeldScript(inst, `f04h${run}`);
    const start = await chatStart(inst.c, T, { prompt: `R151F f04 第二个回合 R151S:${held.name}`, mode: 'default' });
    expect(start.status, `前置:发出第二个回合(${String(start.text).slice(0, 200)})`).toBe(200);
    const running = await waitTurn(inst, T, held.name);
    expect(running && running.pid, `前置:原进程 ${p1} 正在跑第二个回合(假模型压着)`).toBe(p1);
    fxMute(inst.ctl, T.sid, p1);

    const sw = await switchMode(inst.c, T.sid, 'bypassPermissions', 25_000);
    let listed = [];
    await waitFor(async () => { listed = await procPids(inst.c, T.sid); return !listed.includes(p1); }, 5_000, 200);
    expect(mutedCount(inst, T, p1), `夹具生效:进程 ${p1} 收到了切档请求、没有回应`).toBeGreaterThan(0);

    // 界面回到逐步确认后,用户发下一条;模型要写文件
    const wid = `toolu_f04_w_${run}`; const file = path.join(T.cwd, `r151f-f04-${run}.txt`);
    writeFileScript(inst, `f04n${run}`, file, wid);
    const next = await chatStart(inst.c, T, { prompt: `R151F f04 下一条 R151S:f04n${run}`, mode: 'default' });
    const card = await waitCard(ws, T.sid, wid, 25_000);
    const turn = turnsOf(inst.ctl, T.sid).find((x) => String(x.text).includes(`f04n${run}`)) || null;
    const failed = failedOf(sw);
    expect({
      status: sw.status,
      within20s: sw.elapsed <= 20_000,
      attempted: sw.body && sw.body.attempted,
      delivered: sw.body && sw.body.delivered,
      abortedItem: Boolean(failed && failed.length === 1 && failed[0].sessionId === T.sid && failed[0].aborted === true),
      processGoneWithin5sOfReply: !listed.includes(p1),
      nextChat: next.status,
      nextByNewProcess: turn ? turn.pid !== p1 : null,
      nextTurnMode: turn && turn.mode,
      card: Boolean(card),
      fileBeforeConfirm: fs.existsSync(file),
    }, `切档应答原文:${String(sw.text).slice(0, 300)};用时 ${sw.elapsed}ms;409 后 5 秒时进程列表 ${JSON.stringify(listed)}(原进程 ${p1});下一条的回合记录 ${JSON.stringify(turn)}`)
      .toEqual({ status: 409, within20s: true, attempted: 1, delivered: 0, abortedItem: true, processGoneWithin5sOfReply: true, nextChat: 200, nextByNewProcess: true, nextTurnMode: 'default', card: true, fileBeforeConfirm: false });
    if (card) await allowPerm(inst.c, card);
  } finally {
    ws.close();
    if (T) releaseAll(inst, T.sid);
    if (held) held.release();
    await inst.stop();
  }
});

// ============================ C. 被拒 ============================

test('F05 (相邻)行为5 只有一个进程,命令行拒绝切到「自动」:回 409、档位不变(failed 里没有 aborted);这个进程照旧可用:下一条消息仍由它处理(pid 不变),按逐步确认运行(写文件出现确认卡)', async () => {
  const inst = await startInstanceP2('f05');
  const ws = await wsT(inst.base);
  const run = uniq('');
  let T = null;
  try {
    T = newT(inst, 'f05');
    const t1 = await userTurn(inst.c, T, { mode: 'default', note: 'F05 第一个回合' });
    expect(t1.status, `前置:T 在「逐步确认」档跑第一个回合(${String(t1.text).slice(0, 200)})`).toBe(200);
    const p1 = lastTurnPid(inst.ctl, T.sid);
    expect(p1, '前置:假 claude 记下了第一个回合的进程号').toBeTruthy();
    await settle();
    fxReject(inst.ctl, T.sid, p1, ['auto'], 'auto mode unavailable for this model');

    const sw = await switchMode(inst.c, T.sid, 'auto', 20_000);
    expect(switchLog(inst.ctl, T.sid).filter((x) => x.pid === p1 && x.mode === 'auto' && x.action === 'rejected').length,
      `夹具生效:进程 ${p1} 收到了切到 auto 的请求、并回了拒绝(切档记录:${JSON.stringify(switchLog(inst.ctl, T.sid))})`).toBeGreaterThan(0);

    const wid = `toolu_f05_w_${run}`; const file = path.join(T.cwd, `r151f-f05-${run}.txt`);
    writeFileScript(inst, `f05n${run}`, file, wid);
    const next = await chatStart(inst.c, T, { prompt: `R151F f05 下一条 R151S:f05n${run}`, mode: 'default' });
    const card = await waitCard(ws, T.sid, wid, 25_000);
    const turn = turnsOf(inst.ctl, T.sid).find((x) => String(x.text).includes(`f05n${run}`)) || null;
    const listed = await procPids(inst.c, T.sid);
    const failed = failedOf(sw);
    expect({
      status: sw.status,
      ok: sw.body && sw.body.ok,
      attempted: sw.body && sw.body.attempted,
      delivered: sw.body && sw.body.delivered,
      failedItems: failed && failed.length,
      anyAborted: Boolean(failed && failed.some((f) => f && f.aborted === true)),
      nextChat: next.status,
      nextBySameProcess: turn ? turn.pid === p1 : null,
      nextTurnMode: turn && turn.mode,
      stillListed: listed.includes(p1),
      card: Boolean(card),
    }, `切档应答原文:${String(sw.text).slice(0, 300)};下一条的回合记录 ${JSON.stringify(turn)};进程列表 ${JSON.stringify(listed)}(原进程 ${p1})`)
      .toEqual({ status: 409, ok: false, attempted: 1, delivered: 0, failedItems: 1, anyAborted: false, nextChat: 200, nextBySameProcess: true, nextTurnMode: 'default', stillListed: true, card: true });
    if (card) await allowPerm(inst.c, card);
  } finally {
    ws.close();
    if (T) releaseAll(inst, T.sid);
    await inst.stop();
  }
});

// ============================ D. 只有在等退出的进程 ============================

/** 造"只有一个在等退出的旧进程,没有能接新消息的进程":老进程被换下(见 swapIn)→ 新进程跑完那条消息 → 结束新进程。返回 { oldPid, newPid }。 */
async function onlyExiting(inst, T) {
  const oldPid = await prepareOld(inst, T, { mode: 'bypassPermissions' });
  const swap = uniq('');
  const { newPid } = await swapIn(inst, T, oldPid, { mode: 'bypassPermissions', prompt: `R151F swap ${swap}`, marker: `swap ${swap}` });
  killPid(newPid);
  let pids = [];
  await waitFor(async () => { pids = await procPids(inst.c, T.sid); return !pids.includes(newPid); }, 8_000, 200);
  expect(pids, `前置:新进程 ${newPid} 已被结束,进程列表里只剩被后台命令吊着、在等退出的旧进程 ${oldPid}`).toEqual([oldPid]);
  return { oldPid, newPid };
}

test('F06 (相邻)行为6 只有一个在等退出的旧进程、没有能接新消息的进程:切到逐步确认 5 秒内回 200;之后「放任」发送方的消息不自动处理(pending、class-mismatch);再给 T 发消息,新起的进程按逐步确认运行(写文件出现确认卡)', async () => {
  needReal();
  const inst = await startInstanceP2('f06');
  const ws = await wsT(inst.base);
  const run = uniq('');
  let T = null;
  try {
    await xs(inst.c, inst.home).on();
    T = newT(inst, 'f06');
    const { oldPid, newPid } = await onlyExiting(inst, T);
    await inboundOk(inst.c, T.sid, 'auto');
    const e = await entry(inst.c, T.sid);
    expect(e && e.hasProfile, `前置:T 跑过「放任」回合,有「放任」发送档案(${JSON.stringify(e)})`).toBe(true);

    const sw = await switchMode(inst.c, T.sid, 'default', 20_000);
    const cross = await senderSend(inst, T, 'f06');

    const wid = `toolu_f06_w_${run}`; const file = path.join(T.cwd, `r151f-f06-${run}.txt`);
    writeFileScript(inst, `f06n${run}`, file, wid);
    const next = await chatStart(inst.c, T, { prompt: `R151F f06 下一条 R151S:f06n${run}`, mode: 'default' });
    const card = await waitCard(ws, T.sid, wid, 25_000);
    const turn = turnsOf(inst.ctl, T.sid).find((x) => String(x.text).includes(`f06n${run}`)) || null;
    expect({
      status: sw.status,
      within5s: sw.elapsed <= 5_000,
      crossSession: cross.fin && { status: cross.fin.status, heldReason: cross.fin.heldReason },
      nextChat: next.status,
      nextByBrandNewProcess: turn ? ![oldPid, newPid].includes(turn.pid) : null,
      nextTurnMode: turn && turn.mode,
      card: Boolean(card),
    }, `切档应答原文:${String(sw.text).slice(0, 300)};用时 ${sw.elapsed}ms;发送方的消息最后:${JSON.stringify(cross.fin)};下一条的回合记录 ${JSON.stringify(turn)}`)
      .toEqual({ status: 200, within5s: true, crossSession: { status: 'pending', heldReason: 'class-mismatch' }, nextChat: 200, nextByBrandNewProcess: true, nextTurnMode: 'default', card: true });
    if (card) await allowPerm(inst.c, card);
  } finally {
    ws.close();
    if (T) releaseAll(inst, T.sid);
    await inst.stop();
  }
});

test('F06b 行为6/错误契约 没有能接新消息的进程(只有在等退出的旧进程)时切档:回 200,ok 为 true,attempted 为 0(在等退出的进程不收切档请求、也不计数)', async () => {
  const inst = await startInstanceP2('f06b');
  let T = null;
  try {
    T = newT(inst, 'f06b');
    const { oldPid } = await onlyExiting(inst, T);
    const sw = await switchMode(inst.c, T.sid, 'default', 20_000);
    expect({ status: sw.status, ok: sw.body && sw.body.ok, attempted: sw.body && sw.body.attempted },
      `切档应答原文:${String(sw.text).slice(0, 300)};用时 ${sw.elapsed}ms;在等退出的旧进程 ${oldPid}`)
      .toEqual({ status: 200, ok: true, attempted: 0 });
  } finally {
    if (T) releaseAll(inst, T.sid);
    await inst.stop();
  }
});

// ============================ E. 复用时切档没回应 ============================

test('F07 行为7 复用时切档没回应:空闲的「放任」旧进程被后台命令吊着(回合里报过后台任务开始、没报结束)、不回应切档,用户改用非放任档(规划)发一条 → 换新进程跑这条;结束新进程后,「放任」发送方的消息不自动处理(pending、class-mismatch)', async () => {
  needReal();
  const inst = await startInstanceP2('f07');
  const run = uniq('');
  let T = null;
  try {
    await xs(inst.c, inst.home).on();
    T = newT(inst, 'f07');
    // "被它起的后台命令吊着":T 的上一回合里模型起了一个后台 shell 命令。真命令行此时会在输出里报一条后台任务开始的系统消息
    // (格式见 SDK 公开类型 SDKTaskStartedMessage),任务结束前不再报结束,宿主据此认为这个进程还被后台命令吊着。
    // 外壳 fx-claude.mjs 在这个回合吐 result 之前照这个格式吐一条 task_started,之后不吐结束;脚本里同时演一次 Bash 后台调用(同一个 tool_use_id)。
    const bgId = `toolu_f07_bg_${run}`; const taskId = `f07task${run}`;
    writeScript(`f07a${run}`, [
      { toolUse: { id: bgId, name: 'Bash', input: { command: 'sleep 120', description: 'sleep 120', run_in_background: true } } },
      { toolResult: { tool_use_id: bgId, content: `Command running in background with ID: ${taskId}` } },
      { say: 'R151F f07 老进程的回合完(后台命令还在跑)' },
    ], inst.ctl);
    fxBgTask(inst.ctl, T.sid, { toolUseId: bgId, taskId, description: 'sleep 120' });
    const t1 = await userTurn(inst.c, T, { mode: 'bypassPermissions', note: `F07 建立存活进程 R151S:f07a${run}` });
    expect(t1.status, `前置:T 在「放任」档跑一个回合,回合里起后台命令(${String(t1.text).slice(0, 200)})`).toBe(200);
    const oldPid = lastTurnPid(inst.ctl, T.sid);
    expect(bgTaskLog(inst.ctl, T.sid).filter((x) => x.pid === oldPid && x.action === 'task_started').length,
      `夹具生效:进程 ${oldPid} 在回合里报了一条后台任务开始(记录:${JSON.stringify(bgTaskLog(inst.ctl, T.sid))})`).toBe(1);
    let pids = [];
    await waitFor(async () => { pids = await procPids(inst.c, T.sid); return pids.length === 1 && pids[0] === oldPid; }, 8_000, 200);
    expect(pids, `前置:进程列表里 T 恰有一个存活的空闲进程 ${oldPid}`).toEqual([oldPid]);
    await settle();
    await inboundOk(inst.c, T.sid, 'auto');
    const e = await entry(inst.c, T.sid);
    expect(e && e.hasProfile, `前置:T 有「放任」发送档案(${JSON.stringify(e)})`).toBe(true);
    fxHold(inst.ctl, oldPid);   // 被后台命令吊着:被客气要求退出(关 stdin)也不退;终止信号照常能结束它(中止它的办法是信号)
    fxMute(inst.ctl, T.sid, oldPid);

    // 用户改发非放任档。用「规划」而不是接口写的"逐步确认"的理由:当前代码上「放任」「接受编辑」是宿主层面的放行(进程都是以 --permission-mode default 起的,
    // 没给命令行发过切档),从放任改发「逐步确认」时进程自己的档位没变,宿主不会去切档(实测:进程被原样复用、切档记录为空),"复用时切档没回应"就造不出来;
    // 「规划」是命令行层面的档位,改发它宿主才会对空闲进程发切档。对跨会话判定没有影响:「规划」与「逐步确认」同属"非放任"一类。
    const u = await userTurn(inst.c, T, { mode: 'plan', note: 'F07 规划档的这一条', postMs: 40_000 });
    const turn = turnsOf(inst.ctl, T.sid).find((x) => String(x.text).includes(u.mark)) || null;
    expect(mutedCount(inst, T, oldPid), `夹具生效:旧进程 ${oldPid} 收到了复用时的切档请求、没有回应(切档记录:${JSON.stringify(switchLog(inst.ctl, T.sid))})`).toBeGreaterThan(0);
    const newPid = turn && turn.pid;
    // 新进程这一回合结束后,测试按进程列表里的 pid 结束新进程(不对旧进程此刻是否还在做任何断言:修复后宿主对它的处置可能不同)
    const listed = await procPids(inst.c, T.sid);
    if (newPid && newPid !== oldPid && listed.includes(newPid)) killPid(newPid);
    await waitFor(async () => !(await procPids(inst.c, T.sid)).includes(newPid), 8_000, 200);

    const cross = await senderSend(inst, T, 'f07');
    expect({
      chat: u.status,
      handledByNewPid: Boolean(turn && newPid !== oldPid),
      crossSession: cross.fin && { status: cross.fin.status, heldReason: cross.fin.heldReason },
    }, `这一条的回合记录 ${JSON.stringify(turn)};新进程结束前进程列表 ${JSON.stringify(listed)}(旧 ${oldPid});发送方的消息最后:${JSON.stringify(cross.fin)}`)
      .toEqual({ chat: 200, handledByNewPid: true, crossSession: { status: 'pending', heldReason: 'class-mismatch' } });
  } finally {
    if (T) releaseAll(inst, T.sid);
    await inst.stop();
  }
});

// ============================ F. 连续切档 ============================

test('F08 行为8 连续切档:只有一个进程,第一次切档请求被压住 6 秒再交给命令行。先发「切到放任」、1 秒后再发「切到逐步确认」→ 两个都回 200,切到放任的那个先返回;之后「放任」发送方的消息不自动处理(pending、class-mismatch)', async () => {
  needReal();
  const inst = await startInstanceP2('f08');
  let T = null;
  try {
    await xs(inst.c, inst.home).on();
    T = newT(inst, 'f08');
    const t1 = await userTurn(inst.c, T, { mode: 'default', note: 'F08 逐步确认的第一个回合' });
    expect(t1.status, `前置:T 在「逐步确认」档跑一个回合(${String(t1.text).slice(0, 200)})`).toBe(200);
    const p1 = lastTurnPid(inst.ctl, T.sid);
    let pids = [];
    await waitFor(async () => { pids = await procPids(inst.c, T.sid); return pids.length === 1 && pids[0] === p1; }, 8_000, 200);
    expect(pids, `前置:进程列表里 T 恰有一个存活进程 ${p1}`).toEqual([p1]);
    await settle();
    await inboundOk(inst.c, T.sid, 'auto');
    const e = await entry(inst.c, T.sid);
    expect(e && e.hasProfile, `前置:T 有「逐步确认」发送档案(${JSON.stringify(e)})`).toBe(true);
    fxDelayFirst(inst.ctl, T.sid, p1, 6_000);

    const t0 = Date.now();
    const a = switchMode(inst.c, T.sid, 'bypassPermissions', 30_000).then((r) => ({ ...r, doneAt: Date.now() - t0 }));
    await sleep(1_000);
    const b = switchMode(inst.c, T.sid, 'default', 30_000).then((r) => ({ ...r, doneAt: Date.now() - t0 }));
    const [ra, rb] = await Promise.all([a, b]);
    expect(switchLog(inst.ctl, T.sid).filter((x) => x.pid === p1 && x.action === 'delayed').length,
      `夹具生效:进程 ${p1} 的第一条切档请求被压住了(切档记录:${JSON.stringify(switchLog(inst.ctl, T.sid))})`).toBe(1);

    const cross = await senderSend(inst, T, 'f08');
    expect({
      放任那次: ra.status,
      逐步确认那次: rb.status,
      放任那次先返回: ra.doneAt <= rb.doneAt,
      crossSession: cross.fin && { status: cross.fin.status, heldReason: cross.fin.heldReason },
    }, `两次应答:放任那次 ${ra.status}(${ra.doneAt}ms)${String(ra.text).slice(0, 120)};逐步确认那次 ${rb.status}(${rb.doneAt}ms)${String(rb.text).slice(0, 120)};发送方的消息最后:${JSON.stringify(cross.fin)}`)
      .toEqual({ 放任那次: 200, 逐步确认那次: 200, 放任那次先返回: true, crossSession: { status: 'pending', heldReason: 'class-mismatch' } });
  } finally {
    if (T) releaseAll(inst, T.sid);
    await inst.stop();
  }
});

// ============================ G. 确认卡挂着时切档 ============================

test('F09 (相邻)行为9 确认卡挂着时切档:逐步确认下模型要写文件、确认卡没答 → 切到放任,10 秒内回 200、failed 为空;挂着的卡按放任自动放行,文件写成', async () => {
  const inst = await startInstanceP2('f09');
  const ws = await wsT(inst.base);
  const run = uniq('');
  let T = null;
  try {
    T = newT(inst, 'f09');
    const t1 = await userTurn(inst.c, T, { mode: 'default', note: 'F09 第一个回合' });
    expect(t1.status, `前置:T 在「逐步确认」档跑第一个回合(${String(t1.text).slice(0, 200)})`).toBe(200);
    await settle();
    const wid = `toolu_f09_w_${run}`; const file = path.join(T.cwd, `r151f-f09-${run}.txt`);
    writeFileScript(inst, `f09m${run}`, file, wid);
    const start = await chatStart(inst.c, T, { prompt: `R151F f09 写文件 R151S:f09m${run}`, mode: 'default' });
    expect(start.status, `前置:发出要写文件的回合(${String(start.text).slice(0, 200)})`).toBe(200);
    const card = await waitCard(ws, T.sid, wid);
    expect(card, '前置:出现写文件的确认卡(没答)').toBeTruthy();
    expect(fs.existsSync(file), '前置:确认卡没答,文件还不存在').toBe(false);

    const sw = await switchMode(inst.c, T.sid, 'bypassPermissions', 15_000);
    const written = await waitFor(() => fs.existsSync(file), 10_000, 100);
    const failed = failedOf(sw);
    expect({ status: sw.status, within10s: sw.elapsed <= 10_000, failed, fileWritten: Boolean(written) },
      `切档应答原文:${String(sw.text).slice(0, 300)};用时 ${sw.elapsed}ms`)
      .toEqual({ status: 200, within10s: true, failed: [], fileWritten: true });
  } finally {
    ws.close();
    if (T) releaseAll(inst, T.sid);
    await inst.stop();
  }
});
