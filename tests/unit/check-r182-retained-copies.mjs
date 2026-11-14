#!/usr/bin/env node
// r182 留存副本自检:一轮回复被停止 / 静默超时被结束 / 进程异常退出时,没写进会话文件的那段内容
// 放进 client/src/utils/retainedCopies.js 的按会话表,渲染时按「本轮历史」叠加。这里直接 import 真模块,
// 逐类钉住:留存范围(retainKindOf)、认轮次(locateRound)、覆盖关系(relate)、叠加(applyRetained)、表。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EMPTY_RETAINED, addRetained, applyRetained, dropRetained, listRetained, listRetainedFor, locateRound,
  makeRetainedEntry, migrateRetained, relate, removeRetained, retainKindOf, retainedVersion, subscribeRetained,
  __resetRetainedForTest,
} from '../../client/src/utils/retainedCopies.js';

let passed = 0;
const t = (name, fn) => {
  try { fn(); passed += 1; } catch (err) { console.error(`✗ ${name}`); throw err; }
};

// ── 夹具 ────────────────────────────────────────────────────────────────────
const T0 = Date.parse('2026-11-14T10:00:00.000Z');
const iso = (ms) => new Date(T0 + ms).toISOString();
const user = (uuid, text, ms, extra = {}) => ({ uuid, type: 'user', text, timestamp: iso(ms), ...extra });
const turn = (uuid, ms, { text = '', thinking = '', tools = [] } = {}) => ({
  uuid, type: 'turn', timestamp: iso(ms),
  text: text ? [text] : [], thinking: thinking ? [thinking] : [],
  toolCalls: tools.map((id) => ({ id, name: 'Bash', result: null })),
  blocks: [
    ...(thinking ? [{ type: 'thinking', content: thinking }] : []),
    ...(text ? [{ type: 'text', content: text }] : []),
    ...tools.map((id) => ({ type: 'tool_use', toolCall: { id, name: 'Bash' } })),
  ],
});
const chunks = (from, to) => { let s = ''; for (let i = from; i <= to; i++) s += `片段${String(i).padStart(4, '0')}。`; return s; };
const entry = ({ id = 'chat-stopped-1', text = '', thinking = '', tools = [], srcUuids = [], startMs = 0, stopMs = 1000, prompt = null, kind = 'stop' } = {}) => makeRetainedEntry({
  kind, ownerKey: 'k',
  turn: { ...turn(id, stopMs, { text, thinking, tools }), interrupted: kind === 'stop' },
  srcUuids, roundStartTs: T0 + startMs, stopTs: T0 + stopMs,
  prompt: prompt ? { text: prompt.text, sentTs: T0 + prompt.ms, localUuid: prompt.localUuid || null } : null,
});

