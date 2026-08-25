#!/usr/bin/env node
// r32-plan-flood 修复2:goal 未达成提示折叠。
// 根因:/goal 会话级 Stop 钩子每轮判定未达成就写一条 goal_status(met:false 无 sentinel),
// 消息流原本 N 条「目标未达成，已自动继续」。
// 修复:reader(getSessionMessages)把同一段"未达成就"(同 condition、中间无 met:true/sentinel)
// 折叠成一条 + 次数徽标;达成的最后一条永远保留单显。
// 本文件:① 纯 foldRepeatedGoalNotices(段界/不同条件/单条原样/按条件归段);
//        ② 真 getSessionMessages 跑 12 轮未达成 + 达成,验证计数。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const home = mkdtempSync(join(tmpdir(), 'cgui-r32-goal-'));
process.env.HOME = home;
process.env.USERPROFILE = home; // Windows 上 homedir() 读 %USERPROFILE%,不同设沙箱失效
const HASH = 'r32-goal-fix-project';
const SID = 'r32-goal-flood-session';
mkdirSync(join(home, '.claude', 'projects', HASH), { recursive: true });

const COND_A = '你必须用中文写出"任务完成"';
const COND_B = '另一个目标:把数字加到 100';

// ── ① 纯 foldRepeatedGoalNotices ──────────────────────────────────────────
{
  const { foldRepeatedGoalNotices } = await import(`${root}/server/services/session-reader.js`);
  const g = (cond, o = {}) => ({ type: 'goal', condition: cond, met: false, sentinel: false, reason: 'r', ...o });
  const gset = (cond) => ({ type: 'goal', condition: cond, met: false, sentinel: true, reason: '' });
  const gmet = (cond) => ({ type: 'goal', condition: cond, met: true, sentinel: false, reason: 'done', iterations: 2 });
  const turn = (uuid) => ({ type: 'turn', uuid, text: ['work'], toolCalls: [], blocks: [] });

  const msgs = [
    gset(COND_A),
    g(COND_A), g(COND_A), g(COND_A),
    turn('x1'),                                  // 普通回合不打断"未达成就"
    g(COND_A), g(COND_A),                        // 共 5 条未达成 → ×5
    gmet(COND_A),                                // 达成:永久保留单显,且阻断后一段
    gset(COND_B),
    g(COND_B), g(COND_B),                        // 另一条件 ×2,不与 A 合并
    g(COND_A),                                   // met 之后又出现同 A 条件 → 属新段(哨兵已隔断)
  ];
  const out = foldRepeatedGoalNotices(msgs);
  const goals = out.filter((m) => m.type === 'goal');
  // set(A) / foldedA×5 / met(A) / set(B) / foldedB×2 / singleA(新段,单条)
  assert.equal(goals.length, 6, '段界+不同条件应产生 6 条(met/sentinel 不被折叠)');
  assert.deepEqual(
    goals.map((x) => [x.met, x.sentinel, x.count ?? null, x.condition]),
    [[false, true, null, COND_A],
     [false, false, 5, COND_A],
     [true, false, null, COND_A],
     [false, true, null, COND_B],
     [false, false, 2, COND_B],
     [false, false, null, COND_A]],
    '单条未达成原样(无 count);段内折叠 count=条数;met/sentinel 无 count'
  );
  // 折叠后的 count 消息保留 met/condition/reason(activeGoal 状态机依赖),仅追加 count
  const foldedA = goals[1];
  assert.equal(foldedA.met, false, '折叠保留 met');
  assert.equal(foldedA.condition, COND_A, '折叠保留 condition');
  assert.equal(foldedA.reason, 'r', '折叠保留 reason(取段内第一条)');
  assert.equal(foldedA.count, 5, '折叠追加 count');
}

