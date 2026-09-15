#!/usr/bin/env node
// 直播子代理金额(2026-09-13):子代理【完成那一刻】服务端定向读它那一条转写 ——
// readSubagentUsageForToolUse。要钉住三件事:
//   ① 拿到的条目与历史路径(readSessionSubagentUsage → turn.subUsage.agents[])【逐字段相同】
//      —— 同一形状 = 同一计价口径,客户端算钱那套代码一行不用改;
//   ② 两条查找路径都对:taskId 直连文件名(零扫描)、命不中回落 meta.json 扫 toolUseId;
//   ③ 读不到就 null(不发 0 元)、入参含路径分隔符/.. 直接拒(自身安全边界)。
// 全程在临时 HOME 里跑,不碰真 ~/.claude。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const home = mkdtempSync(join(tmpdir(), 'cgui-live-subusage-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

const HASH = '-Users-x-live-subusage';
const SID = '88888888-8888-4888-8888-888888888888';
const TASK_A = 'a1b2c3d4e5f60718';   // 走 taskId 直连(文件名同名)
const TASK_B = 'b1b2c3d4e5f60718';   // 走 meta 扫描(文件名与 toolUseId 无关)
const projectDir = join(home, '.claude', 'projects', HASH);
const subDir = join(projectDir, SID, 'subagents');
mkdirSync(subDir, { recursive: true });

const usage = (o) => ({
  input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...o,
});
const assistant = (uuid, at, id, model, u) => ({
  type: 'assistant', uuid, timestamp: at, message: { id, model, content: [{ type: 'text', text: 'x' }], usage: u },
});
const writeJsonl = (file, records) => writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');

// 两条子代理转写:各两次带 usage 的调用(去重口径按 message.id,第二次全零不计)。
const transcriptOf = (model, tag) => [
  assistant(`${tag}-1`, '2026-09-13T01:00:01.000Z', `${tag}_m1`, model, usage({ input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 200 })),
  assistant(`${tag}-2`, '2026-09-13T01:00:02.000Z', `${tag}_m2`, model, usage({ input_tokens: 0, output_tokens: 0 })), // 全零 → 不计
  assistant(`${tag}-3`, '2026-09-13T01:00:03.000Z', `${tag}_m3`, model, usage({ input_tokens: 300, cache_creation_input_tokens: 400 })),
];
writeJsonl(join(subDir, `agent-${TASK_A}.jsonl`), transcriptOf('claude-opus-5', 'a'));
writeFileSync(join(subDir, `agent-${TASK_A}.meta.json`), JSON.stringify({ toolUseId: 'toolu_live_a', agentType: 'fixer' }), 'utf8');
// B:文件名与 toolUseId 无关(模拟 task_id 与文件名不同名的旧会话)→ 只能靠 meta 扫描命中。
writeJsonl(join(subDir, 'agent-zzz-not-the-task-id.jsonl'), transcriptOf('claude-sonnet-5', 'b'));
writeFileSync(join(subDir, 'agent-zzz-not-the-task-id.meta.json'), JSON.stringify({ toolUseId: 'toolu_live_b', agentType: 'explorer' }), 'utf8');
// C:转写存在但一条 usage 都没有(刚 spawn、正在 flush)→ 必须返回 null,不许发 0 元。
writeJsonl(join(subDir, `agent-${TASK_B}.jsonl`), [assistant('c-1', '2026-09-13T01:00:01.000Z', 'c_m1', 'claude-opus-5', usage({}))]);
writeFileSync(join(subDir, `agent-${TASK_B}.meta.json`), JSON.stringify({ toolUseId: 'toolu_live_c', agentType: 'fixer' }), 'utf8');

// ── 母会话:一次 Task 调用 + 它的 tool_result(历史路径归属用)────────────────
const parent = [
  { type: 'user', uuid: 'u1', timestamp: '2026-09-13T01:00:00.000Z', message: { role: 'user', content: '第一轮' } },
  {
    type: 'assistant', uuid: 'a1', timestamp: '2026-09-13T01:00:00.500Z',
    message: { id: 'm1', model: 'claude-opus-5', content: [{ type: 'tool_use', id: 'toolu_live_a', name: 'Task', input: { subagent_type: 'fixer' } }] },
  },
  {
    type: 'user', uuid: 'u1r', timestamp: '2026-09-13T01:05:00.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_live_a', content: 'done' }] },
  },
];
writeJsonl(join(projectDir, `${SID}.jsonl`), parent);

const { readSubagentUsageForToolUse, getSessionMessages } = await import(`${root}/server/services/session-reader.js`);

