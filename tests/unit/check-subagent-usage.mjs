#!/usr/bin/env node
// A 项(2026-09-11)服务端:子代理用量读取与归属 —— turn 的 subUsage.agents[]。
// 契约 §10.1:普通子代理用 meta.json 的 toolUseId 归属,workflow 子代理用 runId →
// 那次 Workflow 调用的 tool_use.id(多命中按时间戳就近);归不上的不进 agents[];
// 本轮一条都没有 → subUsage 键不出现;usage 去重口径与 turn.usageCalls 逐字相同。
// 全程在临时 HOME 里跑(裸 express 挂真 server/routes/sessions.js),不碰真 ~/.claude。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const home = mkdtempSync(join(tmpdir(), 'cgui-pa-subusage-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

const HASH = '-Users-x-pa-subusage';
const SID = '77777777-7777-4777-8777-777777777777';
const projectDir = join(home, '.claude', 'projects', HASH);
const subDir = join(projectDir, SID, 'subagents');
const wfDir = join(subDir, 'workflows', 'wf_pa_resume');
mkdirSync(wfDir, { recursive: true });

const usage = (o) => ({
  input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...o,
});
const assistant = (uuid, at, id, model, u) => ({
  type: 'assistant', uuid, timestamp: at, message: { id, model, content: [{ type: 'text', text: 'x' }], usage: u },
});
const writeJsonl = (file, records) => writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');

// ── 母会话:三个回合 ───────────────────────────────────────────────────────
// 回合 1:一个普通 Task(toolu_task1)
// 回合 2:一条 Workflow 调用(toolu_wf_first) + 一条归不到任何子代理的 Task(toolu_ghost)
// 回合 3:同 runId 的 Workflow 续跑(toolu_wf_second)
// 每个回合都由一条真人工消息开头(否则三段会并成同一回合)。
const toolUse = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });
const human = (uuid, at, text) => ({ type: 'user', uuid, timestamp: at, message: { role: 'user', content: text } });
const wfResult = (uuid, at, toolUseId, note) => ({
  type: 'user', uuid, timestamp: at,
  toolUseResult: { taskType: 'local_workflow', runId: 'wf_pa_resume', workflowName: 'wf', transcriptDir: `${projectDir}/${SID}/subagents/workflows/wf_pa_resume` },
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: note }] },
});
const parent = [
  human('u1', '2026-09-11T01:00:00.000Z', '第一轮'),
  {
    type: 'assistant', uuid: 'a1', timestamp: '2026-09-11T01:00:10.000Z',
    message: { id: 'm1', model: 'claude-opus-5', content: [toolUse('toolu_task1', 'Task', { subagent_type: 'code-reviewer' })] },
  },
  {
    type: 'user', uuid: 'u1r', timestamp: '2026-09-11T01:00:20.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_task1', content: 'done' }] },
  },
  human('u2', '2026-09-11T02:00:00.000Z', '第二轮'),
  {
    type: 'assistant', uuid: 'a2', timestamp: '2026-09-11T02:00:10.000Z',
    message: { id: 'm2', model: 'claude-opus-5', content: [toolUse('toolu_wf_first', 'Workflow', { name: 'wf' })] },
  },
  wfResult('u2r', '2026-09-11T02:00:20.000Z', 'toolu_wf_first', 'run 1 done'),
  human('u4', '2026-09-11T03:00:00.000Z', '第三轮'),
  {
    type: 'assistant', uuid: 'a4', timestamp: '2026-09-11T03:00:10.000Z',
    message: { id: 'm4', model: 'claude-opus-5', content: [toolUse('toolu_wf_second', 'Workflow', { name: 'wf' })] },
  },
  wfResult('u4r', '2026-09-11T03:00:20.000Z', 'toolu_wf_second', 'run 2 done'),
  // 第四轮:整轮里没有任何可归属的子代理 → 这一轮不得出现 subUsage 键
  human('u5', '2026-09-11T04:00:00.000Z', '第四轮'),
  {
    type: 'assistant', uuid: 'a5', timestamp: '2026-09-11T04:00:10.000Z',
    message: { id: 'm5', model: 'claude-opus-5', content: [toolUse('toolu_ghost', 'Task', {})] },
  },
];
writeJsonl(join(projectDir, `${SID}.jsonl`), parent);

