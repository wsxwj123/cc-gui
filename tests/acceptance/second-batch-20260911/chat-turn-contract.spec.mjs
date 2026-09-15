// R13 turn identity on POST /api/chat: one canonical turn per
// (auth principal, serverEpoch, clientTurnId); illegal input is rejected before any CLI starts.
import { test, expect } from '@playwright/test';
import {
  chatPayload,
  expectJsonError,
  fixtureSection,
  getHealth,
  getRuntime,
  pollMessages,
  postChat,
  messagesWithMarker,
  requireModel,
  uniqueId,
} from './helpers/sb-runtime.mjs';

const OVERSIZED_BODY_BYTES = 16 * 1024 * 1024; // see README: assumed well above the existing chat body limit

test('SB-T01 空 prompt：400 CHAT_INVALID_INPUT，且不启动任何运行', async ({ request }) => {
  const { baseURL } = getRuntime();
  const payload = await chatPayload(request, baseURL, { prompt: '', clientTurnId: uniqueId('sb_t01') });

  const result = await postChat(request, baseURL, payload);

  expectJsonError(result, { status: 400, code: 'CHAT_INVALID_INPUT' });
  expect(result.body.pid, 'a rejected request must not start a turn').toBeUndefined();
});

test('SB-T02 纯空白 prompt：400 CHAT_INVALID_INPUT', async ({ request }) => {
  const { baseURL } = getRuntime();
  const payload = await chatPayload(request, baseURL, { prompt: '  \n\t  ', clientTurnId: uniqueId('sb_t02') });

  const result = await postChat(request, baseURL, payload);

  expectJsonError(result, { status: 400, code: 'CHAT_INVALID_INPUT' });
  expect(result.body.pid, 'a rejected request must not start a turn').toBeUndefined();
});

test('SB-T03 clientTurnId 超过 64 位：400 CHAT_INVALID_INPUT', async ({ request }) => {
  const { baseURL } = getRuntime();
  const payload = await chatPayload(request, baseURL, { clientTurnId: 'a'.repeat(65) });

  const result = await postChat(request, baseURL, payload);

  expectJsonError(result, { status: 400, code: 'CHAT_INVALID_INPUT' });
  expect(result.body.pid, 'a rejected request must not start a turn').toBeUndefined();
});

test('SB-T04 clientTurnId 含非法字符：400 CHAT_INVALID_INPUT', async ({ request }) => {
  const { baseURL } = getRuntime();
  const payload = await chatPayload(request, baseURL, { clientTurnId: 'sb t04!中文' });

  const result = await postChat(request, baseURL, payload);

  expectJsonError(result, { status: 400, code: 'CHAT_INVALID_INPUT' });
  expect(result.body.pid, 'a rejected request must not start a turn').toBeUndefined();
});

test('SB-T05 缺 cwd：400 且错误体为稳定短码（不启动运行）', async ({ request }) => {
  const { baseURL } = getRuntime();
  const payload = await chatPayload(request, baseURL, { clientTurnId: uniqueId('sb_t05') });
  delete payload.cwd;

  const result = await postChat(request, baseURL, payload);

  // INTERFACE fixes the 400 but not the code for a missing cwd; require a stable code string.
  expectJsonError(result, { status: 400 });
  expect(result.body.pid, 'a rejected request must not start a turn').toBeUndefined();
});

test('SB-T06 prompt 非字符串：400 且不启动运行', async ({ request }) => {
  const { baseURL } = getRuntime();
  const payload = await chatPayload(request, baseURL, { prompt: 20260911, clientTurnId: uniqueId('sb_t06') });

  const result = await postChat(request, baseURL, payload);

  expectJsonError(result, { status: 400 });
  expect(result.body.pid, 'a rejected request must not start a turn').toBeUndefined();
});

test('SB-T07 createdAt 是未来时刻：400 且不启动运行', async ({ request }) => {
  const { baseURL } = getRuntime();
  const future = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
  const payload = await chatPayload(request, baseURL, { clientTurnId: uniqueId('sb_t07'), createdAt: future });

  const result = await postChat(request, baseURL, payload);

  expectJsonError(result, { status: 400 });
  expect(result.body.pid, 'a future createdAt must not start a turn').toBeUndefined();
});

test('SB-T08 createdAt 超出 24h 窗口：409 TURN_EXPIRED，不当作新 turn 发送', async ({ request }) => {
  const { baseURL } = getRuntime();
  const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  const payload = await chatPayload(request, baseURL, { clientTurnId: uniqueId('sb_t08'), createdAt: stale });

  const result = await postChat(request, baseURL, payload);

  expectJsonError(result, { status: 409, code: 'TURN_EXPIRED' });
  expect(result.body.pid, 'an expired turn must not be silently re-sent as a new turn').toBeUndefined();
});

test('SB-T09 GET /api/health 公布稳定的 serverEpoch 服务实例标识', async ({ request }) => {
  const { baseURL } = getRuntime();

  const first = await getHealth(request, baseURL);
  const second = await getHealth(request, baseURL);

  expect(typeof first.serverEpoch, 'health must publish a serverEpoch identity').toBe('string');
  expect(first.serverEpoch.length).toBeGreaterThan(0);
  expect(first.serverEpoch.length, 'serverEpoch is an identity, not a blob').toBeLessThanOrEqual(128);
  expect(first.serverEpoch, 'no whitespace in a machine identity').not.toMatch(/\s/);
  expect(second.serverEpoch, 'serverEpoch is stable within one service instance').toBe(first.serverEpoch);
});