// ── 1. retainKindOf:前端流的每一种结束方式 ──────────────────────────────────────
t('1 正常完成 → 不留', () => assert.equal(retainKindOf({ sawTopResult: true, endedClean: true, sawDone: true }), null));
t('1 命令行报错收尾(顶层 result is_error)→ 不留', () => assert.equal(retainKindOf({ sawTopResult: true, endedClean: true, sawServerError: false }), null));
t('1 结束事件已到、流没收尾时用户停止 → 不留', () => assert.equal(retainKindOf({ aborted: true, killed: true, sawTopResult: true, endedClean: true }), null));
t('1 结束事件之后续跑出新内容,用户停止 → stop', () => assert.equal(retainKindOf({ aborted: true, killed: true, sawTopResult: true, endedClean: false }), 'stop'));
t('1 结束事件之后续跑,后端按静默满窗结束这条流(done)→ 不留', () => assert.equal(retainKindOf({ sawTopResult: true, endedClean: false, sawDone: true }), null));
t('1 结束事件之后续跑,被静默超时结束 → stall', () => assert.equal(retainKindOf({ sawTopResult: true, endedClean: false, stallEnded: true }), 'stall'));
t('1 用户停止 / 编辑重发 → stop', () => assert.equal(retainKindOf({ aborted: true, killed: true }), 'stop'));
t('1 静默超时结束 → stall', () => assert.equal(retainKindOf({ stallEnded: true, sawDone: true }), 'stall'));
t('1 重接流的静默超时结束 → stall', () => assert.equal(retainKindOf({ stallEnded: true, sawDone: true, reattach: true }), 'stall'));
t('1 进程退出(收到 done 没见 result)→ exit', () => assert.equal(retainKindOf({ sawDone: true }), 'exit'));
t('1 进程非零退出(后端错误事件)→ exit', () => assert.equal(retainKindOf({ sawServerError: true }), 'exit'));
t('1 重接流确认不了没有结束事件 → 不留', () => assert.equal(retainKindOf({ sawDone: true, reattach: true }), null));
t('1 切走 / 转后台 abort → 不留', () => assert.equal(retainKindOf({ aborted: true, killed: false }), null));
t('1 传输掉线 → 不留', () => assert.equal(retainKindOf({}), null));
t('1 被接管 → 不留', () => assert.equal(retainKindOf({ sawTakeover: true }), null));
t('1 游标过旧 → 不留', () => assert.equal(retainKindOf({ sawGap: true, sawDone: true }), null));
t('1 网络错 → 不留', () => assert.equal(retainKindOf({ networkDrop: true }), null));
t('1 让位给重接 → 不留', () => assert.equal(retainKindOf({ yielded: true, aborted: true, killed: true }), null));
t('1 正常完成 + 其它标志 → 按正常完成', () => {
  assert.equal(retainKindOf({ sawTopResult: true, endedClean: true, aborted: true, killed: true }), null);
  assert.equal(retainKindOf({ sawTopResult: true, endedClean: true, stallEnded: true, sawDone: true }), null);
  assert.equal(retainKindOf({ sawTopResult: true, endedClean: true, sawServerError: true }), null);
});
t('1 让出 / 游标过旧 / 被接管 / 网络掉线,与 killed、stallEnded、sawDone 组合 → 不留', () => {
  for (const k of ['yielded', 'sawGap', 'sawTakeover', 'networkDrop']) {
    for (const extra of [{ aborted: true, killed: true }, { stallEnded: true }, { sawDone: true }, { sawServerError: true }]) {
      assert.equal(retainKindOf({ [k]: true, ...extra }), null, `${k} + ${JSON.stringify(extra)}`);
    }
  }
});

// ── 2. locateRound ──────────────────────────────────────────────────────────
t('2 编号锚定并往前扩,不越过更早条目', () => {
  const hist = [user('p0', '上一轮', -5000), turn('t0', -4000, { text: 'x' }), user('p1', '这一轮', 10), turn('a', 50, { thinking: '想' }), turn('b', 300, { text: 'y' })];
  const loc = locateRound(hist, entry({ srcUuids: ['b'], startMs: 0, stopMs: 1000 }));
  assert.deepEqual([loc.start, loc.end, loc.turnIdx], [3, 5, [3, 4]]);
});
t('2 编号没交集时用提示词', () => {
  const hist = [user('p0', '问', -5000), turn('t0', -4000, { text: 'x' }), user('p1', '问二', 10)];
  const loc = locateRound(hist, entry({ srcUuids: ['zz'], prompt: { text: '问二', ms: 0 } }));
  assert.equal(loc.start, 3);
});
t('2 提示词与上一轮相同:碰到早于发送时刻的用户条目就停,不取上一轮', () => {
  const hist = [user('p0', '好的', -5000), turn('t0', -4000, { text: '好的。' })];
  assert.equal(locateRound(hist, entry({ prompt: { text: '好的', ms: 0 }, startMs: 0 })), null);
});
t('2 两样都没有时用时间窗', () => {
  const hist = [user('p0', 'a', -5000), turn('t0', -4000, { text: 'x' }), user('p1', 'b', 20), turn('t1', 100, { text: 'y' })];
  const loc = locateRound(hist, entry({ startMs: 0 }));
  assert.equal(loc.start, 3);
  assert.deepEqual(loc.turnIdx, [3]);
});
t('2 时间窗:本轮还没有回合时,取起流之后的提示词', () => {
  const hist = [user('p0', 'a', -5000), turn('t0', -4000, { text: 'x' }), user('p1', 'b', 20)];
  const loc = locateRound(hist, entry({ startMs: 0, stopMs: 1000 }));
  assert.deepEqual([loc.start, loc.end, loc.turnIdx.length], [3, 3, 0]);
});
t('2 打断标记不算边界;早于停止时刻的引导 / 后台通知不算边界;晚于停止时刻的下一轮提示词是边界', () => {
  const hist = [
    user('p1', '这一轮', 10), turn('a', 50, { text: '前' }),
    user('s1', '引导一下', 200, { steered: true }),
    user('n1', '<task-notification>完成</task-notification>', 300),
    turn('b', 400, { text: '后' }),
    user('i1', '[Request interrupted by user]', 1005),
    user('p2', '下一轮', 3000), turn('c', 3100, { text: '新' }),
  ];
  const loc = locateRound(hist, entry({ prompt: { text: '这一轮', ms: 0 }, stopMs: 1000 }));
  assert.equal(loc.start, 1);
  assert.equal(loc.end, 6);
  assert.deepEqual(loc.turnIdx, [1, 4]);
});

