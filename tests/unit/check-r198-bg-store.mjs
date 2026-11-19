#!/usr/bin/env node
// r198 转到后台:页面状态库(真 store + fetch 桩)。
//  - moveToBackground / requestMoveToBackground 的归一表(200 / 后端各 code / 401·403 / 网络失败 / 不是 JSON);
//  - 转成的、按钮那一条回"没有移动"的,清掉本地前台标记;
//  - reconcileLiveTurns:fgTasks 按会话整份替换(直播刚标的留一拍)、movedTasks 补登记 bgTasks、没变化不 set。
// Run: node tests/unit/check-r198-bg-store.mjs
import assert from 'node:assert/strict';

const { useStore, FG_LIVE_GRACE_MS } = await import('../../client/src/stores/sessionStore.js');
const st = () => useStore.getState();

let PASS = 0;
let FAILS = 0;
async function check(name, fn) {
  try { await fn(); PASS++; console.log(`  ✓ ${name}`); }
  catch (e) { FAILS++; console.log(`  ✗ ${name}\n      ${String(e?.message || e).split('\n').slice(0, 6).join('\n      ')}`); }
}

const calls = [];
let reply = null;   // (url, opts) => Response 形状;抛错 = 网络失败
globalThis.fetch = async (url, opts) => { calls.push({ url: String(url), body: opts?.body ? JSON.parse(opts.body) : null }); return reply(url, opts); };
const jsonReply = (status, body) => () => ({ status, ok: status >= 200 && status < 300, json: async () => body });

console.log('\n一、moveToBackground 归一');
await check('请求体:「全部」不带 toolUseId,按钮那一路带;POST 到 /api/chat/background-tasks', async () => {
  reply = jsonReply(200, { ok: true, pid: 'sdk-1', moved: [], pending: [], skipped: [] });
  await st().moveToBackground('S1');
  await st().moveToBackground('S1', 'toolu_A');
  assert.equal(calls[0].url, '/api/chat/background-tasks');
  assert.deepEqual(calls[0].body, { sessionId: 'S1' });
  assert.deepEqual(calls[1].body, { sessionId: 'S1', toolUseId: 'toolu_A' });
});
await check('200 moved 非空 → ok,清掉转成的前台标记;200 moved 空 + 带 toolUseId → 清掉那一条;「全部」moved 空不动别的', async () => {
  st().markFgTask('toolu_M', { sessionId: 'S1' });
  st().markFgTask('toolu_K', { sessionId: 'S1' });
  reply = jsonReply(200, { ok: true, pid: 'sdk-1', moved: ['toolu_M'], pending: ['toolu_P'], skipped: [{ toolUseId: 'toolu_L', reason: 'LONG_TIMEOUT' }] });
  const r = await st().moveToBackground('S1');
  assert.deepEqual(r, { ok: true, code: null, error: '', moved: ['toolu_M'], pending: ['toolu_P'], skipped: [{ toolUseId: 'toolu_L', reason: 'LONG_TIMEOUT' }] });
  assert.equal(st().fgTasks.toolu_M, undefined);
  assert.ok(st().fgTasks.toolu_K, '没转的不动');
  reply = jsonReply(200, { ok: true, moved: [], pending: [], skipped: [] });
  await st().moveToBackground('S1');
  assert.ok(st().fgTasks.toolu_K, '「全部」没有移动时不清别的');
  await st().moveToBackground('S1', 'toolu_K');
  assert.equal(st().fgTasks.toolu_K, undefined, '按钮那一条已不在前台,清掉本地标记');
});
await check('后端错误照带 code / error / 列表;失败时不清前台标记', async () => {
  st().markFgTask('toolu_R', { sessionId: 'S1' });
  for (const [status, body] of [
    [409, { ok: false, code: 'BG_NO_ACTIVE_TURN', error: '这个会话当前没有正在运行的回合' }],
    [409, { ok: false, code: 'BG_STOPPING', error: '这一轮正在停止' }],
    [409, { ok: false, code: 'BG_XS_TURN', error: '这一轮在处理跨会话消息,不能移到后台' }],
    [409, { ok: false, code: 'BG_REJECTED', error: '命令行拒绝转到后台:原话', moved: ['toolu_X'], pending: [], skipped: [] }],
    [504, { ok: false, code: 'BG_TIMEOUT', error: '5 秒内没有收到命令行确认,结果未知', moved: [], pending: [], skipped: [] }],
    [500, { ok: false, code: 'BG_INTERNAL', error: '转到后台处理异常,结果未知' }],
  ]) {
    reply = jsonReply(status, body);
    const r = await st().moveToBackground('S1', 'toolu_R');
    assert.equal(r.ok, false);
    assert.equal(r.code, body.code);
    assert.equal(r.error, body.error);
    assert.deepEqual(r.moved, body.moved || []);
  }
  assert.ok(st().fgTasks.toolu_R, '失败不清');
});
await check('401 / 403 → BG_FORBIDDEN;网络失败、应答不是 JSON → BG_NETWORK;带了 10 秒超时信号', async () => {
  for (const s of [401, 403]) {
    reply = () => ({ status: s, ok: false, json: async () => ({ error: 'forbidden' }) });
    const r = await st().moveToBackground('S1');
    assert.deepEqual(r, { ok: false, code: 'BG_FORBIDDEN', error: '请求被拒绝(登录或来源校验未通过)', moved: [], pending: [], skipped: [] });
  }
  reply = () => { throw new TypeError('Failed to fetch'); };
  assert.equal((await st().moveToBackground('S1')).code, 'BG_NETWORK');
  reply = () => ({ status: 502, ok: false, json: async () => { throw new SyntaxError('not json'); } });
  const r = await st().moveToBackground('S1');
  assert.deepEqual(r, { ok: false, code: 'BG_NETWORK', error: '没连上后台服务,结果未知', moved: [], pending: [], skipped: [] });
  let seenSignal = null;
  reply = (url, opts) => { seenSignal = opts.signal; return { status: 200, ok: true, json: async () => ({ ok: true, moved: [] }) }; };
  await st().moveToBackground('S1');
  assert.ok(seenSignal && typeof seenSignal.aborted === 'boolean', '请求带超时信号');
});

