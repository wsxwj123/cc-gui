#!/usr/bin/env node
// r32-plan-flood 修复1:同计划卡折叠。
// 根因:/goal 会话级 Stop 钩子每轮强制续跑,CLI 每轮把同一份已批准计划以 ExitPlanMode
// 重提一次(input.plan 逐字相同)。每条都是独立 message.id/uuid,dedupReplayedRecords
// 的 uuid/message.id 去重全部落空 → 消息流冒出 N 张相同计划卡。
// 修复:getSessionMessages 对已构建 messages 里的 ExitPlanMode 块按计划全文签名折叠,
// 只保留第一条;不同计划绝不动。
// 本文件两层验证:① 纯 foldRepeatedPlanCards(跨回合/整条省去/保文本/不同计划/回合内去重);
//  ② 真 getSessionMessages 跑 15 轮同计划重提 jsonl,验证折叠后只剩一张计划卡。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// HOME 必须在 import 之前设 —— session-reader 在模块作用域 join(homedir(), ...)。
const home = mkdtempSync(join(tmpdir(), 'cgui-r32-plan-'));
process.env.HOME = home;
const HASH = 'r32-plan-fix-project';
const SID = 'r32-plan-flood-session';
mkdirSync(join(home, '.claude', 'projects', HASH), { recursive: true });

const COND = '你必须用中文写出"任务完成"';
const PLAN_A = '第一步先摸清需求;\n第二步给出方案;\n第三步开始实施。';
const PLAN_B = '完全不同的计划:直接执行,不解释。';

// ── ① 纯 foldRepeatedPlanCards ────────────────────────────────────────────
const plan = (id, text) => ({ type: 'tool_use', id, name: 'ExitPlanMode', input: { plan: text } });
const mkTurn = (uuid, toolCalls, text = [], thinking = []) => ({
  type: 'turn', uuid, toolCalls, text, thinking,
  blocks: toolCalls.map((tc) => ({ type: 'tool_use', toolCall: tc })),
});
{
  const msgs = [
    mkTurn('t1', [plan('p1', PLAN_A)], ['先给你计划']),   // PLAN_A 首次 + text
    mkTurn('t2', [plan('p2', PLAN_A)]),                  // 纯重复计划 → 整条省去
    mkTurn('t3', [plan('p3', PLAN_A)], ['正文保留']),     // 重复但有 text → 留 text 去计划块
    mkTurn('t4', [plan('p4', PLAN_B)]),                  // 不同计划 → 保留(反向哨兵)
    mkTurn('t5', [plan('p5', 'PLAN_C'), plan('p6', 'PLAN_C')]), // 回合内重复 → 只留 1
  ];
  const folded = (await import(`${root}/server/services/session-reader.js`)).foldRepeatedPlanCards(msgs);
  const pturns = folded.filter((m) => m.type === 'turn');
  const planNames = (t) => (t.toolCalls || []).filter((tc) => tc.name === 'ExitPlanMode').map((tc) => tc.input.plan);
  assert.equal(pturns.length, 4, 't2 纯重复计划卡整条省去;t3/t4/t5 保留');
  const byUuid = Object.fromEntries(pturns.map((t) => [t.uuid, t]));
  // t1:首次 PLAN_A,保留
  assert.equal(planNames(byUuid.t1).join('|'), PLAN_A, 't1 首次 PLAN_A 保留');
  assert.deepEqual(byUuid.t1.text, ['先给你计划'], 't1 的文本块未被误伤');
  // t3:重复 PLAN_A,但去计划块后仍有 text → 保留 text,去掉计划块
  assert.deepEqual(planNames(byUuid.t3), [], 't3 重复计划块已去掉');
  assert.deepEqual(byUuid.t3.text, ['正文保留'], 't3 的文本块未被误伤');
  assert.deepEqual(byUuid.t3.blocks, [], 't3 对应 tool_use 块同步去掉');
  // t4:不同计划 PLAN_B,绝不折叠(反向哨兵)
  assert.deepEqual(planNames(byUuid.t4), [PLAN_B], '不同计划的卡不被折叠');
  // t5:回合内两个相同 PLAN_C → 只留 1
  assert.deepEqual(planNames(byUuid.t5), ['PLAN_C'], '回合内重复计划只留 1 张');
}

// ── ② 真 getSessionMessages 跑 15 轮同计划重提 ──────────────────────────────
{
  const rec = (o) => JSON.stringify({ sessionId: SID, timestamp: '2026-08-03T09:21:06.292Z', ...o });
  const lines = [
    rec({ type: 'user', uuid: 'u0', message: { role: 'user', content: [{ type: 'text', text: '开始干活' }] } }),
  ];
  // 15 轮:每轮 [assistant ExitPlanMode PLAN_A] + goal_status 未达成(后者把回合切开,
  // 让每张计划卡落在独立 turn —— 与真实"Stop 钩子强制续跑"的转写一致)。
  for (let i = 1; i <= 15; i++) {
    lines.push(rec({ type: 'assistant', uuid: `as${i}`, message: { role: 'assistant', model: 'claude', content: [{ type: 'tool_use', id: `toolu_${i}`, name: 'ExitPlanMode', input: { plan: PLAN_A } }] } }));
    lines.push(rec({ type: 'attachment', uuid: `g${i}`, attachment: { type: 'goal_status', met: false, sentinel: false, condition: COND, reason: `第 ${i} 轮仍未达成` } }));
  }
  // 收尾:一个不同计划(反向哨兵)
  lines.push(rec({ type: 'assistant', uuid: 'as16', message: { role: 'assistant', model: 'claude', content: [{ type: 'tool_use', id: 'toolu_16', name: 'ExitPlanMode', input: { plan: PLAN_B } }] } }));
  writeFileSync(join(home, '.claude', 'projects', HASH, `${SID}.jsonl`), lines.join('\n') + '\n');

  const { getSessionMessages } = await import(`${root}/server/services/session-reader.js`);
  const { messages } = await getSessionMessages(SID, HASH);
  // 数计划卡:turn 里含 ExitPlanMode 的 toolCall
  const planCards = messages
    .filter((m) => m.type === 'turn')
    .flatMap((m) => (m.toolCalls || []))
    .filter((tc) => tc.name === 'ExitPlanMode')
    .map((tc) => tc.input.plan);
  const planACount = planCards.filter((p) => p === PLAN_A).length;
  const planBCount = planCards.filter((p) => p === PLAN_B).length;
  assert.equal(planACount, 1, `15 轮同计划重提,折叠后 PLAN_A 计划卡只剩 1 张(实得 ${planACount})`);
  assert.equal(planBCount, 1, '不同计划 PLAN_B 的卡保留 1 张(反向哨兵)');
  assert.equal(planCards.length, 2, `总计划卡数 = 1(A) + 1(B) = 2,实得 ${planCards.length}`);

  // 折叠后无空 turn 残留:任何 turn 都要有可渲染内容
  assert.ok(messages.filter((m) => m.type === 'turn').every((m) =>
    (m.text && m.text.length) || (m.thinking && m.thinking.length) || (m.toolCalls && m.toolCalls.length)),
    '折叠后不得残留空 turn');

  rmSync(home, { recursive: true, force: true });
}

console.log('✓ check-r32-plan-dedupe: 同计划只留一张卡 + 不同计划保留 + 纯函数/真 reader 双验证全过');
