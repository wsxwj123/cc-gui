#!/usr/bin/env node
// 批A A7 护栏:「停止后台 N」总闸不再静默 no-op。
// 回归对象(#10 点了没反应):App.jsx 的 stopSessionBackground 只算 idle 可停槽位,
// 空了就 `return` —— 用户点按钮什么都不发生,而按钮上的 N 读的是前端 store(与服务端
// 真值脱钩),僵尸卡让它显示"停止后台 3"而服务端 chatProcesses 是 0。
// 分类体是纯函数,这里真 import;三条出路的接线用源码守卫(stopSessionBackground 在
// App.jsx 里、依赖 confirmDialog/finalizeSessionAgents,node 直跑不了 .jsx)。
import assert from 'node:assert/strict';
import { classifyStopTargets } from '../../client/src/utils/stopTargets.js';

const SID = 'sid-A';
const P = (patch) => ({ kind: 'chat-process', sessionId: SID, stoppable: true, status: 'idle', ...patch });

// ① 正常:有 idle 可停槽位 → 发 /stop
{
  const r = classifyStopTargets([P({ pid: 'sdk-1' }), P({ pid: 'sdk-2' })], SID);
  assert.deepEqual(r.procs.map((a) => a.pid), ['sdk-1', 'sdk-2'], 'idle 可停槽位进 procs');
  assert.equal(r.busy, false, '全 idle → 不算 busy');
}
// ② 服务端一个进程都没有 → procs 空且 !busy(总闸走"清残留卡"分支)
{
  const r = classifyStopTargets([], SID);
  assert.deepEqual(r.procs, [], '无进程 → 无可停对象');
  assert.equal(r.busy, false, '无进程 → 不是"主回合在跑"');
  assert.deepEqual(r.all, [], 'all 也是空');
}
// ③ 进程在但主回合在跑 → procs 空且 busy(总闸只提示,【不清卡片】)
{
  for (const status of ['streaming', 'starting']) {
    const r = classifyStopTargets([P({ pid: 'sdk-1', status })], SID);
    assert.deepEqual(r.procs, [], `${status} 槽位不可停(选择性 /stop 会连坐 interrupt 续跑正文)`);
    assert.equal(r.busy, true, `${status} → busy,提示"主回合仍在进行"`);
  }
}
// ④ 归属/可停过滤:别的会话、非 chat-process、已结束的槽位一律不算
{
  const r = classifyStopTargets([
    P({ pid: 'other-sess', sessionId: 'sid-B' }),
    P({ pid: 'not-chat', kind: 'cli-session' }),
    P({ pid: 'finished', stoppable: false }),
    P({ pid: 'finished-busy', stoppable: false, status: 'streaming' }),
  ], SID);
  assert.deepEqual(r.procs, [], '这些都不是可停对象');
  assert.equal(r.busy, false, '不可停的槽位(stoppable:false)不该被算成"主回合在跑"');
  assert.deepEqual(r.all.map((a) => a.pid), ['finished', 'finished-busy'],
    'all 只收本会话的 chat-process(别的会话 / cli-session 都不进)');
}
// 健壮性
{
  assert.deepEqual(classifyStopTargets(null, SID).procs, [], '无列表不炸');
  assert.deepEqual(classifyStopTargets([null, undefined], SID).all, [], 'null 条目不炸');
}

// ── 源码守卫:三条出路都要有反馈 ────────────────────────────────────
{
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const app = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'client', 'src', 'App.jsx'), 'utf8');
  const fn = app.slice(app.indexOf('async function stopSessionBackground(sessionId)'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.ok(/const \{ procs, busy \} = classifyStopTargets\(d\.agents, sessionId\);/.test(body),
    '总闸必须走 classifyStopTargets 分类');
  assert.ok(!/if \(!procs\.length\) return;/.test(body), '不得再静默 no-op(用户点了没反应的根因)');
  // busy 分支:只提示,绝不发请求、绝不清卡片(进程活着,卡片可能是真的)
  const busyBranch = body.slice(body.indexOf('if (busy) {'), body.indexOf('finalizeSessionAgents'));
  assert.ok(/confirmDialog\('主回合仍在进行中/.test(busyBranch), 'busy 分支必须提示"主回合仍在进行"');
  assert.ok(!busyBranch.includes('finalizeSessionAgents'), 'busy 分支不得清卡片');
  assert.ok(!busyBranch.includes('fetch('), 'busy 分支不得发 /stop(会连坐 interrupt 续跑正文)');
  // 空集分支:清残留卡 + 提示
  const emptyBranch = body.slice(body.indexOf('finalizeSessionAgents'), body.indexOf('await Promise.allSettled'));
  assert.ok(/finalizeSessionAgents\(sessionId\);/.test(emptyBranch), '空集分支必须清残留卡');
  assert.ok(/confirmDialog\('服务端已没有本会话的后台进程/.test(emptyBranch), '空集分支必须提示');
  assert.ok(!emptyBranch.includes('fetch('), '空集分支不发请求');
  // 正常路径:选择性 /stop 的 allTasks:true 语义不得被顺手改掉
  assert.ok(/body: JSON\.stringify\(\{ allTasks: true \}\)/.test(body),
    '总闸仍是 allTasks:true(唯一"跨回合后台任务也停"的入口),不得改');
  assert.ok(!/hard/.test(body), '总闸不得升级成 hard(那会连 shell 长任务一起杀)');
}

console.log('✓ check-stop-background-empty: 分类 4 组 + 三条出路源码守卫 全过');