// ── 3. relate:九种形态 + 不用长度容差 ───────────────────────────────────────────
const P1 = { text: '这一轮', ms: 0 };
t('3 强杀 → append', () => {
  const hist = [user('p0', '前', -5000), turn('t0', -4000, { text: '旧' }), user('p1', '这一轮', 10)];
  const r = relate(hist, entry({ text: chunks(1, 40), thinking: '先想一想。', prompt: P1 }));
  assert.equal(r.mode, 'append'); assert.equal(r.insertAt, 3);
});
t('3 强杀后又发一轮 → append,位置在下一轮提示词前', () => {
  const hist = [user('p1', '这一轮', 10), user('p2', '下一轮', 4000), turn('t2', 4100, { text: '下一轮。' + chunks(1, 5) })];
  const r = relate(hist, entry({ text: chunks(1, 40), prompt: P1, stopMs: 1000 }));
  assert.equal(r.mode, 'append'); assert.equal(r.insertAt, 1);
});
t('3 正常打断(半截写盘,页面的是前缀)→ covered', () => {
  const hist = [user('p1', '这一轮', 10), turn('th', 50, { thinking: '先想一想。', text: chunks(1, 43) }), user('i', '[Request interrupted by user]', 1004)];
  const r = relate(hist, entry({ text: chunks(1, 40), thinking: '先想一想。', srcUuids: ['th'], prompt: P1 }));
  assert.equal(r.mode, 'covered');
});
t('3 前一条写盘、后面没写 → replace', () => {
  const hist = [user('p1', '这一轮', 10), turn('th', 50, { thinking: '先想一想。' })];
  const r = relate(hist, entry({ text: chunks(1, 40), thinking: '先想一想。', srcUuids: ['th'], prompt: P1 }));
  assert.equal(r.mode, 'replace'); assert.equal(r.insertAt, 1); assert.deepEqual(r.turnIdx, [1]);
});
t('3 与上一轮全文相同 → append(不被上一轮覆盖)', () => {
  const hist = [user('p0', '上一轮', -5000), turn('t0', -4000, { thinking: '先想一想。', text: chunks(1, 5) }), user('p1', '这一轮', 10)];
  const r = relate(hist, entry({ text: chunks(1, 5), thinking: '先想一想。', prompt: P1 }));
  assert.equal(r.mode, 'append');
});
t('3 与以前某轮开头一大段相同 → append', () => {
  const hist = [user('p0', '上一轮', -9000), turn('t0', -8000, { text: chunks(1, 140) }), user('p1', '这一轮', 10)];
  assert.equal(relate(hist, entry({ text: chunks(1, 30), prompt: P1 })).mode, 'append');
});
t('3 中途引导 → covered', () => {
  const hist = [user('p1', '这一轮', 10), turn('a', 50, { text: '前半。' }), user('s', '引导', 200, { steered: true }), turn('b', 300, { text: '后半。' })];
  const r = relate(hist, entry({ text: '前半。后半。', srcUuids: ['a'], prompt: P1 }));
  assert.equal(r.mode, 'covered');
});
t('3 没有快照的重接(无提示词、无编号)→ append', () => {
  const hist = [user('p0', 'a', -5000), turn('t0', -4000, { text: 'x' }), user('p1', '这一轮', 10)];
  const r = relate(hist, entry({ text: chunks(20, 40), startMs: 0 }));
  assert.equal(r.mode, 'append'); assert.equal(r.insertAt, 3);
});
t('3 只靠时间窗 → covered', () => {
  const hist = [user('p1', '这一轮', 10), turn('x', 60, { text: chunks(1, 50) })];
  assert.equal(relate(hist, entry({ text: chunks(1, 40), startMs: 0 })).mode, 'covered');
});
t('3 第三方编号不对齐(流里编号与记录编号不同)→ 靠提示词 → replace', () => {
  const hist = [user('p1', '这一轮', 10), turn('rec-1', 50, { thinking: '先想一想。' })];
  const r = relate(hist, entry({ text: chunks(1, 9), thinking: '先想一想。', srcUuids: ['stream-1'], prompt: P1 }));
  assert.equal(r.mode, 'replace');
});
t('3 重接后前一部分已写盘(种回的流见过第一条记录)→ replace', () => {
  const hist = [user('p1', '这一轮', 10), turn('m1', 50, { thinking: '先想一想。', text: chunks(1, 10), tools: ['tool-1'] })];
  const r = relate(hist, entry({ text: chunks(1, 10) + chunks(11, 30), thinking: '先想一想。', tools: ['tool-1'], srcUuids: ['m1'], startMs: 0 }));
  assert.equal(r.mode, 'replace');
});
t('3 正文只差一个字 → 不得 covered(不用长度容差)', () => {
  const hist = [user('p1', '这一轮', 10), turn('x', 60, { text: '这是一段回复A' })];
  const r = relate(hist, entry({ text: '这是一段回复B', srcUuids: ['x'], prompt: P1 }));
  assert.notEqual(r.mode, 'covered');
  assert.equal(r.mode, 'split');
  assert.deepEqual(r.rest.blocks.map((b) => b.type), ['text']);
});
t('3 split 只留没被包含的块类型', () => {
  const hist = [user('p1', '这一轮', 10), turn('x', 60, { thinking: '先想一想。', text: '别的正文' })];
  const r = relate(hist, entry({ thinking: '先想一想。', text: '我的正文', tools: ['t9'], srcUuids: ['x'], prompt: P1 }));
  assert.equal(r.mode, 'split');
  assert.deepEqual(r.rest.blocks.map((b) => b.type), ['text', 'tool_use']);
  assert.deepEqual(r.rest.thinking, []);
});
t('3 进程异常退出(exit)形态与强杀相同 → append', () => {
  const hist = [user('p1', '这一轮', 10)];
  const e = entry({ kind: 'exit', text: chunks(1, 12), prompt: P1 });
  assert.equal(e.turn.interrupted, false);
  assert.equal(relate(hist, e).mode, 'append');
});
t('3 历史里还认不出本轮 → unplaced', () => {
  const hist = [user('p0', '上一轮', -5000), turn('t0', -4000, { text: chunks(1, 5) })];
  assert.equal(relate(hist, entry({ text: chunks(1, 5), prompt: P1 })).mode, 'unplaced');
});

