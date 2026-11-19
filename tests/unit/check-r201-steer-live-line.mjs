// r201:pickReattachHostTurn —— 历史后面还画着东西时不承载实时状态行(行为断言,不数源码)。
//   调用处(App.jsx 算 reattachHostUuid 那一处)把页面画在历史之后的内容按页面顺序补在条目末尾:
//   还没写进会话文件的「已并入」兜底气泡 = 用户消息条目 { type:'user', uuid:steerId },
//   重新接上的尾巴 = { type: REATTACH_TAIL_ENTRY_TYPE }。
//   S1 历史后面跟着兜底并入气泡 → null(工具挂着 / 工具组已返回在思考 / 流里见过工具 id 都一样)
//   S2 历史后面跟着尾巴条目 → null(E7:工具都返回了、模型在写下一段;工具还挂着时也不承载)
//   S3 两样都有(截图那种:后台任务通知之后的续跑段 + 兜底气泡 + 尾巴)→ null
//   S4 后面没东西时与原来一致(同 r186 的几条代表性输入,结果逐条相同)
//   S5 后面只有不属于「一轮的起点」也不是尾巴的条目(拒绝提示)→ 仍承载,与原来一致
import assert from 'node:assert/strict';
import { pickReattachHostTurn as pick, REATTACH_TAIL_ENTRY_TYPE } from '../../client/src/utils/reattachLiveHost.js';

const tool = (id, title, result) => ({ type: 'tool_use', toolCall: { id, name: 'Bash', input: { description: title, command: 'x' }, ...(result ? { result } : {}) } });
const text = (s) => ({ type: 'text', content: s });
const thinking = (s) => ({ type: 'thinking', content: s });
const user = (uuid) => ({ type: 'user', uuid, content: 'hi' });
const turn = (uuid, blocks) => ({ type: 'turn', uuid, blocks });
// 与 App.jsx 拼出来的同形:兜底气泡只带 type / uuid(steerId),尾巴条目只带 type / uuid
const steer = (steerId) => ({ type: 'user', uuid: steerId });
const tail = { type: REATTACH_TAIL_ENTRY_TYPE, uuid: 'reattach-tail' };

const seed = turn('t-seed', [tool('s1', 'SEED-1', 'ok'), text('done')]);
// 正在跑的那一轮:正文 P0 → 工具 1 挂着
const running = turn('t-run', [text('P0'), tool('a1', 'TOOL-1')]);
// 工具都已返回、末段是工具组(阶段判成思考):E7 / 截图里长思考之后的形态
const returned = turn('t-ret', [text('P0'), tool('b1', 'TOOL-1', 'ok'), text('P1'), tool('b2', 'TOOL-2', 'ok')]);
// 工具组里最后是一段思考(阶段思考)
const thinkingTurn = turn('t-th', [text('P0'), tool('c1', 'TOOL-1', 'ok'), thinking('想一下')]);
let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n += 1; console.log('  ok', msg); };

console.log('S0');
ok(REATTACH_TAIL_ENTRY_TYPE === 'reattach-tail', '尾巴条目类型是 reattach-tail');

console.log('S1');
ok(pick([user('u1'), running]) === 't-run', '对照:工具挂着、后面没东西 → 承载');
ok(pick([user('u1'), running], { streamToolIds: ['a1'] }) === 't-run', '对照:流里见过 a1、后面没东西 → 承载');
ok(pick([user('u1'), thinkingTurn], { streamToolIds: ['c1'] }) === 't-th', '对照:末段是思考、流里见过 c1、后面没东西 → 承载');
ok(pick([user('u1'), running, steer('st-1')]) === null, '工具挂着、后面跟着兜底并入气泡 → null');
ok(pick([user('u1'), running, steer('st-1')], { streamToolIds: ['a1'] }) === null, '流里见过这一轮的工具 id 也一样 → null');
ok(pick([user('u1'), returned, steer('st-1')], { streamToolIds: ['b2'] }) === null, '工具都已返回(阶段思考)、后面跟着兜底并入气泡 → null');
ok(pick([user('u1'), thinkingTurn, steer('st-1')], { streamToolIds: ['c1'] }) === null, '末段是思考、后面跟着兜底并入气泡 → null');
ok(pick([user('u1'), running, steer('st-1'), steer('st-2')]) === null, '后面跟着两个兜底并入气泡 → null');

