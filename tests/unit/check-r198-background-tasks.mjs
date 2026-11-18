#!/usr/bin/env node
// r198 转到后台:后端入口 POST /api/chat/background-tasks 的错误契约、簿记(applyBackgroundSignals)、轮询字段
// (liveTurnSnapshot)、登记前待移,以及读历史时工具结果上的 movedToBackground 标记。
// 白盒:真 import 纯函数与处理器;处理器注入 procs 与桩 query(不起服务、不占端口)。
// HOME 指向临时沙箱后再动态 import —— session-reader 的 PROJECTS_DIR 在模块加载时由 homedir() 定。
// Run: node tests/unit/check-r198-background-tasks.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'r198-home-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const chat = await import('../../server/routes/chat.js');
const { getSessionMessages } = await import('../../server/services/session-reader.js');
const {
  handleBackgroundTasksPost, validateBackgroundRequest, planBackgroundTargets, liveTurnSnapshot,
  applyBackgroundSignals, resetBackgroundTurnState, moveTargetsToBackground, bgOutputPathOf, LONG_FG_TIMEOUT_MS,
} = chat;

let PASS = 0;
let FAILS = 0;
async function check(name, fn) {
  try { await fn(); PASS++; console.log(`  ✓ ${name}`); }
  catch (e) { FAILS++; console.log(`  ✗ ${name}\n      ${String(e?.message || e).split('\n').slice(0, 6).join('\n      ')}`); }
}

const SID = 'a1980000-0000-4000-8000-000000000001';
const fakeRes = () => ({
  statusCode: 200, body: undefined, headersSent: false,
  status(c) { this.statusCode = c; return this; },
  json(b) { this.body = b; this.headersSent = true; return this; },
});
const post = async (body, procs) => { const res = fakeRes(); await handleBackgroundTasksPost({ body }, res, procs); return res; };
// 桩 query:backgroundTasks(id) 按 impl 回;记下调用
const stubQuery = (impl) => ({ calls: [], backgroundTasks(id) { this.calls.push(id); return impl(id); } });
const fgEntry = (toolUseId, extra = {}) => ({ toolUseId, kind: 'shell', epoch: 0, createdAt: Date.now(), fg: true, parentTaskId: null, timeoutMs: null, ...extra });
function slotOf(extra = {}) {
  return {
    sessionId: SID, idle: false, closing: false, pumpEnded: false, exitCode: null, input: { push() { return true; } },
    turnEpoch: 0, turnStopRequested: false, turnSettled: false, liveTasks: new Map(), openCalls: new Map(),
    query: stubQuery(async () => true), ...extra,
  };
}
const procsOf = (slot, pid = 'sdk-1') => new Map([[pid, slot]]);
const INVALID = { ok: false, code: 'BG_INVALID_INPUT', error: '转到后台的请求参数无效' };
const NO_ACTIVE = { ok: false, code: 'BG_NO_ACTIVE_TURN', error: '这个会话当前没有正在运行的回合' };

console.log('\n一、参数校验(400 BG_INVALID_INPUT)');
await check('请求体不是对象 / sessionId 缺失或形状不对 / toolUseId 不是字符串或形状不对 → 400', async () => {
  const bad = [null, [], 'x', {}, { sessionId: 5 }, { sessionId: 'a b' }, { sessionId: '' }, { sessionId: 'x'.repeat(129) },
    { sessionId: SID, toolUseId: 5 }, { sessionId: SID, toolUseId: null }, { sessionId: SID, toolUseId: 'bad id!' }, { sessionId: SID, toolUseId: '' }];
  for (const b of bad) {
    const r = await post(b, procsOf(slotOf()));
    assert.equal(r.statusCode, 400, JSON.stringify(b));
    assert.deepEqual(r.body, INVALID);
  }
  assert.deepEqual(validateBackgroundRequest({ sessionId: `  ${SID} `, toolUseId: ' toolu_A1 ' }), { sessionId: SID, toolUseId: 'toolu_A1' });
  assert.deepEqual(validateBackgroundRequest({ sessionId: SID }), { sessionId: SID, toolUseId: null });
});