// ── 4. applyRetained ────────────────────────────────────────────────────────
t('4 没有条目时返回原引用', () => {
  const hist = [user('p1', 'a', 10)]; const local = [];
  const v = applyRetained(hist, EMPTY_RETAINED, local);
  assert.equal(v.list, hist); assert.equal(v.local, local); assert.equal(v.coveredIds, EMPTY_RETAINED);
});
t('4 只有 covered 时两段都返回原引用,coveredIds 只含 covered 的', () => {
  const hist = [user('p1', '这一轮', 10), turn('th', 50, { thinking: '先想一想。', text: chunks(1, 43) })];
  const local = [{ uuid: 'n', type: 'turn' }];
  const e1 = entry({ id: 'chat-stopped-a', text: chunks(1, 40), thinking: '先想一想。', srcUuids: ['th'], prompt: P1 });
  const v = applyRetained(hist, [e1], local);
  assert.equal(v.list, hist); assert.equal(v.local, local); assert.deepEqual(v.coveredIds, ['chat-stopped-a']);
});
t('4 replace 隐藏的正好是本轮那几个回合,副本画在第一个的位置', () => {
  const hist = [user('p0', '上一轮', -5000), turn('t0', -4000, { text: 'x' }), user('p1', '这一轮', 10), turn('th', 50, { thinking: '先想一想。' }), user('p2', '下一轮', 5000), turn('t2', 5100, { text: 'z' })];
  const e1 = entry({ id: 'chat-stopped-r', text: chunks(1, 40), thinking: '先想一想。', srcUuids: ['th'], prompt: P1, stopMs: 1000 });
  const v = applyRetained(hist, [e1], []);
  assert.deepEqual(v.list.map((m) => m.uuid), ['p0', 't0', 'p1', 'chat-stopped-r', 'p2', 't2']);
  assert.deepEqual(v.coveredIds, []);
});
t('4 历史认不出本轮时,副本紧跟本地段里页面自己发出的提示词气泡', () => {
  const hist = [user('p0', '上一轮', -5000), turn('t0', -4000, { text: chunks(1, 5) })];
  const local = [{ uuid: 'chat-user-1', type: 'user', text: '这一轮', timestamp: iso(0) }, { uuid: 'stall-1', type: 'turn', localNotice: 'stall' }];
  const e1 = entry({ id: 'chat-assistant-s', kind: 'stall', text: chunks(1, 5), prompt: { ...P1, localUuid: 'chat-user-1' } });
  const v = applyRetained(hist, [e1], local);
  assert.equal(v.list, hist);
  assert.deepEqual(v.local.map((m) => m.uuid), ['chat-user-1', 'chat-assistant-s', 'stall-1']);
});
t('4 历史和本地都认不出 → 插在历史末尾', () => {
  const hist = [user('p0', '上一轮', -5000)];
  const v = applyRetained(hist, [entry({ id: 'chat-stopped-x', text: 'q', prompt: P1 })], []);
  assert.deepEqual(v.list.map((m) => m.uuid), ['p0', 'chat-stopped-x']);
});
t('4 连续两轮都没写盘:各自留在自己那一轮', () => {
  const hist = [user('p1', '第一轮', 10), user('p2', '第二轮', 3000)];
  const e1 = entry({ id: 'chat-stopped-1', text: chunks(1, 40), prompt: { text: '第一轮', ms: 0 }, startMs: 0, stopMs: 1000 });
  const e2 = entry({ id: 'chat-stopped-2', text: chunks(1, 20), prompt: { text: '第二轮', ms: 2990 }, startMs: 2990, stopMs: 4000 });
  const v = applyRetained(hist, [e1, e2], []);
  assert.deepEqual(v.list.map((m) => m.uuid), ['p1', 'chat-stopped-1', 'p2', 'chat-stopped-2']);
});