// ── 普通子代理 ─────────────────────────────────────────────────────────────
// agent-pa-normal:正常;同一 message.id 两条(流式分片)→ 首次出现为准
writeJsonl(join(subDir, 'agent-pa-normal.jsonl'), [
  { type: 'user', uuid: 's1', timestamp: '2026-09-11T01:00:11.000Z', message: { role: 'user', content: 'go' } },
  assistant('s2', '2026-09-11T01:00:12.000Z', 'sm1', 'claude-sonnet-4-6', usage({ input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 80, cache_creation: { ephemeral_5m_input_tokens: 80 } })),
  assistant('s3', '2026-09-11T01:00:13.000Z', 'sm1', 'claude-sonnet-4-6', usage({ input_tokens: 999, output_tokens: 999 })),
  assistant('s4', '2026-09-11T01:00:14.000Z', 'sm2', 'claude-sonnet-4-6', usage({ input_tokens: 7, output_tokens: 3 })),
  assistant('s5', '2026-09-11T01:00:15.000Z', 'sm3', 'claude-sonnet-4-6', usage({})),
]);
writeFileSync(join(subDir, 'agent-pa-normal.meta.json'), JSON.stringify({ agentType: 'code-reviewer', toolUseId: 'toolu_task1', model: 'sonnet' }), 'utf8');

// agent-pa-nometa:meta 里没有 toolUseId、也不在 workflow 目录 → 归不上
writeJsonl(join(subDir, 'agent-pa-nometa.jsonl'), [
  assistant('t1', '2026-09-11T01:00:16.000Z', 'tm1', 'claude-sonnet-4-6', usage({ input_tokens: 5 })),
]);
writeFileSync(join(subDir, 'agent-pa-nometa.meta.json'), JSON.stringify({ agentType: 'explorer' }), 'utf8');

// agent-pa-elsewhere:toolUseId 属于别的会话(本会话没有这次调用) → 归不上
writeJsonl(join(subDir, 'agent-pa-elsewhere.jsonl'), [
  assistant('v1', '2026-09-11T01:00:17.000Z', 'vm1', 'claude-sonnet-4-6', usage({ input_tokens: 6 })),
]);
writeFileSync(join(subDir, 'agent-pa-elsewhere.meta.json'), JSON.stringify({ agentType: 'fixer', toolUseId: 'toolu_other_session' }), 'utf8');

// agent-pa-broken:坏 JSON → 跳过它自己,其余照常
writeFileSync(join(subDir, 'agent-pa-broken.jsonl'), '{not json\n', 'utf8');

// ── workflow 子代理(同一 runId 挂两条 tool_result = 续跑)────────────────────
// 三次调用的时刻:toolu_wf_first @02:00:20、toolu_wf_second @03:00:20
writeJsonl(join(wfDir, 'agent-wf-early.jsonl'), [
  assistant('w0', '2026-09-11T01:59:00.000Z', 'wm0', 'claude-opus-5', usage({ input_tokens: 1 })),   // 早于全部调用 → 归最早那次
]);
writeJsonl(join(wfDir, 'agent-wf-middle.jsonl'), [
  assistant('w1', '2026-09-11T02:30:00.000Z', 'wm1', 'claude-opus-5', usage({ input_tokens: 2 })),   // 落在两次之间 → 归第一次
]);
writeJsonl(join(wfDir, 'agent-wf-late.jsonl'), [
  assistant('w2', '2026-09-11T03:30:00.000Z', 'wm2', 'claude-opus-5', usage({ input_tokens: 3 })),   // 晚于全部 → 归最后一次
]);
// 同一 runId 下的两个 agent 落在同一轮 → 同一 toolUseId 名下两个(金额合计规则的基础)
writeJsonl(join(wfDir, 'agent-wf-middle2.jsonl'), [
  assistant('w3', '2026-09-11T02:40:00.000Z', 'wm3', 'claude-opus-5', usage({ input_tokens: 4 })),
]);

// ── 归属边界(契约 §10.1「多命中且时间戳分不开」)──────────────────────────────
// 另一个会话里两两成对的承载记录:一对时间戳**逐字相同**(分不开 → 一个都不归属),一对
// 时刻**不同**(对照:多命中仍按就近归属 —— 新分支只对"分不开"生效,不把多命中一律打死)。
const SID2 = '99999999-9999-4999-8999-999999999999';
const subDir2 = join(projectDir, SID2, 'subagents');
const tieDir = join(subDir2, 'workflows', 'wf_pa_tie');
const ctlDir = join(subDir2, 'workflows', 'wf_pa_ctl');
mkdirSync(tieDir, { recursive: true });
mkdirSync(ctlDir, { recursive: true });