console.log('\n二、先判先回的 409');
await check('没有进程 / 空闲 / 关闭中 / 已退出 / 泵已结束 → 409 BG_NO_ACTIVE_TURN', async () => {
  for (const procs of [new Map(), procsOf(slotOf({ idle: true })), procsOf(slotOf({ closing: true })),
    procsOf(slotOf({ exitCode: 0 })), procsOf(slotOf({ pumpEnded: true })), procsOf(slotOf({ sessionId: 'other' }))]) {
    const r = await post({ sessionId: SID }, procs);
    assert.equal(r.statusCode, 409);
    assert.deepEqual(r.body, NO_ACTIVE);
  }
});
await check('跨会话消息那一轮 → 409 BG_XS_TURN,不调 SDK;回合已结束的 tag 不算', async () => {
  const s = slotOf({ runtimeTurn: { ended: false, tag: { xsMessageId: 'xs-1', key: 'k' } } });
  s.liveTasks.set('t1', fgEntry('toolu_X1'));
  const r = await post({ sessionId: SID }, procsOf(s));
  assert.equal(r.statusCode, 409);
  assert.deepEqual(r.body, { ok: false, code: 'BG_XS_TURN', error: '这一轮在处理跨会话消息,不能移到后台' });
  assert.equal(s.query.calls.length, 0);
  s.runtimeTurn.ended = true;
  assert.equal((await post({ sessionId: SID }, procsOf(s))).statusCode, 200);
});
await check('已按停止、还没收尾 → 409 BG_STOPPING,不调 SDK;收尾后的续跑回合不算正在停止', async () => {
  const s = slotOf({ turnStopRequested: true });
  s.liveTasks.set('t1', fgEntry('toolu_S1'));
  const r = await post({ sessionId: SID }, procsOf(s));
  assert.equal(r.statusCode, 409);
  assert.deepEqual(r.body, { ok: false, code: 'BG_STOPPING', error: '这一轮正在停止' });
  assert.equal(s.query.calls.length, 0);
  s.turnSettled = true;
  const r2 = await post({ sessionId: SID }, procsOf(s));
  assert.equal(r2.statusCode, 200);
  assert.deepEqual(r2.body.moved, ['toolu_S1']);
});

