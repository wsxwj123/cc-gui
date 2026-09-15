#!/usr/bin/env node
// 缺陷①回归:刷新/重开后正在跑的工作流丢进度。
//
// 现场:activeAgents 是纯内存 map(store 里没有 persist),条目只由 live 的
// task_started 建(r114 只给这一条建卡路径)。刷新后:
//   · 历史消息照常把 Workflow 卡片画出来(toolCall 在 jsonl 里),
//   · 但 store 里没有条目 → live=null、快照又不落盘(只在终态写)→ 卡片停在
//     「此运行未提供进度信息」,之后每 10s 一份的进度事件全部落在空处。
// 修法:进度事件本身就带齐身份(tool_use_id / task_id / session_id),缺条目时
// 按最小形态补一条 —— 两条投递路径(SSE 的 task_progress 分支、WS 兜底
// workflow-progress-bg)共用 client/src/utils/workflowEntry.js 的同一个判据。
//
// 证据强度:纯函数语义 + 真 selectWorkflowSource/runDisplayStatus 组合复现
// (「空 store + 一条进度事件」→ 修前卡片必然回落 none),加两条接线点的源码守卫。
// 非真机重载现场(那需要真跑一个工作流;见交付报告"证据强度"一节)。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDisplayStatus, selectWorkflowSource } from '../../client/src/utils/workflowView.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let rebuildWorkflowEntry = null;
try { ({ rebuildWorkflowEntry } = await import('../../client/src/utils/workflowEntry.js')); } catch {}

const TABLE = [
  { type: 'workflow_phase', index: 1, title: '摸底' },
  { type: 'workflow_agent', index: 1, phaseIndex: 1, label: 'a1', state: 'progress' },
];

// ── ① 复现:刷新后 store 空,唯一能到的是进度事件 ────────────────────────
{
  const st = { activeAgents: {} };                       // ← 刷新后的 store(内存态,不持久化)
  const ev = { tool_use_id: 'toolu_wf', task_id: 'T1', workflow_progress: TABLE };
  const patch = rebuildWorkflowEntry
    ? rebuildWorkflowEntry({ toolUseId: ev.tool_use_id, taskId: ev.task_id, sessionId: 'sess-A', existing: st.activeAgents[ev.tool_use_id] })
    : null;
  assert.ok(patch, '刷新后收到带进度表的事件必须补出条目 —— 不补,后面每条进度都落在空处');
  st.activeAgents[ev.tool_use_id] = { ...patch, wfProgress: ev.workflow_progress };
  const a = st.activeAgents[ev.tool_use_id];
  const pick = selectWorkflowSource({
    live: { progress: a.wfProgress, status: runDisplayStatus(a), taskId: a.taskId, startedAt: a.startedAt ?? null },
    snapshot: null,
    cardTaskId: ev.task_id,
  });
  assert.equal(pick.source, 'live', '补出条目后卡片必须看直播,而不是"此运行未提供进度信息"');
  assert.equal(pick.superseded, false);
}

// ── ② 反面:没有条目时(修前的状态)卡片就是 none ────────────────────────
{
  const pick = selectWorkflowSource({ live: null, snapshot: null, cardTaskId: 'T1' });
  assert.equal(pick.source, 'none', '前提复现:条目缺失时卡片只能回落"未提供进度信息"');
}

// ── ③ 补建条目的形态:身份三件套齐,不许有假名字/假起始时间 ──────────────
{
  const e = rebuildWorkflowEntry({ toolUseId: 'toolu_wf', taskId: 'T1', sessionId: 'sess-A' });
  assert.deepEqual(e, {
    workflow: true, taskManaged: true, status: 'working', taskId: 'T1', sessionId: 'sess-A',
  }, '最小形态:workflow/taskManaged(躲开回合末兜底收尾与 level 剪枝)+ taskId + sessionId,不留别的键');
  assert.equal('startedAt' in e, false, '不许编起始时间:头部耗时以它起算,补出来的时间 = 从刷新那刻起算的假耗时');
  assert.equal('name' in e, false, '不许拿进度描述当工作流名(卡片本来就按 toolCall.input.name 回落)');
  assert.equal(runDisplayStatus(e), 'running', '补出来的条目在跑:卡片能给直播,而不是"状态未知"');
}

