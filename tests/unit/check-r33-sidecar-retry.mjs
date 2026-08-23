#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  ATTACHMENT_SIDECAR_OUTBOX_KEY,
  MAX_PERSISTED_ATTACHMENT_PREVIEW_CHARS,
  createAttachmentSidecarOutbox,
} from '../../client/src/utils/attachments.js';

class MemoryStorage {
  constructor(limit = Infinity) {
    this.limit = limit;
    this.values = new Map();
  }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) {
    if (String(value).length > this.limit) throw new Error('QuotaExceededError');
    this.values.set(key, String(value));
  }
}

const image = (name, preview = null) => ({
  kind: 'image', name, path: `/tmp/${name}`, bytes: 4 * 1024 * 1024, preview,
});
const payload = (name, preview = null) => ({
  text: `请查看附件\n\n附件:\n@/tmp/${name}`,
  displayText: `查看 ${name}`,
  attachments: [image(name, preview)],
});

// 连续 503 后组件“卸载”：新 manager 只凭同一 storage 恢复，成功后才清账。
const restartStorage = new MemoryStorage();
let failures = 0;
const failing = createAttachmentSidecarOutbox({
  storage: restartStorage,
  fetchImpl: async () => { failures += 1; return { ok: false, status: 503 }; },
  now: () => 100,
});
const stagedFailure = await failing.stageAndFlush({ sessionId: 'real-a', payload: payload('a.png') });
assert.deepEqual({ ok: stagedFailure.ok, retained: stagedFailure.retained, error: stagedFailure.error },
  { ok: false, retained: true, error: 'http' }, '真实 session 非2xx 必须明确失败且已持久保留');
await failing.flushSession('real-a');
await failing.flushSession('real-a');
assert.equal(failures, 3, '连续三次 503 均不清 outbox');
assert.equal(failing.read().length, 1);

let recoveredBody = null;
const afterRestart = createAttachmentSidecarOutbox({
  storage: restartStorage,
  fetchImpl: async (url, init) => {
    assert.equal(url, '/api/sessions/real-a/attachments');
    recoveredBody = JSON.parse(init.body);
    return { ok: true, status: 200 };
  },
});
assert.equal((await afterRestart.flushAll()).ok, true, '新实例挂载可恢复并重试');
assert.deepEqual(recoveredBody, payload('a.png'));
assert.equal(afterRestart.read().length, 0, '仅 2xx 后清除持久条目');

// draft 先持久，拿到真实 sid 后绑定并发送；ownerKey 是迁移索引，不依赖组件 ref。
const draftStorage = new MemoryStorage();
let draftUrl = '';
const draftOutbox = createAttachmentSidecarOutbox({
  storage: draftStorage,
  fetchImpl: async (url) => { draftUrl = url; return { ok: true }; },
});
assert.equal((await draftOutbox.stage({ ownerKey: 'draft-project-d1', payload: payload('draft.png') })).ok, true);
assert.equal(draftOutbox.read()[0].sessionId, null);
assert.equal((await draftOutbox.bindAndFlush('draft-project-d1', 'real-draft')).ok, true);
assert.equal(draftUrl, '/api/sessions/real-draft/attachments');
assert.equal(draftOutbox.read().length, 0);

// 同 session 串行；不同 session 可并行。每次成功删除都读最新快照，不覆盖并发条目。
const concurrentStorage = new MemoryStorage();
let activeA = 0;
let maxActiveA = 0;
let releaseFirstA;
const firstAGate = new Promise((resolve) => { releaseFirstA = resolve; });
const posted = [];
const concurrent = createAttachmentSidecarOutbox({
  storage: concurrentStorage,
  fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body);
    posted.push([url, body.displayText]);
    if (url.includes('/session-a/')) {
      activeA += 1;
      maxActiveA = Math.max(maxActiveA, activeA);
      if (body.displayText === '查看 one.png') await firstAGate;
      activeA -= 1;
    }
    return { ok: true };
  },
  now: (() => { let n = 200; return () => ++n; })(),
});
await Promise.all([
  concurrent.stage({ sessionId: 'session-a', payload: payload('one.png') }),
  concurrent.stage({ sessionId: 'session-a', payload: payload('two.png') }),
  concurrent.stage({ sessionId: 'session-b', payload: payload('three.png') }),
]);
const flushA1 = concurrent.flushSession('session-a');
const flushA2 = concurrent.flushSession('session-a');
const flushB = concurrent.flushSession('session-b');
await new Promise((resolve) => setTimeout(resolve, 0));
assert.ok(posted.some(([url]) => url.includes('/session-b/')), '另一 session 不被 A 的网络等待阻塞');
releaseFirstA();
await Promise.all([flushA1, flushA2, flushB]);
assert.equal(maxActiveA, 1, '同 session 始终串行 POST');
assert.equal(concurrent.read().length, 0, '两项/两 session 全部清除且无读改写覆盖');

// 4MiB Base64 preview 不可进入 outbox；恢复关键字段保持完整。
const hugePreview = `data:image/png;base64,${Buffer.alloc(4 * 1024 * 1024).toString('base64')}`;
const boundedStorage = new MemoryStorage(200 * 1024);
const bounded = createAttachmentSidecarOutbox({ storage: boundedStorage, fetchImpl: async () => ({ ok: false, status: 503 }) });
const boundedResult = await bounded.stage({ sessionId: 'bounded', payload: payload('huge.png', hugePreview) });
assert.equal(boundedResult.ok, true, '4MiB图片元数据可在有界quota内持久化');
const boundedEntry = bounded.read()[0];
assert.equal(boundedEntry.payload.attachments[0].preview, null);
assert.deepEqual(
  Object.fromEntries(['kind', 'name', 'path', 'bytes'].map((key) => [key, boundedEntry.payload.attachments[0][key]])),
  Object.fromEntries(['kind', 'name', 'path', 'bytes'].map((key) => [key, image('huge.png', hugePreview)[key]])),
);
assert.equal(boundedEntry.payload.displayText, '查看 huge.png');
assert.ok((boundedStorage.getItem(ATTACHMENT_SIDECAR_OUTBOX_KEY) || '').length < MAX_PERSISTED_ATTACHMENT_PREVIEW_CHARS + 2048,
  '持久快照有明确上限，不含完整 Base64');

// quota 在连最小元数据都写不下时必须返回“未保留”，供 UI 显式告警。
const quotaStorage = new MemoryStorage(8);
const quota = createAttachmentSidecarOutbox({ storage: quotaStorage });
const quotaResult = await quota.stage({ sessionId: 'quota', payload: payload('q.png') });
assert.deepEqual({ ok: quotaResult.ok, retained: quotaResult.retained, error: quotaResult.error },
  { ok: false, retained: false, error: 'persist-failed' });
assert.equal(quotaStorage.getItem(ATTACHMENT_SIDECAR_OUTBOX_KEY), null);

console.log('✓ check-r33-sidecar-retry: 持久恢复、503保留、串行并发、quota与大preview边界全过');