console.log('S2');
ok(pick([user('u1'), returned], { streamToolIds: ['b2'] }) === 't-ret', '对照:工具都已返回、流里见过 b2、后面没东西 → 承载');
ok(pick([user('u1'), returned, tail], { streamToolIds: ['b2'] }) === null, '后面跟着尾巴(模型在写下一段)→ null');
ok(pick([user('u1'), thinkingTurn, tail], { streamToolIds: ['c1'] }) === null, '末段是思考、后面跟着尾巴 → null');
ok(pick([user('u1'), running, tail]) === null, '工具还挂着、后面跟着尾巴 → null(尾巴画在它下面)');
ok(pick([user('u1'), running, tail], { streamToolIds: ['a1'] }) === null, '流里见过工具 id、后面跟着尾巴 → null');

console.log('S3');
const notice = { type: 'task-notice', uuid: 'n1' };
const cont = turn('t-cont', [tool('d1', 'CONT', 'ok'), thinking('接着想')]);
ok(pick([user('u1'), seed, notice, cont], { streamToolIds: ['d1'] }) === 't-cont', '对照:通知之后的续跑段、后面没东西 → 承载');
ok(pick([user('u1'), seed, notice, cont, steer('st-1'), tail], { streamToolIds: ['d1'] }) === null, '续跑段后面跟着兜底并入气泡和尾巴 → null');
ok(pick([user('u1'), seed, notice, cont, steer('st-1')], { streamToolIds: ['d1'] }) === null, '续跑段后面只跟着兜底并入气泡 → null');
ok(pick([user('u1'), seed, notice, cont, tail], { streamToolIds: ['d1'] }) === null, '续跑段后面只跟着尾巴 → null');

console.log('S4');
const r186Run = turn('t-r186', [tool('a1', 'TOOL-1', 'ok'), tool('a2', 'TOOL-2', 'ok'), tool('a3', 'TOOL-3')]);
ok(pick([user('u0'), seed, user('u1'), r186Run]) === 't-r186', '这一轮的回合 → 它的 uuid(与原来一致)');
ok(pick([user('u0'), r186Run, user('u1')]) === null, '最后一个助手回合在这一轮用户消息之前 → null(与原来一致)');
ok(pick([user('u1'), turn('t-txt', [tool('e1', 'X', 'ok'), text('正在写')])]) === null, '最后一段是正文 → null(与原来一致)');
ok(pick([user('u1'), r186Run], { streamToolIds: ['zz'] }) === null, '流里的工具 id 回合里一个都没有 → null(与原来一致)');
ok(pick([user('u1'), r186Run], { streamToolIds: [undefined, 'a3'] }) === 't-r186', '含流里的工具 id → uuid(与原来一致)');
ok(pick([user('u1'), turn('t-done', [tool('f1', 'F-1', 'ok'), tool('f2', 'F-2', 'ok')])]) === null, '流里没有工具 id、工具都已返回 → null(与原来一致)');
ok(pick([user('u1'), r186Run], { stopping: true }) === null, '停止中 → null(与原来一致)');
ok(pick([r186Run]) === null, '前面看不见这一轮的起点 → null(与原来一致)');
ok(pick([]) === null, '空列表 → null(与原来一致)');

console.log('S5');
ok(pick([user('u1'), r186Run, { type: 'denial', uuid: 'x' }]) === 't-r186', '回合后面只有拒绝提示 → 仍承载(与原来一致)');

console.log(`check-r201-steer-live-line: ${n} passed, 0 failed`);
