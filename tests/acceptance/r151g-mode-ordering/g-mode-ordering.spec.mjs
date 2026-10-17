// r151g 用户发消息与切档的先后顺序 + 复用占位 + 收尾 —— 验收。依据 .devflow/r151g-mode-ordering-接口.md 的"行为清单"(12 条),
// 用例 A1–F12 与行为号一一对应:
//   A 复用换模型期间切档(行为 1、2)· B 消息里的档位与切档结果对齐(3、4、5)· C 复用热切期间的占位(6、7)·
//   D 界面切档超时(8、9)· E 冷启等待已发起中止的进程(10)· F 回合记录终态(11、12)。
//   相邻回归(接口文件标明当前不该变、修复前应绿):A2 / B5 / C7 / D9;其余 8 条修复前应因结果断言而红。
//
// 场景夹具见 helpers/(从 r151f 复制并扩展:fx-claude 增加"压住 / 吞掉换模型请求",另给 hold 增加 exitAfterMs 用来造
// "已发起中止、旧进程还会活一会儿"的窗口)。每条用例一个一次性实例(临时 HOME、自挑端口、用例自己 stop);
// 界面用例(D8 / D9)用 run.sh 起的共享实例 + dev server。断言一律把几个可观察事实收进一个对象一次比较。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { uniq, realCliPath, makeWorkspace, mockDir, homeDir } from '../r151b-xsession-p1/helpers/fixtures.mjs';
import { xs, shared as sharedC, waitFor, spawnRecords, writeScript, touchCtl, readStream } from '../r151b-xsession-p1/helpers/api.mjs';
import { startInstanceP2, wsT, inboundOk, entry, msgs, SM, addScript } from '../r151c-xsession-p2/helpers/p2.mjs';
import { permRequests, allowPerm, sendFrom } from '../r151d-xsession-hardening/helpers/d.mjs';
import { boot, openSessionBySearch } from '../r151b-xsession-p1/helpers/ui.mjs';
import { selector, chooseMode } from '../r151a-auto-audit/helpers/ui.mjs';
import {
  sleep, settle, newT, chatStart, switchMode, writeHeldScript, writeFileScript, waitTurn,
  fxMute, fxModelDelayFirst, fxDelayFirst, fxHold, fxBgTask,
  modelLog, switchLog, exitLog, procPids, procOf, turnsOf, lastTurnPid, prepareOld, releaseAll, killPid, pidGoneAt, thirdPartyAuto, failedOf, touchSettings,
} from './helpers/g.mjs';

test.describe.configure({ timeout: 360_000 });

const CTL = () => process.env.R151B_CTL || path.join(homeDir(), 'fake-claude');
const waitCard = (ws, sid, toolUseID, ms = 25_000) => waitFor(() => permRequests(ws, sid).find((q) => q.toolUseID === toolUseID) || null, ms, 100);
const jsonl = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

/** 起一个一次性实例,并在 finally 里由用例自己停。 */
const startInst = (tag) => startInstanceP2(`g-${tag}`);

/** 让会话跑一个正常回合(可指定档位 / 模型),返回这一回合的进程号;调用方自己 settle 后才算"空闲可复用"。 */
async function resident(inst, T, { mode = 'default', model, note = '回合' } = {}) {
  const r = await chatStart(inst.c, T, { prompt: `R151G ${note}`, mode, model, postMs: 40_000 });
  expect(r.status, `前置:${T.sid} 跑一个回合(${String(r.text).slice(0, 240)})`).toBe(200);
  if (r.body && r.body.pid) await readStream(r.body.pid, { timeoutMs: 25_000, base: inst.c.base });
  const pid = lastTurnPid(inst.ctl, T.sid);
  expect(pid, `前置:假 claude 记下了这一回合的进程号(回合记录:${JSON.stringify(turnsOf(inst.ctl, T.sid).slice(-2))})`).toBeTruthy();
  return pid;
}

/** 某进程 pid 在 spawn.jsonl 里的启动时刻(毫秒);没有记录返回 null。 */
function spawnAt(ctl, pid) {
  const r = spawnRecords(ctl).find((x) => x.pid === Number(pid));
  return r ? Date.parse(r.at) : null;
}

/**
 * 真 CLI 发送方:先在假模型里等 <数据根>/mock/<go> 文件,再调用 send_message。用于"热切压住期间让跨会话消息到达"。
 * 返回 { S, fire(), finish() }:fire 放行模型调用;finish 停掉授权轮询并等发送方回合收尾。
 */
