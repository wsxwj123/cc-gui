#!/usr/bin/env node
// 单测:r11-⑤ 修复卡三态反馈 + repairHint 持久化 LRU(import 真函数)。
// 变异哨兵(实际验证过红):
//   S1 classifyRepairOutcome 删 409 分支(静默化为通用 error)→ t1 红
//   S2 upsertRepairHint 删 cap 淘汰 → t4 红
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  classifyRepairOutcome, classifyCheckOutcome,
  upsertRepairHint, removeRepairHint, REPAIR_HINT_CAP,
} from '../../client/src/utils/repairFlow.js';

// t1 三态之「运行中」:409 必须显式提示先停止,不许落进通用错误(⑤主诉:409 被吞)
{
  const out = classifyRepairOutcome(409, { error: '会话正在运行,请先停止再清理' });
  assert.equal(out.kind, 'running', 't1: 409 → running 态');
  assert.match(out.text, /先停止/, 't1: 文案必须明确提示先停止再清理');
  assert.doesNotMatch(out.text, /^清理失败/, 't1: 409 不许伪装成通用失败');
}

// t2 三态之「成功」:200 changed → 报告数字 + 提示重发
{
  const out = classifyRepairOutcome(200, {
    changed: true,
    report: { emptyText: 3, emptyThinking: 2, droppedLines: 1, relinked: 2 },
  });
  assert.equal(out.kind, 'cleaned', 't2: 成功态');
  assert.match(out.text, /3 处/, 't2: 空 text 数字上文案');
  assert.match(out.text, /2 处/, 't2: 空 thinking 数字上文案');
  assert.match(out.text, /1 行/, 't2: 删行数字上文案');
  assert.match(out.text, /重发/, 't2: 提示重发');
}

// t3 三态之「无需清理」:200 !changed → 历史已干净(不再零反馈)
{
  const out = classifyRepairOutcome(200, { changed: false, report: { emptyText: 0, emptyThinking: 0, droppedLines: 0, relinked: 0 } });
  assert.equal(out.kind, 'clean', 't3: 干净态');
  assert.match(out.text, /已干净/, 't3: 明说历史已干净');
  // 其余状态码 → error 态并带原因
  assert.equal(classifyRepairOutcome(500, { error: 'boom' }).kind, 'error', 't3: 500 → error');
  assert.match(classifyRepairOutcome(500, { error: 'boom' }).text, /boom/, 't3: 透出服务端原因');
  assert.equal(classifyRepairOutcome(404, null).kind, 'error', 't3: 404 无 body → error');
}

// t3b 体检(dry-run)分类:found / clean / error
{
  const rep = { emptyText: 1, emptyThinking: 0, droppedLines: 0, relinked: 0 };
  assert.equal(classifyCheckOutcome(200, { report: rep, wouldChange: true }).kind, 'found', 't3b: 有待清理项');
  assert.deepEqual(classifyCheckOutcome(200, { report: rep, wouldChange: true }).report, rep, 't3b: 透传 report');
  assert.equal(classifyCheckOutcome(200, { report: rep, wouldChange: false }).kind, 'clean', 't3b: 干净');
  assert.equal(classifyCheckOutcome(404, { error: 'x' }).kind, 'error', 't3b: 404 → error');
}

// t4 持久化 reducer:LRU 上限 20,超出按 at 最旧淘汰;同 id upsert 触新
{
  const R = { emptyText: 1, emptyThinking: 0, droppedLines: 0, relinked: 0 };
  let map = {};
  const t0 = Date.now() - 60_000; // 钉在过去:后续 upsert 的 Date.now() 恒比它们新
  for (let i = 0; i < REPAIR_HINT_CAP; i++) {
    map = upsertRepairHint(map, `s${i}`, R);
    map[`s${i}`] = { ...map[`s${i}`], at: t0 + i }; // 钉死次序,免同毫秒并列
  }
  assert.equal(Object.keys(map).length, 20, 't4: 满 20 条');
  map = upsertRepairHint(map, 's0', R);            // 触新最旧的 s0
  map = upsertRepairHint(map, 'sNew', R);          // 第 21 条 → 淘汰当前最旧 s1
  assert.equal(Object.keys(map).length, 20, 't4: 淘汰后仍 20 条');
  assert.ok(!('s1' in map), 't4: 最旧的 s1 被淘汰');
  assert.ok('s0' in map, 't4: 触新过的 s0 保留');
  assert.ok('sNew' in map, 't4: 新条目在');
  assert.deepEqual(map.sNew.report, R, 't4: 条目形态 {report, at}');
  assert.ok(typeof map.sNew.at === 'number', 't4: at 为时间戳');
}

// t5 removeRepairHint:存在则删,不存在原样返回(引用不变)
{
  const m = upsertRepairHint({}, 'a', { emptyText: 1 });
  const removed = removeRepairHint(m, 'a');
  assert.ok(!('a' in removed), 't5: 删除生效');
  const same = removeRepairHint(m, 'zzz');
  assert.equal(same, m, 't5: 未命中不换引用');
}

// t6 仪表化判据:服务端 GET dry-run 路由存在且只读(无写盘/备份);前端常驻入口 + 模态 + 持久化接线
{
  const sessions = readFileSync(new URL('../../server/routes/sessions.js', import.meta.url), 'utf8');
  const getRoute = /router\.get\('\/sessions\/:sessionId\/repair-official-compat'[\s\S]*?\n\}\);/.exec(sessions)?.[0];
  assert.ok(getRoute, 't6: GET dry-run 路由存在');
  assert.doesNotMatch(getRoute, /writeJsonlAtomic|writeFile|\.bak/, 't6: dry-run 必须只读');
  const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /官方兼容体检与清理/, 't6: 常驻入口文案在');
  assert.match(app, /RepairCompatModal/, 't6: 居中模态组件在');
  assert.match(app, /loadRepairHints\(\)/, 't6: hints 从 localStorage 初始化');
  assert.match(app, /persistRepairHints\(next\)/, 't6: hints 更新即持久化');
  assert.doesNotMatch(app.slice(app.indexOf('function RepairCompatModal')), /window\.confirm|window\.alert/, 't6: 模态不用原生 confirm/alert');
  const modal = /function RepairCompatModal[\s\S]*?\n\}\n\n\/\/ ─── Session Detail/.exec(app)?.[0] || '';
  assert.match(modal, /glass-popover[^"]*flex flex-col/, 't6: glass-popover + flex 列');
  assert.doesNotMatch(modal, /sticky/, 't6: 模态禁 sticky footer(memory 红线)');
}

console.log('check-repair-flow: all passed');