console.log('\n三、200 与幂等');
await check('query 还没建好(冷启中)→ 200 没东西可转', async () => {
  const r = await post({ sessionId: SID }, procsOf(slotOf({ query: null })));
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, { ok: true, pid: 'sdk-1', moved: [], pending: [], skipped: [] });
});
await check('没有前台任务 → 200 moved=[],不调 SDK(模型后台起的、子代理线程里的都不算)', async () => {
  const s = slotOf();
  s.liveTasks.set('t-bg', fgEntry('toolu_BG', { fg: false }));
  s.liveTasks.set('t-sub', fgEntry('toolu_SUB', { parentTaskId: 'parent-1' }));
  const r = await post({ sessionId: SID }, procsOf(s));
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, { ok: true, pid: 'sdk-1', moved: [], pending: [], skipped: [] });
  assert.equal(s.query.calls.length, 0);
});
await check('「全部」转走前台任务 → 200 moved=[id],只按 id 调;条目即刻记为后台;同一任务第二次 → 200 moved=[]', async () => {
  const s = slotOf();
  s.liveTasks.set('bbz1', fgEntry('toolu_F1'));
  const r = await post({ sessionId: SID }, procsOf(s));
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, { ok: true, pid: 'sdk-1', moved: ['toolu_F1'], pending: [], skipped: [] });
  assert.deepEqual(s.query.calls, ['toolu_F1'], '只按 tool_use_id 调,不用不带参数的调用');
  assert.equal(s.liveTasks.get('bbz1').fg, false);
  assert.ok(s.liveTasks.get('bbz1').movedAt > 0);
  const r2 = await post({ sessionId: SID }, procsOf(s));
  assert.deepEqual(r2.body.moved, []);
  assert.equal(s.query.calls.length, 1, '第二次没有可转的目标,不再调 SDK');
});
await check('带 toolUseId:命令行回 false(已结束 / 已在后台 / 不认识)→ 200 moved=[]', async () => {
  const s = slotOf({ query: stubQuery(async () => false) });
  const r = await post({ sessionId: SID, toolUseId: 'toolu_GONE' }, procsOf(s));
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, { ok: true, pid: 'sdk-1', moved: [], pending: [], skipped: [] });
  assert.deepEqual(s.query.calls, ['toolu_GONE']);
});
await check('长时限保护:前台时限 > 30 分钟的「全部」不转、进 skipped;带 toolUseId 的不套保护', async () => {
  const s = slotOf();
  s.liveTasks.set('bbzL', fgEntry('toolu_LONG', { timeoutMs: LONG_FG_TIMEOUT_MS + 1 }));
  s.liveTasks.set('bbzE', fgEntry('toolu_EDGE', { timeoutMs: LONG_FG_TIMEOUT_MS }));
  const r = await post({ sessionId: SID }, procsOf(s));
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body.skipped, [{ toolUseId: 'toolu_LONG', reason: 'LONG_TIMEOUT' }]);
  assert.deepEqual(r.body.moved, ['toolu_EDGE'], '正好 30 分钟的不算超长');
  const r2 = await post({ sessionId: SID, toolUseId: 'toolu_LONG' }, procsOf(s));
  assert.deepEqual(r2.body.moved, ['toolu_LONG']);
});
await check('还没登记的本回合调用 → pending;超长时限的未登记调用进 skipped;别的世代的不算', async () => {
  const s = slotOf({ turnEpoch: 3 });
  s.openCalls.set('toolu_P1', { epoch: 3, timeoutMs: null });
  s.openCalls.set('toolu_P2', { epoch: 3, timeoutMs: 2_400_000 });
  s.openCalls.set('toolu_OLD', { epoch: 2, timeoutMs: null });
  const r = await post({ sessionId: SID }, procsOf(s));
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body.pending, ['toolu_P1']);
  assert.deepEqual(r.body.skipped, [{ toolUseId: 'toolu_P2', reason: 'LONG_TIMEOUT' }]);
  assert.equal(s.query.calls.length, 0);
});