// ── 4b. 认轮次的上界(列表只是历史的一段 / 已含停止之后的更晚轮次)──────────────────────
// 时间记号:t0(-5000)< 起流(0)≤ t1(10)< 停止(1000)< t3(3000)< t4(3100)
const KEEP = { text: '继续', ms: 0 };
t('4b 连发两条相同提示词:第 1 轮的条目不认到第 2 轮的提示词上,副本在两条提示词之间', () => {
  const hist = [user('u1', '继续', 10), user('u2', '继续', 3000), turn('t2', 3100, { text: '第二轮' })];
  const e1 = entry({ id: 'chat-stopped-k', text: chunks(1, 8), prompt: KEEP, srcUuids: ['zz'] });
  const loc = locateRound(hist, e1);
  assert.deepEqual([loc.start, loc.end, loc.turnIdx], [1, 1, []]);
  const v = applyRetained(hist, [e1], []);
  assert.deepEqual(v.list.map((m) => m.uuid), ['u1', 'chat-stopped-k', 'u2', 't2']);
});
t('4b 两轮都被强杀、提示词相同:各自落在自己那条提示词后面', () => {
  const hist = [user('u1', '继续', 10), user('u2', '继续', 3000)];
  const e1 = entry({ id: 'chat-stopped-1', text: chunks(1, 8), prompt: KEEP, startMs: 0, stopMs: 1000 });
  const e2 = entry({ id: 'chat-stopped-2', text: chunks(9, 12), prompt: { text: '继续', ms: 2990 }, startMs: 2990, stopMs: 4000 });
  const v = applyRetained(hist, [e1, e2], []);
  assert.deepEqual(v.list.map((m) => m.uuid), ['u1', 'chat-stopped-1', 'u2', 'chat-stopped-2']);
});
t('4b 提示词全文对不上(带附件)后又发了一轮:副本在本轮提示词之后、下一轮提示词之前', () => {
  const hist = [user('u1', '看看这张图', 10), user('u2', '下一轮', 3000), turn('t2', 3100, { text: '新' })];
  const e1 = entry({ id: 'chat-stopped-a', text: chunks(1, 8), prompt: { text: '看看这张图 [附件]', ms: 0 } });
  const v = applyRetained(hist, [e1], []);
  assert.deepEqual(v.list.map((m) => m.uuid), ['u1', 'chat-stopped-a', 'u2', 't2']);
});
t('4b 列表只含更晚轮次 → offscreen;applyRetained 两段都返回原引用、coveredIds 为空', () => {
  const e1 = entry({ id: 'chat-stopped-o', text: chunks(1, 8), prompt: P1 });
  const histA = [user('u3', '下一轮', 3000), turn('t3', 3100, { text: '新' })];
  const histB = [turn('t3', 3000, { text: '旧尾' }), user('u4', '再下一轮', 3100), turn('t4', 3200, { text: '新' })];
  for (const hist of [histA, histB]) {
    assert.equal(relate(hist, e1).mode, 'offscreen');
    const local = [{ uuid: 'chat-user-x', type: 'user', text: '这一轮' }];
    const v = applyRetained(hist, [e1], local);
    assert.equal(v.list, hist); assert.equal(v.local, local); assert.deepEqual(v.coveredIds, []);
  }
});
t('4b 没有提示词信息、本轮只有打断后才写盘的半截:起点是那条半截回合', () => {
  const hist = [user('u0', 'a', -5000), turn('t0', -4000, { text: 'x' }), turn('half', 3000, { text: '半截' })];
  const loc = locateRound(hist, entry({ text: '半截还有', srcUuids: ['zz'], startMs: 0 }));
  assert.deepEqual([loc.start, loc.end, loc.turnIdx], [2, 3, [2]]);
});
t('4b 没有提示词信息、本轮在这段里没有记录、后面已有更晚轮次:副本插在更晚的提示词之前', () => {
  const hist = [user('u0', 'a', -5000), turn('t0', -4000, { text: 'x' }), user('u3', '下一轮', 3000), turn('t3', 3100, { text: '新' })];
  const v = applyRetained(hist, [entry({ id: 'chat-stopped-n', text: chunks(1, 8), startMs: 0 })], []);
  assert.deepEqual(v.list.map((m) => m.uuid), ['u0', 't0', 'chat-stopped-n', 'u3', 't3']);
});