const TIE_AT = '2026-09-11T06:00:30.000Z';   // 两条承载记录逐字相同的时刻
const wfCallOf = (uuid, at, toolUseId, runId) => ({
  type: 'assistant', uuid, timestamp: at,
  message: { id: `msg_${uuid}`, model: 'claude-opus-5', content: [toolUse(toolUseId, 'Workflow', { name: runId })] },
});
const wfResultOf = (uuid, at, toolUseId, runId) => ({
  type: 'user', uuid, timestamp: at,
  toolUseResult: { taskType: 'local_workflow', runId, workflowName: runId, transcriptDir: join(subDir2, 'workflows', runId) },
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'done' }] },
});
writeJsonl(join(projectDir, `${SID2}.jsonl`), [
  human('h1', '2026-09-11T06:00:00.000Z', '第一轮'),
  wfCallOf('b1', '2026-09-11T06:00:10.000Z', 'toolu_tie_a', 'wf_pa_tie'),
  wfResultOf('b1r', TIE_AT, 'toolu_tie_a', 'wf_pa_tie'),
  human('h2', '2026-09-11T06:01:00.000Z', '第二轮'),
  wfCallOf('b2', '2026-09-11T06:01:10.000Z', 'toolu_tie_b', 'wf_pa_tie'),
  wfResultOf('b2r', TIE_AT, 'toolu_tie_b', 'wf_pa_tie'),
  human('h3', '2026-09-11T06:02:00.000Z', '第三轮(对照)'),
  wfCallOf('b3', '2026-09-11T06:02:10.000Z', 'toolu_ctl_a', 'wf_pa_ctl'),
  wfResultOf('b3r', '2026-09-11T06:02:30.000Z', 'toolu_ctl_a', 'wf_pa_ctl'),
  human('h4', '2026-09-11T06:03:00.000Z', '第四轮(对照)'),
  wfCallOf('b4', '2026-09-11T06:03:10.000Z', 'toolu_ctl_b', 'wf_pa_ctl'),
  wfResultOf('b4r', '2026-09-11T06:03:30.000Z', 'toolu_ctl_b', 'wf_pa_ctl'),
]);
const wfAgent = (dir2, id, at) => {
  writeJsonl(join(dir2, `${id}.jsonl`), [
    assistant(`${id}-a`, at, `${id}-m`, 'claude-opus-5', usage({ input_tokens: 10, output_tokens: 1 })),
  ]);
  writeFileSync(join(dir2, `${id}.meta.json`), JSON.stringify({ agentType: 'workflow-subagent', spawnDepth: 1 }), 'utf8');
};
wfAgent(tieDir, 'agent-tie-after', '2026-09-11T06:10:00.000Z');    // 晚于两条承载记录 → 分不开
wfAgent(tieDir, 'agent-tie-before', '2026-09-11T05:00:00.000Z');   // 早于两条承载记录 → 也分不开
wfAgent(ctlDir, 'agent-ctl-between', '2026-09-11T06:03:00.000Z');  // 落在两条之间 → 归前一条

