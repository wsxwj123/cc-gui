#!/usr/bin/env node
// r191:重接尾巴的纯判据(client/src/utils/reattachTail.js)。直接 import 真函数。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  makeReattachTail, tailMarkBlockDone, tailAssignUuid, tailMarkSnapshot, tailMarkEnded, tailMarkSettled,
  tailHistoryIndex, visibleTailBlocks, histTailSig, tailReadBack, countInterruptEntries, lastPromptTs,
} from '../../client/src/utils/reattachTail.js';
import { relate, makeRetainedEntry } from '../../client/src/utils/retainedCopies.js';

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

ok('用户停止:历史先变(没有新的打断提示)不算读回、尾巴还在;出现打断提示才算读回、尾巴退场', () => {
  const Hs = [...H0, { type: 'user', uuid: 'i-old', text: '[Request interrupted by user]' }, user('go2'), turn('r5', [{ type: 'text', content: 'P0 text' }])];
  const t = tailMarkEnded(makeReattachTail('s1'), [{ type: 'text', content: P1_PART }], Hs, false, true);
  assert.equal(t.aborted, true);
  assert.equal(t.endInterrupts, 1, '收尾时已有的旧打断提示计入基线');
  // 停止前发出的刷新晚到:带回更早写盘的一段,签名变了但没有新的打断提示
  const Hlate = [...Hs.slice(0, -1), turn('r5', [{ type: 'text', content: 'P0 text' }, { type: 'tool_use', toolCall: { id: 't9' } }])];
  assert.notEqual(histTailSig(Hlate), histTailSig(Hs));
  assert.equal(tailReadBack(t, Hlate), false, '只是历史变了:不算读回');
  assert.deepEqual(visibleTailBlocks(t, [], Hlate).map((b) => b.content), [P1_PART], '尾巴还在');
  // 编号 / 正文比对命中的块照常不画
  const Hpart = [...Hlate.slice(0, -1), turn('r5', [{ type: 'text', content: 'P0 text' }, { type: 'text', content: P1_PART }])];
  assert.equal(visibleTailBlocks(t, [], Hpart).length, 0, '逐块规则照常');
  // 命令行写下半截与打断提示
  const Hdone = [...Hpart, { type: 'user', uuid: 'i-new', text: ['[Request interrupted by user]'] }];
  assert.equal(countInterruptEntries(Hdone), 2);
  assert.equal(tailReadBack(t, Hdone), true, '新的打断提示:算读回');
  assert.equal(visibleTailBlocks(tailMarkEnded(makeReattachTail('s1'), [{ type: 'text', content: 'zz' }], Hs, false, true), [], Hdone).length, 0, '尾巴整条退场');
});

ok('非用户停止(被结束 / 出错):历史末条签名变了就算读回', () => {
  const t = tailMarkEnded(makeReattachTail('s1'), [{ type: 'text', content: 'zz' }], H0, false, false);
  assert.equal(tailReadBack(t, [...H0]), false, '内容没变');
  const H1 = [...H0, turn('r7', [{ type: 'text', content: 'yy' }])];
  assert.equal(tailReadBack(t, H1), true);
  assert.equal(visibleTailBlocks(t, [], H1).length, 0);
  assert.equal(tailReadBack(makeReattachTail('s1'), H1), false, '没收尾:不算');
  assert.equal(tailReadBack(null, H1), false);
});

ok('源码:收尾轮询与渲染期退场共用 tailReadBack', () => {
  const src = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
  assert.ok(src.includes('!tailReadBack(tailEnd, getLocalMessages())'), '轮询用同一判据');
  assert.ok(src.includes('tailMarkEnded(makeReattachTail(null), tailLive ? orderedBlocks : [], getLocalMessages(), endedClean, turnAborted)'), '收尾记录带用户停止标记');
  const mod = readFileSync(new URL('../../client/src/utils/reattachTail.js', import.meta.url), 'utf8');
  assert.ok(mod.includes('if (tailReadBack(tail, messages)) return [];'), '渲染期整条退场用同一判据');
});

