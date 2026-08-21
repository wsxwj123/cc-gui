#!/usr/bin/env node
// r26-G8【复现+边界】:同 uuid 重复行,接骨把引用摘到死行的 parent 上,无视仍存活的同名行。
// 场景:jsonl 里同一个 uuid 出现两次(断线重发/补丁写入的真实形态):一条是会被修复删掉的
// 空内容行,一条是存活的真内容行。R3 接骨时,凡 parentUuid 指向该 uuid 的行被重指到
// 「被删行的 parent」—— 明明有一行活的同名行可以指,引用被错误地拽走,对话树断开。
// 修复后期望:重指优先指向仍存活的同名行;只有同名行全灭才沿 parent 链上溯。
// Run: node tests/acceptance/r26/g8-duplicate-uuid-relink.mjs
import assert from 'node:assert/strict';
import { repairOfficialCompat } from '../../../server/utils/session-repair.js';

const lines = [
  JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, message: { content: [{ type: 'text', text: '问题' }] } }),
  // a1 第一次出现:空 text 块 → 会被 R1/R3 删掉
  JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { content: [{ type: 'text', text: '' }] } }),
  // a1 第二次出现:同 uuid 但内容真实 → 存活
  JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { content: [{ type: 'text', text: '真正的回答' }] } }),
  // 追问指向 a1:修复后必须仍指向活着的 a1,而不是被拽到 u1
  JSON.stringify({ type: 'user', uuid: 'u2', parentUuid: 'a1', message: { content: [{ type: 'text', text: '追问' }] } }),
];

const { lines: out, report } = repairOfficialCompat(lines);

assert.equal(report.droppedLines, 1, 'G8 夹具:空行被删一条');
assert.equal(out.length, 3, 'G8 夹具:存活三行');

const alive = out.map((l) => JSON.parse(l));
const dup = alive.find((o) => o.uuid === 'a1');
assert.ok(dup, 'G8: 存活的同名行 a1 必须在');
assert.equal(dup.message.content[0].text, '真正的回答', 'G8: 存活的是有真内容的那条');

// 核心断言(修前必红):追问仍指向活着的 a1,不被拽到死行的 parent(u1)
const follow = alive.find((o) => o.uuid === 'u2');
assert.equal(follow.parentUuid, 'a1',
  `G8: 同 uuid 有存活行时,引用被错误重指到了被删行的 parent(实际 ${follow.parentUuid})—— 对话树被接断`);

// 反向钉:同名行全灭时,沿 parent 链上溯的接骨仍是正确行为(不许因本修复坏掉)
{
  const orphan = repairOfficialCompat([
    JSON.stringify({ type: 'user', uuid: 'p', parentUuid: null, message: { content: [{ type: 'text', text: 'x' }] } }),
    JSON.stringify({ type: 'assistant', uuid: 'dead', parentUuid: 'p', message: { content: [{ type: 'text', text: '  ' }] } }),
    JSON.stringify({ type: 'user', uuid: 'c', parentUuid: 'dead', message: { content: [{ type: 'text', text: 'y' }] } }),
  ]);
  const c = orphan.lines.map((l) => JSON.parse(l)).find((o) => o.uuid === 'c');
  assert.equal(c.parentUuid, 'p', 'G8: 同名行全灭时仍上溯到被删行的 parent(既有正确接骨)');
}

console.log('PASS r26-g8-duplicate-uuid-relink');
