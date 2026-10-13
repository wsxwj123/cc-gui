#!/usr/bin/env node
// 单测:r148 P4 —— 子代理的流式增量合并提交;跑过的子代理记录有回收路径。
//
// 现象 ①:主回合的流式正文早就按帧合并了,子代理没有 —— 每来一条增量就写一次 store,每次都把整张
//   子代理表和该子代理的全部文字数组拷一遍,并通知所有订阅者。几个子代理并发时每秒上百次。
// 现象 ②:子代理记录只增不减(clearAgents 全仓没人调),跑过的子代理全文一直留在内存里。
//
// 可数的量:N 条增量 → 订阅者被通知几次;终态记录最多留几条。
// 硬要求:合并之后**一个字都不能丢、顺序不能乱** —— 紧跟着增量到达的任何一次别的写入
// (工具调用、结束状态)都必须先把缓冲里的文字落进去。
// Run: node tests/unit/check-r148-p4-agent-deltas.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.log(`  ✗ ${name}\n      ${String(e && e.message || e).split('\n').join('\n      ')}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('r148 P4 子代理增量合并提交 / 记录回收');

const mod = await import(root + 'client/src/stores/sessionStore.js');
const { useStore } = mod;
// 立刻把缓冲落进 store。当前代码没有缓冲(逐条写),没有这个导出时等价于什么都不用做。
const flush = () => { if (typeof mod.flushAgentDeltas === 'function') mod.flushAgentDeltas(); };
const agent = (id) => useStore.getState().activeAgents[id];
const textOf = (id) => (agent(id)?.text || []).join('');

await check('① 300 条文字增量:订阅者最多被通知 2 次(原来是 300 次),文字一个不少', async () => {
  useStore.getState().upsertAgent('ag-burst', { status: 'working', sessionId: 's-open' });
  let notified = 0;
  const unsub = useStore.subscribe(() => { notified += 1; });
  let expected = '';
  for (let i = 0; i < 300; i += 1) { const d = `字${i} `; expected += d; useStore.getState().appendAgentText('ag-burst', d); }
  flush();
  unsub();
  assert.ok(notified <= 2, `300 条增量通知了 ${notified} 次`);
  assert.equal(textOf('ag-burst'), expected);
  assert.equal(agent('ag-burst').blocks.length, 1, '连续的文字应并成一块');
  assert.equal(agent('ag-burst').blocks[0].content, expected);
});

await check('① 思考增量同样合并', async () => {
  useStore.getState().upsertAgent('ag-think', { status: 'working', sessionId: 's-open' });
  let notified = 0;
  const unsub = useStore.subscribe(() => { notified += 1; });
  for (let i = 0; i < 200; i += 1) useStore.getState().appendAgentThinking('ag-think', `t${i} `);
  flush();
  unsub();
  assert.ok(notified <= 2, `200 条思考增量通知了 ${notified} 次`);
  assert.equal((agent('ag-think').thinking || []).join('').split(' ').filter(Boolean).length, 200);
});

await check('顺序不乱:文字 → 工具调用 → 文字 → 思考,落进去的块顺序与到达顺序一致', async () => {
  const s = useStore.getState();
  s.upsertAgent('ag-order', { status: 'working', sessionId: 's-open' });
  s.appendAgentText('ag-order', 'A');
  s.appendAgentText('ag-order', 'B');
  s.appendAgentTool('ag-order', { id: 'tool-1', name: 'Read', input: {}, result: null });
  s.appendAgentText('ag-order', 'C');
  s.appendAgentThinking('ag-order', 'T');
  s.updateAgentTool('ag-order', 'tool-1', { input: { file_path: '/x' } });
  flush();
  const a = agent('ag-order');
  assert.deepEqual(a.blocks.map((b) => b.type), ['text', 'tool_use', 'text', 'thinking']);
  assert.equal(a.blocks[0].content, 'AB');
  assert.equal(a.blocks[2].content, 'C');
  assert.equal(a.blocks[3].content, 'T');
  assert.deepEqual(a.blocks[1].toolCall.input, { file_path: '/x' });
  assert.equal(textOf('ag-order'), 'ABC');
});

await check('不丢尾:最后一段文字后面紧跟"结束"写入(中间没有任何等待)—— 结束那一刻文字已经完整', async () => {
  const s = useStore.getState();
  s.upsertAgent('ag-tail', { status: 'working', sessionId: 's-open' });
  s.appendAgentText('ag-tail', '前文 ');
  s.appendAgentText('ag-tail', '最后一段');
  s.upsertAgent('ag-tail', { status: 'done', finishedAt: Date.now() });   // 子代理结束 / 回合结束 / 停止 都走这个写入
  assert.equal(textOf('ag-tail'), '前文 最后一段', '结束状态写进去时,缓冲里的文字必须已经落下');
  assert.equal(agent('ag-tail').status, 'done');
});

await check('不丢尾:什么都不做、只是等一小会儿,缓冲里的文字也会自己落进去(不依赖后续事件来推)', async () => {
  const s = useStore.getState();
  s.upsertAgent('ag-idle', { status: 'working', sessionId: 's-open' });
  s.appendAgentText('ag-idle', '没人再推我');
  await sleep(120);
  assert.equal(textOf('ag-idle'), '没人再推我');
});

