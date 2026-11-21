#!/usr/bin/env node
// r207 自检:历史读取超时按进展算(utils/history-read-deadline.js)。计时规则用缩短的时长验证
// (停顿 300ms、兜底 1500ms;正式值 15 秒 / 120 秒 / 64KB 另行钉住),再用真路由确认接线没断。
//   - 一直有进展:超过停顿时长很多倍也不超时;停顿满时长才超时;总时长兜底;
//   - 非普通文件 / 还没确认文件类型:进展不算 = 硬超时;不足 64KB 且没换步的不算进展;
//   - 超时只触发一次,之后的进展 / 收尾都不再有效果;收尾后不再触发;没有未处理的拒绝;
//   - 真路由:普通会话 200 且体与直接读取相同;getSessionMessages 回报的进展事件形状与计时规则对得上。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'cgui-r207-timeout-')));
const HOME = join(TMP, 'home');
process.env.HOME = HOME; process.env.USERPROFILE = HOME; process.env.CGUI_DISABLE_FILE_WATCHER = '1';
const PROJECT = '-tmp-r207-timeout';
mkdirSync(join(HOME, '.claude', 'projects', PROJECT), { recursive: true });

const {
  startHistoryReadDeadline, HISTORY_STALL_MS, HISTORY_TOTAL_MS, HISTORY_PROGRESS_MIN_BYTES,
} = await import('../../server/utils/history-read-deadline.js');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed += 1; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(e));

ok(HISTORY_STALL_MS === 15_000 && HISTORY_TOTAL_MS === 120_000 && HISTORY_PROGRESS_MIN_BYTES === 64 * 1024, '正式值:停顿 15 秒、兜底 120 秒、进展 64KB');

const STALL = 300;
const TOTAL = 1500;
const KB = 1024;
// 起一个计时器,按 plan 喂进展事件;返回 { firedAt(相对起点 ms,没触发为 null), fires }
async function run(plan, { runFor }) {
  const t0 = Date.now();
  let firedAt = null;
  let fires = 0;
  const d = startHistoryReadDeadline(() => { fires += 1; if (firedAt === null) firedAt = Date.now() - t0; }, { stallMs: STALL, totalMs: TOTAL });
  for (const step of plan) {
    await wait(step.after);
    d.progress(step.event);
  }
  const rest = runFor - (Date.now() - t0);
  if (rest > 0) await wait(rest);
  d.clear();
  return { firedAt, fires, d };
}
const open = (regularFile = true) => ({ after: 0, event: { step: 'open', regularFile, bytes: 0 } });
const reads = (n, every, perStep = 100 * KB, from = 0) => Array.from({ length: n }, (_, i) => ({ after: every, event: { step: 'read', bytes: from + (i + 1) * perStep } }));