// ── ④ 归属闸门:没有会话归属一律不建(条目会绕过 resolveOwnedAgent 串窗格) ──
{
  const base = { toolUseId: 'toolu_wf', taskId: 'T1' };
  assert.equal(rebuildWorkflowEntry({ ...base, sessionId: null }), null, '没 sessionId 不建');
  assert.equal(rebuildWorkflowEntry({ ...base, sessionId: '' }), null, '空 sessionId 不建');
  assert.equal(rebuildWorkflowEntry({ ...base, sessionId: 123 }), null, '非字符串 sessionId 不建');
  assert.equal(rebuildWorkflowEntry({ ...base, sessionId: 'sess-A', existing: { status: 'working' } }), null,
    '已有条目时必须走原来的"只更新"路径,不得覆盖(在跑条目的 startedAt/taskId 是权威值)');
  assert.equal(rebuildWorkflowEntry({ toolUseId: '', taskId: 'T1', sessionId: 'sess-A' }), null, '缺 tool_use_id 不建');
  assert.equal(rebuildWorkflowEntry(null), null, '空入参不炸');
  // taskId 缺失照样建:进度表能显示才是主要目的,taskId 只是跨回合反查的钥匙
  const noTask = rebuildWorkflowEntry({ toolUseId: 'toolu_wf', sessionId: 'sess-A' });
  assert.equal(noTask.taskId, null, 'taskId 缺失补 null,不编一个假编号');
  assert.equal(noTask.status, 'working');
}

// ── ⑤ 接线守卫:两条投递路径都必须真的补建(纯函数对了但没接上等于没修) ──
{
  const APP = readFileSync(join(ROOT, 'client/src/App.jsx'), 'utf8');

  // SSE:task_progress 分支(与 r114 锁同口径:从分支起点往后 1400 字符)
  const i = APP.indexOf("subtype === 'task_progress'");
  assert.ok(i > 0, 'App.jsx 必须仍有 task_progress 分支');
  const tpSeg = APP.slice(i, i + 1400);
  assert.match(tpSeg, /rebuildWorkflowEntry\(/, 'SSE 的 task_progress 分支必须补建条目(重载后 reattach 靠它接回直播)');
  assert.match(tpSeg, /Array\.isArray\(event\.workflow_progress\)/, '补建必须以"带进度表"为判据(缺表的心跳分不清是工作流还是普通子代理)');
  assert.match(tpSeg, /streamOwnerSid\(\)/, '补建条目必须钉本流归属会话');

  // WS 兜底:applyWorkflowProgress
  const wsStart = APP.indexOf('function applyWorkflowProgress');
  const wsEnd = APP.indexOf('function finalizeAgent', wsStart);
  assert.ok(wsStart > 0 && wsEnd > wsStart, 'applyWorkflowProgress 必须还在');
  const wsSeg = APP.slice(wsStart, wsEnd);
  assert.match(wsSeg, /rebuildWorkflowEntry\(/, 'WS 兜底路径(回合已结束、只剩后台进度)同样要能补建');
  assert.match(wsSeg, /sessionId/, 'WS 是全局广播:补建必须按广播自带的会话归属');

  // 广播消费点必须把归属与 taskId 递进去
  const bgStart = APP.indexOf('const onWorkflowProgressBg');
  assert.ok(bgStart > 0, 'App.jsx 必须仍有 workflow-progress-bg 消费点');
  const bgSeg = APP.slice(bgStart, bgStart + 600);
  assert.match(bgSeg, /d\.sessionId/, '消费点必须把广播的 sessionId 传下去');
  assert.match(bgSeg, /d\.task_id|d\.taskId/, '消费点必须把广播的 task_id 传下去');
}

console.log('✓ check-wf-reload-entry: 补建判据 4 组 + 接线守卫 全过');