// ── 5. 表 ───────────────────────────────────────────────────────────────────
__resetRetainedForTest();
t('5 listRetained 只读不取走;空时返回同一个空数组常量', () => {
  assert.equal(listRetained('none'), EMPTY_RETAINED);
  assert.equal(listRetainedFor(['none', 'none2']), EMPTY_RETAINED);
  assert.ok(addRetained('s1', entry({ id: 'chat-stopped-a' })));
  assert.equal(listRetained('s1').length, 1);
  assert.equal(listRetained('s1').length, 1);
});
t('5 同一组键、同一个版本返回同一个引用;版本变了换新引用', () => {
  const a = listRetainedFor(['s1', 'draft-1']);
  const b = listRetainedFor(['s1', 'draft-1']);
  assert.equal(a, b);
  addRetained('s1', entry({ id: 'chat-stopped-b', stopMs: 2000 }));
  const c = listRetainedFor(['s1', 'draft-1']);
  assert.notEqual(a, c);
  assert.deepEqual(c.map((e) => e.id), ['chat-stopped-a', 'chat-stopped-b']);
});
t('5 停止后切走再切回:读别的会话不影响本会话的条目', () => {
  assert.equal(listRetainedFor(['other']), EMPTY_RETAINED);
  assert.equal(listRetainedFor(['s1']).length, 2);
});
t('5 写入 / 删除会通知订阅方', () => {
  let n = 0;
  const off = subscribeRetained(() => { n += 1; });
  const v0 = retainedVersion();
  removeRetained('s1', ['chat-stopped-b']);
  assert.equal(n, 1); assert.ok(retainedVersion() > v0);
  assert.equal(removeRetained('s1', ['nope']), false);
  assert.equal(n, 1);
  off();
});
t('5 墓碑:之后到的、起流时刻早于墓碑的条目拒收;之后开始的回合照收', () => {
  addRetained('s2', entry({ id: 'chat-stopped-old', startMs: 0 }));
  dropRetained('s2', T0 + 500);
  assert.equal(listRetained('s2'), EMPTY_RETAINED);
  assert.equal(addRetained('s2', entry({ id: 'chat-stopped-late', startMs: 0 })), false);
  assert.equal(listRetained('s2'), EMPTY_RETAINED);
  assert.equal(addRetained('s2', entry({ id: 'chat-stopped-new', startMs: 600 })), true);
});
t('5 migrateRetained 幂等,改键并带上墓碑', () => {
  addRetained('draft-9', entry({ id: 'chat-stopped-d' }));
  assert.equal(migrateRetained('draft-9', 's9'), true);
  assert.equal(migrateRetained('draft-9', 's9'), false);
  assert.equal(listRetained('draft-9'), EMPTY_RETAINED);
  assert.deepEqual(listRetained('s9').map((e) => [e.id, e.ownerKey]), [['chat-stopped-d', 's9']]);
  dropRetained('draft-x', T0 + 500);
  migrateRetained('draft-x', 's10');
  assert.equal(addRetained('s10', entry({ id: 'chat-stopped-z', startMs: 0 })), false);
});
t('5 会话键上限:最多 8 个会话', () => {
  __resetRetainedForTest();
  for (let i = 0; i < 10; i++) addRetained(`k${i}`, entry({ id: `chat-stopped-${i}` }));
  assert.equal(listRetained('k0'), EMPTY_RETAINED);
  assert.equal(listRetained('k9').length, 1);
});

