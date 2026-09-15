#!/usr/bin/env node
// R11(监控「查看」定位母会话)+ R12(子代理详情:来源/fork 归属/迟到响应)客户端一半的
// 判据单测。全部打在 client/src/utils/agentView.js 的纯函数上 —— 组件只是把它们接到 UI,
// 所以这里红了组件必然错,这里绿也不能代替真机(真机由 second-batch 锁定用例 + 开发侧探针覆盖)。
//   ① 身份匹配:母会话 + toolUseId 定位,不看窗格位置/序号/模型名;
//   ② 迟到响应丢弃:只有"仍然是我们水合的那条 + 归属没变"才允许写入;
//   ③ fork 归属:同一个 toolUseId 在两个母会话下是两条各自的条目,复制品没有运行证据;
//   ④ 来源标注:实时 = 有证据在跑,历史 = 只剩转写;
//   ⑤ 运行证据的证据链 + 失败文案四档。
import assert from 'node:assert/strict';
import {
  AGENT_TERMINAL_STATUSES,
  agentHydrationStatus,
  agentKey,
  agentOpenFailureAction,
  agentSourceState,
  buildAgentRows,
  fetchAgentHistory,
  historyReadFailureText,
  locateParentPane,
  shouldApplyHistory,
  splitHistoryBlocks,
  taskRunEvidence,
} from '../../client/src/utils/agentView.js';

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok   ${name}`); }
  catch (err) { failed++; console.error(`FAIL ${name}\n     ${err.message}`); }
}

const PARENT_A = 'aaa-1111';
const PARENT_B = 'bbb-2222';
const TOOL = 'call_00_shared';
const AGENT = 'agent-aaaa1111bbbb2222';
const HASH = '-Users-x-fixture';

const taskCall = (id, result) => ({ id, name: 'Agent', input: { prompt: 'do it', subagent_type: 'general-purpose' }, ...(result ? { result } : {}) });
const asyncResult = { toolUseId: TOOL, content: '[{"type":"text","text":"Async agent launched successfully. The agent is working in the background."}]' };
const doneResult = { toolUseId: TOOL, content: '[{"type":"text","text":"AGENT_DONE"}]' };

// ── ① 身份匹配 ────────────────────────────────────────────────────────────────
await check('locateParentPane:按母 sessionId 找窗格,不看位置/序号', () => {
  const panes = [{ sessionId: 'x' }, { sessionId: PARENT_A }, { sessionId: null }];
  assert.equal(locateParentPane(panes, 3, PARENT_A), 1);
  assert.equal(locateParentPane(panes, 1, PARENT_A), -1, '被 paneCount 裁掉的槽位不算还开着');
  assert.equal(locateParentPane(panes, 3, 'nope'), -1);
  assert.equal(locateParentPane(panes, 3, null), -1);
  assert.equal(locateParentPane(null, 3, PARENT_A), -1);
});

await check('agentKey:身份 = 母会话 + toolUseId(同 id 不同母会话是两个身份)', () => {
  assert.notEqual(agentKey(PARENT_A, TOOL), agentKey(PARENT_B, TOOL));
  assert.equal(agentKey(PARENT_A, TOOL), `aaa-1111|call_00_shared`);
});

await check('buildAgentRows:fork 复制品与源会话同名时,条目归属"眼前那个母会话"', () => {
  const source = { sessionId: 'src-session', projectHash: HASH, firstPrompt: 'source', subagents: [{ sessionId: 'agent-src', toolUseId: TOOL }] };
  const fork = { sessionId: PARENT_B, projectHash: HASH, firstPrompt: 'fork copy' };
  const messages = [{ type: 'turn', toolCalls: [taskCall(TOOL, doneResult)] }];
  const rows = buildAgentRows({
    sessionsByProject: { [HASH]: [source, fork] },
    panes: [{ session: fork, messages }],       // 只开着复制品
    liveAgents: {},
    openSessionIds: [PARENT_B],
  });
  assert.equal(rows.length, 1, '同名任务在列表里只留一条,点错母会话就是从"两条都一样"开始的');
  assert.equal(rows[0].parentSessionId, PARENT_B, '查看要落在用户眼前的那个母会话上');
  assert.equal(rows[0].agentSessionId, null);
  assert.equal(rows[0].hasTranscript, false, '复制的历史不是它自己的运行证据');
});

// ── ⑤ 运行证据 ────────────────────────────────────────────────────────────────
await check('taskRunEvidence:没回结果 = 在跑;回了普通结果 = 结束', () => {
  assert.equal(taskRunEvidence([{ type: 'turn', toolCalls: [taskCall(TOOL)] }], TOOL), 'running');
  assert.equal(taskRunEvidence([{ type: 'turn', toolCalls: [taskCall(TOOL, doneResult)] }], TOOL), 'ended');
});
await check('taskRunEvidence:后台启动且无终态通知 = 在跑;来了终态通知 = 结束', () => {
  const launched = [{ type: 'turn', toolCalls: [taskCall(TOOL, asyncResult)] }];
  assert.equal(taskRunEvidence(launched, TOOL), 'running');
  const notified = [...launched, { type: 'task-notice', status: 'completed', text: `<tool-use-id>${TOOL}</tool-use-id><status>completed</status>` }];
  assert.equal(taskRunEvidence(notified, TOOL), 'ended');
  // 别的身份的终态通知不算(不能拿别人的通知收尾)
  const other = [...launched, { type: 'task-notice', status: 'completed', text: '<tool-use-id>call_other</tool-use-id><status>completed</status>' }];
  assert.equal(taskRunEvidence(other, TOOL), 'running');
});
await check('taskRunEvidence:不是它的母会话 = null(不知道就不猜)', () => {
  assert.equal(taskRunEvidence([{ type: 'turn', toolCalls: [taskCall('call_other')] }], TOOL), null);
  assert.equal(taskRunEvidence([], TOOL), null);
  assert.equal(taskRunEvidence([{ type: 'turn', toolCalls: [{ id: TOOL, name: 'Read', input: {} }] }], TOOL), null, '同 id 但不是 Task/Agent 工具不算');
  assert.equal(taskRunEvidence(null, TOOL), null);
});

// ── ④ 来源标注 + fork 停止按钮 ────────────────────────────────────────────────
await check('agentSourceState:实时/历史两档(停止按钮 = 有运行证据)', () => {
  assert.deepEqual(agentSourceState({ evidence: 'running', nonTerminal: false }), { running: true, label: '实时' });
  assert.deepEqual(agentSourceState({ evidence: 'ended', nonTerminal: true }), { running: false, label: '历史' });
  assert.deepEqual(agentSourceState({ evidence: null, nonTerminal: true }), { running: true, label: '实时' });
  assert.deepEqual(agentSourceState({ evidence: null, nonTerminal: false }), { running: false, label: '历史' });
  // fork 视图:复制品的历史里带着源代理的终态通知(实测形态)→ 证据说结束 →
  // running=false → 停止按钮不显示(不是靠"有没有转写"否定,索引可能是过期的)。
  const forkMessages = [
    { type: 'turn', toolCalls: [taskCall(TOOL, asyncResult)] },
    { type: 'task-notice', status: 'completed', text: `<tool-use-id>${TOOL}</tool-use-id><status>completed</status>` },
  ];
  assert.equal(taskRunEvidence(forkMessages, TOOL), 'ended');
  assert.deepEqual(agentSourceState({ evidence: taskRunEvidence(forkMessages, TOOL), nonTerminal: false }), { running: false, label: '历史' });
});

// ── ② 迟到响应丢弃 ────────────────────────────────────────────────────────────
await check('shouldApplyHistory:只有"还是我们水合的那条 + 归属没变"才写', () => {
  assert.equal(shouldApplyHistory({ hydrated: true, sessionId: PARENT_A }, PARENT_A), true);
  assert.equal(shouldApplyHistory({ hydrated: false, sessionId: PARENT_A }, PARENT_A), false, '活流条目自己会到,历史不得覆盖');
  assert.equal(shouldApplyHistory({ hydrated: true, sessionId: PARENT_B }, PARENT_A), false, '目标已改变 → 丢弃');
  assert.equal(shouldApplyHistory(null, PARENT_A), false, '条目已消失 → 丢弃');
  assert.equal(shouldApplyHistory({ hydrated: true, sessionId: PARENT_A }, null), true, '已知归属缺省时不作否定');
});

// ── ⑤ 失败文案四档 + 有序块 ───────────────────────────────────────────────────
await check('historyReadFailureText:五种失败分别可见,不合并成一句"失败"', () => {
  assert.equal(historyReadFailureText(409, 'AGENT_OWNER_UNRESOLVED'), '无法确定母会话');
  assert.equal(historyReadFailureText(404, 'SESSION_NOT_FOUND'), '母会话不存在');
  assert.equal(historyReadFailureText(403, null), '无权查看此会话');
  assert.equal(historyReadFailureText(504, 'HISTORY_READ_TIMEOUT'), '加载超时，可重试');
  assert.equal(historyReadFailureText(0, 'AGENT_OPEN_TIMEOUT'), '加载超时，可重试');
  assert.equal(historyReadFailureText(0, 'NETWORK'), '加载失败，可重试');
  assert.equal(historyReadFailureText(500, 'HISTORY_READ_FAILED'), '加载失败，可重试');
});

// ── 代理打开:15 秒超时是独立状态,取消只取消读取 ─────────────────────────────
await check('fetchAgentHistory:15 秒没回来 = 超时(独立文案),不是"加载失败"', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (_url, opts) => new Promise((_res, reject) => {
    opts?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  try {
    const t0 = Date.now();
    const res = await fetchAgentHistory({ agentSessionId: 'agent-x', projectHash: 'hash', timeoutMs: 40 });
    assert.equal(res.ok, false);
    assert.equal(res.timedOut, true);
    assert.equal(res.message, '加载超时，可重试');
    assert.ok(Date.now() - t0 >= 35, '要等满 timeoutMs 才宣告超时');
    assert.equal(agentOpenFailureAction(res), 'keep', '超时只是临时读不到:视图与停止目标必须留着');
  } finally { globalThis.fetch = real; }
});
await check('fetchAgentHistory:取消/切目标 = 只取消读取,不出文案、不回滚', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (_url, opts) => new Promise((_res, reject) => {
    opts?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  try {
    const ctl = new AbortController();
    const p = fetchAgentHistory({ agentSessionId: 'agent-x', projectHash: 'hash', signal: ctl.signal, timeoutMs: 5_000 });
    ctl.abort();
    const res = await p;
    assert.deepEqual(res, { ok: false, aborted: true }, '被取消:连文案都没有');
    assert.equal(agentOpenFailureAction(res), 'ignore', '取消不得触发任何可见错误或回滚');
  } finally { globalThis.fetch = real; }
});
await check('fetchAgentHistory:服务端 504 走超时文案;5xx 走加载失败', async () => {
  const real = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false, status: 504, json: async () => ({ ok: false, code: 'HISTORY_READ_TIMEOUT' }) });
    const t = await fetchAgentHistory({ agentSessionId: 'agent-x', projectHash: 'hash' });
    assert.equal(t.message, '加载超时，可重试');
    assert.equal(agentOpenFailureAction(t), 'keep');
    globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ ok: false, code: 'HISTORY_READ_FAILED' }) });
    const f = await fetchAgentHistory({ agentSessionId: 'agent-x', projectHash: 'hash' });
    assert.equal(f.message, '加载失败，可重试');
    assert.equal(agentOpenFailureAction(f), 'keep');
    globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({ ok: false, code: 'SESSION_NOT_FOUND' }) });
    const nf = await fetchAgentHistory({ agentSessionId: 'agent-x', projectHash: 'hash' });
    assert.equal(agentOpenFailureAction(nf), 'rollback', '不存在/无权限才回滚,保留用户原来的视图');
  } finally { globalThis.fetch = real; }
});
await check('agentOpenFailureAction:归属不可靠 → 回滚;成功 → 不动', () => {
  assert.equal(agentOpenFailureAction({ ok: false, code: 'AGENT_OWNER_UNRESOLVED' }), 'rollback');
  assert.equal(agentOpenFailureAction({ ok: false, status: 403 }), 'rollback');
  assert.equal(agentOpenFailureAction({ ok: true, owner: {}, blocks: [] }), 'none');
});
await check('splitHistoryBlocks:prompt 单独取,其余保持原序', () => {
  const { prompt, blocks } = splitHistoryBlocks([
    { type: 'prompt', content: '读 README' },
    { type: 'thinking', content: '先看文件' },
    { type: 'tool_use', toolCall: { id: 'call_read', name: 'Read' } },
    { type: 'text', content: 'AGENT_DONE' },
  ]);
  assert.equal(prompt, '读 README');
  assert.deepEqual(blocks.map((b) => b.type), ['thinking', 'tool_use', 'text']);
});

// ── ① / ③ 列表口径 ────────────────────────────────────────────────────────────
await check('buildAgentRows:历史里的子代理(母会话没打开)也在列表里', () => {
  const rows = buildAgentRows({
    sessionsByProject: { [HASH]: [{
      sessionId: PARENT_A, projectHash: HASH, firstPrompt: 'alpha',
      subagents: [{ sessionId: AGENT, toolUseId: TOOL, agentType: 'general-purpose', model: 'm-1', firstPrompt: 'read readme', lastActivity: '2026-09-11T00:00:00.000Z' }],
    }] },
    panes: [],
    liveAgents: {},
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].toolUseId, TOOL);
  assert.equal(rows[0].parentSessionId, PARENT_A);
  assert.equal(rows[0].agentSessionId, AGENT);
  assert.equal(rows[0].agentProjectHash, HASH, '转写读法要带母会话所在项目');
  assert.equal(rows[0].hasTranscript, true);
  assert.equal(rows[0].running, false, '没有证据就不宣称在跑');
});
await check('buildAgentRows:活流条目压过索引条目(同身份只一条),状态取自活流', () => {
  const rows = buildAgentRows({
    sessionsByProject: { [HASH]: [{
      sessionId: PARENT_A, projectHash: HASH,
      subagents: [{ sessionId: AGENT, toolUseId: TOOL, agentType: 'general-purpose' }],
    }] },
    panes: [],
    liveAgents: { [TOOL]: { id: TOOL, sessionId: PARENT_A, status: 'working', model: 'm-2' } },
  });
  assert.equal(rows.length, 1, `同一身份不能列两条:${JSON.stringify(rows)}`);
  assert.equal(rows[0].running, true);
  assert.equal(rows[0].live, true);
  assert.equal(rows[0].agentSessionId, AGENT, '索引补上的转写身份要保留');
});
await check('buildAgentRows:活流里已完成/水合的条目不算在跑', () => {
  const rows = buildAgentRows({
    sessionsByProject: {},
    panes: [],
    liveAgents: {
      done1: { id: 'done1', sessionId: PARENT_A, status: 'done' },
      hyd1: { id: 'hyd1', sessionId: PARENT_A, status: 'working', hydrated: true },
      orphan1: { id: 'orphan1', sessionId: null, status: 'working' },
    },
  });
  assert.equal(rows.filter((r) => r.running).length, 0);
  assert.equal(rows.length, 1, '没有母会话的 draft 期条目不进这份列表(定位不了)');
});
await check('buildAgentRows:workflow 内层助手不进这份列表(面板另有专区分组)', () => {
  const rows = buildAgentRows({
    sessionsByProject: { [HASH]: [{
      sessionId: PARENT_A, projectHash: HASH,
      subagents: [{ sessionId: 'agent-wf1', toolUseId: null, workflowId: 'wf_1' }],
    }] },
    panes: [], liveAgents: {},
  });
  assert.equal(rows.length, 0);
});
await check('buildAgentRows:缺工具身份的子代理仍列出(点开会说"无法确定母会话",不猜)', () => {
  const rows = buildAgentRows({
    sessionsByProject: { [HASH]: [{
      sessionId: PARENT_A, projectHash: HASH,
      subagents: [{ sessionId: AGENT, toolUseId: null, agentType: 'general-purpose' }],
    }] },
    panes: [], liveAgents: {},
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].toolUseId, null);
  assert.equal(rows[0].agentSessionId, AGENT);
});
await check('buildAgentRows:索引还没加载时不当成"复制品"(新建会话里的子代理不许被误标)', () => {
  // 会话刚建好、项目的会话索引还没落地:面板只有窗格消息这一条来源。
  // 此时"有没有转写"是【不知道】,不是"没有" —— 当成复制品会把在跑的子代理说成已停止、
  // 还会摘掉停止按钮(实测:SB-T52 在索引未就绪时就会这样翻车)。
  const rows = buildAgentRows({
    sessionsByProject: {},                              // 索引还没加载
    panes: [{ session: { sessionId: PARENT_A, projectHash: HASH }, messages: [{ type: 'turn', toolCalls: [taskCall(TOOL, asyncResult)] }] }],
    liveAgents: {},
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hasTranscript, null, '不知道就是不知道');
  assert.equal(rows[0].running, true, '后台启动 + 无终态通知 = 在跑');
  assert.equal(agentHydrationStatus({ running: rows[0].running, hasTranscript: rows[0].hasTranscript, result: rows[0].result }), 'working');
});
await check('agentHydrationStatus:在跑/有转写/看得见结果/中断残骸四档', () => {
  assert.equal(agentHydrationStatus({ running: true, hasTranscript: false }), 'working');
  assert.equal(agentHydrationStatus({ running: false, hasTranscript: true }), 'done');
  assert.equal(agentHydrationStatus({ running: false, hasTranscript: null, result: 'AGENT_DONE' }), 'done');
  assert.equal(agentHydrationStatus({ running: false, hasTranscript: null }), 'stopped', '看得见的都没有 → 中断残骸');
});
await check('buildAgentRows:复制品带着源代理的终态通知 = 不在跑(停止按钮不显示)', () => {
  const forkMessages = [
    { type: 'turn', toolCalls: [taskCall(TOOL, asyncResult)] },
    { type: 'task-notice', status: 'completed', text: `<tool-use-id>${TOOL}</tool-use-id><status>completed</status>` },
  ];
  const rows = buildAgentRows({
    sessionsByProject: { [HASH]: [{ sessionId: PARENT_A, projectHash: HASH }] },   // 复制品没有 subagents/
    panes: [{ session: { sessionId: PARENT_A, projectHash: HASH }, messages: forkMessages }],
    liveAgents: {},
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].running, false, '证据说结束(源代理已有终态通知)→ 不给实时、不给停止按钮');
  // 转写存在性只做标注:复制品确知没有自己的转写(母会话在索引里、却没有这条)
  assert.equal(rows[0].hasTranscript, false);
});
await check('buildAgentRows:同一个 toolUseId 只留一条,优先"现在开着的那条"(分支复制品)', () => {
  const source = { sessionId: '22a22067', projectHash: HASH, subagents: [{ sessionId: 'agent-src', toolUseId: TOOL, agentType: 'general-purpose' }] };
  const forkA = { sessionId: PARENT_A, projectHash: HASH };     // 复制品没有 subagents/
  const messages = [{ type: 'turn', toolCalls: [taskCall(TOOL, doneResult)] }];
  // 没开任何窗格:留源会话那条(有独立转写)
  let rows = buildAgentRows({
    sessionsByProject: { [HASH]: [source, forkA] },
    panes: [{ session: forkA, messages }],
    liveAgents: {},
    openSessionIds: [],
  });
  assert.equal(rows.length, 1, `同一 toolUseId 出现两行就会点错母会话:${JSON.stringify(rows.map((r) => r.parentSessionId))}`);
  assert.equal(rows[0].parentSessionId, '22a22067');
  // 复制品的母会话开着:那一条才代表用户眼前的东西
  rows = buildAgentRows({
    sessionsByProject: { [HASH]: [source, forkA] },
    panes: [{ session: forkA, messages }],
    liveAgents: {},
    openSessionIds: [PARENT_A],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].parentSessionId, PARENT_A);
  assert.equal(rows[0].hasTranscript, false, '复制的历史不算它自己的运行证据');
});
await check('buildAgentRows:条数封顶,跑中的排最前', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ sessionId: `s${i}`, projectHash: HASH, subagents: [{ sessionId: `a${i}`, toolUseId: `call_${i}` }] }));
  const rows = buildAgentRows({
    sessionsByProject: { [HASH]: many },
    panes: [{ session: { sessionId: 's9', projectHash: HASH }, messages: [{ type: 'turn', toolCalls: [taskCall('call_9')] }] }],
    liveAgents: {},
    limit: 5,
  });
  assert.equal(rows.length, 5);
});

console.log(failed ? `FAIL check-r11r12-agent-view(${failed} 条红)` : 'PASS check-r11r12-agent-view');
process.exit(failed ? 1 : 0);