console.log('\n四、拒绝 / 超时 / 进程没了 / 意外异常');
await check('两个任务一个转成、一个被命令行拒绝 → 409 BG_REJECTED,moved 只含转成的,原话前 200 字', async () => {
  const said = `后台任务已被关闭${'x'.repeat(300)}`;
  const s = slotOf({ query: stubQuery(async (id) => { if (id === 'toolu_R2') throw new Error(said); return true; }) });
  s.liveTasks.set('a', fgEntry('toolu_R1'));
  s.liveTasks.set('b', fgEntry('toolu_R2'));
  const r = await post({ sessionId: SID }, procsOf(s));
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.code, 'BG_REJECTED');
  assert.equal(r.body.error, `命令行拒绝转到后台:${said.slice(0, 200)}`);
  assert.deepEqual(r.body.moved, ['toolu_R1']);
  assert.deepEqual(r.body.pending, []);
  assert.deepEqual(r.body.skipped, []);
});
await check('SDK 因已关闭而拒绝 / 调用途中进程没了 → 409 BG_NO_ACTIVE_TURN', async () => {
  const s1 = slotOf({ query: stubQuery(async () => { throw new Error('Query closed before response received'); }) });
  s1.liveTasks.set('a', fgEntry('toolu_C1'));
  assert.deepEqual((await post({ sessionId: SID }, procsOf(s1))).body, NO_ACTIVE);
  const s2 = slotOf();
  s2.query = stubQuery(async () => { s2.pumpEnded = true; throw new Error('transport gone'); });
  s2.liveTasks.set('a', fgEntry('toolu_C2'));
  assert.deepEqual((await post({ sessionId: SID }, procsOf(s2))).body, NO_ACTIVE);
});
await check('并发调用、总时限:两个各 80ms 的目标在 150ms 时限内都完成(串行要 160ms);不回的记 timeout', async () => {
  const q = stubQuery((id) => (id === 'never' ? new Promise(() => {}) : new Promise((r) => setTimeout(() => r(true), 80))));
  const out = await moveTargetsToBackground(q, ['a', 'b'], 150);
  assert.deepEqual(out.map((o) => o.state), ['ok', 'ok']);
  const t0 = Date.now();
  const out2 = await moveTargetsToBackground(q, ['a', 'never'], 150);
  assert.deepEqual(out2.map((o) => o.state), ['ok', 'timeout']);
  assert.ok(Date.now() - t0 < 1000);
  const out3 = await moveTargetsToBackground({ backgroundTasks() { throw new Error('sync boom'); } }, ['z'], 100);
  assert.equal(out3[0].state, 'error', '同步抛出按拒绝算');
});
await check('5 秒内没回执 → 504 BG_TIMEOUT(与拒绝同时出现时以超时为准),moved 照报', async () => {
  const s = slotOf({ query: stubQuery((id) => (id === 'toolu_T1' ? new Promise(() => {}) : (id === 'toolu_T2' ? Promise.reject(new Error('no')) : Promise.resolve(true)))) });
  s.liveTasks.set('a', fgEntry('toolu_T1'));
  s.liveTasks.set('b', fgEntry('toolu_T2'));
  s.liveTasks.set('c', fgEntry('toolu_T3'));
  const t0 = Date.now();
  const r = await post({ sessionId: SID }, procsOf(s));
  const waited = Date.now() - t0;
  assert.equal(r.statusCode, 504);
  assert.deepEqual(r.body, { ok: false, code: 'BG_TIMEOUT', error: '5 秒内没有收到命令行确认,结果未知', moved: ['toolu_T3'], pending: [], skipped: [] });
  assert.ok(waited >= 4900 && waited < 7000, `总时限约 5 秒(实际 ${waited}ms)`);
});
await check('意外异常 → 500 BG_INTERNAL', async () => {
  const s = slotOf();
  Object.defineProperty(s, 'liveTasks', { get() { throw new Error('boom'); } });
  const r = await post({ sessionId: SID }, procsOf(s));
  assert.equal(r.statusCode, 500);
  assert.deepEqual(r.body, { ok: false, code: 'BG_INTERNAL', error: '转到后台处理异常,结果未知' });
});
await check('本入口不 interrupt / abort / 关输入,不动 turnEpoch / closing / stopTimer', async () => {
  let touched = 0;
  const s = slotOf({ turnEpoch: 7, stopTimer: null, abort: { abort() { touched++; } } });
  s.input = { push() { return true; }, close() { touched++; } };
  s.query.interrupt = () => { touched++; };
  s.liveTasks.set('a', fgEntry('toolu_N1'));
  await post({ sessionId: SID }, procsOf(s));
  assert.equal(touched, 0);
  assert.equal(s.turnEpoch, 7);
  assert.equal(s.closing, false);
  assert.equal(s.stopTimer, null);
});