console.log('\n二、reconcileLiveTurns 对账');
await check('fgTasks 按会话整份替换:轮询报的补上、没报的清掉;直播刚标的留一拍', async () => {
  useStore.setState({ fgTasks: {
    old_A: { sessionId: 'SA', taskId: null, at: 0 },
    live_A: { sessionId: 'SA', taskId: 't', at: Date.now() },
    gone_B: { sessionId: 'SB', taskId: null, at: Date.now() - FG_LIVE_GRACE_MS - 10 },
  } });
  st().reconcileLiveTurns([
    { kind: 'chat-process', sessionId: 'SA', fgTasks: ['new_A'] },
    { kind: 'cli-session', sessionId: 'SB', fgTasks: ['nope'] },
  ]);
  assert.deepEqual(Object.keys(st().fgTasks).sort(), ['live_A', 'new_A']);
  assert.equal(st().fgTasks.new_A.sessionId, 'SA');
});
await check('movedTasks → bgTasks 补登记(进程面板要的字段);已有输出路径的不动;没路径的不登记', async () => {
  useStore.setState({ bgTasks: { toolu_HAS: { id: 'toolu_HAS', outputPath: '/x/keep.output', description: '原来的', sessionId: 'SA' } } });
  st().reconcileLiveTurns([{ kind: 'chat-process', sessionId: 'SA', movedTasks: [
    { toolUseId: 'toolu_MV', taskId: 'bbzmv', outputPath: '/t/a b/bbzmv.output', description: '编译' },
    { toolUseId: 'toolu_HAS', taskId: 'bbzh', outputPath: '/other.output', description: '新的' },
    { toolUseId: 'toolu_NOPATH', taskId: 'bbzn', outputPath: null, description: '没路径' },
  ] }]);
  const mv = st().bgTasks.toolu_MV;
  assert.equal(mv.outputPath, '/t/a b/bbzmv.output');
  assert.equal(mv.description, '编译');
  assert.equal(mv.shellId, 'bbzmv');
  assert.equal(mv.sessionId, 'SA');
  assert.equal(mv.status, 'running');
  assert.equal(mv.moved, true);
  assert.equal(st().bgTasks.toolu_HAS.outputPath, '/x/keep.output');
  assert.equal(st().bgTasks.toolu_NOPATH, undefined);
});
await check('没有变化不 set(防每 1.5 秒白渲染)', async () => {
  const agents = [{ kind: 'chat-process', sessionId: 'SA', fgTasks: ['new_A', 'live_A'], movedTasks: [{ toolUseId: 'toolu_MV', taskId: 'bbzmv', outputPath: '/t/a b/bbzmv.output', description: '编译' }] }];
  st().reconcileLiveTurns(agents);
  let notified = 0;
  const unsub = useStore.subscribe(() => { notified += 1; });
  st().reconcileLiveTurns(agents);
  st().reconcileLiveTurns(agents);
  unsub();
  assert.equal(notified, 0);
  st().reconcileLiveTurns(null);   // 坏输入不抛
});

console.log(`\nr198 页面状态库单测:${PASS} 通过,${FAILS} 失败`);
process.exit(FAILS ? 1 : 0);