async function startHeldSender(inst, targetSid, text, { mode = 'default' } = {}) {
  const S = { cwd: makeWorkspace(`real-g-${uniq('')}`) };
  const mark = uniq('R151CK');
  const go = `g-go-${uniq('')}`;
  addScript('real', mark, [{ name: SM, input: { to: [targetSid], message: text }, waitFile: go }], []);
  const r = await inst.c.post('/api/chat', { cwd: S.cwd, permissionMode: mode, prompt: `${mark} 请按约定调用工具` });
  expect(r.status, `前置:发送方起一个真 CLI 回合(${String(r.text).slice(0, 200)})`).toBe(200);
  const events = readStream(r.body.pid, { timeoutMs: 90_000, base: inst.c.base });
  let stop = false;
  const seen = new Set();
  const approver = (async () => {
    while (!stop) {
      const b = (await inst.c.get('/api/permissions/pending').catch(() => ({ body: null }))).body;
      for (const it of (b && Array.isArray(b.items) ? b.items : [])) {
        if (it && it.toolName === SM && it.cwd === S.cwd && !seen.has(it.id)) { seen.add(it.id); await allowPerm(inst.c, it).catch(() => null); }
      }
      await sleep(120);
    }
  })();
  return {
    S,
    fire: () => { fs.mkdirSync(mockDir(), { recursive: true }); fs.writeFileSync(path.join(mockDir(), go), String(Date.now())); },
    finish: async () => { stop = true; await approver.catch(() => null); await events.catch(() => null); },
  };
}

// ============================ A. 复用换模型期间切档 ============================

test('A1 行为1 空闲「放任」进程复用、换模型压住 4 秒期间切到逐步确认(回 200):这一回合两层档位都按逐步确认——模型要写文件出现确认卡,确认前文件不存在', async () => {
  const inst = await startInst('a1');
  const ws = await wsT(inst.base);
  const run = uniq('');
  let T = null;
  const wid = `toolu_a1_w_${run}`;
  try {
    T = newT(inst, 'a1');
    const p1 = await resident(inst, T, { mode: 'bypassPermissions', model: 'r151-chat', note: `A1 第一回合 ${run}` });
    expect(await procPids(inst.c, T.sid), '前置:T 恰有一个存活进程').toEqual([p1]);
    await settle(8_000);
    fxModelDelayFirst(inst.ctl, T.sid, p1, 4_000);
    const file = path.join(T.cwd, `a1-${run}.txt`);
    writeFileScript(inst, `a1m${run}`, file, wid);
    // POST /api/chat 会等换模型 / 热切派发完才回;这里先发出去,压住期间再切档,最后才收这个应答。
    const chatP = chatStart(inst.c, T, { prompt: `R151G A1 换模型写文件 ${run} R151S:a1m${run}`, mode: 'bypassPermissions', model: 'r151-reasoner', postMs: 45_000 });
    const delayed = await waitFor(() => modelLog(inst.ctl, T.sid).find((x) => x.action === 'delayed'), 10_000, 50);
    expect(delayed, `夹具生效:换模型请求被压住(换模型记录:${JSON.stringify(modelLog(inst.ctl, T.sid))})`).toBeTruthy();

    const sw = await switchMode(inst.c, T.sid, 'default', 25_000);
    const start = await chatP;
    expect(start.status, `前置:发出这条消息(${String(start.text).slice(0, 240)})`).toBe(200);
    const card = await waitCard(ws, T.sid, wid);
    const turn = turnsOf(inst.ctl, T.sid).find((x) => String(x.text).includes(`a1m${run}`)) || null;
    const proc = await procOf(inst.c, T.sid);
    expect({
      switchStatus: sw.status,
      switchWithin20s: sw.elapsed <= 20_000,
      modelSwitchWasDelayed: modelLog(inst.ctl, T.sid).filter((x) => x.action === 'delayed').length === 1,
      sameProcess: turn ? turn.pid === p1 : null,
      cliMode: turn && turn.mode,
      card: Boolean(card),
      fileBeforeConfirm: fs.existsSync(file),
    }, `切档应答原文:${String(sw.text).slice(0, 300)};用时 ${sw.elapsed}ms;这一回合 ${JSON.stringify(turn)};进程列表项 ${JSON.stringify(proc)};确认卡 ${JSON.stringify(card)}`)
      .toEqual({ switchStatus: 200, switchWithin20s: true, modelSwitchWasDelayed: true, sameProcess: true, cliMode: 'default', card: true, fileBeforeConfirm: false });
    if (card) await allowPerm(inst.c, card);
  } finally {
    ws.close();
    if (T) releaseAll(inst, T.sid);
    await inst.stop();
  }
});