console.log('\n五、消息泵簿记与轮询字段');
const OUT_PATH = '/Users/John Doe/tmp/claude/tasks/bbz01wrtn.output';
const MOVED_TEXT = `Command was manually backgrounded by user with ID: bbz01wrtn. Output is being written to: ${OUT_PATH} If it is still running after 30m in the background, it will be stopped and you will be notified.`;
await check('前台命令:发出 → 登记 → 转走 → 工具结果,fgTasks / movedTasks / outputPath 依次正确', async () => {
  const s = slotOf({ query: null, openCalls: undefined });
  applyBackgroundSignals(s, { type: 'assistant', parent_tool_use_id: null, message: { content: [
    { type: 'tool_use', id: 'toolu_M1', name: 'Bash', input: { command: 'make', description: '编译', timeout: 600000 } },
    { type: 'tool_use', id: 'toolu_BG1', name: 'Bash', input: { command: 'npm run dev', run_in_background: true } },
  ] } });
  assert.deepEqual([...s.openCalls.keys()], ['toolu_M1'], '模型后台起的不记');
  assert.deepEqual(s.openCalls.get('toolu_M1'), { epoch: 0, timeoutMs: 600000 });
  // 消息泵里 task_started 的条目由既有簿记先建好,这里补字段
  s.liveTasks.set('bbz01wrtn', { toolUseId: 'toolu_M1', kind: 'shell', epoch: 0, createdAt: Date.now() });
  applyBackgroundSignals(s, { type: 'system', subtype: 'task_started', task_id: 'bbz01wrtn', tool_use_id: 'toolu_M1', description: '编译', is_backgrounded: false, task_type: 'local_bash' });
  const t = s.liveTasks.get('bbz01wrtn');
  assert.equal(t.fg, true);
  assert.equal(t.timeoutMs, 600000);
  assert.deepEqual(liveTurnSnapshot(s), { fgTasks: ['toolu_M1'] });
  applyBackgroundSignals(s, { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'bbz01wrtn', task_type: 'local_bash' }] });
  applyBackgroundSignals(s, { type: 'system', subtype: 'task_updated', task_id: 'bbz01wrtn', patch: { is_backgrounded: true } });
  assert.equal(t.fg, false);
  assert.ok(t.movedAt > 0);
  assert.deepEqual(liveTurnSnapshot(s), { movedTasks: [{ toolUseId: 'toolu_M1', taskId: 'bbz01wrtn', outputPath: null, description: '编译' }] });
  applyBackgroundSignals(s, { type: 'user', parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_M1', is_error: false, content: MOVED_TEXT }] },
    tool_use_result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bbz01wrtn', backgroundedByUser: true } });
  assert.equal(s.openCalls.size, 0);
  assert.deepEqual(liveTurnSnapshot(s).movedTasks, [{ toolUseId: 'toolu_M1', taskId: 'bbz01wrtn', outputPath: OUT_PATH, description: '编译' }]);
});
await check('模型后台起的命令(is_backgrounded:true)不算前台、不算被转走;正常出结果的前台命令清掉前台标记', async () => {
  const s = slotOf();
  s.liveTasks.set('bm', { toolUseId: 'toolu_BM', kind: 'shell', epoch: 0, createdAt: Date.now() });
  applyBackgroundSignals(s, { type: 'system', subtype: 'task_started', task_id: 'bm', tool_use_id: 'toolu_BM', is_backgrounded: true });
  applyBackgroundSignals(s, { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'bm' }] });
  assert.deepEqual(liveTurnSnapshot(s), {});
  s.liveTasks.set('fx', { toolUseId: 'toolu_FX', kind: 'shell', epoch: 0, createdAt: Date.now() });
  applyBackgroundSignals(s, { type: 'system', subtype: 'task_started', task_id: 'fx', tool_use_id: 'toolu_FX', is_backgrounded: false });
  applyBackgroundSignals(s, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_FX', content: 'done' }] },
    tool_use_result: { stdout: 'done', backgroundTaskId: 'fx' } });
  assert.equal(s.liveTasks.get('fx').fg, false);
  assert.equal(s.liveTasks.get('fx').movedAt, undefined, '只有 backgroundTaskId 的不算被转走');
  assert.deepEqual(liveTurnSnapshot(s), {});
  // 字段缺失(旧命令行)按"不是前台"
  s.liveTasks.set('old', { toolUseId: 'toolu_OLD', kind: 'shell', epoch: 0, createdAt: Date.now() });
  applyBackgroundSignals(s, { type: 'system', subtype: 'task_started', task_id: 'old', tool_use_id: 'toolu_OLD' });
  assert.equal(s.liveTasks.get('old').fg, false);
});
await check('轮询字段:进程退出 / 泵结束不报;空闲不报 fgTasks;跨会话回合报 xsTurn;回合收尾清前台标记与未出结果调用', async () => {
  const s = slotOf({ runtimeTurn: { ended: false, tag: { xsMessageId: 'm1', key: 'k' } } });
  s.liveTasks.set('a', fgEntry('toolu_Z1'));
  s.openCalls.set('toolu_Z1', { epoch: 0, timeoutMs: null });
  assert.deepEqual(liveTurnSnapshot(s), { fgTasks: ['toolu_Z1'], xsTurn: true });
  assert.deepEqual(liveTurnSnapshot({ ...s, idle: true }), { xsTurn: true });
  assert.deepEqual(liveTurnSnapshot({ ...s, exitCode: 0 }), {});
  assert.deepEqual(liveTurnSnapshot({ ...s, pumpEnded: true }), {});
  s.pendingMove = { epoch: 0, ids: new Set(['x']) };
  resetBackgroundTurnState(s);
  assert.equal(s.liveTasks.get('a').fg, false);
  assert.equal(s.openCalls.size, 0);
  assert.equal(s.pendingMove, null);
  assert.equal(bgOutputPathOf(MOVED_TEXT), OUT_PATH, '路径含空格也取全');
  assert.equal(bgOutputPathOf('no path here'), null);
  assert.deepEqual(planBackgroundTargets(undefined, undefined, 0), { targets: [], pending: [], skipped: [] });
});

