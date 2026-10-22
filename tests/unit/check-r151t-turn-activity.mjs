#!/usr/bin/env node
// r151t:消息泵判据「这条消息说明主 agent 正在跑回合」(白名单 isMainAgentTurnActivity)。
// ① 直接 import chat.js 的真函数,逐类核对算 / 不算;
// ② 源码核对三处使用点(标记写回、复活、收尾等待窗内取消并重新计时)共用这一个结果,不再各自维护黑名单。
// Run: node tests/unit/check-r151t-turn-activity.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainAgentTurnActivity } from '../../server/routes/chat.js';

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n += 1; };

// ① 算:主 agent 顶层(parent_tool_use_id 为空 / 缺省)的回合内容
for (const m of [
  { type: 'assistant', parent_tool_use_id: null, message: { content: [] } },
  { type: 'assistant' }, // 缺省 parent_tool_use_id
  { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result' }] } },
  { type: 'stream_event', parent_tool_use_id: null, event: {} },
  { type: 'tool_progress', parent_tool_use_id: null },
  { type: 'command_lifecycle', command_uuid: 'u1', state: 'started' },
]) ok(isMainAgentTurnActivity(m) === true, `应算回合活动:${JSON.stringify(m)}`);

// 不算:后台子代理自己的消息(parent_tool_use_id 非空),哪怕类型在白名单里
for (const t of ['assistant', 'user', 'stream_event', 'tool_progress']) {
  ok(isMainAgentTurnActivity({ type: t, parent_tool_use_id: 'toolu_x' }) === false, `子代理的 ${t} 不算`);
}
ok(isMainAgentTurnActivity({ type: 'command_lifecycle', state: 'started', parent_tool_use_id: 'toolu_x' }) === false, '子代理的 started 不算');

// 不算:终态 / 信息事件 / 未列出的类型
for (const m of [
  { type: 'result', subtype: 'success' },
  { type: 'system', subtype: 'init' },
  { type: 'system', subtype: 'status' },
  { type: 'system', subtype: 'api_retry' },
  { type: 'system', subtype: 'task_progress' },
  { type: 'rate_limit_event' },
  { type: 'prompt_suggestion' },
  { type: 'command_lifecycle', state: 'queued' },
  { type: 'command_lifecycle', state: 'completed' },
  { type: 'command_lifecycle' }, // 缺 state
  { type: 'tool_use_summary', summary: 'x' },
  { type: 'auth_status' },
  { type: 'conversation_reset' },
  { type: 'keep_alive' },
  { type: 'x_unknown_event' },
  { type: 'control_response' },
  {},
]) ok(isMainAgentTurnActivity(m) === false, `不应算回合活动:${JSON.stringify(m)}`);
for (const bad of [null, undefined]) ok(isMainAgentTurnActivity(bad) === false, `非法输入 ${bad} 不算`);

// ② 三处使用点共用同一结果(消息泵内只算一次)
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '..', 'server', 'routes', 'chat.js'), 'utf8');
const count = (s) => src.split(s).length - 1;
ok(count('const mainAgentTurnActivity = isMainAgentTurnActivity(m);') === 1, '消息泵里应恰好算一次判据');
ok(count('if (slot.turnSettled && mainAgentTurnActivity && !slot.turnStopRequested) {') === 1, '跨会话标记写回应用同一判据');
ok(count('if (slot.idle && mainAgentTurnActivity) {') === 1, '复活应用同一判据');
ok(count('} else if (closeTimer && mainAgentTurnActivity) {') === 1, '收尾等待窗内取消并重新计时应用同一判据');
ok(!/m\.type !== 'rate_limit_event' && m\.type !== 'system'/.test(src), '旧的近似黑名单不应残留');
ok(!/\bmainAgentContent\b/.test(src), '旧的黑名单变量不应残留');

console.log(`check-r151t-turn-activity: ${n} 项全部通过`);