test('A2 (相邻)行为2 同样换模型压住、期间不切档:这一回合按「放任」运行——模型写文件时不出现确认卡,文件直接写成', async () => {
  const inst = await startInst('a2');
  const ws = await wsT(inst.base);
  const run = uniq('');
  let T = null;
  const wid = `toolu_a2_w_${run}`;
  try {
    T = newT(inst, 'a2');
    const p1 = await resident(inst, T, { mode: 'bypassPermissions', model: 'r151-chat', note: `A2 第一回合 ${run}` });
    await settle(8_000);
    fxModelDelayFirst(inst.ctl, T.sid, p1, 4_000);
    const file = path.join(T.cwd, `a2-${run}.txt`);
    writeFileScript(inst, `a2m${run}`, file, wid);
    const start = await chatStart(inst.c, T, { prompt: `R151G A2 换模型写文件 ${run} R151S:a2m${run}`, mode: 'bypassPermissions', model: 'r151-reasoner', postMs: 45_000 });
    expect(start.status, `前置:发出这条消息(${String(start.text).slice(0, 240)})`).toBe(200);
    const delayed = await waitFor(() => modelLog(inst.ctl, T.sid).find((x) => x.action === 'delayed'), 10_000, 50);
    expect(delayed, `夹具生效:换模型请求被压住(换模型记录:${JSON.stringify(modelLog(inst.ctl, T.sid))})`).toBeTruthy();
    const written = await waitFor(() => fs.existsSync(file), 25_000, 100);
    await sleep(1_000);
    const turn = turnsOf(inst.ctl, T.sid).find((x) => String(x.text).includes(`a2m${run}`)) || null;
    expect({
      modelSwitchWasDelayed: Boolean(delayed),
      sameProcess: turn ? turn.pid === p1 : null,
      card: permRequests(ws, T.sid).filter((q) => q.toolUseID === wid).length,
      fileWritten: Boolean(written),
    }, `这一回合 ${JSON.stringify(turn)};确认卡记录 ${JSON.stringify(permRequests(ws, T.sid).map((q) => q.toolUseID))}`)
      .toEqual({ modelSwitchWasDelayed: true, sameProcess: true, card: 0, fileWritten: true });
  } finally {
    ws.close();
    if (T) releaseAll(inst, T.sid);
    await inst.stop();
  }
});

// ============================ B. 消息里的档位与切档结果对齐 ============================

test('B3 行为3 旧进程被推迟退出、用户以放任发消息要等它退出;等待期间切到逐步确认(回 200):这条消息起的新进程按逐步确认运行——写文件出现确认卡,确认前文件不存在', async () => {
  const inst = await startInst('b3');
  const ws = await wsT(inst.base);
  const run = uniq('');
  let T = null;
  const wid = `toolu_b3_w_${run}`;
  try {
    T = newT(inst, 'b3');
    const oldPid = await prepareOld(inst, T, { mode: 'bypassPermissions' });
    const file = path.join(T.cwd, `b3-${run}.txt`);
    writeFileScript(inst, `b3m${run}`, file, wid);
    // POST /api/chat 会等旧进程退出 / 新进程起来才回;先发出去,等待期间切档,最后才收应答。
    const chatP = chatStart(inst.c, T, { prompt: `R151G B3 写文件 ${run} R151S:b3m${run}`, mode: 'bypassPermissions', postMs: 45_000 });
    await sleep(700);
    const sw = await switchMode(inst.c, T.sid, 'default', 20_000);
    const start = await chatP;
    expect(start.status, `前置:发出这条消息(${String(start.text).slice(0, 240)})`).toBe(200);
    const card = await waitCard(ws, T.sid, wid);
    const turn = turnsOf(inst.ctl, T.sid).find((x) => String(x.text).includes(`b3m${run}`)) || null;
    expect({
      switchStatus: sw.status,
      switchWithin20s: sw.elapsed <= 20_000,
      newProcess: turn ? turn.pid !== oldPid : null,
      card: Boolean(card),
      fileBeforeConfirm: fs.existsSync(file),
    }, `切档应答原文:${String(sw.text).slice(0, 300)};旧进程 ${oldPid};这一回合 ${JSON.stringify(turn)};退出记录 ${JSON.stringify(exitLog(inst.ctl, T.sid).slice(-4))}`)
      .toEqual({ switchStatus: 200, switchWithin20s: true, newProcess: true, card: true, fileBeforeConfirm: false });
    if (card) await allowPerm(inst.c, card);
  } finally {
    ws.close();
    if (T) releaseAll(inst, T.sid);
    await inst.stop();
  }
});

test('B4 行为4 界面档位逐步确认、进程不回应切到自动的请求(超时 409);紧接着以自动发的这条消息排队,起的进程按回滚后的逐步确认运行——写文件出现确认卡,确认前文件不存在', async () => {
  const inst = await startInst('b4');
  const ws = await wsT(inst.base);
  const run = uniq('');
  let T = null;
  const wid = `toolu_b4_w_${run}`;
  try {
    T = newT(inst, 'b4');
    const p1 = await resident(inst, T, { mode: 'default', note: `B4 第一回合 ${run}` });
    await settle(8_000);
    expect(await procPids(inst.c, T.sid), '前置:T 恰有一个存活进程').toEqual([p1]);
    fxMute(inst.ctl, T.sid, p1);
    const file = path.join(T.cwd, `b4-${run}.txt`);
    writeFileScript(inst, `b4m${run}`, file, wid);
    const swP = switchMode(inst.c, T.sid, 'auto', 25_000);
    await sleep(200);
    const start = await chatStart(inst.c, T, { prompt: `R151G B4 排队写文件 ${run} R151S:b4m${run}`, mode: 'auto', postMs: 45_000 });
    expect(start.status, `前置:发出以自动档排队的这条消息(${String(start.text).slice(0, 240)})`).toBe(200);
    const sw = await swP;
    const card = await waitCard(ws, T.sid, wid);
    const turn = await waitFor(() => turnsOf(inst.ctl, T.sid).find((x) => String(x.text).includes(`b4m${run}`)) || null, 25_000, 100);
    expect({
      switchStatus: sw.status,
      switchErrorHasTimeout: /超时/.test(String(sw.body && sw.body.error)),
      newProcess: turn ? turn.pid !== p1 : null,
      cliMode: turn && turn.mode,
      card: Boolean(card),
      fileBeforeConfirm: fs.existsSync(file),
    }, `切档应答原文:${String(sw.text).slice(0, 300)};原进程 ${p1};这一回合 ${JSON.stringify(turn)};切档记录 ${JSON.stringify(switchLog(inst.ctl, T.sid))}`)
      .toEqual({ switchStatus: 409, switchErrorHasTimeout: true, newProcess: true, cliMode: 'default', card: true, fileBeforeConfirm: false });
    if (card) await allowPerm(inst.c, card);
  } finally {
    ws.close();
    if (T) releaseAll(inst, T.sid);
    await inst.stop();
  }
});

