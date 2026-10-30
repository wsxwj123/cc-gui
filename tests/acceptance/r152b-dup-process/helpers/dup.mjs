// r152b 本套件辅助(只走 HTTP / 文件 / 外部进程记录,不 import 产品代码)。在 r.mjs(r151g 辅助的副本)之上加:
//   · 按需发"后台任务终态通知"(fx-claude.mjs 的 bgend 控制文件)与它的记录;
//   · GET /api/agents/active 里某会话的 chat-process 条目(接口文件定义的"进程数");
//   · 造"进程空闲、手上带着没结束的后台任务"的前置场景、发第二条消息、把可观察事实收成一个对象。
import { expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { spawnRecords, waitFor, writeScript, readStream } from '../../r151b-xsession-p1/helpers/api.mjs';
import { settle, chatStart, waitTurn, fxBgTask, fxHold, procPids, turnsOf, lastTurnPid, exitLog, pidGoneAt } from './r.mjs';

const jsonl = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
/** 让会话 sid 的进程(opts.pid)吐一条后台任务终态通知(opts = { pid, taskId, toolUseId, status?, summary? })。 */
export const fxBgEnd = (ctl, sid, opts) => {
  const d = path.join(ctl, 'r152b', 'bgend');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, String(sid)), JSON.stringify(opts));
};
export const bgEndLog = (ctl, sid) => jsonl(path.join(ctl, 'r152b-bgend.jsonl')).filter((x) => !sid || x.sid === sid);
/** 进程 pid 还活着(存在即真,没权限也算活着)。 */
export const alive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch (e) { return !(e && e.code === 'ESRCH'); } };

/** GET /api/agents/active 里该会话的 chat-process 条目(= 接口文件说的"进程数"的数据来源)。 */
export async function activeProcs(c, sid) {
  const r = await c.get('/api/agents/active');
  expect(r.status, `GET /api/agents/active 应 200(${r.text.slice(0, 200)})`).toBe(200);
  const list = r.body && Array.isArray(r.body.agents) ? r.body.agents : [];
  return list.filter((x) => x && x.kind === 'chat-process' && x.sessionId === sid).map((x) => ({ pid: x.pid, status: x.status, permissionMode: x.permissionMode }));
}
/** 条目状态为 done / error = 进程已经没了、条目只是留着给监控面板看,不算"进程"(2026-10-30 实测:旧进程退出后条目会留一阵,状态见失败信息里的"进程条目")。 */
const TERMINAL = new Set(['done', 'error']);
let lastActive = [];
/** 最近一次读到的该会话全部 chat-process 条目(含已结束的),拼进失败信息里。 */
export const lastActiveJson = () => JSON.stringify(lastActive);
/** 最多等 ms 毫秒让"还活着的条目"数到 n;返回最后一次读到的活条目(没到 n 也返回,由调用方断言)。 */
export async function activeSettled(c, sid, n, ms = 10_000) {
  let live = [];
  await waitFor(async () => { lastActive = await activeProcs(c, sid); live = lastActive.filter((x) => !TERMINAL.has(x.status)); return live.length === n; }, ms, 200);
  return live;
}

/**
 * 第一回合:T 用 effort 档跑一个回合(模型 r151-chat、档位 default);bg = 'bash' | 'agent' | null:回合里起一个后台命令 / 后台子代理,
 * 且不报它结束;回合结束后留 8 秒空闲(宿主把它当空闲进程)。返回 { r1, p1, bgIds }。
 * holdOld:true = 造"旧进程被还活着的后台任务吊着":宿主关它的输入它也不退(信号能结束它);用例 finally 里 releaseAll 放行。
 * 修复前,配置不一致的第二条会关旧开新,而被吊着的旧进程退不掉 → 同一会话两个进程(本轮要消除的"重复进程");修复后第二条不关它。
 */
export async function idleProcess(inst, T, { tag, run, bg = 'bash', effort = 'low', mode = 'default', model = 'r151-chat', holdOld = false }) {
  const bgIds = { toolUseId: `toolu_${tag}_bg_${run}`, taskId: `${tag}task${run}` };
  const name = `${tag}a${run}`;
  if (bg) {
    const agent = bg === 'agent';
    const desc = agent ? 'R152B 后台子代理' : 'sleep 120';
    writeScript(name, [
      agent
        ? { toolUse: { id: bgIds.toolUseId, name: 'Task', input: { description: desc, prompt: '等一会儿再汇报', subagent_type: 'general-purpose', run_in_background: true } } }
        : { toolUse: { id: bgIds.toolUseId, name: 'Bash', input: { command: 'sleep 120', description: desc, run_in_background: true } } },
      { toolResult: { tool_use_id: bgIds.toolUseId, content: agent ? `Async agent launched successfully.\nagentId: ${bgIds.taskId}` : `Command running in background with ID: ${bgIds.taskId}` } },
      { say: `R152B ${tag} 第一回合完(后台${agent ? '子代理' : '命令'}还在跑)` },
    ], inst.ctl);
    fxBgTask(inst.ctl, T.sid, { ...bgIds, description: desc, ...(agent ? { kind: 'agent' } : {}) });
  }
  const r1 = await chatStart(inst.c, T, { prompt: `R152B ${tag} 第一回合 ${run}${bg ? ` R151S:${name}` : ''}`, mode, model, extra: { effort }, postMs: 40_000 });
  expect(r1.status, `前置:第一回合发出(${String(r1.text).slice(0, 240)})`).toBe(200);
  if (r1.body && r1.body.pid) await readStream(r1.body.pid, { timeoutMs: 25_000, base: inst.c.base });
  const p1 = lastTurnPid(inst.ctl, T.sid);
  expect(p1, `前置:假 claude 记下了第一回合的进程号(回合记录:${JSON.stringify(turnsOf(inst.ctl, T.sid).slice(-2))})`).toBeTruthy();
  await settle(8_000);
  expect(await procPids(inst.c, T.sid), '前置:T 恰有一个存活的空闲进程,就是跑第一回合的那个').toEqual([p1]);
  if (holdOld) fxHold(inst.ctl, p1, { signals: true });
  return { r1, p1, bgIds };
}
/** 再发一条消息(label 区分第几条);effort 不给 = 不带。返回 { r2, marker }。 */
export async function sendSecond(inst, T, { tag, run, label = '第二条', mode = 'default', model = 'r151-chat', effort, extra = {}, scriptName, postMs = 45_000 }) {
  const marker = `R152B ${tag} ${label} ${run}`;
  const r2 = await chatStart(inst.c, T, { prompt: `${marker}${scriptName ? ` R151S:${scriptName}` : ''}`, mode, model, extra: { ...(effort ? { effort } : {}), ...extra }, postMs });
  return { r2, marker };
}

