// R13 SSE stream and stop contract: cursors, replay identity, and "stop is explicit and
// identity-checked; watching from somewhere else never stops anything".
import { test, expect } from '@playwright/test';
import {
  expectJsonError,
  fixtureSection,
  getRuntime,
  isTerminalEvent,
  postStop,
  readStream,
  requireModel,
  startFixtureRun,
  uniqueId,
} from './helpers/sb-runtime.mjs';

const STATUS_ENUM = ['running', 'stopping', 'completed', 'failed', 'stopped'];
const TERMINAL_STATUS = ['completed', 'failed', 'stopped'];

async function startFixtureTurn(request, baseURL) {
  requireModel();
  const flow = fixtureSection('sessionFlow');
  const run = await startFixtureRun(request, baseURL, { sessionId: flow.sessionASid });
  return { flow, run };
}

async function readUntilTerminal(baseURL, pid, params = {}, timeoutMs = 25_000) {
  const result = await readStream(baseURL, pid, { params, timeoutMs, stopWhen: isTerminalEvent });
  expect(result.status, `stream for ${pid}: ${result.status} ${JSON.stringify(result.body)?.slice(0, 120)}`).toBe(200);
  expect(
    result.events.some(isTerminalEvent),
    `run ${pid} must reach a terminal stream event within ${timeoutMs}ms (use a trivial fixture prompt)`,
  ).toBe(true);
  return result;
}

test('SB-T15 打开不存在 pid 的 stream：404 且错误体为 ok:false 合同', async ({ request }) => {
  const { baseURL } = getRuntime();
  const pid = `sb_missing_pid_${uniqueId('x')}`;

  const result = await readStream(baseURL, pid, { params: { afterSeq: 0 }, timeoutMs: 8_000 });

  expect(result.status).toBe(404);
  expect(result.body, 'a 404 stream must answer with JSON, not an event stream').toBeTruthy();
  expect(result.body.ok).toBe(false);
  expect(typeof result.body.error).toBe('string');
  expect(result.body.error.length).toBeLessThanOrEqual(300);
});

test('SB-T16 停止从未存在的 pid：404 RUN_NOT_FOUND', async ({ request }) => {
  const { baseURL } = getRuntime();
  const pid = `sb_missing_pid_${uniqueId('x')}`;

  const result = await postStop(request, baseURL, pid, { owner: 'sb_owner_none', clientTurnId: uniqueId('sb_t16') });

  expectJsonError(result, { status: 404, code: 'RUN_NOT_FOUND' });
});

for (const [id, value, label] of [
  ['SB-T17', -1, '负数'],
  ['SB-T18', 1.5, '非整数'],
  ['SB-T19', Number.MAX_SAFE_INTEGER + 1, '超安全整数'],
  ['SB-T20', 'abc', '非数字'],
]) {
  test(`${id} afterSeq 为${label}：400 STREAM_INVALID_CURSOR`, async ({ request }) => {
    const { baseURL } = getRuntime();
    const { run } = await startFixtureTurn(request, baseURL);

    const result = await readStream(baseURL, run.pid, { params: { afterSeq: value }, timeoutMs: 8_000 });

    expect(result.status, `afterSeq=${String(value)} body: ${JSON.stringify(result.body)?.slice(0, 160)}`).toBe(400);
    expect(result.body?.ok).toBe(false);
    expect(result.body?.code).toBe('STREAM_INVALID_CURSOR');
    expect(result.contentType, 'an invalid cursor must not open an event stream').not.toMatch(/text\/event-stream/i);
  });
}

test('SB-T21 afterSeq=0 合法：只回 seq 大于游标的事件', async ({ request }) => {
  const { baseURL } = getRuntime();
  const { run } = await startFixtureTurn(request, baseURL);

  const full = await readUntilTerminal(baseURL, run.pid, { afterSeq: 0 });
  const seqs = [...new Set(full.events.map(event => event.seq).filter(Number.isInteger))].sort((a, b) => a - b);
  expect(seqs.length, 'a live run must emit sequenced events').toBeGreaterThan(0);
  expect(seqs[0], 'afterSeq=0 is legal and excludes nothing at or below 0').toBeGreaterThan(0);

  if (seqs.length >= 2) {
    const cursor = seqs[seqs.length - 2];
    const resumed = await readStream(baseURL, run.pid, { params: { afterSeq: cursor }, timeoutMs: 10_000, stopWhen: isTerminalEvent });
    expect(resumed.status, `resume body: ${JSON.stringify(resumed.body)?.slice(0, 160)}`).toBe(200);
    for (const event of resumed.events) {
      if (Number.isInteger(event.seq)) {
        expect(event.seq, `afterSeq=${cursor} must not replay seq ${event.seq}`).toBeGreaterThan(cursor);
      }
    }
  }
});

