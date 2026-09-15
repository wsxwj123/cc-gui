#!/usr/bin/env node
// R12(服务端一半)代理停止 POST /api/chat/:pid/stop-task 的四档判定与终态来源。
//   ① agentStopVerdict 纯函数四档:错归属 409 / 活任务 200 stopped:true(shell 不冒领)/
//      运行实例已回收但历史里有它 409 AGENT_NOT_RUNNING / 哪里都没有 404;
//   ② 终态簿记 rememberFinishedTask:只收真终态、有上限;
//   ③ findAgentRunEvidence 从母会话历史取真实终态(通知信封两种落盘形态 + 结构化
//      toolUseResult;'async_launched' 不算终态);
//   ④ 路由信封:缺参数 400、pid 不存在且历史里没有 404、pid 不存在但历史里有 → 409
//      AGENT_NOT_RUNNING(SB-T60 的那一档);
//   ⑤ 路径防线:畸形 parentSessionId(`../..`、绝对路径、`\0`)既不 400 也不 500,照常走判定,
//      且一个字节的文件都不读 —— 用诱饵会话证明(见 ⑤ 段注释)。全程在临时 HOME 里跑。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const home = mkdtempSync(join(tmpdir(), 'cgui-r12-stop-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

const HASH = '-Users-x-fixture-workspace';
const PARENT = '55555555-5555-4555-8555-555555555555';
const NOTIFY = 'call_00_R12NOTIFY0001';
const QUEUED = 'call_00_R12QUEUED0002';
const FG = 'call_00_R12FOREGROUND3';
const ASYNC = 'call_00_R12ASYNC00004';
const FAILED = 'call_00_R12FAILED0005';
const REPEAT = 'call_00_R12REPEAT0006';

const projectsDir = join(home, '.claude', 'projects');
mkdirSync(join(projectsDir, HASH), { recursive: true });
const rec = (o) => JSON.stringify(o);
const notification = (tid, status) =>
  `<task-notification>\n<task-id>t_${tid}</task-id>\n<tool-use-id>${tid}</tool-use-id>\n<status>${status}</status>\n<summary>x</summary>\n</task-notification>`;

writeFileSync(join(projectsDir, HASH, `${PARENT}.jsonl`), [
  { type: 'assistant', uuid: 'x1', message: { content: [{ type: 'tool_use', id: NOTIFY, name: 'Agent', input: {} }] } },
  { type: 'user', uuid: 'x2', origin: { kind: 'task-notification' }, message: { role: 'user', content: notification(NOTIFY, 'completed') } },
  { type: 'assistant', uuid: 'x3', message: { content: [{ type: 'tool_use', id: QUEUED, name: 'Agent', input: {} }] } },
  { type: 'attachment', uuid: 'x4', attachment: { type: 'queued_command', prompt: notification(QUEUED, 'completed') } },
  { type: 'user', uuid: 'x5', toolUseResult: { status: 'completed' }, message: { content: [{ type: 'tool_result', tool_use_id: FG, content: '答完了' }] } },
  { type: 'user', uuid: 'x6', toolUseResult: { isAsync: true, status: 'async_launched' }, message: { content: [{ type: 'tool_result', tool_use_id: ASYNC, content: 'Async agent launched' }] } },
  { type: 'user', uuid: 'x7', toolUseResult: { status: 'failed' }, message: { content: [{ type: 'tool_result', tool_use_id: FAILED, content: '炸了', is_error: true }] } },
  // 同一 task 通知多次:以后者为准
  { type: 'user', uuid: 'x8', message: { role: 'user', content: notification(REPEAT, 'completed') } },
  { type: 'user', uuid: 'x9', message: { role: 'user', content: notification(REPEAT, 'stopped') } },
].map(rec).join('\n') + '\n', 'utf8');

