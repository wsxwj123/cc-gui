#!/usr/bin/env node
import assert from 'node:assert/strict';
import { flushPendingAttachmentSidecar } from '../../client/src/utils/attachments.js';

const payload = {
  text: '请查看附件\n\n附件:\n@/tmp/a.png',
  displayText: '',
  attachments: [{ kind: 'image', name: 'a.png', path: '/tmp/a.png', bytes: 123, preview: null }],
};
const pendingRef = { current: payload };
let calls = 0;
const fetchImpl = async (url, init) => {
  calls += 1;
  assert.equal(url, '/api/sessions/session-real/attachments');
  assert.equal(init.method, 'POST');
  assert.deepEqual(JSON.parse(init.body), payload);
  return { ok: calls > 1, status: calls > 1 ? 200 : 503 };
};

assert.equal(await flushPendingAttachmentSidecar(pendingRef, 'session-real', { fetchImpl }), false,
  '非2xx 明确失败');
assert.equal(pendingRef.current, payload, '失败保留原 payload 可重试');
assert.equal(await flushPendingAttachmentSidecar(pendingRef, 'session-real', { fetchImpl }), true,
  '下一次重试成功');
assert.equal(pendingRef.current, null, '仅成功后清 pending');

const newer = { ...payload, text: '更新载荷' };
const racingRef = { current: payload };
assert.equal(await flushPendingAttachmentSidecar(racingRef, 'session-real', {
  fetchImpl: async () => { racingRef.current = newer; return { ok: true }; },
}), true);
assert.equal(racingRef.current, newer, '在途更新不能被旧请求成功响应误清');

const offlineRef = { current: payload };
assert.equal(await flushPendingAttachmentSidecar(offlineRef, 'session-real', {
  fetchImpl: async () => { throw new Error('offline'); },
}), false);
assert.equal(offlineRef.current, payload, '网络异常同样保留');
assert.equal(await flushPendingAttachmentSidecar(offlineRef, '', { fetchImpl }), false, '无真实 session 不发送');

console.log('✓ check-r33-sidecar-retry: 非2xx/断网保留 + 重试成功清除 + 在途更新保护全过');