test('SB-T22 游标超过 lastSeq：409 STREAM_CURSOR_AHEAD', async ({ request }) => {
  const { baseURL } = getRuntime();
  const { run } = await startFixtureTurn(request, baseURL);
  const full = await readUntilTerminal(baseURL, run.pid, {});
  const maxSeq = Math.max(...full.events.map(event => event.seq).filter(Number.isInteger), 0);

  const result = await readStream(baseURL, run.pid, { params: { afterSeq: maxSeq + 100_000 }, timeoutMs: 8_000 });

  expect(result.status, `future cursor body: ${JSON.stringify(result.body)?.slice(0, 160)}`).toBe(409);
  expect(result.body?.ok).toBe(false);
  expect(result.body?.code).toBe('STREAM_CURSOR_AHEAD');
});

test('SB-T23 携带别的 runId：409 RUN_STALE', async ({ request }) => {
  const { baseURL } = getRuntime();
  const { run } = await startFixtureTurn(request, baseURL);

  const result = await readStream(baseURL, run.pid, {
    params: { afterSeq: 0, runId: `sb_wrong_run_${uniqueId('x')}` },
    timeoutMs: 8_000,
  });

  expect(result.status, `wrong runId body: ${JSON.stringify(result.body)?.slice(0, 160)}`).toBe(409);
  expect(result.body?.ok).toBe(false);
  expect(result.body?.code).toBe('RUN_STALE');
});

test('SB-T24 流事件携带 runId 与单调 seq，SSE id 为 runId:seq，终态只出现一次', async ({ request }) => {
  const { baseURL } = getRuntime();
  const { run } = await startFixtureTurn(request, baseURL);

  const stream = await readUntilTerminal(baseURL, run.pid, { afterSeq: 0 });
  const sequenced = stream.events.filter(event => Number.isInteger(event.seq));

  expect(sequenced.length, 'every stream event must carry a monotonic seq').toBe(stream.events.length);
  for (const event of stream.events) {
    expect(typeof event.runId, `event without runId: ${event.raw}`).toBe('string');
    expect(event.id, `SSE id must be runId:seq, got ${event.id}`).toBe(`${event.runId}:${event.seq}`);
  }
  const seqs = stream.events.map(event => event.seq);
  for (let i = 1; i < seqs.length; i += 1) {
    expect(seqs[i], `seq must increase monotonically: ${seqs.join(',')}`).toBeGreaterThan(seqs[i - 1]);
  }
  expect(stream.events.filter(isTerminalEvent).length, 'one terminal state per connection').toBe(1);
});

test('SB-T25 用正确 owner/clientTurnId 停止：200 且状态取自枚举', async ({ request }) => {
  const { baseURL } = getRuntime();
  const { flow, run } = await startFixtureTurn(request, baseURL);

  const result = await postStop(request, baseURL, run.pid, { owner: flow.sessionASid, clientTurnId: run.clientTurnId });

  expect(result.status, `stop body: ${JSON.stringify(result.body)?.slice(0, 200)}`).toBe(200);
  expect(result.body?.ok).toBe(true);
  expect(String(result.body?.pid)).toBe(run.pid);
  expect(JSON.stringify(result.body?.owner), 'stop must report the owning identity it acted on').toContain(flow.sessionASid);
  expect(STATUS_ENUM, `status ${result.body?.status} must come from the documented enum`).toContain(result.body?.status);
  expect(typeof result.body?.stopped).toBe('boolean');
  if (result.body.stopped === false) {
    expect(TERMINAL_STATUS, 'a 200 without a fresh stop must report a real terminal state').toContain(result.body.status);
  }
});

test('SB-T26 重复停止同一运行：200 stopped:false 且仍是该 pid 的真实终态', async ({ request }) => {
  const { baseURL } = getRuntime();
  const { flow, run } = await startFixtureTurn(request, baseURL);
  const stopPayload = { owner: flow.sessionASid, clientTurnId: run.clientTurnId };

  const first = await postStop(request, baseURL, run.pid, stopPayload);
  expect(first.status, `first stop body: ${JSON.stringify(first.body)?.slice(0, 200)}`).toBe(200);

  const second = await postStop(request, baseURL, run.pid, stopPayload);

  expect(second.status, `repeat stop body: ${JSON.stringify(second.body)?.slice(0, 200)}`).toBe(200);
  expect(second.body?.ok).toBe(true);
  expect(second.body?.stopped, 'a repeat stop must not claim a fresh stop').toBe(false);
  expect(TERMINAL_STATUS, 'repeat stop reports the real terminal status').toContain(second.body?.status);
  expect(String(second.body?.pid), 'a repeat stop must not address another process').toBe(run.pid);
});

test('SB-T27 停止时 clientTurnId 不匹配：409 RUN_STALE，不宣称已停止', async ({ request }) => {
  const { baseURL } = getRuntime();
  const { flow, run } = await startFixtureTurn(request, baseURL);

  const result = await postStop(request, baseURL, run.pid, {
    owner: flow.sessionASid,
    clientTurnId: uniqueId('sb_wrong_turn'),
  });

  expectJsonError(result, { status: 409, code: 'RUN_STALE' });
  expect(result.body.stopped, 'a rejected stop must not report a stop').toBeUndefined();
  expect(result.body.status, 'a rejected stop must not report a status').toBeUndefined();
});