const express = (await import('express')).default;
const { default: sessionRoutes } = await import(`${root}/server/routes/sessions.js`);
const app = express();
app.use(express.json());
app.use('/api', sessionRoutes);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${String((e && e.message) || e).split('\n').slice(0, 6).join('\n      ')}`); }
};

const read = async () => {
  const res = await fetch(`${base}/api/sessions/${encodeURIComponent(SID)}/messages?projectHash=${encodeURIComponent(HASH)}`);
  return { status: res.status, body: await res.json() };
};
const first = await read();
const messages = first.body.messages || [];
const turns = messages.filter((m) => m.type === 'turn');
const agentsOf = (turn) => turn?.subUsage?.agents || [];
const turnWith = (toolUseId) => turns.find((t) => (t.toolCalls || []).some((tc) => tc.id === toolUseId));

await check('① 普通子代理按 meta.toolUseId 归到那一轮,字段语义到位', () => {
  const turn = turnWith('toolu_task1');
  assert.ok(turn, '必须有承载 toolu_task1 的回合');
  const list = agentsOf(turn);
  assert.equal(list.length, 1, '只应有 1 个可归属子代理');
  const a = list[0];
  assert.equal(a.agentSessionId, 'agent-pa-normal');
  assert.equal(a.toolUseId, 'toolu_task1');
  assert.equal(a.agentType, 'code-reviewer');
  assert.equal(a.model, 'claude-sonnet-4-6', 'model 必须取转写里的真 id(不是 meta 的别名 sonnet)');
  assert.equal(a.timestamp, '2026-09-11T01:00:12.000Z', '首条带 timestamp 的 assistant 记录');
  assert.deepEqual(Object.keys(a.usage).sort(), ['cache_read_input_tokens', 'cache_creation', 'cache_creation_input_tokens', 'input_tokens', 'output_tokens'].sort());
});

await check('② usage 去重口径与 turn.usageCalls 逐字相同(同 id 首次出现为准、全零不计)', () => {
  const a = agentsOf(turnWith('toolu_task1'))[0];
  assert.equal(a.usageCalls.length, 2, 'sm1 与 sm2 各一项(同 id 的后写分片与全零 sm3 不计)');
  assert.equal(a.usageCalls[0].usage.input_tokens, 100, '取首次出现那条(不是末条的 999)');
  assert.equal(a.usageCalls[0].at, '2026-09-11T01:00:12.000Z');
  for (const field of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
    const sum = a.usageCalls.reduce((acc, call) => acc + (call.usage[field] || 0), 0);
    assert.equal(sum, a.usage[field] ?? 0, `usageCalls 之和 === usage.${field}`);
  }
  assert.deepEqual(a.usage.cache_creation, { ephemeral_5m_input_tokens: 80, ephemeral_1h_input_tokens: 0 }, 'TTL 分项按同口径汇总');
});

await check('③ 归不上的子代理不进 agents[](无 toolUseId / 属于别的会话 / 坏文件)', () => {
  const raw = JSON.stringify(messages);
  for (const id of ['agent-pa-nometa', 'agent-pa-elsewhere', 'agent-pa-broken']) {
    assert.ok(!raw.includes(id), `${id} 不得出现在 agents[]`);
  }
  assert.ok(!raw.includes('unattributed'), 'v3 已删 unattributed 桶');
});

await check('④ 挂不上任何子代理的回合:subUsage 键不出现(不是 {agents:[]})', () => {
  const turn = turnWith('toolu_ghost');
  assert.ok(turn, '必须有承载 toolu_ghost 的回合');
  assert.ok(!('subUsage' in turn), 'subUsage 键不得出现');
  for (const t of turns) if ('subUsage' in t) assert.ok((t.subUsage.agents || []).length > 0, 'subUsage 出现时必须非空');
});

await check('⑤ workflow 归属:runId → 那次 Workflow 调用;resume 多命中按时间戳就近', () => {
  const t1 = turnWith('toolu_wf_first');
  const t2 = turnWith('toolu_wf_second');
  const ids1 = agentsOf(t1).map((a) => a.agentSessionId).sort();
  const ids2 = agentsOf(t2).map((a) => a.agentSessionId).sort();
  assert.deepEqual(ids1, ['agent-wf-early', 'agent-wf-middle', 'agent-wf-middle2'], '早于全部调用 → 最早那次;两次之间 → 第一次');
  assert.deepEqual(ids2, ['agent-wf-late'], '晚于全部 → 最后一次');
  for (const a of [...agentsOf(t1), ...agentsOf(t2)]) {
    assert.ok(['toolu_wf_first', 'toolu_wf_second'].includes(a.toolUseId), 'toolUseId 必须是那次 Workflow 调用');
  }
});

await check('⑥ 同一 agent 只出现一次(金额不得两轮各显示一遍)', () => {
  const all = turns.flatMap((t) => agentsOf(t).map((a) => a.agentSessionId));
  assert.equal(all.length, new Set(all).size, 'agentSessionId 不得重复');
});

await check('⑦ 同一 toolUseId 名下多个 agent 按转写文件名升序', () => {
  const list = agentsOf(turnWith('toolu_wf_first')).filter((a) => a.agentSessionId.startsWith('agent-wf-middle'));
  assert.deepEqual(list.map((a) => a.agentSessionId), ['agent-wf-middle', 'agent-wf-middle2']);
});

await check('⑧ 重复读取结果逐字段相等(stat 签名缓存命中路径)', async () => {
  const second = await read();
  assert.equal(JSON.stringify(second.body.messages), JSON.stringify(first.body.messages));
});

await check('⑨ 轮末口径未被污染:usage/ctxUsage/costUsd 字段照旧,usageTotals 无 subagent 分项', () => {
  for (const t of turns) {
    assert.ok('usage' in t || t.usage == null, 'turn 仍带 usage 字段');
    assert.ok(!('costUsd' in t), '服务端从不下发 turn.costUsd(展示层算)');
  }
  assert.ok(first.body.usageTotals, 'usageTotals 必须仍在');
  assert.ok(!Object.prototype.hasOwnProperty.call(first.body.usageTotals, 'subagent'), '不得新增 usageTotals.subagent');
  assert.ok(!('subagentUnattributed' in first.body), '不得新增顶层 subagentUnattributed');
});

await check('⑩ 没有 subagents 目录的会话:subUsage 一个都不出现', async () => {
  const plain = '88888888-8888-4888-8888-888888888888';
  writeJsonl(join(projectDir, `${plain}.jsonl`), [
    { type: 'user', uuid: 'p1', timestamp: '2026-09-11T01:00:00.000Z', message: { role: 'user', content: 'hi' } },
    {
      type: 'assistant', uuid: 'p2', timestamp: '2026-09-11T01:00:05.000Z',
      message: { id: 'pm1', model: 'deepseek-flash', content: [toolUse('toolu_plain', 'Task', {})] },
    },
  ]);
  const res = await fetch(`${base}/api/sessions/${plain}/messages?projectHash=${encodeURIComponent(HASH)}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(!JSON.stringify(body.messages || []).includes('subUsage'), 'subUsage 不得出现');
});