test('SB-T10 serverEpoch 不匹配：409 TURN_SERVER_CHANGED，旧请求不自动重发', async ({ request }) => {
  requireModel();
  const { baseURL } = getRuntime();
  const payload = await chatPayload(request, baseURL, { clientTurnId: uniqueId('sb_t10') });
  payload.serverEpoch = `sb_stale_epoch_${uniqueId('x')}`;

  const result = await postChat(request, baseURL, payload);

  expectJsonError(result, { status: 409, code: 'TURN_SERVER_CHANGED' });
  expect(result.body.pid, 'a request from a previous service instance must not start a turn').toBeUndefined();
});

test('SB-T11 同 clientTurnId 同参重发：命中同一 run，不重复送 prompt', async ({ request }) => {
  requireModel();
  const { baseURL } = getRuntime();
  const flow = fixtureSection('sessionFlow');
  const marker = uniqueId('SB_T11');
  const clientTurnId = uniqueId('sb_t11');
  const payload = await chatPayload(request, baseURL, {
    prompt: `Reply with exactly: ${marker}`,
    sessionId: flow.sessionASid,
    clientTurnId,
  });

  const first = await postChat(request, baseURL, payload);
  const second = await postChat(request, baseURL, payload);

  expect(first.status, `first POST body: ${JSON.stringify(first.body)}`).toBe(200);
  expect(second.status, `retry POST body: ${JSON.stringify(second.body)}`).toBe(200);
  expect(first.body.pid, 'first POST must return the service run identity').toBeTruthy();
  expect(second.body.pid, 'a same-identity retry must return the same run, never a second one').toBe(first.body.pid);
  if (first.body.runId !== undefined || second.body.runId !== undefined) {
    expect(second.body.runId).toBe(first.body.runId);
  }
  // delivery state must be reported so a lost response can be resolved by query, not by re-sending
  expect(
    Object.keys(second.body).some(key => /deliver|status|sent/i.test(key)),
    `POST /api/chat response must report delivery state; got keys ${Object.keys(second.body).join(',')}`,
  ).toBe(true);

  const messages = await pollMessages(
    request, baseURL, flow.sessionASid, flow.sessionAProjectHash,
    body => messagesWithMarker(body, marker).length > 0,
  );
  expect(messages.status, 'history must be readable right after the retry').toBe(200);
  expect(messagesWithMarker(messages.body, marker).length, 'one canonical turn writes exactly one message').toBe(1);
});

test('SB-T12 同 clientTurnId 异参：409 TURN_CONFLICT，不启动第二个 run', async ({ request }) => {
  requireModel();
  const { baseURL } = getRuntime();
  const flow = fixtureSection('sessionFlow');
  const clientTurnId = uniqueId('sb_t12');
  const payload = await chatPayload(request, baseURL, {
    prompt: `Reply with exactly: ${uniqueId('SB_T12_A')}`,
    sessionId: flow.sessionASid,
    clientTurnId,
  });

  const first = await postChat(request, baseURL, payload);
  expect(first.status, `first POST body: ${JSON.stringify(first.body)}`).toBe(200);

  const conflicting = await postChat(request, baseURL, { ...payload, prompt: `Reply with exactly: ${uniqueId('SB_T12_B')}` });

  expectJsonError(conflicting, { status: 409, code: 'TURN_CONFLICT' });
  expect(conflicting.body.pid, 'a conflicting parameter set must not start a second turn').toBeUndefined();
});

test('SB-T13 并发同参两个请求：合并为一个 run，历史只有一条消息', async ({ request }) => {
  requireModel();
  const { baseURL } = getRuntime();
  const flow = fixtureSection('sessionFlow');
  const marker = uniqueId('SB_T13');
  const payload = await chatPayload(request, baseURL, {
    prompt: `Reply with exactly: ${marker}`,
    sessionId: flow.sessionASid,
    clientTurnId: uniqueId('sb_t13'),
  });

  const [a, b] = await Promise.all([postChat(request, baseURL, payload), postChat(request, baseURL, payload)]);

  expect(a.status, `POST A body: ${JSON.stringify(a.body)}`).toBe(200);
  expect(b.status, `POST B body: ${JSON.stringify(b.body)}`).toBe(200);
  expect(a.body.pid, 'both responses must describe the merged run').toBeTruthy();
  expect(b.body.pid, 'concurrent same-identity requests merge instead of opening two runs').toBe(a.body.pid);

  const messages = await pollMessages(
    request, baseURL, flow.sessionASid, flow.sessionAProjectHash,
    body => messagesWithMarker(body, marker).length > 0,
  );
  expect(messages.status).toBe(200);
  expect(
    messagesWithMarker(messages.body, marker).length,
    'a merged turn must store the human message exactly once',
  ).toBe(1);
});

test('SB-T14 请求体超过既有正文上限：413 且不启动 CLI', async ({ request }) => {
  requireModel();
  const { baseURL } = getRuntime();
  const payload = await chatPayload(request, baseURL, {
    prompt: 'x'.repeat(OVERSIZED_BODY_BYTES),
    clientTurnId: uniqueId('sb_t14'),
  });

  const result = await postChat(request, baseURL, payload);

  expect(result.status, `oversized body must be 413, got ${JSON.stringify(result.body)?.slice(0, 200)}`).toBe(413);
  expect(result.body?.ok, 'oversized body uses the same ok:false envelope').toBe(false);
  expect(result.body?.pid, 'an oversized body must not start a CLI').toBeUndefined();
});