console.log('\n五b、登记前待移(T2)');
const tick = () => new Promise((r) => setTimeout(r, 10));
const registerFg = (s, taskId, toolUseId) => {
  s.liveTasks.set(taskId, { toolUseId, kind: 'shell', epoch: s.turnEpoch | 0, createdAt: Date.now() });
  applyBackgroundSignals(s, { type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: toolUseId, is_backgrounded: false, task_type: 'local_bash' });
};
const sendToolUse = (s, id, input = { command: 'make' }) => applyBackgroundSignals(s, { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input }] } });
await check('先请求后登记:「全部」回 pending=[id] 且不调 SDK;一登记就按 id 转走一次,条目记为后台', async () => {
  const s = slotOf();
  sendToolUse(s, 'toolu_PM1');
  const r = await post({ sessionId: SID }, procsOf(s));
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, { ok: true, pid: 'sdk-1', moved: [], pending: ['toolu_PM1'], skipped: [] });
  assert.equal(s.query.calls.length, 0);
  registerFg(s, 'bbzP1', 'toolu_PM1');
  assert.deepEqual(s.query.calls, ['toolu_PM1']);
  await tick();
  assert.equal(s.liveTasks.get('bbzP1').fg, false);
  assert.ok(s.liveTasks.get('bbzP1').movedAt > 0);
  assert.equal(s.pendingMove.ids.size, 0);
  // 同一个 id 再登记一次(重复事件)不再调
  registerFg(s, 'bbzP1', 'toolu_PM1');
  assert.equal(s.query.calls.length, 1);
});
await check('3 秒内就出了结果:待移作废,之后不转;待移那次调用失败只记日志、不抛', async () => {
  const s = slotOf({ query: stubQuery(async () => { throw new Error('disabled'); }) });
  sendToolUse(s, 'toolu_PM2');
  sendToolUse(s, 'toolu_PM3');
  await post({ sessionId: SID }, procsOf(s));
  applyBackgroundSignals(s, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_PM2', content: 'ok' }] } });
  registerFg(s, 'bbzP2', 'toolu_PM2');
  assert.equal(s.query.calls.length, 0, '出过结果的不再转');
  registerFg(s, 'bbzP3', 'toolu_PM3');
  assert.deepEqual(s.query.calls, ['toolu_PM3']);
  await tick();
  assert.equal(s.liveTasks.get('bbzP3').fg, true, '失败的待移不改簿记');
});
await check('回合结束 / 换了世代 / 已按停止 / 跨会话回合:待移不转', async () => {
  const s = slotOf();
  sendToolUse(s, 'toolu_PM4');
  await post({ sessionId: SID }, procsOf(s));
  resetBackgroundTurnState(s);
  registerFg(s, 'bbzP4', 'toolu_PM4');
  assert.equal(s.query.calls.length, 0, '回合收尾清掉了待移');
  const s2 = slotOf();
  sendToolUse(s2, 'toolu_PM5');
  await post({ sessionId: SID }, procsOf(s2));
  s2.turnEpoch = 1;
  registerFg(s2, 'bbzP5', 'toolu_PM5');
  assert.equal(s2.query.calls.length, 0, '世代变了不转');
  const s3 = slotOf();
  sendToolUse(s3, 'toolu_PM6');
  await post({ sessionId: SID }, procsOf(s3));
  s3.turnStopRequested = true;
  registerFg(s3, 'bbzP6', 'toolu_PM6');
  assert.equal(s3.query.calls.length, 0, '已按停止不转');
  const s4 = slotOf();
  sendToolUse(s4, 'toolu_PM7');
  await post({ sessionId: SID }, procsOf(s4));
  s4.runtimeTurn = { ended: false, tag: { xsMessageId: 'm', key: 'k' } };
  registerFg(s4, 'bbzP7', 'toolu_PM7');
  assert.equal(s4.query.calls.length, 0, '跨会话回合不转');
});

console.log('\n六、读历史:工具结果上的 movedToBackground');
await check('会话文件里被转走那条(toolUseResult 带 backgroundedByUser / timedOutAfterMs)→ movedToBackground + bgTaskId;其余结果不多键', async () => {
  const HASH = '-tmp-r198-proj';
  const PROJ = join(HOME, '.claude', 'projects', HASH);
  mkdirSync(PROJ, { recursive: true });
  const sid = 'b1980000-0000-4000-8000-000000000002';
  const base = { sessionId: sid, cwd: join(HOME, 'proj'), isSidechain: false, userType: 'external' };
  const ts = (n) => `2026-11-18T00:00:0${n}.000Z`;
  const toolUse = (id, input) => ({ type: 'tool_use', id, name: 'Bash', input });
  const rows = [
    { ...base, type: 'user', uuid: 'u1', timestamp: ts(0), message: { role: 'user', content: '跑一下' } },
    { ...base, type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: ts(1), message: { role: 'assistant', content: [toolUse('toolu_H1', { command: 'make' })] } },
    { ...base, type: 'user', uuid: 'u2', parentUuid: 'a1', timestamp: ts(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_H1', is_error: false, content: MOVED_TEXT }] },
      toolUseResult: { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: 'bbz01wrtn', backgroundedByUser: true } },
    { ...base, type: 'assistant', uuid: 'a2', parentUuid: 'u2', timestamp: ts(3), message: { role: 'assistant', content: [toolUse('toolu_H2', { command: 'sleep 999' }), toolUse('toolu_H3', { command: 'npm run dev', run_in_background: true }), toolUse('toolu_H4', { command: 'ls' })] } },
    { ...base, type: 'user', uuid: 'u3', parentUuid: 'a2', timestamp: ts(4), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_H2', content: 'Command did not complete within its 120s timeout and was moved to the background (ID: bbzT)' }] },
      toolUseResult: { stdout: '', backgroundTaskId: 'bbzT', timedOutAfterMs: 120000 } },
    { ...base, type: 'user', uuid: 'u4', parentUuid: 'u3', timestamp: ts(5), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_H3', content: 'Command running in background with ID: bbzM' }] },
      toolUseResult: { stdout: '', backgroundTaskId: 'bbzM' } },
    { ...base, type: 'user', uuid: 'u5', parentUuid: 'u4', timestamp: ts(6), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_H4', content: 'a\nb' }] },
      toolUseResult: { stdout: 'a\nb', stderr: '' } },
  ];
  writeFileSync(join(PROJ, `${sid}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const { messages } = await getSessionMessages(sid, HASH);
  const calls = Object.fromEntries((messages || []).flatMap((m) => m.toolCalls || []).map((tc) => [tc.id, tc.result]));
  assert.equal(calls.toolu_H1.movedToBackground, true);
  assert.equal(calls.toolu_H1.bgTaskId, 'bbz01wrtn');
  assert.equal(calls.toolu_H2.movedToBackground, true, '前台超时自动转的也算');
  assert.equal(calls.toolu_H2.bgTaskId, 'bbzT');
  for (const id of ['toolu_H3', 'toolu_H4']) {
    assert.equal('movedToBackground' in calls[id], false, `${id} 不多键`);
    assert.equal('bgTaskId' in calls[id], false, `${id} 不多键`);
  }
});

console.log(`\nr198 转到后台单测:${PASS} 通过,${FAILS} 失败`);
process.exit(FAILS ? 1 : 0);
