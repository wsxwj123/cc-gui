// r199 一个会话同一时刻只有一个命令行进程 —— 接口层验收。依据 .devflow/r199-session-one-proc-接口.md 的行为清单。
// 用例标题里的 [第N条] 是覆盖的行为号。断言一律把可观察事实收成一个对象一次比较(失败时对象 diff 直接看出哪一项不对)。
// 第 10、11、13 条由 r152b-dup-process 的 B1 / B5 / B10 覆盖,这里不重写。第 3、5 条里"用真命令行 + 本机假上游时请求里有什么"由主会话另行验证。
import { test, expect } from '@playwright/test';
import {
  sleep, uniq, newSession, newWorkspace, chat, http, openStream, isText, isResult, isDone, isCompactDone, waitFor,
  osProcs, procsSettled, turnStarts, turnEnds, inputsOf, alive, writeScript, touchFile, fxHold, fxRelease, cleanupSession,
  primeProcess, startAutoTurn, waitAutoEnd,
} from './helpers/lib.mjs';

test.describe.configure({ timeout: 200_000 });

const BUSY_NEW = 'CHAT_SESSION_BUSY';
const raw = (r) => `应答原文:${String(r && r.text).slice(0, 400)}`;

test('A1 [第1、2、3、15条] 后台命令还在跑、命令行自己接着回复时发 /compact:约 4 秒后回 409 session-turn-running(带进程号),进程数仍 1;那一轮结束后同一个 clientTurnId 重发 200 复用同一进程并出现压缩完成事件;再发普通消息仍复用', async () => {
  const T = newSession('a1');
  try {
    const { pid1, taskIds } = await primeProcess(T, { bgTasks: 2 });
    await startAutoTurn(T, { taskId: taskIds[1], sleepMs: 10_000 });
    await sleep(800);
    const clientTurnId = `ct-${uniq()}`;
    const r409 = await chat(T, '/compact', { clientTurnId }, 20_000);
    const facts409 = {
      status: r409.status,
      ok: r409.body && r409.body.ok,
      code: r409.body && r409.body.code,
      reason: r409.body && r409.body.reason,
      pid: r409.body && r409.body.pid,
      error: r409.body && r409.body.error,
      elapsedWithin3500to5500ms: r409.ms >= 3_500 && r409.ms <= 5_500,
      processCount: osProcs(T.sid).length,
      compactReachedCli: inputsOf(T.sid).some((x) => String(x.content).startsWith('/compact')),
    };
    expect(facts409, `发出到应答 ${r409.ms}ms;${raw(r409)}`).toEqual({
      status: 409, ok: false, code: BUSY_NEW, reason: 'session-turn-running', pid: pid1, error: '会话这一轮还在运行',
      elapsedWithin3500to5500ms: true, processCount: 1, compactReachedCli: false,
    });

    expect(await waitAutoEnd(T, 1, 30_000), '前置:命令行自己接着回复的那一段结束').toBeTruthy();
    await sleep(300);
    const r2 = await chat(T, '/compact', { clientTurnId }, 20_000);
    expect({ status: r2.status, reused: r2.body && r2.body.reused, samePid: r2.body && r2.body.pid === pid1 }, `同一 clientTurnId 重发;${raw(r2)}`)
      .toEqual({ status: 200, reused: true, samePid: true });
    const s2 = openStream(r2.body.pid);
    const compact = await s2.waitFor(isCompactDone, 15_000);
    const done2 = await s2.waitFor(isDone, 15_000);
    s2.abort();
    expect({ compactEvent: Boolean(compact), processCount: osProcs(T.sid).length }, `回合流事件:${s2.summary()}`).toEqual({ compactEvent: true, processCount: 1 });
    expect(done2, '前置:压缩这一轮结束').toBeTruthy();

    await sleep(300);
    const r3 = await chat(T, `R199 a1 压缩后的普通消息 ${uniq()}`, {}, 20_000);
    expect({ status: r3.status, reused: r3.body && r3.body.reused, samePid: r3.body && r3.body.pid === pid1, processCount: osProcs(T.sid).length }, raw(r3))
      .toEqual({ status: 200, reused: true, samePid: true, processCount: 1 });
  } finally { await cleanupSession(T); }
});

