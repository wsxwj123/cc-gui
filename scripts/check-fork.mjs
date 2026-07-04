#!/usr/bin/env node
// 分叉截断逻辑自检:upToUuid 锚点须纳入锚点回合全部内容(tool_result+末条 assistant)、
// 停在下一个真·用户提问之前,不留悬空 tool_use。覆盖:整会话/回合中段锚点/用户提问锚点/
// 末回合/缺锚点/首提问边界。
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forkJsonl } from '../server/routes/fork.js';

const dir = mkdtempSync(join(tmpdir(), 'forktest-'));
const src = join(dir, 'a.jsonl');

// Q1 → A1(plain) → Q2 → A2a(tool_use) → toolResult → A2b(final) → Q3 → A3
const lines = [
  { type: 'user', uuid: 'u1', sessionId: 'OLD', message: { content: [{ type: 'text', text: 'Q1' }] } },
  { type: 'assistant', uuid: 'a1', sessionId: 'OLD', message: { content: [{ type: 'text', text: 'A1' }] } },
  { type: 'user', uuid: 'u2', sessionId: 'OLD', message: { content: [{ type: 'text', text: 'Q2' }] } },
  { type: 'assistant', uuid: 'a2a', sessionId: 'OLD', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read' }] } },
  { type: 'user', uuid: 'r1', sessionId: 'OLD', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file' }] } },
  { type: 'assistant', uuid: 'a2b', sessionId: 'OLD', message: { content: [{ type: 'text', text: 'A2 final' }] } },
  { type: 'user', uuid: 'u3', sessionId: 'OLD', message: { content: [{ type: 'text', text: 'Q3' }] } },
  { type: 'assistant', uuid: 'a3', sessionId: 'OLD', message: { content: [{ type: 'text', text: 'A3' }] } },
];
writeFileSync(src, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

const uuidsIn = (f) => readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).uuid);
const allNew = (f) => readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).every((l) => JSON.parse(l).sessionId === 'NEW');

let n, dest, got;

// 1) 无锚点 → 整会话复制 + sessionId 改写
dest = join(dir, 'whole.jsonl');
n = await forkJsonl(src, dest, 'OLD', 'NEW', null);
assert.equal(uuidsIn(dest).length, 8, 'whole: 8 lines');
assert.ok(allNew(dest), 'whole: sessionId rewritten');
assert.equal(n, 8, 'whole: return count');

// 2) 锚点在回合首条 assistant a2a → 必含 tool_result r1 + 末条 a2b,停在 Q3 前
dest = join(dir, 'a2a.jsonl');
await forkJsonl(src, dest, 'OLD', 'NEW', 'a2a');
got = uuidsIn(dest);
assert.deepEqual(got, ['u1', 'a1', 'u2', 'a2a', 'r1', 'a2b'], 'a2a: through full turn, no dangling');

// 3) 锚点在用户提问 u2 → 含其完整回答,停在 Q3 前
dest = join(dir, 'u2.jsonl');
await forkJsonl(src, dest, 'OLD', 'NEW', 'u2');
assert.deepEqual(uuidsIn(dest), ['u1', 'a1', 'u2', 'a2a', 'r1', 'a2b'], 'u2: through its answer');

// 4) 锚点在末回合 a3 → 无后续提问 → 整会话
dest = join(dir, 'a3.jsonl');
await forkJsonl(src, dest, 'OLD', 'NEW', 'a3');
assert.equal(uuidsIn(dest).length, 8, 'a3: whole');

// 5) 锚点不存在 → 返回 0(端点转 404)
dest = join(dir, 'none.jsonl');
n = await forkJsonl(src, dest, 'OLD', 'NEW', 'nope');
assert.equal(n, 0, 'missing anchor: 0');

// 6) 锚点在首条 Q1 → 只 Q1+A1,停在 Q2 前
dest = join(dir, 'u1.jsonl');
await forkJsonl(src, dest, 'OLD', 'NEW', 'u1');
assert.deepEqual(uuidsIn(dest), ['u1', 'a1'], 'u1: Q1+A1 only');

rmSync(dir, { recursive: true, force: true });
console.log('check-fork: all assertions passed');