const has = (b, k) => Object.prototype.hasOwnProperty.call(b, k);
const firstRespPid = (r1) => (r1 && r1.body ? r1.body.pid : undefined);
/** 第二条消息发出后"沿用原进程"的可观察事实(B1/B2/B3/B6/B7 共用)。 */
export async function observeSameProcess(inst, T, { p1, r1, r2, marker }) {
  const b = (r2 && r2.body) || {};
  const turn = await waitTurn(inst, T, marker, 20_000);
  const active = await activeSettled(inst.c, T.sid, 1, 6_000);
  return {
    status: r2 && r2.status,
    reused: b.reused,
    configDeferred: b.configDeferred,
    hasConfigDeferredKey: has(b, 'configDeferred'),
    responsePidUnchanged: b.pid !== undefined && b.pid === firstRespPid(r1),
    turnRanOnOriginalProcess: turn ? turn.pid === p1 : null,
    activeCount: active.length,
    osProcesses: await procPids(inst.c, T.sid),
    interactiveSpawns: spawnRecords(inst.ctl).filter((x) => x.sid === T.sid && x.interactive).map((x) => x.pid),
    originalStillAlive: alive(p1),
    originalNeverAskedToExit: exitLog(inst.ctl, T.sid).filter((e) => e.pid === p1).length === 0,
  };
}
/** deferred = true:接口要求的 reused:true + configDeferred:true;false:配置一致的复用(reused:true,没有 configDeferred 这个字段)。 */
export const sameProcessExpected = (p1, deferred) => ({
  status: 200, reused: true, configDeferred: deferred ? true : undefined, hasConfigDeferredKey: Boolean(deferred),
  responsePidUnchanged: true, turnRanOnOriginalProcess: true, activeCount: 1, osProcesses: [p1], interactiveSpawns: [p1],
  originalStillAlive: true, originalNeverAskedToExit: true,
});

/** 第二条消息发出后"关旧开新"的可观察事实(B4/B5/B8 共用)。checkReused:false 时不比 reused(B8 修复前第三条会复用第二条起的新进程,接口对 B8 只要求关旧开新 + 进程数为 1)。 */
export async function observeReplaced(inst, T, { p1, r1, r2, marker, checkReused = true }) {
  const b = (r2 && r2.body) || {};
  const turn = await waitTurn(inst, T, marker, 25_000);
  const goneAt = await pidGoneAt(p1, 20_000);
  const active = await activeSettled(inst.c, T.sid, 1, 12_000);
  const osPids = await procPids(inst.c, T.sid);
  const facts = {
    status: r2 && r2.status,
    noConfigDeferredKey: !has(b, 'configDeferred'),
    responsePidChanged: b.pid !== undefined && b.pid !== firstRespPid(r1),
    turnRanOnNewProcess: Boolean(turn) && turn.pid !== p1,
    oldProcessGone: goneAt !== null,
    activeCount: active.length,
    onlyTheNewProcessIsAlive: osPids.length === 1 && osPids[0] !== p1 && Boolean(turn) && osPids[0] === turn.pid,
  };
  if (checkReused) facts.reusedIsNotTrue = b.reused !== true;
  return facts;
}
export const replacedExpected = (checkReused = true) => ({
  status: 200, noConfigDeferredKey: true, responsePidChanged: true, turnRanOnNewProcess: true, oldProcessGone: true, activeCount: 1,
  onlyTheNewProcessIsAlive: true, ...(checkReused ? { reusedIsNotTrue: true } : {}),
});

/** B10:不沿用(关旧开新),但不看旧进程退没退(旧进程因后台命令继续活着是已知现状);新进程要在新的工作目录 cwd2 里起。 */
export async function observeNotReused(inst, T, { p1, r1, r2, marker, cwd2 }) {
  const b = (r2 && r2.body) || {};
  const turn = await waitTurn(inst, T, marker, 25_000);
  const real = (d) => { try { return fs.realpathSync(d); } catch { return d; } };
  const mine = turn ? spawnRecords(inst.ctl).find((x) => x.sid === T.sid && x.interactive && x.pid === turn.pid) : null;
  return {
    status: r2 && r2.status,
    reusedIsNotTrue: b.reused !== true,
    noConfigDeferredKey: !has(b, 'configDeferred'),
    responsePidChanged: b.pid !== undefined && b.pid !== firstRespPid(r1),
    turnRanOnNewProcess: Boolean(turn) && turn.pid !== p1,
    newProcessStartedInRequestedCwd: Boolean(mine) && real(mine.cwd) === real(cwd2),
  };
}
export const notReusedExpected = () => ({
  status: 200, reusedIsNotTrue: true, noConfigDeferredKey: true, responsePidChanged: true, turnRanOnNewProcess: true, newProcessStartedInRequestedCwd: true,
});