test('A2 [第4、5条] 上一轮回复已出完、结果还没出,下一条 B 发来,上一轮 4 秒内结束:B 应答 200 复用同一进程、由同一系统进程处理,进程数 1;B 结束后再发 C 仍同一进程', async () => {
  const T = newSession('a2');
  try {
    const { pid1 } = await primeProcess(T, { bgTasks: 0 });
    writeScript(`${T.tag}-b`, [{ say: 'R199 A2 回复已出' }, { sleep: 2_500 }]);
    const rA = await chat(T, `R199 ${T.tag} A R199S:${T.tag}-b`);
    expect({ status: rA.status, samePid: rA.body && rA.body.pid === pid1 }, `前置:上一轮 A 发出并复用空闲进程;${raw(rA)}`).toEqual({ status: 200, samePid: true });
    const sA = openStream(rA.body.pid);
    expect(await sA.waitFor(isText('R199 A2 回复已出'), 8_000), `前置:A 的回复已出(${sA.summary()})`).toBeTruthy();
    expect({ resultSeen: sA.has(isResult), doneSeen: sA.has(isDone) }, '前置:这一轮还没结束').toEqual({ resultSeen: false, doneSeen: false });
    const markerB = `R199 ${T.tag} B ${uniq()}`;
    const rB = await chat(T, markerB, {}, 20_000);
    sA.abort();
    const aOs = (turnStarts(T.sid, `${T.tag} A`)[0] || {}).pid;
    const turnB = await waitFor(() => turnStarts(T.sid, markerB)[0] || null, 15_000, 100);
    expect({ status: rB.status, reused: rB.body && rB.body.reused, samePid: rB.body && rB.body.pid === pid1, ranOnSameProcess: Boolean(turnB) && turnB.pid === aOs, processCount: osProcs(T.sid).length }, raw(rB))
      .toEqual({ status: 200, reused: true, samePid: true, ranOnSameProcess: true, processCount: 1 });

    expect(await waitFor(() => turnEnds(T.sid, markerB).length > 0, 20_000, 100), '前置:B 这一轮结束').toBeTruthy();
    await sleep(1_500);
    const markerC = `R199 ${T.tag} C ${uniq()}`;
    const rC = await chat(T, markerC, {}, 20_000);
    const turnC = await waitFor(() => turnStarts(T.sid, markerC)[0] || null, 15_000, 100);
    expect({ status: rC.status, samePid: rC.body && rC.body.pid === pid1, ranOnSameProcess: Boolean(turnC) && turnC.pid === aOs, processCount: osProcs(T.sid).length }, raw(rC))
      .toEqual({ status: 200, samePid: true, ranOnSameProcess: true, processCount: 1 });
  } finally { await cleanupSession(T); }
});

test('A3 [第19条] 上一轮结果已出、还在等输入预测(没收到结束事件)时发下一条:应答 200 复用同一进程,进程数 1', async () => {
  const T = newSession('a3');
  try {
    // 第一回合也开输入预测:输入预测开关是进程的配置之一,和后面几条不一致会被当成"改配置"关旧开新,本条要测的不是这个
    const { pid1 } = await primeProcess(T, { bgTasks: 0, extra: { promptSuggestions: true } });
    const rA = await chat(T, `R199 ${T.tag} A ${uniq()}`, { promptSuggestions: true });
    expect({ status: rA.status, samePid: rA.body && rA.body.pid === pid1 }, `前置:上一轮发出;${raw(rA)}`).toEqual({ status: 200, samePid: true });
    const sA = openStream(rA.body.pid);
    expect(await sA.waitFor(isResult, 10_000), `前置:结果已出(${sA.summary()})`).toBeTruthy();
    expect(sA.has(isDone), '前置:还没收到结束事件(在等输入预测)').toBe(false);
    const markerB = `R199 ${T.tag} B ${uniq()}`;
    const rB = await chat(T, markerB, { promptSuggestions: true }, 20_000);
    sA.abort();
    const turnB = await waitFor(() => turnStarts(T.sid, markerB)[0] || null, 15_000, 100);
    const aOs = (turnStarts(T.sid, `${T.tag} A`)[0] || {}).pid;
    expect({ status: rB.status, reused: rB.body && rB.body.reused, samePid: rB.body && rB.body.pid === pid1, ranOnSameProcess: Boolean(turnB) && turnB.pid === aOs, processCount: osProcs(T.sid).length }, raw(rB))
      .toEqual({ status: 200, reused: true, samePid: true, ranOnSameProcess: true, processCount: 1 });
  } finally { await cleanupSession(T); }
});

