#!/usr/bin/env node
// 缺陷②回归:快照缓存只按 runId 分键 → 同页续跑(同一个脚本 resumeFromRunId)整体覆写
// 同名快照后,新卡片永久命中去重缓存,拿到的是第一轮那份(且 selectWorkflowSource 里
// "已被续跑覆盖"的提示语义会写反)。
//
// 修法:键 = runId + taskId。taskId 每次启动都是新的,正是"同一份文件换成新数据"的判据
// (selectWorkflowSource 判"同一次运行"用的也是 taskId === taskId);缺 taskId 的调用点
// 退化成 runId 单键,r114 契约 C2.6 的并发去重/缓存命中语义一字不变。
// 顺带给无上限的 Map 加上限(长会话里它只增不减,每份解出来的快照可达数百 KB)。
import assert from 'node:assert/strict';

const V = await import('../../client/src/utils/workflowView.js');
const getWorkflowSnapshot = V.getWorkflowSnapshot;
assert.equal(typeof getWorkflowSnapshot, 'function', 'workflowView.js 必须导出 getWorkflowSnapshot');
// 修前没有这个常量(取 32 当试出来的上限,红得是行为而不是"导入失败")
const CAP = Number.isFinite(V.SNAPSHOT_CACHE_MAX) ? V.SNAPSHOT_CACHE_MAX : 32;
assert.ok(CAP >= 4 && CAP <= 512, `上限 ${CAP} 不合理(要挡得住无界增长,又不能小到反复重拉)`);

const ref = (n) => ({ runId: `wf_${n}-0001`, projectHash: '-h', sid: 's' });

// ── ① 复现:同页续跑覆写同名快照 → 换了 taskId 必须重新取 ────────────────
{
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return calls === 1
      ? { taskId: 'T1', status: 'completed', result: '第一轮' }
      : { taskId: 'T2', status: 'completed', result: '第二轮' };
  };
  const r = ref('resume');
  const first = await getWorkflowSnapshot(r, { taskId: 'T1', fetcher });
  const second = await getWorkflowSnapshot(r, { taskId: 'T2', fetcher });
  assert.equal(first.result, '第一轮');
  assert.equal(calls, 2, '换了 taskId = 同一次运行号下新的一轮,必须重新请求(修前命中缓存仍是 1 次)');
  assert.equal(second.result, '第二轮', '修前这里回的是第一轮那份 = 卡片永久显示旧数据');
  assert.equal(second.taskId, 'T2');
}

// ── ② 同一 taskId(或都没有 taskId)仍只打一次:契约 C2.6-1/2 的并发去重不变 ──
{
  let calls = 0;
  const fetcher = async () => { calls += 1; return { status: 'completed', n: calls }; };
  const r = ref('dedupe');
  const [a, b] = await Promise.all([
    getWorkflowSnapshot(r, { taskId: 'T', fetcher }),
    getWorkflowSnapshot(r, { taskId: 'T', fetcher }),
  ]);
  await getWorkflowSnapshot(r, { taskId: 'T', fetcher });
  assert.equal(calls, 1, '分屏两窗格 + 已解析后再调 → 仍只 1 次请求(缓存命中)');
  assert.deepEqual(a, b);
}
{
  let calls = 0;
  const fetcher = async () => { calls += 1; return { status: 'completed' }; };
  const r = ref('notask');
  await getWorkflowSnapshot(r, { fetcher });
  await getWorkflowSnapshot(r, { fetcher });
  assert.equal(calls, 1, '调用点不给 taskId → 退化成 runId 单键,旧调用点零回归');
}

// ── ③ 失败不缓存(既有语义):删的必须是这一把新键 ──────────────────────
{
  let calls = 0;
  const fetcher = async () => { calls += 1; return calls === 1 ? null : { status: 'failed' }; };
  const r = ref('fail');
  assert.equal(await getWorkflowSnapshot(r, { taskId: 'T1', fetcher }), null, '404/422 → null');
  const second = await getWorkflowSnapshot(r, { taskId: 'T1', fetcher });
  assert.equal(calls, 2, '失败不写缓存,下次还能再试(换键后这条语义必须原样保留)');
  assert.deepEqual(second, { status: 'failed' });
}

// ── ④ 缓存有上限:超过上限时最早的那把键被淘汰 ──────────────────────────
{
  let calls = 0;
  const fetcher = async (rf) => { calls += 1; return { runId: rf.runId, status: 'completed' }; };
  for (let i = 0; i <= CAP; i++) await getWorkflowSnapshot(ref('cap' + i), { taskId: 'T', fetcher });
  const before = calls;
  await getWorkflowSnapshot(ref('cap0'), { taskId: 'T', fetcher });
  assert.equal(calls, before + 1, `超过 ${CAP} 份后最早的必须被淘汰 —— 否则长会话里 Map 只增不减`);
  await getWorkflowSnapshot(ref('cap' + CAP), { taskId: 'T', fetcher });
  assert.equal(calls, before + 1, '最近取到的那份仍在缓存里(淘汰的是最久没用过的)');
}

console.log(`✓ check-wf-snapshot-cache: 键含 taskId + 去重语义 + 失败不缓存 + 上限 ${CAP} 全过`);