await check('没有这条子代理记录时,增量不凭空建记录、不报错(与原来一致)', async () => {
  useStore.getState().appendAgentText('ag-missing', 'x');
  useStore.getState().appendAgentThinking('ag-missing', 'y');
  flush();
  assert.equal(agent('ag-missing'), undefined);
});

// ── ② 回收 ────────────────────────────────────────────────
const KEEP = mod.AGENT_RECYCLE_KEEP;
await check('② 有回收上限这个常量(AGENT_RECYCLE_KEEP:已结束、且不在任何打开视图里的记录最多留几条)', async () => {
  assert.ok(Number.isInteger(KEEP) && KEEP > 0 && KEEP <= 200, `AGENT_RECYCLE_KEEP = ${KEEP}`);
});

await check('② 300 条"已结束 + 所属会话没在任何窗格里打开"的记录:只留最近的若干条,其余回收', async () => {
  useStore.setState({ activeAgents: {}, paneSessions: [{ sessionId: 's-open', projectHash: 'p' }], paneCount: 1, viewingAgentByTab: {} });
  const s = useStore.getState();
  for (let i = 0; i < 300; i += 1) s.upsertAgent(`closed-${i}`, { status: 'done', sessionId: `s-closed-${i % 7}`, startedAt: 1000 + i, finishedAt: 2000 + i });
  flush();
  const ids = Object.keys(useStore.getState().activeAgents);
  const limit = Number.isInteger(KEEP) ? KEEP : 100;
  assert.ok(ids.length <= limit, `留下了 ${ids.length} 条(上限 ${limit})`);
  assert.ok(ids.includes('closed-299'), '最近结束的应留着');
  assert.ok(!ids.includes('closed-0'), '最早结束的应被回收');
});

await check('② 不回收:还在跑的 / 所属会话正开在某个窗格里的 / 正在主区放大查看的', async () => {
  useStore.setState({ activeAgents: {}, paneSessions: [{ sessionId: 's-open', projectHash: 'p' }, { sessionId: 's-open-2', projectHash: 'p' }], paneCount: 2, viewingAgentByTab: { 0: 'viewing-1' } });
  const s = useStore.getState();
  for (let i = 0; i < 40; i += 1) s.upsertAgent(`open-${i}`, { status: 'done', sessionId: i % 2 ? 's-open' : 's-open-2', finishedAt: 10 + i });
  for (let i = 0; i < 10; i += 1) s.upsertAgent(`running-${i}`, { status: 'working', sessionId: 's-closed-x', startedAt: 10 + i });
  s.upsertAgent('starting-1', { status: 'starting', sessionId: 's-closed-x' });
  s.upsertAgent('waiting-1', { status: 'needs_input', sessionId: 's-closed-x' });
  s.upsertAgent('viewing-1', { status: 'done', sessionId: 's-closed-x', finishedAt: 1 });
  for (let i = 0; i < 400; i += 1) s.upsertAgent(`closed-${i}`, { status: i % 3 === 0 ? 'error' : (i % 3 === 1 ? 'stopped' : 'done'), sessionId: 's-closed-y', finishedAt: 5000 + i });
  flush();
  const all = useStore.getState().activeAgents;
  for (let i = 0; i < 40; i += 1) assert.ok(all[`open-${i}`], `打开窗格里的会话的记录 open-${i} 不该被回收(卡片 / 监控面板还在用)`);
  for (let i = 0; i < 10; i += 1) assert.ok(all[`running-${i}`], `还在跑的 running-${i} 不该被回收`);
  assert.ok(all['starting-1'] && all['waiting-1'], '启动中 / 等输入的不该被回收');
  assert.ok(all['viewing-1'], '正在主区放大查看的不该被回收');
  const closedLeft = Object.keys(all).filter((k) => k.startsWith('closed-')).length;
  const limit = Number.isInteger(KEEP) ? KEEP : 100;
  assert.ok(closedLeft <= limit, `可回收的记录留下了 ${closedLeft} 条(上限 ${limit})`);
});

await check('② 分屏收窄后,已关掉的窗格里的会话不算"打开"(与监控面板同一口径)', async () => {
  // paneSessions 是按下标的数组:4 格改回 1 格后 2~4 号槽位还留着当时的会话对象
  useStore.setState({ activeAgents: {}, paneSessions: [{ sessionId: 's-open', projectHash: 'p' }, { sessionId: 's-was-open', projectHash: 'p' }], paneCount: 1, viewingAgentByTab: {} });
  const s = useStore.getState();
  for (let i = 0; i < 300; i += 1) s.upsertAgent(`gone-${i}`, { status: 'done', sessionId: 's-was-open', finishedAt: 100 + i });
  flush();
  const left = Object.keys(useStore.getState().activeAgents).length;
  const limit = Number.isInteger(KEEP) ? KEEP : 100;
  assert.ok(left <= limit, `留下了 ${left} 条(上限 ${limit})`);
});

if (failed) { console.log(`\n${failed} 项失败`); process.exit(1); }
console.log('\n全部通过');