ok('尾巴已关:收尾记录定格空数组,读回判据照常可用', () => {
  const Hs = [...H0, { type: 'user', text: '[Request interrupted by user]' }];
  const a = tailMarkEnded(makeReattachTail(null), [], Hs, false, true);
  assert.deepEqual(a.blocks, []);
  assert.equal(tailReadBack(a, [...Hs, turn('r8', [{ type: 'text', content: 'x' }])]), false, '用户停止:历史变了但没有新打断提示');
  assert.equal(tailReadBack(a, [...Hs, { type: 'user', text: '[Request interrupted by user]' }]), true, '新打断提示:读回');
  const b = tailMarkEnded(makeReattachTail(null), [], H0, false, false);
  assert.equal(tailReadBack(b, [...H0]), false);
  assert.equal(tailReadBack(b, [...H0, user('z')]), true, '其余:末条签名变了');
});

ok('visibleTailBlocks(收尾记录, null, 历史):meta 为空时按指纹去掉历史已有的块', () => {
  const rec = tailMarkEnded(makeReattachTail(null), [{ type: 'text', content: 'P0 text' }, { type: 'tool_use', toolCall: { id: 'q' } }, { type: 'text', content: P1_PART }], H0, false, true);
  assert.deepEqual(rec.meta, {});
  assert.deepEqual(visibleTailBlocks(rec, null, H0).map((b) => b.content), [P1_PART], '历史已有的 P0 去掉,留下没有的');
});

ok('tailHistoryIndex 按列表引用缓存', () => {
  const H = [...H0];
  const a = tailHistoryIndex(H);
  assert.equal(tailHistoryIndex(H), a, '同一引用 → 同一对象');
  const H2 = [...H0, turn('r9', [{ type: 'text', content: 'new' }])];
  const b = tailHistoryIndex(H2);
  assert.notEqual(b, a);
  assert.ok(b.fps.has('text:new') && !a.fps.has('text:new'), '新数组是新结果');
  assert.equal(tailHistoryIndex(null).uuids.size, 0, '非数组不缓存、照常返回空索引');
});

ok('源码:回放不完整关尾巴;读回保证跟着流的形态;只在用户停止时多读;读不回来写留存表', () => {
  const src = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
  const bodyOf = (head) => {
    const i = src.indexOf(head);
    assert.ok(i > 0, head);
    const j = src.indexOf('\n          }\n', i);
    return src.slice(i, j);
  };
  for (const head of ["if (event.type === 'early_overflow') {", "if (event.type === 'stream_gap') {"]) {
    const body = bodyOf(head);
    assert.ok(body.includes('tailLive = false;'), `${head} 关掉尾巴`);
    assert.ok(body.includes('setReattachTail((t) => (t && t.tok === tailToken ? null : t));'), `${head} 置空本流尾巴`);
  }
  const waitLine = src.split('\n').find((l) => l.includes('i < 11 && !tailReadBack(tailEnd, getLocalMessages())'));
  assert.ok(waitLine, '等读回的条件');
  assert.ok(!waitLine.includes('tailLive'), '不再以 tailLive 为条件');
  assert.ok(waitLine.includes('tailEnd.aborted'), '只在用户停止时多读');
  assert.ok(src.includes('const tailEnd = unseededReattach() ?'), '生成 tailEnd 的条件');
  assert.ok(src.includes('&& !unseededReattach()) {\n          producedReply = true;'), '停止分支不推本地副本用同一个量');
  const pEnd = src.indexOf('const tailEnd = unseededReattach() ?');
  const pRetain = src.indexOf("retainStreamCopy('stop'", pEnd);
  const pSettled = src.indexOf('tailMarkSettled', pEnd);
  assert.ok(pRetain > pEnd && pSettled > pRetain, '读不回来写留存表在标 settled 之前');
});