test('B5 (相邻)行为5 没有切档发生:以逐步确认发消息,模型写文件 → 出现确认卡,确认前文件不存在', async () => {
  const inst = await startInst('b5');
  const ws = await wsT(inst.base);
  const run = uniq('');
  let T = null;
  const wid = `toolu_b5_w_${run}`;
  try {
    T = newT(inst, 'b5');
    const p1 = await resident(inst, T, { mode: 'default', note: `B5 第一回合 ${run}` });
    await settle(8_000);
    const file = path.join(T.cwd, `b5-${run}.txt`);
    writeFileScript(inst, `b5m${run}`, file, wid);
    const start = await chatStart(inst.c, T, { prompt: `R151G B5 写文件 ${run} R151S:b5m${run}`, mode: 'default', postMs: 45_000 });
    expect(start.status, `前置:发出这条消息(${String(start.text).slice(0, 240)})`).toBe(200);
    const card = await waitCard(ws, T.sid, wid);
    const turn = turnsOf(inst.ctl, T.sid).find((x) => String(x.text).includes(`b5m${run}`)) || null;
    expect({
      sameProcess: turn ? turn.pid === p1 : null,
      card: Boolean(card),
      fileBeforeConfirm: fs.existsSync(file),
    }, `这一回合 ${JSON.stringify(turn)};确认卡 ${JSON.stringify(card)}`)
      .toEqual({ sameProcess: true, card: true, fileBeforeConfirm: false });
    if (card) await allowPerm(inst.c, card);
  } finally {
    ws.close();
    if (T) releaseAll(inst, T.sid);
    await inst.stop();
  }
});

// ============================ C. 复用热切期间的占位 ============================