{
  const r = await run([open(), ...reads(10, 100)], { runFor: 1100 });
  ok(r.firedAt === null, `一直有进展(每 100ms 读 100KB,共 1.1 秒 = 停顿时长的 3 倍多)不超时(实际 ${r.firedAt})`);
}
{
  const r = await run([open(), ...reads(4, 100)], { runFor: 1200 });
  ok(r.firedAt !== null && r.firedAt >= 400 + STALL - 30 && r.firedAt < 400 + STALL + 250, `最后一次进展后停顿满 ${STALL}ms 才超时(实际 ${r.firedAt}ms)`);
  ok(r.fires === 1, '只触发一次');
}
{
  const r = await run([open(), ...reads(19, 100)], { runFor: 2000 });
  ok(r.firedAt !== null && r.firedAt >= TOTAL - 30 && r.firedAt < TOTAL + 250, `一直有进展也在总时长 ${TOTAL}ms 兜底(实际 ${r.firedAt}ms)`);
}
{
  const r = await run([open(false), ...reads(8, 100)], { runFor: 1000 });
  ok(r.firedAt !== null && r.firedAt < STALL + 250, `非普通文件:进展不算,${STALL}ms 硬超时(实际 ${r.firedAt}ms)`);
}
{
  const r = await run(reads(8, 100), { runFor: 1000 });
  ok(r.firedAt !== null && r.firedAt < STALL + 250, `还没确认是普通文件:同样硬超时(实际 ${r.firedAt}ms)`);
}
{
  const r = await run([open(), ...reads(8, 100, 10 * KB)], { runFor: 1000 });
  ok(r.firedAt !== null && r.firedAt >= STALL - 30 && r.firedAt < STALL + 250, `每次只多 10KB、步骤不变:不算进展(实际 ${r.firedAt}ms)`);
}
{
  const steps = ['read', 'sidecar', 'assemble', 'subagents', 'page'].map((step) => ({ after: 200, event: { step } }));
  const r = await run([open(), ...steps], { runFor: 1700 });
  ok(r.firedAt !== null && r.firedAt >= 1000 + STALL - 30 && r.firedAt < TOTAL + 250, `进入新的一步算进展(每 200ms 换一步,共五步;实际 ${r.firedAt}ms)`);
}
{
  // 超时之后:再来进展、再收尾都没有效果,也不会再触发
  let fires = 0;
  const d = startHistoryReadDeadline(() => { fires += 1; }, { stallMs: 100, totalMs: 1000 });
  d.progress({ step: 'open', regularFile: true });
  await wait(250);
  d.progress({ step: 'read', bytes: 10 * 1024 * 1024 });
  await wait(250);
  d.clear();
  ok(fires === 1, '超时后再报进展不会续命、不会再触发');
  // 收尾之后不触发
  let fired2 = 0;
  const d2 = startHistoryReadDeadline(() => { fired2 += 1; }, { stallMs: 100, totalMs: 200 });
  d2.clear();
  d2.progress({ step: 'open', regularFile: true });
  await wait(300);
  ok(fired2 === 0, '收尾之后不触发');
  d2.progress(null); d2.progress(undefined); d2.progress('x');   // 坏事件不抛
  passed += 1;
}

// ── 真路由接线:普通会话照常 200;读取回报的进展能让计时器续命 ─────────────────────────
{
  const express = (await import('express')).default;
  const { default: sessionsRouter } = await import('../../server/routes/sessions.js');
  const { getSessionMessages } = await import('../../server/services/session-reader.js');
  const sid = '20720720-0000-4000-8000-0000000000c1';
  const lines = [];
  for (let i = 0; i < 40; i++) {
    lines.push({ type: 'user', uuid: `u${i}`, timestamp: new Date(1_790_000_000_000 + i * 2000).toISOString(), message: { role: 'user', content: `问${i} ${'字'.repeat(4000)}` } });
    lines.push({ type: 'assistant', uuid: `a${i}`, timestamp: new Date(1_790_000_000_000 + i * 2000 + 1000).toISOString(),
      message: { id: `m${i}`, role: 'assistant', model: 'r207', content: [{ type: 'text', text: `答${i}` }], usage: { input_tokens: 1, output_tokens: 1 } } });
  }
  writeFileSync(join(HOME, '.claude', 'projects', PROJECT, `${sid}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  const app = express();
  app.use('/api', sessionsRouter);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const resp = await fetch(`${base}/sessions/${sid}/messages?projectHash=${PROJECT}&limit=120`);
    ok(resp.status === 200, '普通会话 200');
    const body = await resp.json();
    const direct = await getSessionMessages(sid, PROJECT, { limit: 120 });
    assert.deepEqual(body, JSON.parse(JSON.stringify(direct)), '路由返回与直接读取相同'); passed += 1;
    // 读取回报的事件喂给计时器:第一条 open(普通文件),之后每一步都算进展
    const events = [];
    await getSessionMessages(sid, PROJECT, { limit: 120, onProgress: (e) => events.push(e) });
    let fires = 0;
    const d = startHistoryReadDeadline(() => { fires += 1; }, { stallMs: 150, totalMs: 5000 });
    for (const e of events) { d.progress(e); await wait(100); }
    d.clear();
    ok(events.length >= 6 && fires === 0, `读取回报 ${events.length} 次进展,每次间隔 100ms(< 停顿 150ms)不超时`);
    ok(events.filter((e) => e.step === 'read').every((e) => e.bytes > 0), 'read 事件带累计字节');
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

await wait(100);
assert.deepEqual(unhandled, [], '没有未处理的 Promise 拒绝'); passed += 1;
console.log(`check-r207-history-timeout: OK (${passed} assertions)`);