test('A5 [第12条] (回归)上一轮上游回复慢、手上没有后台命令、4 秒内没结束时发下一条:照旧中止上一轮,新进程处理这条——200、进程号变了、旧进程退出、进程数 1', async () => {
  const T = newSession('a5');
  const goFile = `${T.tag}-go`;
  try {
    const { pid1 } = await primeProcess(T, { bgTasks: 0 });
    writeScript(`${T.tag}-slow`, [{ say: 'R199 A5 上游回复慢,先出一半' }, { waitFile: goFile }]);
    const rA = await chat(T, `R199 ${T.tag} A R199S:${T.tag}-slow`);
    expect({ status: rA.status, samePid: rA.body && rA.body.pid === pid1 }, `前置:慢的一轮发出;${raw(rA)}`).toEqual({ status: 200, samePid: true });
    const startA = await waitFor(() => turnStarts(T.sid, `${T.tag} A`)[0] || null, 10_000, 100);
    expect(startA, '前置:慢的一轮在命令行里开始了').toBeTruthy();
    await sleep(1_000);
    const markerB = `R199 ${T.tag} B ${uniq()}`;
    const rB = await chat(T, markerB, {}, 40_000);
    const turnB = await waitFor(() => turnStarts(T.sid, markerB)[0] || null, 20_000, 100);
    const oldGone = await waitFor(() => !alive(startA.pid), 30_000, 200);
    const live = await procsSettled(T.sid, 1, 20_000);
    expect({ status: rB.status, pidChanged: Boolean(rB.body) && rB.body.pid !== pid1, ranOnNewProcess: Boolean(turnB) && turnB.pid !== startA.pid, oldProcessGone: Boolean(oldGone), processCount: live.length }, raw(rB))
      .toEqual({ status: 200, pidChanged: true, ranOnNewProcess: true, oldProcessGone: true, processCount: 1 });
  } finally { await cleanupSession(T, [goFile]); }
});

test('A6 [第14条] (回归)普通连续对话,每一轮结束后再发下一条,连发 3 条:每条都 reused:true、进程号始终不变,进程数 1', async () => {
  const T = newSession('a6');
  try {
    const { pid1 } = await primeProcess(T, { bgTasks: 0 });
    const facts = [];
    for (let i = 1; i <= 3; i += 1) {
      const r = await chat(T, `R199 ${T.tag} 第${i}条 ${uniq()}`, {}, 20_000);
      facts.push({ n: i, status: r.status, reused: r.body && r.body.reused, samePid: Boolean(r.body) && r.body.pid === pid1 });
      const s = openStream(r.body && r.body.pid);
      await s.waitFor(isDone, 20_000);
      s.abort();
      await sleep(8_000);
    }
    expect({ facts, processCount: osProcs(T.sid).length }).toEqual({
      facts: [1, 2, 3].map((n) => ({ n, status: 200, reused: true, samePid: true })), processCount: 1,
    });
  } finally { await cleanupSession(T); }
});

