// r151q 第 9 项(前端纯函数部分):被 409 CHAT_SESSION_BUSY 退回队首的消息
//   · busyRetryAt 没到点前队首不可排空(两次尝试至少隔 2 秒),也不越过它先发后项;到点后照常排空;
//   · 'kept' 条目照旧跳过,未带 busyRetryAt 的老条目行为不变;
//   · 切走时被暂存的那份乐观气泡按 uuid 撤掉,同会话其它暂存保留。
// node tests/unit/check-r151q-busy-requeue.mjs
import assert from 'node:assert/strict';
import { firstDrainableIndex } from '../../client/src/utils/steerQueue.js';
import { dropStashedUserBubble, stashUserBubbles, takePendingUserBubbles } from '../../client/src/utils/localUserStash.js';

let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };

const NOW = 1_000_000;
const busy = { text: 'busy', busyRetryAt: NOW + 2000 };
const later = { text: 'later' };
eq(firstDrainableIndex([busy, later], NOW), -1, '冷却中的队首不可排空');
eq(firstDrainableIndex([busy, later], NOW + 1999), -1, '差 1 毫秒也不行');
eq(firstDrainableIndex([busy, later], NOW + 2000), 0, '到点后队首可排空');
eq(firstDrainableIndex([{ text: 'k', steerState: 'kept' }, busy, later], NOW), -1, 'kept 之后的冷却队首同样挡住后项');
eq(firstDrainableIndex([{ text: 'k', steerState: 'kept' }, busy], NOW + 5000), 1, 'kept 照旧跳过');
eq(firstDrainableIndex([later], NOW), 0, '没带 busyRetryAt 的条目行为不变');
eq(firstDrainableIndex([{ text: 'x', busyRetryAt: 'oops' }], NOW), 0, '非数值的 busyRetryAt 不挡');
eq(firstDrainableIndex([], NOW), -1, '空队列');

const KEY = 'sess-r151q';
stashUserBubbles(KEY, [{ uuid: 'u1', type: 'user', text: 'a' }, { uuid: 'u2', type: 'user', text: 'b' }]);
dropStashedUserBubble(KEY, 'u1');
const known = { has: () => false };
const back = takePendingUserBubbles(KEY, known);
eq(back.pending.map((m) => m.uuid), ['u2'], '只撤掉指定 uuid 的那份暂存');
dropStashedUserBubble(KEY, 'u2');
dropStashedUserBubble(KEY, 'nope');
dropStashedUserBubble(null, 'u2');
const empty = takePendingUserBubbles(KEY, known);
eq([empty.pending.length, empty.persisted.length], [0, 0], '撤空后该会话没有暂存');

console.log(`PASS check-r151q-busy-requeue(${checks} 项)`);