// ── ① taskId 直连 ─────────────────────────────────────────────────────────
const byTaskId = await readSubagentUsageForToolUse(HASH, SID, { toolUseId: 'toolu_live_a', taskId: TASK_A });
assert.ok(byTaskId, 'a 转写应按 taskId 直连命中');
assert.equal(byTaskId.toolUseId, 'toolu_live_a', '归属键必须取调用方给的 tool_use_id(卡片键)');
assert.equal(byTaskId.agentSessionId, `agent-${TASK_A}`);
assert.equal(byTaskId.agentType, 'fixer');
assert.equal(byTaskId.model, 'claude-opus-5');
assert.equal(byTaskId.timestamp, '2026-09-13T01:00:01.000Z');
assert.equal(byTaskId.usage.input_tokens, 400, '两次非零调用相加(全零那条不计)');
assert.equal(byTaskId.usage.output_tokens, 10);
assert.equal(byTaskId.usage.cache_read_input_tokens, 200);
assert.equal(byTaskId.usage.cache_creation_input_tokens, 400);
assert.equal(byTaskId.usageCalls.length, 2, 'usageCalls = 非零调用的逐条记录');

// ── ② 文件名不同名 → 回落 meta 扫描 ───────────────────────────────────────
const byMeta = await readSubagentUsageForToolUse(HASH, SID, { toolUseId: 'toolu_live_b', taskId: 'ffffffffffffffff' });
assert.ok(byMeta, 'taskId 命不中时应回落到 meta.json 扫 toolUseId');
assert.equal(byMeta.toolUseId, 'toolu_live_b');
assert.equal(byMeta.model, 'claude-sonnet-5');

// ── ③ 读不到就不发 ────────────────────────────────────────────────────────
assert.equal(await readSubagentUsageForToolUse(HASH, SID, { toolUseId: 'toolu_live_c', taskId: TASK_B }), null,
  '转写里没有任何非零 usage → null(宁缺勿假,不显示 $0.00)');
assert.equal(await readSubagentUsageForToolUse(HASH, SID, { toolUseId: 'toolu_nope', taskId: 'ffffffffffffffff' }), null,
  '找不到就 null');
assert.equal(await readSubagentUsageForToolUse(HASH, SID, {}), null, '既无 toolUseId 也无 taskId → null');
assert.equal(await readSubagentUsageForToolUse(HASH, '..', { toolUseId: 'toolu_live_a' }), null, '路径穿越的 sid 直接拒');
assert.equal(await readSubagentUsageForToolUse('../etc', SID, { toolUseId: 'toolu_live_a' }), null, '路径穿越的 projectHash 直接拒');

// ── ④ 与历史路径逐字段同形(同一计价口径)─────────────────────────────────
const hist = await getSessionMessages(SID, HASH);
const histAgents = (hist.messages || []).flatMap((m) => (m.type === 'turn' ? (m.subUsage?.agents || []) : []));
const histA = histAgents.find((a) => a.toolUseId === 'toolu_live_a');
assert.ok(histA, '历史路径应能归属到同一个 toolUseId');
assert.deepEqual(byTaskId, histA, '定向读的条目必须与历史 subUsage.agents[] 逐字段相同');

// ── ⑤ 接线哨兵:四条链路缺一条,金额就静默不到卡片/面板 ────────────────
// (行为验证在 tests/acceptance/live-subcost-20260913;这里只防"改动把线剪了"。)
const read = (rel) => readFileSync(join(root, rel), 'utf8');
const chat = read('server/routes/chat.js');
assert.ok(chat.includes("if (line.includes('task_notification')) queueLiveSubagentUsage(slot, line);"),
  'chat.js:投递口必须对完成通知排一次定向读');
assert.ok(/if \(line\.includes\('subagent_usage'\)\)/.test(chat) && chat.includes("type: 'subagent-usage-bg'"),
  'chat.js:无 SSE 监听时,金额伴随事件必须走 WS 兜底(后台子代理跨回合完成只走这条)');
// 消息泵那段是 r114 源码锁锁死的逐字节区间:这里再钉一次"没在那儿动刀"。
assert.ok(chat.includes('const line = JSON.stringify(m);'), 'chat.js:消息泵的原行生成不得改写');
const app = read('client/src/App.jsx');
assert.ok(app.includes("if (event.type === 'subagent_usage' && event.subagentUsage)"), 'App.jsx:SSE 分支必须收下金额伴随事件');
assert.ok(app.includes("window.addEventListener('cgui:subagent-usage-bg', onSubagentUsage)"), 'App.jsx:WS 兜底必须收下金额伴随事件');
assert.ok(app.includes('subUsage: liveSubUsageTurn'), 'App.jsx:直播回合字面量必须把金额喂进 subUsage(渲染层才画得出来)');
assert.ok(read('client/src/hooks/useWebSocket.js').includes("case 'subagent-usage-bg':"), 'useWebSocket.js:必须把该 WS 类型转成 window 事件');
assert.ok(read('client/src/stores/sessionStore.js').includes('pushLiveSubUsage:'), 'sessionStore.js:必须仍有落表动作');

console.log('check-live-subusage: OK');