test('C6 行为6 空闲进程被用户消息选中、热切到自动被压住 5 秒期间,跨会话发送方发来一条消息:这条消息没有被自动处理,会话始终只有一个进程、也没有为它起第二个回合', async () => {
  const inst = await startInst('c6');
  const run = uniq('');
  const cross = `R151G C6 cross ${run}`;
  let T = null;
  let sender = null;
  try {
    test.skip(!realCliPath(), '本机没有真 claude CLI(跨会话发送方要用真 CLI 调 send_message)');
    T = newT(inst, 'c6');
    const held = writeHeldScript(inst, `c6hold${run}`);
    await xs(inst.c, inst.home).on();
    const p1 = await resident(inst, T, { mode: 'default', note: `C6 第一回合 ${run}` });
    await settle(8_000);
    expect(await procPids(inst.c, T.sid), '前置:T 恰有一个存活进程').toEqual([p1]);
    await inboundOk(inst.c, T.sid, 'auto');
    const e = await entry(inst.c, T.sid);
    expect(e && e.hasProfile, `前置:T 有发送档案(${JSON.stringify(e)})`).toBe(true);
    sender = await startHeldSender(inst, T.sid, cross, { mode: 'default' });

    fxDelayFirst(inst.ctl, T.sid, p1, 4_000);
    // POST /api/chat 会等这次热切派发完才回;先发出去,压住期间再放行跨会话消息,最后才收应答。
    const userP = chatStart(inst.c, T, { prompt: `R151G C6 用户这一回合 ${run} R151S:${held.name}`, mode: 'auto', postMs: 60_000 });
    const delayed = await waitFor(() => switchLog(inst.ctl, T.sid).find((x) => x.action === 'delayed'), 10_000, 50);
    expect(delayed, `夹具生效:热切请求被压住(切档记录:${JSON.stringify(switchLog(inst.ctl, T.sid))})`).toBeTruthy();

    // 压住期间开始采样进程数;放行发送方的模型,让它立刻调 send_message。
    const samples = [];
    let sampling = true;
    const sampler = (async () => {
      while (sampling) { samples.push(await procPids(inst.c, T.sid).catch(() => [])); await sleep(150); }
    })();
    const t0 = Date.now();
    sender.fire();
    const m = await waitFor(async () => (await msgs(inst.c, T.sid)).find((x) => x.from && x.from.kind === 'session') || null, 3_000, 100);
    const foundAfterMs = Date.now() - t0;
    const switchPassedAtFind = switchLog(inst.ctl, T.sid).some((x) => x.action === 'delayed-passed');
    const crossTurnsAtFind = turnsOf(inst.ctl, T.sid).filter((t) => String(t.text).includes(cross)).length;

    // 等热切结束、用户这一回合真的在 p1 上跑起来,再看这条跨会话消息的最后样子。
    await waitFor(() => switchLog(inst.ctl, T.sid).some((x) => x.action === 'delayed-passed'), 20_000, 100);
    const userTurn = await waitFor(() => turnsOf(inst.ctl, T.sid).find((t) => String(t.text).includes(held.name)) || null, 25_000, 100);
    await sleep(1_000);
    sampling = false;
    await sampler;
    const user = await userP;
    expect(user.status, `前置:用户以自动档发这条消息(${String(user.text).slice(0, 240)})`).toBe(200);
    const fin = m ? (await msgs(inst.c, T.sid)).find((x) => x.id === m.id) || null : null;
    const maxPids = samples.reduce((n, pids) => Math.max(n, pids.length), 0);
    const onlyP1 = samples.every((pids) => pids.every((p) => p === p1));
    expect({
      switchDelayed: Boolean(delayed),
      messageArrivedWithin3sWhileSwitchPending: Boolean(m) && foundAfterMs <= 3_000 && !switchPassedAtFind,
      messageNotAutoProcessed: Boolean(m) && m.status !== 'done' && m.via !== 'auto',
      onlyOneProcessThroughout: onlyP1 && maxPids <= 1,
      noSecondTurnForCrossMessage: crossTurnsAtFind === 0,
      userTurnOnTheIdleProcess: userTurn ? userTurn.pid === p1 : null,
      stillNotAutoProcessed: fin ? fin.status !== 'done' && fin.via !== 'auto' : null,
    }, `跨会话消息:${JSON.stringify(m && { status: m.status, via: m.via, ids: [m.id] })};到达用时 ${foundAfterMs}ms;switchPassedAtFind=${switchPassedAtFind};m=${Boolean(m)}(采样 ${samples.length} 次,最多 ${maxPids} 个进程,pid 始终 ${p1}=${onlyP1});这一回合 ${JSON.stringify(userTurn)};切档记录 ${JSON.stringify(switchLog(inst.ctl, T.sid))}`)
      .toEqual({
        switchDelayed: true,
        messageArrivedWithin3sWhileSwitchPending: true,
        messageNotAutoProcessed: true,
        onlyOneProcessThroughout: true,
        noSecondTurnForCrossMessage: true,
        userTurnOnTheIdleProcess: true,
        stillNotAutoProcessed: true,
      });
  } finally {
    if (sender) await sender.finish();
    if (T) releaseAll(inst, T.sid);
    await inst.stop();
  }
});

test('C7 (相邻)行为7 热切完成、用户这一回合结束、进程回到空闲后,发送方再发一条:按既有规则自动处理(done、via:"auto")', async () => {
  const inst = await startInst('c7');
  const run = uniq('');
  const cross = `R151G C7 cross ${run}`;
  let T = null;
  try {
    test.skip(!realCliPath(), '本机没有真 claude CLI(跨会话发送方要用真 CLI 调 send_message)');
    T = newT(inst, 'c7');
    await xs(inst.c, inst.home).on();
    const p1 = await resident(inst, T, { mode: 'default', note: `C7 第一回合 ${run}` });
    await settle(8_000);
    await inboundOk(inst.c, T.sid, 'auto');
    const e = await entry(inst.c, T.sid);
    expect(e && e.hasProfile, `前置:T 有发送档案(${JSON.stringify(e)})`).toBe(true);

    // 用户把档位热切到自动并跑完这一回合。
    const hot = await chatStart(inst.c, T, { prompt: `R151G C7 热切这一回合 ${run}`, mode: 'auto', postMs: 45_000 });
    expect(hot.status, `前置:用户以自动档发这条消息(${String(hot.text).slice(0, 240)})`).toBe(200);
    await readStream(hot.body.pid, { timeoutMs: 25_000, base: inst.c.base });
    await settle(8_000);
    expect(await procPids(inst.c, T.sid), '前置:这一回合结束后仍是同一个空闲进程').toEqual([p1]);

    const S = { cwd: makeWorkspace(`real-g-c7-${run}`) };
    const sr = await sendFrom(inst.c, S, T.sid, cross, 'default');
    const done = await waitFor(async () => (await msgs(inst.c, T.sid)).find((x) => x.from && x.from.kind === 'session' && x.status === 'done' && x.via === 'auto') || null, 30_000, 200);
    const crossTurn = turnsOf(inst.ctl, T.sid).find((t) => String(t.text).includes(cross)) || null;
    expect({
      delivery: sr && sr.delivery,
      status: done && done.status,
      via: done && done.via,
      crossTurnStarted: Boolean(crossTurn),
    }, `发送方工具结果 ${JSON.stringify(sr)};这条消息 ${JSON.stringify(done && { status: done.status, via: done.via })};回合记录 ${JSON.stringify(crossTurn)}`)
      .toEqual({ delivery: 'auto', status: 'done', via: 'auto', crossTurnStarted: true });
  } finally {
    if (T) releaseAll(inst, T.sid);
    await inst.stop();
  }
});

