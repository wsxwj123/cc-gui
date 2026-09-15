#!/usr/bin/env node
// 回合聚合的 usageCalls(2026-09-11 计价修正,契约 §3.4):turn 上逐条列出底层 API 调用,
// 每项 {at, usage};求和恒等于 turn.usage;同一 message.id 的流式分片按**首次出现**为准。
// 全程在临时 HOME 里跑(裸 express 挂真 server/routes/sessions.js),不碰真 ~/.claude。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const home = mkdtempSync(join(tmpdir(), 'cgui-pa-usagecalls-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

const HASH = '-Users-x-pa-usagecalls';
const SID = '55555555-5555-4555-8555-555555555555';
const projectsDir = join(home, '.claude', 'projects', HASH);
mkdirSync(projectsDir, { recursive: true });

const usage = (o) => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...o });
// 一次 API 调用在 jsonl 里拆成多条 assistant 记录(共用 message.id):
// 第一条是收尾片(input 10/output 5),第二条是同 id 的**后写分片**(数值更大 + 时间更晚)——
// "首次出现为准"与"取末条/取最大"给出不同结果,正好把口径钉死。
const records = [
  { type: 'user', uuid: 'u1', timestamp: '2026-09-11T01:00:00.000Z', message: { role: 'user', content: 'hi' } },
  {
    type: 'assistant', uuid: 'a1', timestamp: '2026-09-11T02:00:00.000Z',
    message: {
      id: 'msg_first', model: 'deepseek-flash', content: [{ type: 'text', text: '一' }],
      usage: usage({ input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 100 } }),
    },
  },
  {
    type: 'assistant', uuid: 'a1-late', timestamp: '2026-09-11T03:00:00.000Z',
    message: { id: 'msg_first', model: 'deepseek-flash', content: [{ type: 'text', text: '一' }], usage: usage({ input_tokens: 999, output_tokens: 999 }) },
  },
  {
    type: 'assistant', uuid: 'a2', timestamp: '2026-09-11T04:00:00.000Z',
    message: { id: 'msg_second', model: 'deepseek-flash', content: [{ type: 'text', text: '二' }], usage: usage({ input_tokens: 7, output_tokens: 3 }) },
  },
  {
    type: 'assistant', uuid: 'a3-zero', timestamp: '2026-09-11T05:00:00.000Z',
    message: { id: 'msg_zero', model: 'deepseek-flash', content: [{ type: 'text', text: '三' }], usage: usage({}) },
  },
];
writeFileSync(join(projectsDir, `${SID}.jsonl`), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');

const express = (await import('express')).default;
const { default: sessionRoutes } = await import(`${root}/server/routes/sessions.js`);
const app = express();
app.use(express.json());
app.use('/api', sessionRoutes);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${String((e && e.message) || e).split('\n').slice(0, 4).join('\n      ')}`); }
};

const res = await fetch(`${base}/api/sessions/${encodeURIComponent(SID)}/messages?projectHash=${encodeURIComponent(HASH)}`);
const body = await res.json();
const turn = (body.messages || []).find((m) => m.type === 'turn');

await check('turn 带 usageCalls 且一项 = 一次 API 调用(全零 usage 的不算)', () => {
  assert.ok(turn, '必须有 turn');
  assert.ok(Array.isArray(turn.usageCalls), 'turn 必须有 usageCalls');
  assert.equal(turn.usageCalls.length, 2, 'msg_first 与 msg_second 各一项');
});
await check('各条四字段之和 === turn.usage(逐字段)', () => {
  for (const field of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
    const sum = (turn.usageCalls || []).reduce((acc, call) => acc + (call.usage?.[field] || 0), 0);
    assert.equal(sum, turn.usage?.[field] ?? 0, field);
  }
});
await check('同一 message.id 取首次出现那条(不是末条/最大值)', () => {
  const first = turn.usageCalls.find((call) => call.usage.input_tokens === 10);
  assert.ok(first, '必须保留首次出现的 10');
  assert.equal(turn.usageCalls.some((call) => call.usage.input_tokens === 999), false, '不得取后写分片');
  assert.equal(turn.usage.input_tokens, 17, '汇总 = 10 + 7');
  assert.equal(Date.parse(first.at), Date.parse('2026-09-11T02:00:00.000Z'), 'at 取首次出现那条记录的时间');
});
await check('每项 at 可被 Date.parse,usage 是对象', () => {
  for (const call of turn.usageCalls) {
    assert.ok(Number.isFinite(Date.parse(call.at)), `at 不可解析:${call.at}`);
    assert.equal(typeof call.usage, 'object');
  }
});
await check('嵌套 TTL 分项随该次调用原样带出', () => {
  const first = turn.usageCalls.find((call) => call.usage.cache_creation);
  assert.equal(first.usage.cache_creation.ephemeral_5m_input_tokens, 100);
});
await check('现有字段一字不动:usage/ctxUsage 数值与旧口径一致', () => {
  assert.equal(turn.usage.input_tokens, 17);
  assert.equal(turn.usage.output_tokens, 8);
  assert.equal(turn.usage.cache_creation_input_tokens, 100);
  assert.equal(turn.ctxUsage.input_tokens, 7, 'ctxUsage = 最后一次非零调用(全零记录被跳过)');
});

server.close();
if (failed) {
  console.log(`check-pricing-usagecalls: ${failed} 项失败`);
  process.exit(1);
}
console.log('check-pricing-usagecalls: OK');
