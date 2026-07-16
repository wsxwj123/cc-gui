// 回归护栏:停止(turnAborted=真杀进程)时给未回执的普通工具补合成终态,
// 让 Skill/Bash/Read 等卡片不再永久转圈;但不覆盖已有回执、非停止不动、Task/Agent 不碰。
// 无框架,纯 assert。复刻 client/src/utils/toolResult.js 的 finalizePendingToolCalls。
import assert from 'node:assert';
import { finalizePendingToolCalls, applyFinalizedToBlocks } from '../../client/src/utils/toolResult.js';

// ---- 场景 1:停止时,未回执的普通工具(Skill/Bash)补合成终态 ----
{
  const out = finalizePendingToolCalls(
    [{ id: 's1', name: 'Skill', input: {}, result: null }],
    true,
  );
  assert.ok(out[0].result, '停止时未回执工具应补 result');
  assert.strictEqual(out[0].result.interrupted, true, '合成终态应带 interrupted');
  assert.strictEqual(out[0].result.isError, false, '合成终态非错误');
  assert.strictEqual(out[0].result.synthetic, true, '标记为合成');
  assert.strictEqual(out[0].category, 'call', 'category 兜底为 call');
}

// ---- 场景 2:已有 result 不被覆盖(含 run_in_background 的"已派发"result) ----
{
  const real = { content: '已在后台派发', isError: false };
  const out = finalizePendingToolCalls(
    [{ id: 'b1', name: 'Bash', input: {}, result: real }],
    true,
  );
  assert.strictEqual(out[0].result, real, '已有回执必须原样保留,不被合成覆盖');
  assert.ok(!out[0].result.interrupted, '已有回执不应被打上 interrupted');
}

// ---- 场景 3:非停止(turnAborted=false,detach/后台化)不补 —— 进程还在跑,tool_result 会迟到 ----
{
  const out = finalizePendingToolCalls(
    [{ id: 's2', name: 'Skill', input: {}, result: null }],
    false,
  );
  assert.strictEqual(out[0].result, null, '非停止时未回执工具保持转圈(result 仍为 null)');
}

// ---- 场景 4:Task/Agent 即便停止也不补 result(卡片状态走 activeAgents+isInterrupted) ----
{
  const out = finalizePendingToolCalls(
    [
      { id: 't1', name: 'Task', input: {}, result: null },
      { id: 'a1', name: 'Agent', input: {}, result: null },
    ],
    true,
  );
  assert.strictEqual(out[0].result, null, 'Task 不补 result(否则无 agent 时翻成绿勾完成)');
  assert.strictEqual(out[1].result, null, 'Agent 同样不补 result');
}

// ---- 场景 5:边界 —— 空/undefined 输入不炸 ----
{
  assert.deepStrictEqual(finalizePendingToolCalls(null, true), [], 'null 输入返回空数组');
  assert.deepStrictEqual(finalizePendingToolCalls(undefined, true), [], 'undefined 输入返回空数组');
}

// ---- 场景 6:blocks 回写(fable 判官阻断项)——合成终态必须打进有序 blocks 渲染路径 ----
// 官方 CLI 恒发 partial → tool_use 进 blocks → TurnBubble 有 blocks 时只渲染 blocks,
// 只 finalize toolCalls 修不到主路径。
{
  const real = { content: 'done', isError: false };
  const calls = [
    { id: 'p1', name: 'Bash', input: { command: 'sleep 99' }, result: null },   // pending → 应补
    { id: 'ok1', name: 'Read', input: {}, result: real },                        // 已有回执 → 不动
    { id: 't1', name: 'Task', input: {}, result: null },                         // Task → 不补
  ];
  const textBlock = { type: 'text', content: 'hi' };
  const blocks = [
    textBlock,
    { type: 'tool_use', toolCall: calls[0] },
    { type: 'tool_use', toolCall: calls[1] },
    { type: 'tool_use', toolCall: calls[2] },
  ];
  const fin = finalizePendingToolCalls(calls, true);
  const out = applyFinalizedToBlocks(blocks, fin);

  assert.ok(out[1].toolCall.result, 'pending tool_use 块 finalize 后 result 必须就位');
  assert.strictEqual(out[1].toolCall.result.interrupted, true, '回写进 blocks 的是中断合成终态');
  assert.notStrictEqual(out[1], blocks[1], '被修补的块是新对象(不可变更新)');

  assert.strictEqual(out[0], textBlock, '非工具块原引用返回');
  assert.strictEqual(out[2], blocks[2], '已有 result 的块原引用返回,不被覆盖');
  assert.strictEqual(out[2].toolCall.result, real, '已有回执原样保留');
  assert.strictEqual(out[3], blocks[3], 'Task 块不补(finalize 不给 Task 造 result)→ 原引用');
  assert.strictEqual(out[3].toolCall.result, null, 'Task 的 result 仍为 null(状态走 activeAgents)');
}

// ---- 场景 7:blocks 回写边界 —— 空 blocks / 无 finalized 列表不炸、原样返回 ----
{
  assert.deepStrictEqual(applyFinalizedToBlocks([], []), [], '空 blocks 原样返回');
  assert.strictEqual(applyFinalizedToBlocks(null, []), null, 'null blocks 原样返回');
  const blocks = [{ type: 'tool_use', toolCall: { id: 'x', name: 'Bash', result: null } }];
  const out = applyFinalizedToBlocks(blocks, null);
  assert.strictEqual(out[0], blocks[0], 'finalized 为空时块原引用返回(保持转圈,不误标)');
}

console.log('check-finalize-pending-toolcalls: all assertions passed');