// ============================ D. 界面切档超时(共享实例 + dev server) ============================

/** 共享实例里给一条新会话造一个存活进程;返回 { T, pid }。 */
async function sharedResident(tag, mode = 'bypassPermissions') {
  const T = newT({ home: homeDir() }, tag);
  const r = await chatStart(sharedC, T, { prompt: `R151G ${tag} 第一回合`, mode, postMs: 40_000 });
  expect(r.status, `前置:共享实例里 ${T.sid} 跑一个回合(${String(r.text).slice(0, 240)})`).toBe(200);
  if (r.body && r.body.pid) await readStream(r.body.pid, { timeoutMs: 25_000, base: sharedC.base });
  let pids = [];
  await waitFor(async () => { pids = await procPids(sharedC, T.sid); return pids.length === 1; }, 10_000, 200);
  expect(pids.length, '前置:共享实例里这条会话恰有一个存活进程').toBe(1);
  await sleep(8_000);
  return { T, pid: pids[0] };
}

test('D8 行为8 界面上把放任切到逐步确认、CLI 一直不回应:界面在 10–30 秒内退回放任,选择器上方出现含服务端错误原文(含"超时")的一行,全程不会停在逐步确认', async ({ page }) => {
  test.skip(!process.env.R151B_UI_BASE || !process.env.R151B_CTL, '需要 run.sh 起的共享实例 + dev server');
  const { T, pid } = await sharedResident('d8');
  await boot(page);
  await openSessionBySearch(page, T.title, T.reply);
  await chooseMode(page, 'bypassPermissions');
  await expect(selector(page), '前置:界面档位是放任').toContainText('放任', { timeout: 15_000 });
  await sleep(500);
  const pids = await procPids(sharedC, T.sid);
  expect(pids, '前置:切到放任后仍是同一个存活进程').toEqual([pid]);
  fxMute(process.env.R151B_CTL, T.sid, pid);

  const t0 = Date.now();
  await chooseMode(page, 'default');
  let noticeText = null;
  let atMs = null;
  while (Date.now() - t0 < 30_000) {
    const texts = await page.getByText(/档位未切换/).allInnerTexts().catch(() => []);
    if (texts.length) { noticeText = texts.join(' | '); atMs = Date.now() - t0; break; }
    await page.waitForTimeout(250);
  }
  const finalSelector = await selector(page).innerText().catch(() => '');
  expect({
    noticeSeen: Boolean(noticeText),
    noticeHasServerError: /档位未切换\s*[:：]\s*\S+/.test(String(noticeText)) && String(noticeText).includes('超时'),
    rolledBackToBypass: /放任/.test(finalSelector) && !/逐步确认/.test(finalSelector),
    within10to30s: Boolean(noticeText) && atMs !== null && atMs >= 10_000 && atMs <= 30_000,
    notStuckOnDefault: Boolean(noticeText) && /放任/.test(finalSelector),
  }, `提示原文:${JSON.stringify(noticeText)};出现用时 ${atMs}ms;最终选择器 ${JSON.stringify(finalSelector)};进程 ${pid}`)
    .toEqual({ noticeSeen: true, noticeHasServerError: true, rolledBackToBypass: true, within10to30s: true, notStuckOnDefault: true });
});

test('D9 (相邻)行为9 CLI 正常回应切档:界面上把放任切到逐步确认 → 显示逐步确认,没有"档位未切换"提示', async ({ page }) => {
  test.skip(!process.env.R151B_UI_BASE || !process.env.R151B_CTL, '需要 run.sh 起的共享实例 + dev server');
  const { T } = await sharedResident('d9');
  await boot(page);
  await openSessionBySearch(page, T.title, T.reply);
  await chooseMode(page, 'bypassPermissions');
  await expect(selector(page), '前置:界面档位是放任').toContainText('放任', { timeout: 15_000 });
  await chooseMode(page, 'default');
  await expect(selector(page), '切档后界面应显示逐步确认').toContainText('逐步确认', { timeout: 15_000 });
  await sleep(2_000);
  const notices = await page.getByText(/档位未切换/).allInnerTexts().catch(() => []);
  expect({ selector: await selector(page).innerText(), notices }, `选择器 ${JSON.stringify(await selector(page).innerText())};提示 ${JSON.stringify(notices)}`)
    .toEqual({ selector: expect.stringContaining('逐步确认'), notices: [] });
});

// ============================ E. 冷启等待已发起中止的进程 ============================