await check('⑪ 同一 runId 的承载记录时间戳分不开(逐字相同)→ 一个都不归属;时刻可分则照旧就近', async () => {
  // 夹具自证:同一 runId 两条承载记录时间戳逐字相同;对照组两条时刻不同
  const parent2 = readFileSync(join(projectDir, `${SID2}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const carriersOf = (runId) => parent2.flatMap((r) => (Array.isArray(r.message?.content) ? r.message.content : [])
    .filter((c) => c?.type === 'tool_result' && r.toolUseResult?.runId === runId)
    .map((c) => ({ toolUseId: c.tool_use_id, at: r.timestamp })));
  const tied = carriersOf('wf_pa_tie');
  assert.equal(tied.length, 2, '夹具自证:同一 runId 必须挂两条承载记录');
  assert.equal(new Set(tied.map((c) => c.at)).size, 1, '夹具自证:两条承载记录的时刻必须逐字相同');
  const ctl = carriersOf('wf_pa_ctl');
  assert.equal(ctl.length, 2, '夹具自证:对照组也挂两条');
  assert.equal(new Set(ctl.map((c) => c.at)).size, 2, '夹具自证:对照组两条时刻必须不同');

  // 产品行为
  const res = await fetch(`${base}/api/sessions/${encodeURIComponent(SID2)}/messages?projectHash=${encodeURIComponent(HASH)}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  const raw = JSON.stringify(body.messages || []);
  for (const id of ['agent-tie-after', 'agent-tie-before']) {
    assert.ok(!raw.includes(id), `${id} 的归属时刻分不开 → 不得出现在任何 agents[](宁缺勿猜)`);
  }
  const turns2 = (body.messages || []).filter((m) => m.type === 'turn');
  const ctlTurn = turns2.find((t) => (t.toolCalls || []).some((tc) => tc.id === 'toolu_ctl_a'));
  const ctlAgents = (ctlTurn?.subUsage?.agents || []).map((a) => a.agentSessionId);
  assert.deepEqual(ctlAgents, ['agent-ctl-between'], '对照:多命中且时刻可分 → 仍按就近归属(新分支不得把多命中一律打死)');
  assert.equal(ctlTurn.subUsage.agents[0].toolUseId, 'toolu_ctl_a', '落在两条之间 → 归前一条');
});

server.close();
console.log(failed ? `\n${failed} 条失败` : '\n✓ check-subagent-usage: 子代理用量与归属 全过');
process.exit(failed ? 1 : 0);
