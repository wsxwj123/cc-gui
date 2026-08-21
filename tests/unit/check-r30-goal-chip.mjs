#!/usr/bin/env node
// r30:goal 常驻条(dsh 同款)。覆盖:
//   · 渲染条件哨兵 —— activeGoal 存在才渲染、不存在整条消失(组件层源码哨兵);
//   · 编辑保存走既有发送链路(复用 onSend 发 /goal,不造第二条通道)的接线断言;
//   · 清除走 confirmDialog(非原生 confirm)并发送 /goal clear;
//   · 与任务清单/已批准计划的叠加顺序:计划 → 任务清单 → 目标条 → composer。
// activeGoal 的状态机行为(met 判定/达成即消失)在 check-goal-visible.mjs 已复刻断言,此处不重复。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const app = readFileSync(join(root, 'client/src/App.jsx'), 'utf8');
const chat = readFileSync(join(root, 'client/src/components/ChatInput.jsx'), 'utf8');
const goalBar = readFileSync(join(root, 'client/src/components/GoalBar.jsx'), 'utf8');

// ── 1. 渲染条件哨兵:goal 存在才渲染、不存在不渲染 ──────────────────────
assert.ok(/data-cgui="goal-bar"/.test(goalBar), '常驻条要有渲染哨兵 data-cgui="goal-bar"');
assert.ok(/if \(!goal\) return null/.test(goalBar), '无 activeGoal 时整条不渲染');
assert.ok(goalBar.includes("goal.condition || '(无条件文本)'"), 'condition 缺省归一为(无条件文本)');
assert.ok(/目标进行中：/.test(goalBar), '常驻条显示"目标进行中"文案');
assert.ok(/最近判定：/.test(goalBar), '常驻条 title 含"最近判定理由"');

// 数据源:App 复用 activeGoal memo(经 effectiveGoal 乐观合并)作 goal 传入 ChatInput
assert.ok(/goal=\{effectiveGoal\}/.test(app), 'App 用 effectiveGoal(activeGoal 叠加乐观态)作 goal 数据源');

// ── 2. 编辑保存走既有发送链路(复用 onSend,不造第二条发送通道) ─────────
assert.ok(/const startEdit = /.test(goalBar), '编辑态有 startEdit(进入编辑)');
assert.ok(/const cancelEdit = /.test(goalBar), '编辑态有 cancelEdit(取消不发送)');
assert.ok(/const saveEdit = /.test(goalBar), '编辑态有 saveEdit(保存)');
assert.ok(/value=\{draft\}/.test(goalBar), '编辑态是可编辑输入框(受控 draft)');
assert.ok(/setDraft\(goal\.condition/.test(goalBar), '编辑态预填当前 condition');
assert.ok(goalBar.includes("onSend('/goal ' + v)"), '保存复用既有发送链路发 /goal');

// ── 3. 清除走 confirmDialog ────────────────────────────────────────
assert.ok(goalBar.includes('confirmDialog'), '清除必须走 confirmDialog 而非原生 confirm');
assert.ok(goalBar.includes('/goal clear'), '清除发送 /goal clear');
assert.ok(/async/.test(goalBar), '清除为异步(await confirmDialog 后发送)');

// ── 4. 叠加顺序:计划 → 任务清单 → 目标条 → composer(不互相覆盖) ──────
const iTodo = chat.indexOf('<TodoPanel');
const iGoal = chat.indexOf('<GoalBar');
const iComposer = chat.indexOf('data-cgui="composer"');
assert.ok(iTodo >= 0 && iGoal >= 0 && iComposer >= 0, 'ChatInput 须同时渲染 TodoPanel / GoalBar / composer');
assert.ok(iTodo < iGoal, '任务清单应在目标条之上(更远离输入框)');
assert.ok(iGoal < iComposer, '目标条应在 composer 输入框正上方(不互相覆盖)');
const todoSrc = readFileSync(join(root, 'client/src/components/TodoPanel.jsx'), 'utf8');
const iPlan = todoSrc.indexOf('<PlanBlock');
const iChecklist = todoSrc.indexOf('<TodoChecklist');
assert.ok(iPlan >= 0 && iChecklist >= 0, 'TodoPanel 须同时渲染 PlanBlock / TodoChecklist');
assert.ok(iPlan < iChecklist, '已批准计划应渲染在任务清单之上');

// ── 5. 顶栏旧徽章退役 ──────────────────────────────────────────────
assert.ok(!/<span className="truncate">目标进行中：\{activeGoal\.condition/.test(app),
  '顶栏原"目标进行中"小徽章已退役,不得残留');

console.log('✓ check-r30-goal-chip: goal 常驻条渲染哨兵 + 编辑保存走发送链路 + 清除走 confirmDialog + 叠加顺序全过');