test('E10 行为10 空闲进程带着活的后台命令、热切不回应被中止(5 秒):之后再发一条消息,新进程的启动时刻晚于旧进程退出时刻(同一会话不会在旧进程还活着时同时 --resume)', async () => {
  const inst = await startInst('e10');
  const run = uniq('');
  let T = null;
  try {
    T = newT(inst, 'e10');
    const bgId = `toolu_e10_bg_${run}`;
    const taskId = `e10task${run}`;
    writeScript(`e10a${run}`, [
      { toolUse: { id: bgId, name: 'Bash', input: { command: 'sleep 120', description: 'sleep 120', run_in_background: true } } },
      { toolResult: { tool_use_id: bgId, content: `Command running in background with ID: ${taskId}` } },
      { say: 'R151G E10 老进程的回合完(后台命令还在跑)' },
    ], inst.ctl);
    fxBgTask(inst.ctl, T.sid, { toolUseId: bgId, taskId, description: 'sleep 120' });
    const p1 = await resident(inst, T, { mode: 'default', note: `E10 建立进程 ${run} R151S:e10a${run}` });
    await settle(8_000);
    expect(await procPids(inst.c, T.sid), '前置:T 恰有一个存活的空闲进程').toEqual([p1]);
    // 旧进程:被后台命令吊着;被中止时先无视终止信号,1 秒后才真正退出(造"已发起中止、还会活一会儿"的窗口)。
    // 取 1 秒是为了让它在宿主 4 秒等待上限内稳稳退掉,别和上限卡在同一时刻竞赛。
    fxHold(inst.ctl, p1, { signals: true, exitAfterMs: 1_000 });
    fxMute(inst.ctl, T.sid, p1);

    // 热切不回应 → 5 秒后旧进程被中止。
    const hot = await chatStart(inst.c, T, { prompt: `R151G E10 热切这一条 ${run}`, mode: 'auto', postMs: 60_000 });
    expect(hot.status, `前置:发出要热切的这条消息(${String(hot.text).slice(0, 240)})`).toBe(200);

    // 旧进程"真正退出"的时刻取夹具自己的权威记录:退出前写下的 ev:"exit" 行的 t(毫秒)。
    // pidGoneAt 只兜底确认"确实没了"(Boolean),不再参与时刻比较 —— 它每 50ms 才 kill(pid,0) 轮询一次,
    // pid 从进程退出到 kill(0) 观察不到还有几毫秒延迟,拿它当退出时刻会把 3–5ms 的测量噪声误判成行为错误。
    const gone = Boolean(await pidGoneAt(p1, 25_000));
    const p1Exit = exitLog(inst.ctl, T.sid).filter((x) => x.pid === p1 && x.ev === 'exit').pop() || null;
    const oldExitedAt = p1Exit ? Number(p1Exit.t) : null;
    expect({ oldProcessGone: gone, oldExitRecorded: oldExitedAt !== null },
      `旧进程 ${p1} 应在中止后自行退出并留下退出记录(退出记录:${JSON.stringify(exitLog(inst.ctl, T.sid).filter((x) => x.pid === p1).slice(-6))})`)
      .toEqual({ oldProcessGone: true, oldExitRecorded: true });

    // 热切那条消息自己起的新进程:它的启动时刻也必须晚于旧进程退出时刻。
    const firstNew = await waitFor(() => spawnRecords(inst.ctl).find((x) => x.sid === T.sid && x.interactive && x.pid !== p1) || null, 30_000, 100);
    const firstNewAt = firstNew ? Date.parse(firstNew.at) : null;

    // 之后再发一条(任何档位):它起的进程同样必须在旧进程退出之后才启动。
    const next = await chatStart(inst.c, T, { prompt: `R151G E10 之后这一条 ${run}`, mode: 'default', postMs: 60_000 });
    expect(next.status, `前置:再发一条(${String(next.text).slice(0, 240)})`).toBe(200);
    const turn = await waitFor(() => turnsOf(inst.ctl, T.sid).find((t) => String(t.text).includes(`E10 之后这一条 ${run}`)) || null, 25_000, 100);
    const newPid = turn && turn.pid;
    const newAt = newPid ? spawnAt(inst.ctl, newPid) : null;
    expect({
      oldProcessGone: gone && oldExitedAt !== null,
      newProcess: Boolean(newPid) && newPid !== p1,
      firstNewProcessStartedAfterOldExited: firstNewAt !== null && oldExitedAt !== null ? firstNewAt >= oldExitedAt : null,
      laterProcessStartedAfterOldExited: newAt !== null && oldExitedAt !== null ? newAt >= oldExitedAt : null,
    }, `旧进程 ${p1} 退出于 ${oldExitedAt}(夹具退出记录;pidGoneAt 观察=${gone});热切那条起的新进程 ${firstNew && firstNew.pid} 启动于 ${firstNewAt};之后那条的进程 ${newPid} 启动于 ${newAt};退出记录 ${JSON.stringify(exitLog(inst.ctl, T.sid).filter((x) => x.pid === p1).slice(-6))};回合记录 ${JSON.stringify(turn)}`)
      .toEqual({ oldProcessGone: true, newProcess: true, firstNewProcessStartedAfterOldExited: true, laterProcessStartedAfterOldExited: true });
  } finally {
    if (T) releaseAll(inst, T.sid);
    await inst.stop();
  }
});