test('A7 [第16条] 换工作目录关旧开新(旧进程为后台命令挂着)后,新进程这一轮还在跑、4 秒内没结束时再发一条:200、进程号与前两个都不同;再发一条进程号等于最新的;进程数 2', async () => {
  const T = newSession('a7');
  const goFile = `${T.tag}-go2`;
  try {
    const { pid1, osPid1 } = await primeProcess(T, { bgTasks: 1 });
    fxHold(osPid1, { signals: true });
    const cwd2 = newWorkspace('a7-other');
    const at2 = { sid: T.sid, cwd: cwd2 };
    writeScript(`${T.tag}-slow2`, [{ say: 'R199 A7 新进程这一轮在等上游' }, { waitFile: goFile }]);
    const r2 = await chat(at2, `R199 ${T.tag} B R199S:${T.tag}-slow2`, {}, 40_000);
    expect({ status: r2.status, pidChanged: Boolean(r2.body) && r2.body.pid !== pid1 }, `前置:换工作目录关旧开新;${raw(r2)}`).toEqual({ status: 200, pidChanged: true });
    const turn2 = await waitFor(() => turnStarts(T.sid, `${T.tag} B`)[0] || null, 20_000, 100);
    expect(turn2, '前置:新进程开始跑这一轮').toBeTruthy();
    await sleep(1_000);
    const markerC = `R199 ${T.tag} C ${uniq()}`;
    const r3 = await chat(at2, markerC, {}, 40_000);
    const turn3 = await waitFor(() => turnStarts(T.sid, markerC)[0] || null, 20_000, 100);
    expect({ status: r3.status, differsFromFirst: Boolean(r3.body) && r3.body.pid !== pid1, differsFromSecond: Boolean(r3.body) && r3.body.pid !== r2.body.pid, ranOnThirdProcess: Boolean(turn3) && turn3.pid !== turn2.pid && turn3.pid !== osPid1 }, raw(r3))
      .toEqual({ status: 200, differsFromFirst: true, differsFromSecond: true, ranOnThirdProcess: true });
    expect(await waitFor(() => turnEnds(T.sid, markerC).length > 0, 20_000, 100), '前置:第三条这一轮结束').toBeTruthy();
    await sleep(8_000);
    const r4 = await chat(at2, `R199 ${T.tag} D ${uniq()}`, {}, 40_000);
    const live = await procsSettled(T.sid, 2, 25_000);
    expect({ status: r4.status, samePidAsLatest: Boolean(r4.body) && r4.body.pid === r3.body.pid, liveIsOldPlusLatest: [...live].sort((a, b) => a - b), }, raw(r4))
      .toEqual({ status: 200, samePidAsLatest: true, liveIsOldPlusLatest: [osPid1, turn3.pid].sort((a, b) => a - b) });
  } finally { await cleanupSession(T, [goFile]); }
});

// 用例修订(2026-11-19,test-r199-fix):按改后的第 17 条,另一条有三种都算对(旧形态 409 / 新形态 409 session-turn-running / 200 reused:true),原来只认旧形态 409。
test('A8 [第17条] 进程空闲时两条消息几乎同时发到同一会话:一条 200 reused:true、进程号等于先前的;另一条是三种之一(旧形态 409 无 reason 无 pid / 新形态 409 session-turn-running 带原进程号 / 200 reused:true 同进程号);都不落到别的进程,进程数 1', async () => {
  const T = newSession('a8');
  try {
    const { pid1 } = await primeProcess(T, { bgTasks: 0 });
    const [x, y] = await Promise.all([
      chat(T, `R199 ${T.tag} 并发甲 ${uniq()}`, {}, 40_000),
      chat(T, `R199 ${T.tag} 并发乙 ${uniq()}`, {}, 40_000),
    ]);
    const keysOf = (b) => JSON.stringify(Object.keys(b || {}).sort());
    // 逐种写具体断言:每条应答必须精确落进下面三种之一,否则标成 unexpected 并带上原文
    const classify = (r) => {
      const b = r.body || {};
      if (r.status === 200 && b.reused === true && b.pid === pid1) return 'reused200';
      if (r.status === 409 && keysOf(b) === JSON.stringify(['code', 'error', 'ok']) && b.ok === false && b.code === BUSY_NEW && b.error === '会话正在运行') return 'old409';
      if (r.status === 409 && keysOf(b) === JSON.stringify(['code', 'error', 'ok', 'pid', 'reason']) && b.ok === false && b.code === BUSY_NEW && b.reason === 'session-turn-running' && b.pid === pid1 && b.error === '会话这一轮还在运行') return 'new409';
      return `unexpected(${r.status})`;
    };
    const kinds = [classify(x), classify(y)].sort();
    const allowed = [['old409', 'reused200'], ['new409', 'reused200'], ['reused200', 'reused200']];
    expect(allowed, `甲:${raw(x)};乙:${raw(y)};实际归类 ${JSON.stringify(kinds)}`).toContainEqual(kinds);
    expect((await procsSettled(T.sid, 1, 10_000)).length, '进程数').toBe(1);
  } finally { await cleanupSession(T); }
});