// ── 6. 源码文本守卫(App.jsx 的接线)────────────────────────────────────────────
const app = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../client/src/App.jsx'), 'utf8');
const count = (s) => app.split(s).length - 1;
t('6 catch:用户停止时只写表,不再用 setChatMessages 推 chat-stopped-', () => {
  // 停止路径也看结束事件:回合已收到顶层结束事件、流还没收尾时点停止,不当成「没写盘」留存。
  const head = 'if (retainKindOf({ aborted: true, killed: killedRef.current, endedClean })) {';
  const i = app.indexOf(head);
  assert.ok(i !== -1, 'catch 里要用 retainKindOf 判停止,且带上 endedClean');
  const branch = app.slice(i, app.indexOf('} else {', i));
  assert.ok(branch.includes("retainStreamCopy('stop', stoppedCopy)"), '停止分支写表');
  assert.ok(!branch.includes('setChatMessages'), '停止分支不许推 chatMessages');
  const elseBranch = app.slice(app.indexOf('} else {', i), app.indexOf('} else {', i) + 600);
  assert.ok(elseBranch.includes('localCopiesCleared ? prev : [...prev, stoppedCopy]'), '切走 / 转后台照旧推本地副本');
});
t('6 sawTopResult / endedClean 声明在 try 之外(catch 可读),顶层新内容只复位 endedClean、顶层 result 两个都置位', () => {
  const decl = app.indexOf('let sawTopResult = false;');
  assert.ok(decl !== -1 && count('let sawTopResult = false;') === 1, '只声明一处');
  const decl2 = app.indexOf('let endedClean = false;');
  assert.ok(decl2 !== -1 && count('let endedClean = false;') === 1, 'endedClean 只声明一处');
  const mirror = app.indexOf("let streamEndMirror = null;");
  assert.ok(mirror !== -1 && decl > mirror && decl - mirror < 800, '与 streamEndMirror 放在一处');
  assert.ok(decl2 > mirror && decl2 - mirror < 800, 'endedClean 与 streamEndMirror 放在一处');
  const setAt = app.indexOf("if (event.type === 'result' && !event.parent_tool_use_id) { sawTopResult = true; endedClean = true; }");
  assert.ok(setAt !== -1, '顶层 result 置位两个标志');
  const pre = app.slice(setAt - 500, setAt);
  assert.ok(pre.includes('endedClean = false;') && pre.includes("'content_block_start'") && pre.includes("'content_block_delta'") && pre.includes("event.type === 'assistant'"), '置位之前有顶层新内容复位 endedClean');
  assert.equal(count('sawTopResult = false;'), 1, 'sawTopResult 不复位(只有声明那一处)');
  assert.ok(retainKindOf({ aborted: true, killed: true, sawTopResult: true, endedClean: true }) === null, '已完整结束的停止不留存');
});
t('6 流收尾推副本处:先 retainKindOf,命中写表,否则走原来那一行推送', () => {
  const i = app.indexOf('const retainKind = retainKindOf({');
  assert.ok(i !== -1);
  const seg = app.slice(i, app.indexOf('} else if (!reattachPid || seeded) setChatMessages((prev) => [...prev, {', i));
  assert.ok(seg.includes('if (retainKind && (!reattachPid || seeded)) {'), '写表只在原推送的同一条件下发生');
  assert.ok(seg.includes('retainStreamCopy(retainKind,'), '命中写表');
  assert.ok(seg.includes('finalizePendingToolCalls(currentToolCalls, true)'), '写表前给没回执的工具补终态');
});
t('6 全文件只有 retainKindOf 判断留存:写表只经 retainStreamCopy,它的两个调用点都跟在 retainKindOf 之后', () => {
  assert.equal(count('addRetained('), 1, 'addRetained 只在 retainStreamCopy 里调用');
  assert.equal(count('retainKindOf('), 2);
  assert.equal(count('retainStreamCopy('), 2, '调用 2 处(停止 / 流收尾)');
  assert.equal(count('const retainStreamCopy = '), 1);
});
t('6 写表的会话键取本流闭包里的值', () => {
  assert.ok(app.includes('const retainStreamCopy = (kind, turnCopy) => addRetained(streamSid || sessionQueueKey, makeRetainedEntry({'));
  assert.ok(app.includes('roundStartTs: turnStreamStart, stopTs: Date.now(),'));
});
t('6 表的通知走 startTransition;叠加在 mountedMessages / renderChat 上', () => {
  assert.ok(app.includes('const off = subscribeRetained(() => { startTransition(() => setRetainedTick(retainedVersion())); });'));
  const sub = app.indexOf('const off = subscribeRetained(');
  const tail = app.slice(sub, sub + 400);
  assert.ok(/setRetainedTick\(retainedVersion\(\)\);\s*return off;/.test(tail), '订阅之后补读一次版本号,再返回取消订阅');
  assert.ok(app.includes('applyRetained(mountedBase, retainedEntries, renderChatBase)'));
  assert.ok(app.includes('const mountedMessages = retainedView.list;'));
  assert.ok(app.includes('const renderChat = retainedView.local;'));
});
t('6 回滚 / 清空会话清表,草稿转正式迁移', () => {
  const tu = app.slice(app.indexOf('const truncateUi = () => {'), app.indexOf('const truncateUi = () => {') + 600);
  assert.ok(tu.includes('dropRetained(k)'), 'truncateUi 清表并记墓碑');
  assert.ok(/dropUserStash\(conversationResetFrom\);[^\n]*\n\s*dropRetained\(conversationResetFrom\);/.test(app), '/clear 轮换清表');
  assert.ok(/migrateUserStash\(_dk0, event\.session_id\);[^\n]*\n\s*migrateRetained\(_dk0, event\.session_id\);/.test(app), '草稿转正式迁移');
});
t('6 其余裁剪历史的路径也清表', () => {
  // 检查点还原裁剪:裁剪成功后清
  assert.ok(/trimOk = tr\.ok;[^\n]*\n[^\n]*\n\s*if \(tr\.ok\) dropRetained\(sessionId\);/.test(app), '检查点还原裁剪清表');
  // 定向压缩(after):尾段被移除处清
  const ca = app.indexOf("if (direction === 'after') {");
  assert.ok(ca !== -1, '定向压缩 after 分支');
  assert.ok(app.slice(ca, ca + 400).includes('dropRetained(k)'), '定向压缩 after 清表');
  // 回滚期间切走(truncateUi 不执行)
  const lv = app.indexOf('if (!stillHere()) {\n      // r182');
  assert.ok(lv !== -1, '回滚切走分支');
  assert.ok(app.slice(lv, app.indexOf('leaveForOwner(', lv)).includes('if (!trimFailed) for (const k of new Set([queueKeyFor(sel), sel?.sessionId].filter(Boolean))) dropRetained(k);'), '回滚切走分支清表');
  // 重做工具 / 内容审核回退:乐观截断与停流之前清
  const rt = app.slice(app.indexOf('const handleRetryTool = useCallback('), app.indexOf("runHistoryOp(sel.sessionId, 'trim-before-tool'"));
  const di = rt.indexOf('for (const k of new Set([rtKey, sel.sessionId].filter(Boolean))) dropRetained(k);');
  assert.ok(di !== -1, '重做工具清表');
  assert.ok(di < rt.indexOf('if (opts.contentRisk) {') && di < rt.indexOf('abortRef.current.abort()'), '清表在乐观截断与停流之前');
});
t('6 删除会话处清表(侧栏 reallyDelete 与卸载兜底)', () => {
  const sb = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../client/src/components/UnifiedSidebar.jsx'), 'utf8');
  assert.ok(sb.includes("import { dropRetained } from '../utils/retainedCopies.js';"));
  const rd = sb.slice(sb.indexOf('const reallyDelete = async (session) => {'), sb.indexOf('const handleDelete = (session) => {'));
  assert.ok(rd.indexOf('dropRetained(session.sessionId);') > rd.indexOf('if (!r.ok)'), 'DELETE 成功之后清表');
  const fa = sb.slice(sb.indexOf('const flushAllPending = () => {'), sb.indexOf('const flushAllPending = () => {') + 800);
  assert.ok(fa.includes('dropRetained(p.session.sessionId);'), '卸载兜底清表');
});

console.log(`check-r182-retained-copies: ${passed} 条通过`);
