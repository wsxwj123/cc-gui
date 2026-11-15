#!/usr/bin/env node
// r191:重接尾巴的纯判据(client/src/utils/reattachTail.js)。直接 import 真函数。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  makeReattachTail, tailMarkBlockDone, tailAssignUuid, tailMarkSnapshot, tailMarkEnded, tailMarkSettled,
  tailHistoryIndex, visibleTailBlocks, histTailSig,
} from '../../client/src/utils/reattachTail.js';

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log('  ok', name); };

const user = (t) => ({ type: 'user', uuid: 'u-' + t, text: t });
const turn = (uuid, blocks) => ({ type: 'turn', uuid, blocks, text: blocks.filter((b) => b.type === 'text').map((b) => b.content) });
const H0 = [user('go'), turn('r0', [{ type: 'text', content: 'P0 text' }, { type: 'tool_use', toolCall: { id: 't1' } }])];
const P1_PART = 'P1-001 P1-002 ';
const P1_FULL = 'P1-001 P1-002 P1-003 ';

ok('未写完的块:历史里没有就画', () => {
  const t = makeReattachTail('s1');
  const out = visibleTailBlocks(t, [{ type: 'text', content: P1_PART }], H0);
  assert.deepEqual(out.map((b) => b.content), [P1_PART]);
});

ok('工具块、空块、报错块不画', () => {
  const t = makeReattachTail('s1');
  const out = visibleTailBlocks(t, [{ type: 'tool_use', toolCall: {} }, { type: 'text', content: '' }, { type: 'text', content: 'x', errorText: true }, { type: 'thinking', content: 'hm' }], H0);
  assert.deepEqual(out.map((b) => b.type), ['thinking']);
});

ok('写完 + 编号:编号命中历史回合 uuid 就不画', () => {
  let t = makeReattachTail('s1');
  t = tailMarkBlockDone(t, 0, H0);
  t = tailAssignUuid(t, 'r1');
  assert.equal(t.meta[0].uuid, 'r1');
  const live = [{ type: 'text', content: P1_FULL }];
  assert.equal(visibleTailBlocks(t, live, H0).length, 1, '历史还没有:照画(引用没变)');
  const H1 = [...H0, turn('r1', [{ type: 'text', content: 'other' }])];
  assert.equal(visibleTailBlocks(t, live, H1).length, 0);
});

ok('写完 + 编号:历史回合 uuid 是第一条记录的,靠本轮正文指纹认出', () => {
  let t = tailAssignUuid(tailMarkBlockDone(makeReattachTail('s1'), 0, H0), 'r1');
  const live = [{ type: 'text', content: P1_FULL }];
  const H1 = [user('go'), turn('r0', [{ type: 'text', content: 'P0 text' }, { type: 'tool_use', toolCall: { id: 't1' } }, { type: 'text', content: 'P1-001  P1-002\nP1-003' }])];
  assert.equal(visibleTailBlocks(t, live, H1).length, 0, '去空白后相同');
  // 指纹只认本轮(最后一条提示词之后)
  const H2 = [user('old'), turn('rx', [{ type: 'text', content: P1_FULL }]), user('go')];
  assert.equal(visibleTailBlocks(t, live, H2).length, 1, '更早一轮的同文不算');
});

ok('编号按到达顺序记到最早一个已写完、无编号的块', () => {
  let t = makeReattachTail('s1');
  t = tailMarkBlockDone(t, 0, H0);
  t = tailMarkBlockDone(t, 2, H0);
  t = tailAssignUuid(t, 'a');
  t = tailAssignUuid(t, 'b');
  assert.equal(t.meta[0].uuid, 'a');
  assert.equal(t.meta[2].uuid, 'b');
  assert.equal(tailAssignUuid(t, 'c'), t, '没有待记的块:不变');
  assert.equal(tailAssignUuid(makeReattachTail('s1'), 'z').meta[0], undefined, '没写完的块不记');
});

ok('记不上编号的块:写完且此后历史应用过一次就不画', () => {
  const t = tailMarkBlockDone(makeReattachTail('s1'), 0, H0);
  const live = [{ type: 'text', content: 'abc' }];
  assert.equal(visibleTailBlocks(t, live, H0).length, 1, '同一引用 = 还没应用过');
  assert.equal(visibleTailBlocks(t, live, [...H0]).length, 0);
});

ok('整条快照型事件补进的块:写完 + 编号', () => {
  const t = tailMarkSnapshot(makeReattachTail('s1'), 1, 3, 'snap', H0);
  assert.deepEqual([t.meta[1].uuid, t.meta[2].uuid, t.meta[2].done], ['snap', 'snap', true]);
  assert.equal(tailMarkSnapshot(t, 3, 3, 'x', H0), t);
});

ok('收尾:定格块内容;历史末条变了才退场(同帧)', () => {
  let t = makeReattachTail('s1');
  const live = [{ type: 'text', content: P1_PART }];
  t = tailMarkEnded(t, live, H0, false);
  live.push({ type: 'text', content: 'late' });
  assert.equal(t.blocks.length, 1, '定格是拷贝');
  assert.equal(visibleTailBlocks(t, [], H0).length, 1, '直播缓冲清空后仍画定格内容');
  assert.equal(visibleTailBlocks(t, [], [...H0]).length, 1, '重读回来内容没变:不退场(不闪空)');
  const H1 = [user('go'), turn('r0', [{ type: 'text', content: 'P0 text' }, { type: 'text', content: P1_PART + ' STOPPED' }])];
  assert.equal(visibleTailBlocks(t, [], H1).length, 0, '历史变了:退场');
  assert.equal(tailMarkBlockDone(t, 0, H0), t, '收尾后不再改');
});

ok('收尾:干净结束且收尾后历史应用过 → 退场;settled → 退场', () => {
  const t = tailMarkEnded(makeReattachTail('s1'), [{ type: 'text', content: 'q' }], H0, true);
  assert.equal(visibleTailBlocks(t, [], H0).length, 1);
  assert.equal(visibleTailBlocks(t, [], [...H0]).length, 0);
  const u = tailMarkSettled(tailMarkEnded(makeReattachTail('s1'), [{ type: 'text', content: 'q' }], H0, false));
  assert.equal(visibleTailBlocks(u, [], H0).length, 0);
  assert.equal(tailMarkSettled(makeReattachTail('s1')).settled, false, '没收尾不能 settled');
});

ok('签名与索引的边界', () => {
  assert.equal(histTailSig([]), '');
  assert.equal(histTailSig(null), '');
  assert.notEqual(histTailSig(H0), histTailSig([...H0, user('x')]));
  const idx = tailHistoryIndex([user('go'), { type: 'user', text: '[Request interrupted by user]' }, turn('r9', [{ type: 'thinking', content: 'th' }])]);
  assert.ok(idx.uuids.has('r9'));
  assert.ok(idx.fps.has('thinking:th'), '打断提示不当提示词');
  assert.deepEqual(visibleTailBlocks(null, [], H0), []);
});

ok('源码:流请求只在无快照的重接时带 openBlock=1', () => {
  const src = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
  assert.ok(src.includes("fetch(`/api/chat/${pid}/stream${reattachPid && !seeded ? '?openBlock=1' : ''}`"), '流请求带开关');
  assert.ok(!/openBlock=1[^']*afterSeq|afterSeq[^\n]*openBlock/.test(src), '不与游标同发');
});

console.log(`check-r191-reattach-tail: ${passed} passed`);
