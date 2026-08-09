#!/usr/bin/env node
// Bug5 分支(fork)子代理串扰:卡片归属校验 + 停止路由。
//
// 根因:fork = 逐行复制 jsonl,只重写顶层 sessionId,message.content 里的 tool_use.id
// 原样保留(server/routes/fork.js);而 store.activeAgents 是【全局、按 tool_use.id 为键】
// 的表 —— 分支会话里的 Task 卡直接取到源会话【还活着】的 agent(显示运行中),
// 停止键又用 agent.sessionId(= 源会话)发请求,把源会话的子代理停了。
//
// 修法:agent 只有属于卡片所在会话才算数(resolveOwnedAgent);停止请求以卡片归属为准。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

const { resolveOwnedAgent } = await import('../../client/src/utils/agentOwner.js');

// ── 1) 纯函数判定(真 import)──────────────────────────────────────
const live = { id: 'tu-1', sessionId: 'sid-src', status: 'working' };

// (a) 分支场景:卡片在分支会话里,agent 归源会话 → 当作不存在
//     (调用方据此落进既有的"中断残骸"分支:灰环已停止 + 停止按钮不显示)
assert.equal(resolveOwnedAgent(live, 'sid-fork'), null,
  '归属不符 → null:分支卡片不得取到源会话那个还活着的 agent');

// (b) 正常会话:同一会话 → 原样返回(非分支零回归)
assert.equal(resolveOwnedAgent(live, 'sid-src'), live, '同会话 → 原样返回');

// (c) agent 没记归属(老条目)→ 无从判断,按原逻辑放行
const noSid = { id: 'tu-2', status: 'working' };
assert.equal(resolveOwnedAgent(noSid, 'sid-fork'), noSid, 'agent 无 sessionId → 放行');

// (d) ownerSid 缺失:流式中的本地 turn 对象没有 sessionId 字段 → 走原逻辑
assert.equal(resolveOwnedAgent(live, null), live, 'ownerSid=null → 放行(live 气泡零回归)');
assert.equal(resolveOwnedAgent(live, undefined), live, 'ownerSid 未传 → 放行');
assert.equal(resolveOwnedAgent(live, ''), live, 'ownerSid 空串 → 放行');

// (e) 本来就没有 agent
assert.equal(resolveOwnedAgent(undefined, 'sid-src'), null, '无 agent → null');
assert.equal(resolveOwnedAgent(null, null), null, '无 agent + 无归属 → null');

// ── 2) 接线:供给点与两个消费点(.jsx 不能被 node 直接 import,守源码)────
const taskCard = read('client', 'src', 'components', 'tools', 'TaskCard.jsx');
assert.ok(/const ownerSid = useContext\(TaskOwnerContext\)/.test(taskCard),
  'TaskCard 从 context 取卡片归属');
assert.ok(/const agent = resolveOwnedAgent\(useStore\(\(s\) => s\.activeAgents\[toolCall\.id\]\), ownerSid\)/.test(taskCard),
  'TaskCard 的 agent 必须过归属校验(不得裸读 activeAgents)');
assert.ok(/stopSingleTask\(\s*ownerSid \|\| agent\?\.sessionId/.test(taskCard),
  '停止路由:卡片归属优先,agent.sessionId(发起时钉的源会话)只做兜底');
// hydrate 不得覆盖别的会话正在跑的 agent(activeAgents 按 id 全局唯一,upsert 是合并写)
assert.ok(/if \(!st\.activeAgents\[toolCall\.id\]\) \{/.test(taskCard),
  'openAgentView 仅在完全无条目时 hydrate,归属不符时不 upsert(否则覆盖源会话的活 agent)');

const turnBubble = read('client', 'src', 'components', 'TurnBubble.jsx');
assert.ok(/<TaskOwnerContext\.Provider value=\{turn\.sessionId \|\| null\}>/.test(turnBubble),
  'TurnBubble 供给本回合的会话归属(session-reader 打在 turn 上的 record.sessionId)');
assert.ok(turnBubble.includes('</TaskOwnerContext.Provider>'), 'Provider 闭合');

const subagentView = read('client', 'src', 'components', 'SubagentView.jsx');
assert.ok(/resolveOwnedAgent\(useStore\(\(s\) => s\.activeAgents\[agentId\]\), parentSessionId\)/.test(subagentView),
  'SubagentView 同一判定:分支窗格打开子代理不得渲染源会话的实时流');
assert.ok(/stopSingleTask\(parentSessionId \|\| agent\.sessionId, agentId\)/.test(subagentView),
  'SubagentView 停止路由同样以母会话(本视图归属)为准');

// ── 3) 分支入口:源会话在跑时先确认(选项 4a)────────────────────────
const app = read('client', 'src', 'App.jsx');
assert.equal((app.match(/confirmDialog\(FORK_RUNNING_CONFIRM/g) || []).length, 2,
  '两个分支入口(侧栏 handleFork / 消息级 forkCurrentSession)都要提示');
assert.ok(/runningSessionIds\.has\(session\.sessionId\)/.test(app),
  '侧栏入口分支的是列表里那条会话 → 用 runningSessionIds 判在跑,不能用本窗格 streamingRef');
assert.ok(/if \(streamingRef\.current \|\| backgroundPidRef\.current\) \{\s*\n\s*if \(!\(await confirmDialog\(FORK_RUNNING_CONFIRM/.test(app),
  '消息级入口分支的是本窗格会话 → streaming 与后台都要判(v0.2.191 转后台漏判律)');
assert.ok(/正在进行的回合与子代理不会带入分支/.test(app) && /也不会因分支而停止/.test(app),
  '文案客观陈述分支的实际语义(只复制已落盘内容 / 不影响源会话)');

// ── 4) 停止路由端到端:按分支会话停,源会话的 slot 一个都不发 ──────────
const { useStore } = await import('../../client/src/stores/sessionStore.js');
const calls = [];
globalThis.fetch = async (url, opts) => {
  calls.push({ url: String(url), opts });
  if (String(url) === '/api/agents/active') {
    return { json: async () => ({ agents: [
      // 只有源会话有活进程 —— 分支是刚复制出来的新会话,还没发过消息
      { kind: 'chat-process', pid: 'sdk-src', sessionId: 'sid-src', stoppable: true },
    ] }) };
  }
  return { json: async () => ({ ok: true, stopped: true }) };
};
useStore.getState().upsertAgent('tu-1', { sessionId: 'sid-src', status: 'working' });
const r = await useStore.getState().stopSingleTask('sid-fork', 'tu-1');
assert.equal(calls.filter((c) => c.url.includes('/stop-task')).length, 0,
  '用分支 sessionId 停:一个 stop-task 都不该发到源会话的 slot(现象②)');
assert.equal(r.noOwner, true, '分支自己没有进程 → noOwner:卡片落终态 + 提示一次,源会话不受影响');

console.log('PASS check-fork-agent-ownership');