// ============================ F. 回合记录终态 ============================

test('F11 行为11 常驻进程跑着带 clientTurnId 的回合、不回应切档 → 该回合被中止;用同一个 clientTurnId 同样参数重发,回执 status 是 "stopped"', async () => {
  const inst = await startInst('f11');
  const run = uniq('');
  const ctid = `r151g-f11-${run}`;
  let T = null;
  try {
    T = newT(inst, 'f11');
    const held = writeHeldScript(inst, `f11held${run}`);
    const body = { prompt: `R151G F11 压着 ${run} R151S:${held.name}`, mode: 'default', clientTurnId: ctid };
    const first = await chatStart(inst.c, T, { ...body, postMs: 60_000 });
    expect(first.status, `前置:发出带 clientTurnId 的回合(${String(first.text).slice(0, 240)})`).toBe(200);
    const pid = await waitFor(() => { const t = turnsOf(inst.ctl, T.sid); return t.length ? t[t.length - 1].pid : null; }, 15_000, 100);
    expect(pid, '前置:这一回合在常驻进程上跑起来').toBeTruthy();
    fxMute(inst.ctl, T.sid, pid);
    const sw = await switchMode(inst.c, T.sid, 'auto', 25_000);
    expect(sw.status, `前置:切档没回应应回 409(${String(sw.text).slice(0, 240)})`).toBe(409);
    await pidGoneAt(pid, 15_000);
    const again = await chatStart(inst.c, T, { ...body, postMs: 30_000 });
    expect({
      switchStatus: sw.status,
      resendStatus: again.status,
      receiptStatus: again.body && again.body.status,
      duplicated: again.body && again.body.duplicated,
    }, `重发应答原文:${String(again.text).slice(0, 300)};切档应答:${String(sw.text).slice(0, 240)}`)
      .toEqual({ switchStatus: 409, resendStatus: 200, receiptStatus: 'stopped', duplicated: true });
  } finally {
    if (T) releaseAll(inst, T.sid);
    await inst.stop();
  }
});

test('F12 行为12 常驻进程跑着带 clientTurnId 的回合,随后改动让进程不能复用的设置、再发一条消息(宿主冷启前中止收尾中的旧进程):用旧回合的 clientTurnId 重发,回执 status 是 "stopped"(不是 "completed")', async () => {
  const inst = await startInst('f12');
  const run = uniq('');
  const ctid = `r151g-f12-${run}`;
  let T = null;
  try {
    T = newT(inst, 'f12');
    const held = writeHeldScript(inst, `f12held${run}`);
    const body = { prompt: `R151G F12 压着 ${run} R151S:${held.name}`, mode: 'default', clientTurnId: ctid };
    const first = await chatStart(inst.c, T, { ...body, postMs: 60_000 });
    expect(first.status, `前置:发出带 clientTurnId 的回合(${String(first.text).slice(0, 240)})`).toBe(200);
    const pid = await waitFor(() => { const t = turnsOf(inst.ctl, T.sid); return t.length ? t[t.length - 1].pid : null; }, 15_000, 100);
    expect(pid, '前置:这一回合在常驻进程上跑起来').toBeTruthy();
    // 让进程不能复用:改临时 HOME 下的 .claude/settings.json(内容与修改时间都变)。
    touchSettings(inst.home);
    const second = await chatStart(inst.c, T, { prompt: `R151G F12 之后这一条 ${run}`, mode: 'default', postMs: 45_000 });
    expect(second.status, `前置:再发一条消息(${String(second.text).slice(0, 240)})`).toBe(200);
    const newTurn = await waitFor(() => turnsOf(inst.ctl, T.sid).find((t) => String(t.text).includes(`F12 之后这一条 ${run}`)) || null, 25_000, 100);
    expect(newTurn, '前置:这条消息起了新进程').toBeTruthy();
    expect(newTurn.pid, '前置:这条消息由另一个进程处理').not.toBe(pid);
    await pidGoneAt(pid, 20_000);
    const again = await chatStart(inst.c, T, { ...body, postMs: 30_000 });
    expect({
      secondStatus: second.status,
      oldTurnResendStatus: again.status,
      receiptStatus: again.body && again.body.status,
      duplicated: again.body && again.body.duplicated,
    }, `重发应答原文:${String(again.text).slice(0, 300)};旧进程 ${pid} / 新进程 ${newTurn && newTurn.pid};退出记录 ${JSON.stringify(exitLog(inst.ctl, T.sid).filter((x) => x.pid === pid).slice(-4))}`)
      .toEqual({ secondStatus: 200, oldTurnResendStatus: 200, receiptStatus: 'stopped', duplicated: true });
  } finally {
    if (T) releaseAll(inst, T.sid);
    await inst.stop();
  }
});
