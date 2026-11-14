// r186:pickReattachHostTurn —— 重接时「正在跑的那一轮」在历史里的那个回合(行为断言,不数源码)。
//   R1 没有助手回合 → null
//   R2 最后一个助手回合属于上一轮(这一轮的用户消息在它之后)→ null
//   R3 最后一个助手回合属于这一轮、最后一段是工具组、末个工具在跑 → 它的 uuid
//   R4 属于这一轮但最后一段不是工具组(正文)→ null
//   R5 守卫:后台任务通知之后的续跑段 → 续跑段那个回合;通知之后还没有助手内容 → null
//   R6 守卫:流里见过的工具 id 这个回合一个都不含 → null;含 → uuid
//   R7 守卫:停止中 / 压缩中 / 聊天模式 → null;前面看不见这一轮起点 → null
import assert from 'node:assert/strict';
import { pickReattachHostTurn as pick } from '../../client/src/utils/reattachLiveHost.js';

const tool = (id, title, result) => ({ type: 'tool_use', toolCall: { id, name: 'Bash', input: { description: title, command: 'x' }, ...(result ? { result } : {}) } });
const text = (s) => ({ type: 'text', content: s });
const user = (uuid) => ({ type: 'user', uuid, content: 'hi' });
const turn = (uuid, blocks) => ({ type: 'turn', uuid, blocks });

const seed = turn('t-seed', [tool('s1', 'SEED-1', 'ok'), tool('s2', 'SEED-2', 'ok'), text('done')]);
const running = turn('t-run', [tool('a1', 'TOOL-1', 'ok'), tool('a2', 'TOOL-2', 'ok'), tool('a3', 'TOOL-3')]);
let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n += 1; console.log('  ok', msg); };

console.log('R1');
ok(pick([]) === null, '空列表 → null');
ok(pick([user('u1')]) === null, '只有用户消息 → null');

console.log('R2');
ok(pick([user('u0'), seed, user('u1')]) === null, '最后一个助手回合在这一轮用户消息之前 → null');
ok(pick([user('u0'), running, user('u1')]) === null, '上一轮末段是挂着的工具组也不承载');

console.log('R3');
ok(pick([user('u0'), seed, user('u1'), running]) === 't-run', '这一轮的回合 → 它的 uuid');
ok(pick([user('u1'), turn('t-th', [tool('b1', 'X', 'ok'), { type: 'thinking', content: '想一下' }])]) === 't-th', '末段工具组里最后是思考 → 承载');

console.log('R4');
ok(pick([user('u1'), turn('t-txt', [tool('c1', 'X', 'ok'), text('正在写')])]) === null, '最后一段是正文 → null');
ok(pick([user('u1'), turn('t-none', [])]) === null, '没有 blocks → null');

console.log('R5');
const notice = { type: 'task-notice', uuid: 'n1' };
const cont = turn('t-cont', [tool('d1', 'CONT', null)]);
ok(pick([user('u1'), seed, notice, cont]) === 't-cont', '通知之后的续跑段 → 续跑回合');
ok(pick([user('u1'), running, notice]) === null, '通知之后还没有助手内容 → null(不挂到通知前那一段)');

console.log('R6');
ok(pick([user('u1'), running], { streamToolIds: ['zz'] }) === null, '流里的工具 id 回合里一个都没有 → null');
ok(pick([user('u1'), running], { streamToolIds: [undefined, 'a3'] }) === 't-run', '含流里的工具 id → uuid');

console.log('R7');
ok(pick([user('u1'), running], { stopping: true }) === null, '停止中 → null');
ok(pick([user('u1'), running], { compacting: true }) === null, '压缩中 → null');
ok(pick([user('u1'), running], { chatMode: true }) === null, '聊天模式 → null');
ok(pick([running]) === null, '前面看不见这一轮的起点 → null');
ok(pick([user('u1'), { ...running, interrupted: true }]) === null, '已被打断的回合 → null');
ok(pick([user('u1'), running, { type: 'denial', uuid: 'x' }]) === 't-run', '回合后面只有拒绝提示 → 仍承载');

console.log(`check-r186-reattach-host-turn: ${n} passed, 0 failed`);