ok('lastPromptTs:最后一条提示词的时间;引导、打断提示不算;没有 / 非数组 → 0', () => {
  const iso = (ms) => new Date(ms).toISOString();
  const H = [
    { type: 'user', text: 'first', timestamp: iso(1000) },
    turn('r1', [{ type: 'text', content: 'a' }]),
    { type: 'user', text: 'second', timestamp: iso(5000) },
    { type: 'user', text: 'steer', steered: true, timestamp: iso(7000) },
    { type: 'user', text: '[Request interrupted by user]', timestamp: iso(9000) },
  ];
  assert.equal(lastPromptTs(H), 5000);
  assert.equal(lastPromptTs([{ type: 'user', text: '[Request interrupted by user]', timestamp: iso(1) }, turn('x', [])]), 0, '没有提示词');
  assert.equal(lastPromptTs([{ type: 'user', text: 'p', timestamp: 'bad' }]), 0, '时间解析不出来');
  assert.equal(lastPromptTs(null), 0);
  assert.equal(lastPromptTs('x'), 0);
});

ok('留存条目按本轮提示词时间定位(relate / makeRetainedEntry 真函数)', () => {
  const T0 = Date.parse('2026-11-16T10:00:00.000Z');
  const iso = (ms) => new Date(ms).toISOString();
  const hist = (turnText) => [
    { type: 'user', uuid: 'p0', text: 'go', timestamp: iso(T0) },
    turn('r1', [{ type: 'text', content: 'P0 text' }, { type: 'text', content: turnText }]).valueOf(),
    { type: 'user', uuid: 'i1', text: '[Request interrupted by user]', timestamp: iso(T0 + 60000) },
  ].map((m, i) => (i === 1 ? { ...m, timestamp: iso(T0 + 1000) } : m));
  const entry = (startTs) => makeRetainedEntry({
    kind: 'stop', ownerKey: 's1', srcUuids: [], roundStartTs: startTs, stopTs: T0 + 50000, prompt: null,
    turn: { uuid: 'chat-stopped-1', type: 'turn', text: [P1_PART], thinking: [], toolCalls: [], blocks: [{ type: 'text', content: P1_PART }] },
  });
  // ① 起点 = 本轮提示词时间,历史本轮回合已含副本正文 → covered
  assert.equal(relate(hist(P1_PART + ' R191-P1-STOPPED'), entry(T0)).mode, 'covered');
  // ② 起点同上,历史本轮回合没有这段 → 不是 covered,要画的内容里有这一块
  const r2 = relate(hist('别的内容'), entry(T0));
  assert.notEqual(r2.mode, 'covered');
  const drawn = r2.mode === 'split' ? r2.rest.blocks : entry(T0).turn.blocks;
  assert.ok(['split', 'append'].includes(r2.mode) && drawn.some((b) => b.content === P1_PART), `要画这一块(${r2.mode})`);
  // ③ 对照:起点 = 重接时刻(晚于本轮回合条目),起点被认到打断提示上,拿不到本轮回合去比 → 不是 covered(要改的原因)
  assert.notEqual(relate(hist(P1_PART + ' R191-P1-STOPPED'), entry(T0 + 30000)).mode, 'covered', '起流时刻作起点时认不出已写盘');
});

ok('源码:读不回来写留存表时按本轮提示词时间定位、srcUuids 为空', () => {
  const src = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
  const p = src.indexOf("retainStreamCopy('stop', {\n            uuid: 'chat-stopped-' + Date.now()");
  assert.ok(p > 0, '第三处调用');
  const call = src.slice(p, src.indexOf('});', src.indexOf('interrupted: true', p)) + 3);
  assert.ok(call.includes('srcUuids: []'), 'srcUuids 空');
  assert.ok(call.includes('roundStartTs: lastPromptTs(getLocalMessages()) || turnStreamStart'), '起点取本轮提示词时间');
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