// ⑤ 的诱饵:一份"只有走 ../.. 穿越才读得到"的会话转写。它放在 <home>/.claude/decoy.jsonl,
// 从 PROJECTS_DIR 出发的朴素拼接 join(PROJECTS_DIR, <任一项目>, '../../decoy.jsonl') 正好落到
// 这里。谁把形状白名单拆了,这里就能被读到 → 判定变成 409 AGENT_NOT_RUNNING(而不是 404),
// 单测立刻红。反过来读不到,说明畸形 parentSessionId 根本没进文件系统。
const TOOL_DECOY = 'call_00_R12DECOY00007';
const DECOY = join(home, '.claude', 'decoy.jsonl');
writeFileSync(DECOY, [
  { type: 'assistant', uuid: 'd1', message: { content: [{ type: 'tool_use', id: TOOL_DECOY, name: 'Agent', input: {} }] } },
  { type: 'user', uuid: 'd2', message: { role: 'user', content: notification(TOOL_DECOY, 'completed') } },
].map(rec).join('\n') + '\n', 'utf8');

const { agentStopVerdict, rememberFinishedTask, FINISHED_TASKS_MAX } = await import(`${root}/server/routes/chat.js`);
const { findAgentRunEvidence, findSessionFile } = await import(`${root}/server/services/session-reader.js`);

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${String(e && e.message || e).split('\n').slice(0, 4).join('\n      ')}`); }
};

// ── ① 四档判定 ──────────────────────────────────────────────────────────────
const V = (o) => agentStopVerdict({ slotKnown: true, slotSessionId: 'sid', parentSessionId: 'sid', liveKind: null, hasEvidence: false, ...o });

await check('错母会话(pid 登记在,母会话对不上)→ 409 AGENT_OWNER_MISMATCH', () => {
  assert.deepEqual(V({ parentSessionId: 'other', liveKind: 'subagent' }), { http: 409, code: 'AGENT_OWNER_MISMATCH' });
});
await check('错母会话优先于"历史里有它":不能靠历史洗白错归属', () => {
  assert.equal(V({ parentSessionId: 'other', hasEvidence: true }).code, 'AGENT_OWNER_MISMATCH');
});
await check('草稿 slot 没落定母会话(登记为 null)时不判错归属', () => {
  assert.deepEqual(V({ slotSessionId: null, parentSessionId: 'sid', liveKind: 'subagent' }), { http: 200, stopped: true });
});
await check('活着的子代理 → 200 stopped:true', () => {
  assert.deepEqual(V({ liveKind: 'subagent' }), { http: 200, stopped: true });
});
await check('活着的 shell 长任务 → 200 stopped:false(刻意保留,不冒领已停)', () => {
  assert.deepEqual(V({ liveKind: 'shell' }), { http: 200, stopped: false });
});
await check('运行实例已回收、历史里有它 → 409 AGENT_NOT_RUNNING', () => {
  assert.deepEqual(V({ slotKnown: false, hasEvidence: true }), { http: 409, code: 'AGENT_NOT_RUNNING' });
});
await check('哪里都没有这个身份 → 404(登记不在)', () => {
  assert.deepEqual(V({ slotKnown: false, hasEvidence: false }), { http: 404, code: 'AGENT_NOT_FOUND' });
});
await check('登记在但查无此身份 → 404(不拿 stopped:false 冒充见过的身份)', () => {
  assert.deepEqual(V({ slotKnown: true, hasEvidence: false }), { http: 404, code: 'AGENT_NOT_FOUND' });
});
await check('已知运行里该子代理恰好结束 → 200 stopped:false(终态由调用方附上)', () => {
  assert.deepEqual(V({ hasEvidence: true }), { http: 200, stopped: false });
});

// ── ② 终态簿记 ──────────────────────────────────────────────────────────────
await check('只收真终态:非终态/非字符串记为 null,不假造终态', () => {
  const slot = { finishedTasks: new Map() };
  rememberFinishedTask(slot, 'tu-1', 'completed');
  rememberFinishedTask(slot, 'tu-2', 'in_progress');
  rememberFinishedTask(slot, 'tu-3', 'stopped');
  rememberFinishedTask(slot, 'tu-4', undefined);
  assert.equal(slot.finishedTasks.get('tu-1'), 'completed');
  assert.equal(slot.finishedTasks.get('tu-2'), null);
  assert.equal(slot.finishedTasks.get('tu-3'), 'stopped');
  assert.equal(slot.finishedTasks.get('tu-4'), null);
  rememberFinishedTask(slot, '', 'completed');
  assert.equal(slot.finishedTasks.has(''), false, '空 toolUseId 不登记');
});
await check(`簿记有上限(${FINISHED_TASKS_MAX}),满了丢最旧的`, () => {
  const slot = { finishedTasks: new Map() };
  for (let i = 0; i < FINISHED_TASKS_MAX + 5; i++) rememberFinishedTask(slot, `tu-${i}`, 'completed');
  assert.equal(slot.finishedTasks.size, FINISHED_TASKS_MAX);
  assert.equal(slot.finishedTasks.has('tu-0'), false, '最旧的被丢掉');
  assert.equal(slot.finishedTasks.has(`tu-${FINISHED_TASKS_MAX + 4}`), true, '最新的还在');
});
await check('slot 上没有簿记/传空也不抛(旧 slot 与防御路径)', () => {
  rememberFinishedTask(null, 'tu', 'completed');
  rememberFinishedTask({}, 'tu', 'completed');
});

// ── ③ 磁盘终态来源 ──────────────────────────────────────────────────────────
await check('普通 user 形态的通知信封 → completed', async () => {
  assert.deepEqual(await findAgentRunEvidence(PARENT, NOTIFY), { seen: true, status: 'completed' });
});
await check('折叠进回合的 queued_command 通知 → completed', async () => {
  assert.deepEqual(await findAgentRunEvidence(PARENT, QUEUED), { seen: true, status: 'completed' });
});
await check('前台 Task 的结构化 toolUseResult.status=completed → completed', async () => {
  assert.deepEqual(await findAgentRunEvidence(PARENT, FG), { seen: true, status: 'completed' });
});
await check('后台启动的 async_launched 不算终态(有痕迹、终态为 null)', async () => {
  assert.deepEqual(await findAgentRunEvidence(PARENT, ASYNC), { seen: true, status: null });
});
await check('失败的结构化终态 → failed', async () => {
  assert.deepEqual(await findAgentRunEvidence(PARENT, FAILED), { seen: true, status: 'failed' });
});
await check('同一 task 通知多次 → 以后一条为准', async () => {
  assert.deepEqual(await findAgentRunEvidence(PARENT, REPEAT), { seen: true, status: 'stopped' });
});
await check('历史里没有这个身份 → null(调用方据此回 404)', async () => {
  assert.equal(await findAgentRunEvidence(PARENT, 'call_00_NEVERSEEN00000'), null);
});
await check('母会话不存在/非法 id → null,不抛', async () => {
  assert.equal(await findAgentRunEvidence('no-such-session', NOTIFY), null);
  assert.equal(await findAgentRunEvidence('', NOTIFY), null);
  assert.equal(await findAgentRunEvidence(PARENT, ''), null);
});

// ── ④ 路由信封(真 chatRoutes 挂在裸 express 上)────────────────────────────
const express = (await import('express')).default;
const { default: chatRoutes } = await import(`${root}/server/routes/chat.js`);
const app = express();
app.use(express.json());
app.use('/api', chatRoutes);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
const stop = async (pid, body) => {
  const res = await fetch(`${base}/api/chat/${encodeURIComponent(pid)}/stop-task`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  let out = null;
  try { out = await res.json(); } catch {}
  return { status: res.status, body: out };
};

await check('缺 toolUseId / 缺母会话 → 400 信封', async () => {
  const a = await stop('sdk-x', { parentSessionId: PARENT });
  assert.equal(a.status, 400);
  assert.equal(a.body.ok, false);
  assert.equal(a.body.code, 'AGENT_INVALID_INPUT');
  const b = await stop('sdk-x', { toolUseId: NOTIFY });
  assert.equal(b.status, 400);
  assert.equal(b.body.ok, false);
});
await check('现有 GUI 的 sessionId 拼写被当作 parentSessionId 收下', async () => {
  // 该 pid 未登记、历史里也没有这个 toolUseId → 走 404 而不是 400,证明拼写已被接受。
  const r = await stop('sdk-x', { toolUseId: 'call_00_NEVERSEEN00000', sessionId: PARENT });
  assert.equal(r.status, 404);
});
await check('pid 未登记且历史里没有 → 404 信封(不是 500/旧 {error} 形态)', async () => {
  const r = await stop('sdk-nope', { parentSessionId: PARENT, toolUseId: 'call_00_NEVERSEEN00000' });
  assert.equal(r.status, 404);
  assert.equal(r.body.ok, false);
  assert.equal(typeof r.body.code, 'string');
  assert.equal(typeof r.body.error, 'string');
  assert.ok(!JSON.stringify(r.body).includes(home), '错误正文泄露了数据根绝对路径');
});
await check('pid 未登记但历史里有该身份 → 409 AGENT_NOT_RUNNING(只有历史没有运行实例)', async () => {
  const r = await stop('sdk-lapsed', { parentSessionId: PARENT, parentPid: 'sdk-lapsed', toolUseId: NOTIFY });
  assert.equal(r.status, 409);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.code, 'AGENT_NOT_RUNNING');
});

// ── ⑤ 路径防线:畸形 parentSessionId 不进文件系统 ─────────────────────────────
// 先证明诱饵真的可达(朴素拼接能落到它)——否则下面几条断言是空转、测不出东西。
await check('诱饵可达性自检:朴素 join(PROJECTS_DIR, 项目, "../../decoy.jsonl") 指向已存在的文件', () => {
  assert.ok(existsSync(join(projectsDir, HASH, '../../decoy.jsonl')), '诱饵路径与朴素拼接不一致,本组断言会失去意义');
  assert.ok(existsSync(DECOY));
});
await check('findSessionFile 对畸形 id 一律 null(路径闸门在拼接之前)', async () => {
  for (const bad of ['../../decoy', '../../etc/passwd', '/etc/passwd', 'x\x00y', '..', '']) {
    assert.equal(await findSessionFile(bad), null, `findSessionFile 不该接受 ${JSON.stringify(bad)}`);
  }
});
await check('findAgentRunEvidence 对畸形 id 返回 null —— 诱饵里的终态读不到 = 一个字节都没读', async () => {
  // 诱饵里写着 TOOL_DECOY 的 completed 通知:若这道闸门被拆,这里会返回 {seen:true,status:'completed'}。
  assert.equal(await findAgentRunEvidence('../../decoy', TOOL_DECOY), null);
  assert.equal(await findAgentRunEvidence('/etc/passwd', TOOL_DECOY), null);
});
await check('路由:畸形 parentSessionId 不是 400/500,照常判"从未找到该身份"(404 信封)', async () => {
  for (const bad of ['../../decoy', '../../etc/passwd', '/etc/passwd', 'x\x00y', 'sb_wrong_parent_zz']) {
    const r = await stop('sdk-nope', { parentSessionId: bad, parentPid: 'sdk-nope', toolUseId: TOOL_DECOY });
    assert.equal(r.status, 404, `${JSON.stringify(bad)} 应走判定而不是拒绝:${JSON.stringify(r.body)}`);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.code, 'AGENT_NOT_FOUND');
  }
});
await check('路由:畸形 parentSessionId 下错归属仍判 409 AGENT_OWNER_MISMATCH', async () => {
  // SB-T59 的形状:声明值是普通文本(非 uuid),判定必须照常走"错归属"而不是"非法输入"。
  // 这里用 verdict 纯函数复现同一组合(单测进程里没有注册中的 slot,注册态那半边由 SB-T59 真机覆盖)。
  assert.deepEqual(
    agentStopVerdict({ slotKnown: true, slotSessionId: PARENT, parentSessionId: 'sb_wrong_parent_zz', liveKind: null, hasEvidence: false }),
    { http: 409, code: 'AGENT_OWNER_MISMATCH' });
  const r = await stop('sdk-nope', { parentSessionId: 'sb_wrong_parent_zz', toolUseId: TOOL_DECOY });
  assert.notEqual(r.status, 400, '非 uuid 声明值不得被判成非法输入');
});
server.close();

console.log(failed ? `FAIL check-r12-agent-stop(${failed} 条红)` : 'PASS check-r12-agent-stop');
process.exit(failed ? 1 : 0);
