#!/usr/bin/env node
// R12(服务端一半)读代理历史:GET /api/sessions/:sessionId/messages 的响应合同。
//   ① 唯一根 schema {messages,usageTotals,owner,view} —— 一个键都不多、一个都不少;
//   ② 子代理转写按落盘位置解析出真实母归属(parentSessionId = 上级目录名,
//      toolUseId = 同目录 <agent>.meta.json),view.kind='agent',
//      view.blocks 按原顺序(prompt/thinking/tool_use/text;CLI 写的空 thinking 不留块);
//   ③ 普通会话 owner 的母身份为 null、view.kind='session'、blocks 为空;
//   ④ 错 projectHash 读子代理 → 409 AGENT_OWNER_UNRESOLVED;哪里都没有 → 404;
//      缺参数/非法身份 → 400;空历史 → 200 空数组;错误正文不得泄露服务器绝对路径。
// 全程在临时 HOME 里跑(真 server/routes/sessions.js 挂在一个裸 express 上),不碰真 ~/.claude。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const home = mkdtempSync(join(tmpdir(), 'cgui-r12-history-'));
process.env.HOME = home;
process.env.USERPROFILE = home; // Windows 上 homedir() 读 %USERPROFILE%

const HASH_A = '-Users-x-fixture-workspace';
const HASH_B = '-Users-x-fixture-workspace-other';
const PARENT = '11111111-1111-4111-8111-111111111111';
const AGENT = 'agent-aaaa1111bbbb2222';
const TOOL = 'call_00_R12HISTORY0001';
const PLAIN = '22222222-2222-4222-8222-222222222222';
const EMPTY = '33333333-3333-4333-8333-333333333333';
const WORKFLOW_SID = '44444444-4444-4444-8444-444444444444';
const WF_AGENT = 'agent-wf00000000000001';

const projectsDir = join(home, '.claude', 'projects');
const subagentsDir = join(projectsDir, HASH_A, PARENT, 'subagents');
const wfDir = join(subagentsDir, 'workflows', 'wf_r12check');
mkdirSync(wfDir, { recursive: true });
mkdirSync(join(projectsDir, HASH_B), { recursive: true });

const rec = (o) => JSON.stringify(o);
const write = (p, recs) => writeFileSync(p, recs.map(rec).join('\n') + '\n', 'utf8');