// ── ② 真 getSessionMessages 跑 12 轮未达成 + 达成 ───────────────────────────
{
  const rec = (o) => JSON.stringify({ sessionId: SID, timestamp: '2026-08-03T09:21:06.292Z', ...o });
  const lines = [
    rec({ type: 'user', uuid: 'u0', message: { role: 'user', content: [{ type: 'text', text: '开始干活' }] } }),
    rec({ type: 'attachment', uuid: 'set0', attachment: { type: 'goal_status', met: false, sentinel: true, condition: COND_A } }),
  ];
  for (let i = 1; i <= 12; i++) {
    // 每轮:assistant 产出真实回合(文本)+ 未达成判定 —— 与"Stop 钩子强制续跑"转写一致
    lines.push(rec({ type: 'assistant', uuid: `as${i}`, message: { role: 'assistant', model: 'claude', content: [{ type: 'text', text: `第 ${i} 轮工作` }] } }));
    lines.push(rec({ type: 'attachment', uuid: `g${i}`, attachment: { type: 'goal_status', met: false, sentinel: false, condition: COND_A, reason: `理由 ${i}` } }));
  }
  // 达成:最后一条永远保留单显
  lines.push(rec({ type: 'assistant', uuid: 'as13', message: { role: 'assistant', model: 'claude', content: [{ type: 'text', text: '任务完成' }] } }));
  lines.push(rec({ type: 'attachment', uuid: 'g13', attachment: { type: 'goal_status', met: true, sentinel: false, condition: COND_A, reason: '最后一条含任务完成', iterations: 12, durationMs: 90000, tokens: 5000 } }));
  writeFileSync(join(home, '.claude', 'projects', HASH, `${SID}.jsonl`), lines.join('\n') + '\n');

  const { getSessionMessages } = await import(`${root}/server/services/session-reader.js`);
  const { messages } = await getSessionMessages(SID, HASH);
  const goals = messages.filter((m) => m.type === 'goal');

  assert.equal(goals.length, 3, '设置 + 折叠后的未达成 + 达成 = 3 条,不是 2+12 条');
  assert.equal(goals[0].met, false); assert.equal(goals[0].sentinel, true, '目标设置单显');
  assert.equal(goals[1].met, false); assert.equal(goals[1].sentinel, false);
  assert.equal(goals[1].count, 12, `12 轮未达成折叠为一条 ×12(实得 ${goals[1].count})`);
  assert.equal(goals[1].condition, COND_A, '折叠保留条件');
  assert.equal(goals[2].met, true, '达成最后一条永远保留单显(不被折叠)');
  assert.equal(goals[2].iterations, 12, '达成记录的原字段不被折叠污染');

  // 折叠时中间的真实回合仍在(只折冗余目标提示,不动对话内容)
  const turnCount = messages.filter((m) => m.type === 'turn').length;
  assert.equal(turnCount, 13, `13 个真实回合(12 未达成轮 + 1 达成轮)全部保留,实得 ${turnCount}`);

  rmSync(home, { recursive: true, force: true });
}

// ── ③ 渲染接线:count 必须真能被用户看见 ─────────────────────────────────
// r33 修:count 原本只有零引用的死组件 GoalNotice 会读(goal 提示自 r30 起已不进消息流,
// 两处 msg.type === 'goal' 都渲染 null)—— 服务端算了、测试测了,界面永远显示不出来。
// 现在落在 composer 上方的常驻条 GoalBar 上,与 activeGoal 同一条数据链。
{
  const app = readFileSync(join(root, 'client/src/App.jsx'), 'utf8');
  const goalBar = readFileSync(join(root, 'client/src/components/GoalBar.jsx'), 'utf8');
  assert.equal(app.includes('function GoalNotice'), false,
    '死组件 GoalNotice 必须删除,不得让 ×N 徽标退回到渲染不出来的地方');
  assert.match(goalBar, /goal\.count > 1/, 'GoalBar 必须按 count>1 显示折叠次数(单条不显示徽标)');
  assert.match(goalBar, /×\{goal\.count\}/, 'GoalBar 要渲染「×N」徽标本体');
  assert.match(goalBar, /本会话目标钩子已拦截 \$\{goal\.count\} 次停止/, '徽标 title 说明这个 N 是什么');
  // 数据链:reader 折叠 → activeGoal(取最后一条 goal) → effectiveGoal → GoalBar 的 goal prop。
  assert.match(app, /const activeGoal = useMemo\(/, 'count 经 activeGoal 抵达常驻条');
  assert.match(app, /goal=\{effectiveGoal\}/, 'effectiveGoal 交给 ChatInput → GoalBar');
}

console.log('✓ check-r32-goal-notice-fold: 未达成提示折叠成一条 + 次数徽标(落在 GoalBar 上);达成单显;不同条件不合并');
