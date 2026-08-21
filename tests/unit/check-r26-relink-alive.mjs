#!/usr/bin/env node
// 单测:r26-G8 同 uuid 重复行,接骨优先指向仍存活的同名行。
// 根因:同 uuid 出现多次(断线重发/补丁写入)时,droppedParent 只认"被删"不看"同名
// 活行",凡指向该 uuid 的引用都被拽到死行的 parent 上,对话树被接断。
// 修法:被删 uuid 有存活同名行 → 不进 droppedParent,引用原样保留(即指向活行);
// 全灭才上溯;多个全灭同名行取最后出现者的 parent(确定性)。
// 变异哨兵(实际验证过红):S1 droppedParent 构建去掉 aliveUuids 过滤 → t1 红。
import assert from 'node:assert/strict';
import { repairOfficialCompat } from '../../server/utils/session-repair.js';

const L = (obj) => JSON.stringify(obj);
const msg = (type, uuid, parentUuid, content) =>
  L({ uuid, parentUuid, sessionId: 'S', type, message: { role: type, content } });

// t1 摘活哨兵:同 uuid 一死一活 → 子行引用保持指向该 uuid(活行),不被拽走
{
  const { lines, report } = repairOfficialCompat([
    msg('user', 'u1', null, [{ type: 'text', text: '问题' }]),
    msg('assistant', 'a1', 'u1', [{ type: 'text', text: '' }]),       // 死:清块致空
    msg('assistant', 'a1', 'u1', [{ type: 'text', text: '真回答' }]), // 活:同 uuid
    msg('user', 'u2', 'a1', [{ type: 'text', text: '追问' }]),
  ]);
  const objs = lines.map((l) => JSON.parse(l));
  assert.equal(report.droppedLines, 1, 't1: 死行被摘一条');
  assert.equal(objs.length, 3, 't1: 存活三行');
  const follow = objs.find((o) => o.uuid === 'u2');
  assert.equal(follow.parentUuid, 'a1', 't1: 引用指向活着的 a1,不被拽到 u1');
  assert.equal(report.relinked, 0, 't1: 有活行可指时不算接骨(引用根本不动)');
  const alive = objs.filter((o) => o.uuid === 'a1');
  assert.equal(alive.length, 1, 't1: a1 只剩活行');
  assert.equal(alive[0].message.content[0].text, '真回答', 't1: 活下来的是真内容行');
}

// t2 确定性哨兵:同 uuid 双死(不同 parent)→ 引用沿最后出现的死行上溯
{
  const { lines } = repairOfficialCompat([
    msg('user', 'p1', null, [{ type: 'text', text: 'x' }]),
    msg('user', 'p2', null, [{ type: 'text', text: 'y' }]),
    msg('assistant', 'd', 'p1', [{ type: 'text', text: '' }]),  // 死① parent=p1
    msg('assistant', 'd', 'p2', [{ type: 'thinking', thinking: ' ' }]), // 死② parent=p2(后出现)
    msg('user', 'c', 'd', [{ type: 'text', text: 'z' }]),
  ]);
  const c = lines.map((l) => JSON.parse(l)).find((o) => o.uuid === 'c');
  assert.equal(c.parentUuid, 'p2', 't2: 全灭时指向最后出现的死行的 parent(确定性)');
}

// t3 活行顺序无关:活行在死行之前出现,同样优先活行
{
  const { lines } = repairOfficialCompat([
    msg('user', 'u1', null, [{ type: 'text', text: 'q' }]),
    msg('assistant', 'a1', 'u1', [{ type: 'text', text: '先到的活行' }]), // 活(先出现)
    msg('assistant', 'a1', 'u1', [{ type: 'text', text: '' }]),           // 死(后出现)
    msg('user', 'u2', 'a1', [{ type: 'text', text: 'follow' }]),
  ]);
  const objs = lines.map((l) => JSON.parse(l));
  assert.equal(objs.find((o) => o.uuid === 'u2').parentUuid, 'a1', 't3: 活行在前也优先活行');
  assert.equal(objs.filter((o) => o.uuid === 'a1').length, 1, 't3: 死行仍被摘');
}

// t4 回归:无重复 uuid 的链式删除接骨不变(沿 parent 链穿透到存活祖先)
{
  const { lines } = repairOfficialCompat([
    msg('user', 'u1', null, [{ type: 'text', text: 'root' }]),
    msg('assistant', 'a1', 'u1', [{ type: 'text', text: '' }]),
    msg('assistant', 'a2', 'a1', [{ type: 'thinking', thinking: ' ' }]),
    msg('user', 'u2', 'a2', [{ type: 'text', text: 'leaf' }]),
  ]);
  assert.equal(lines.map((l) => JSON.parse(l)).find((o) => o.uuid === 'u2').parentUuid, 'u1',
    't4: 普通链式删除接骨不变');
}

console.log('PASS r26-g8-relink-prefers-alive');