// 子代理转写:真形态(实测 <project>/<parent>/subagents/<agent>.jsonl)。中间那条空 thinking
// 是 CLI 真会写的形态(第一个子代理夹具里就有),它不该变成一个空块。
write(join(subagentsDir, `${AGENT}.jsonl`), [
  { type: 'user', uuid: 'u1', timestamp: 't1', message: { role: 'user', content: '读 README 然后只回 AGENT_DONE' } },
  { type: 'assistant', uuid: 'a1', timestamp: 't2', message: { model: 'm', content: [{ type: 'thinking', thinking: '先看文件' }] } },
  { type: 'assistant', uuid: 'a2', timestamp: 't3', message: { model: 'm', content: [{ type: 'tool_use', id: 'call_read_1', name: 'Read', input: { file_path: '/x/README.md' } }] } },
  { type: 'user', uuid: 'u2', timestamp: 't4', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_read_1', content: 'README 正文' }] } },
  { type: 'assistant', uuid: 'a3', timestamp: 't5', message: { model: 'm', content: [{ type: 'thinking', thinking: '' }] } },
  { type: 'assistant', uuid: 'a4', timestamp: 't6', message: { model: 'm', content: [{ type: 'text', text: 'AGENT_DONE' }] } },
]);
writeFileSync(join(subagentsDir, `${AGENT}.meta.json`),
  JSON.stringify({ agentType: 'general-purpose', toolUseId: TOOL }), 'utf8');

// workflow 起的 agent:深两层,meta 里没有 toolUseId(实测形态)——owner.toolUseId 只能为 null,
// 不能因此判成"归属不可靠"(那会把点开 workflow 内层助手的既有入口打挂)。
write(join(wfDir, `${WF_AGENT}.jsonl`), [
  { type: 'user', uuid: 'w1', timestamp: 't1', message: { role: 'user', content: 'workflow inner agent' } },
]);
writeFileSync(join(wfDir, `${WF_AGENT}.meta.json`), JSON.stringify({ agentType: 'general-purpose' }), 'utf8');

// 普通会话 + 空会话
write(join(projectsDir, HASH_A, `${PLAIN}.jsonl`), [
  { type: 'user', uuid: 'p1', timestamp: 't1', message: { role: 'user', content: '你好' } },
  { type: 'assistant', uuid: 'p2', timestamp: 't2', message: { id: 'msg_1', model: 'm', content: [{ type: 'text', text: '在' }], usage: { input_tokens: 3, output_tokens: 1 } } },
]);
writeFileSync(join(projectsDir, HASH_A, `${EMPTY}.jsonl`), '', 'utf8');

// ── 真路由:裸 express 挂 server/routes/sessions.js ─────────────────────────
const express = (await import('express')).default;
const { default: sessionRoutes } = await import(`${root}/server/routes/sessions.js`);
const app = express();
app.use(express.json());
app.use('/api', sessionRoutes);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

const get = async (sid, hash, rawQuery = null) => {
  const url = `${base}/api/sessions/${encodeURIComponent(sid)}/messages${rawQuery !== null ? rawQuery : `?projectHash=${encodeURIComponent(hash)}`}`;
  const res = await fetch(url);
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
};

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${String(e && e.message || e).split('\n').slice(0, 4).join('\n      ')}`); }
};

// ①② 子代理:四键 schema + 母归属 + 原序块
const agentHistory = await get(AGENT, HASH_A);
await check('子代理历史 200 且恰好四个根键', () => {
  assert.equal(agentHistory.status, 200);
  assert.deepEqual(Object.keys(agentHistory.body).sort(), ['messages', 'owner', 'usageTotals', 'view']);
});
await check('owner 带出真实母 sessionId 与 toolUseId', () => {
  assert.equal(agentHistory.body.owner.sessionId, AGENT);
  assert.equal(agentHistory.body.owner.projectHash, HASH_A);
  assert.equal(agentHistory.body.owner.parentSessionId, PARENT);
  assert.equal(agentHistory.body.owner.toolUseId, TOOL);
});
await check('view.kind=agent,blocks 按原顺序 prompt/thinking/tool_use/text', () => {
  assert.equal(agentHistory.body.view.kind, 'agent');
  assert.deepEqual(agentHistory.body.view.blocks.map((b) => b.type), ['prompt', 'thinking', 'tool_use', 'text']);
});
await check('prompt 块带正文,tool_use 块带工具调用与其结果(顺带:空 thinking 不留块)', () => {
  const [prompt, thinking, toolUse, text] = agentHistory.body.view.blocks;
  assert.equal(prompt.content, '读 README 然后只回 AGENT_DONE');
  assert.equal(thinking.content, '先看文件');
  assert.equal(toolUse.toolCall.id, 'call_read_1');
  assert.equal(toolUse.toolCall.result?.content, 'README 正文');
  assert.equal(text.content, 'AGENT_DONE');
});
await check('messages/usageTotals 既有字段原样保留', () => {
  assert.ok(Array.isArray(agentHistory.body.messages) && agentHistory.body.messages.length > 0);
  assert.equal(typeof agentHistory.body.usageTotals.input, 'number');
});

// ③ 普通会话
const plainHistory = await get(PLAIN, HASH_A);
await check('普通会话:owner 母身份为 null,view.kind=session 且 blocks 为空', () => {
  assert.equal(plainHistory.status, 200);
  assert.deepEqual(Object.keys(plainHistory.body).sort(), ['messages', 'owner', 'usageTotals', 'view']);
  assert.equal(plainHistory.body.owner.parentSessionId, null);
  assert.equal(plainHistory.body.owner.toolUseId, null);
  assert.equal(plainHistory.body.view.kind, 'session');
  assert.deepEqual(plainHistory.body.view.blocks, []);
  assert.equal(plainHistory.body.messages.filter((m) => m.type === 'user').length, 1);
});

// ④ 空历史:200 + 空数组
await check('空历史 200 且 messages=[]', async () => {
  const r = await get(EMPTY, HASH_A);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.messages, []);
});

// ⑤ 错 projectHash 读子代理 → 409
await check('错 projectHash 读子代理 → 409 AGENT_OWNER_UNRESOLVED', async () => {
  const r = await get(AGENT, HASH_B);
  assert.equal(r.status, 409);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.code, 'AGENT_OWNER_UNRESOLVED');
  assert.equal(typeof r.body.error, 'string');
});

// ⑥ 不存在 → 404,且不泄露服务器绝对路径
await check('不存在的身份 → 404 信封,正文不含服务器绝对路径', async () => {
  const r = await get('sb_missing_agent_zzz', HASH_A);
  assert.equal(r.status, 404);
  assert.equal(r.body.ok, false);
  assert.equal(typeof r.body.code, 'string');
  assert.ok(r.body.code.length > 0 && r.body.code.length <= 64);
  assert.equal(typeof r.body.error, 'string');
  assert.ok(!r.body.error.includes(home), '错误正文泄露了数据根绝对路径');
  assert.ok(!JSON.stringify(r.body).includes('ENOENT'), '错误正文泄露了 fs 错误');
});

// ⑦ 缺 projectHash / 非法身份 → 400
await check('缺 projectHash → 400 信封', async () => {
  const r = await get(AGENT, HASH_A, '');
  assert.equal(r.status, 400);
  assert.equal(r.body.ok, false);
  assert.equal(typeof r.body.code, 'string');
});
await check('非法身份(带路径分隔符)→ 400 信封', async () => {
  const r = await get('a/../../etc/passwd', HASH_A);
  assert.equal(r.status, 400);
  assert.equal(r.body.ok, false);
});

// ⑧ workflow 内层 agent:meta 无 toolUseId 也要能读(owner.toolUseId=null),不得判成冲突
await check('workflow 内层 agent 可读,母归属为父目录、toolUseId 为 null', async () => {
  const r = await get(WF_AGENT, HASH_A);
  assert.equal(r.status, 200);
  assert.equal(r.body.owner.parentSessionId, PARENT);
  assert.equal(r.body.owner.toolUseId, null);
  assert.equal(r.body.view.kind, 'agent');
});

server.close();
console.log(failed ? `FAIL check-r12-agent-history(${failed} 条红)` : 'PASS check-r12-agent-history');
process.exit(failed ? 1 : 0);
