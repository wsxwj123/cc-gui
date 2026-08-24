#!/usr/bin/env node
import assert from 'node:assert/strict';
import { attachmentMetaForPersistence, buildAttachmentMessage } from '../../client/src/utils/attachments.js';
import { buildHomeDraft, enqueueRestoredHomeDraft, homeDraftFromOrphan } from '../../client/src/utils/home.js';

class DurableStorage {
  constructor() { this.values = new Map(); this.failQueueWrites = false; this.failOrphanWrites = false; }
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) {
    if (key === 'cgui-message-queue' && this.failQueueWrites) throw new DOMException('quota', 'QuotaExceededError');
    if (key === 'cgui-orphan-draft-queues' && this.failOrphanWrites) throw new DOMException('quota', 'QuotaExceededError');
    this.values.set(key, String(value));
  }
  removeItem(key) { this.values.delete(key); }
}

const storage = new DurableStorage();
globalThis.localStorage = storage;
const orphanKey = 'draft-project-a-old';
const orphan = {
  queueId: 'q-orphan-attachment',
  text: '请查看这些附件\n\n附件:\n@/tmp/a.png',
  queuedAt: 1,
  opts: { meta: { displayText: '', attachments: [{
    kind: 'image', name: 'a.png', path: '/tmp/a.png', bytes: 4096, preview: null,
  }] } },
};
storage.setItem('cgui-message-queue', JSON.stringify({ [orphanKey]: [orphan] }));

const { useStore } = await import(`../../client/src/stores/sessionStore.js?r33-orphan=${Date.now()}`);
const st = () => useStore.getState();
assert.equal(st().messageQueue[orphanKey], undefined, '启动时 draft 队列移入孤儿表');
assert.equal(st().orphanDraftQueues[orphanKey].items[0].opts.meta.attachments[0].name, 'a.png', 'meta 原样进入孤儿表');

// “填入”只复制 displayText+attachments，不删除唯一持久副本。
const restored = homeDraftFromOrphan(st().orphanDraftQueues[orphanKey].items[0]);
assert.equal(restored.text, '', 'attachment-only 恢复 displayText，不把 @path 当正文');
assert.deepEqual(restored.attachments.map(({ kind, name, path, bytes, status }) => ({ kind, name, path, bytes, status })), [{
  kind: 'image', name: 'a.png', path: '/tmp/a.png', bytes: 4096, status: 'uploaded',
}]);
assert.ok(st().orphanDraftQueues[orphanKey], '填入后旧孤儿仍持久保留');

const project = { hash: 'project-a', path: '/project/a' };
const draft = buildHomeDraft(project, 'd-new');
const built = buildAttachmentMessage(restored.text, restored.attachments);
const envelope = { text: built.prompt, queuedAt: 2, opts: { meta: attachmentMetaForPersistence(built.meta) } };

// 新队列 quota 失败：不挂 pane、不删除旧孤儿。
storage.failQueueWrites = true;
assert.equal(enqueueRestoredHomeDraft({
  store: st(), orphanQueueKey: orphanKey, orphanQueueId: orphan.queueId,
  sessionKey: 'draft-project-a-d-new', envelope, tabIndex: 0, draft,
}), null);
assert.ok(st().orphanDraftQueues[orphanKey], '重发失败仍有旧持久副本');
assert.equal(st().paneSessions[0] ?? null, null, '重发失败不挂 pane');

// 新队列先成功落盘；即使旧孤儿删除持久化失败，也至少保留新队列+旧孤儿两份。
storage.failQueueWrites = false;
storage.failOrphanWrites = true;
assert.ok(enqueueRestoredHomeDraft({
  store: st(), orphanQueueKey: orphanKey, orphanQueueId: orphan.queueId,
  sessionKey: 'draft-project-a-d-new', envelope, tabIndex: 0, draft,
}));
assert.ok(JSON.parse(storage.getItem('cgui-message-queue'))['draft-project-a-d-new'], '新副本已先持久化');
assert.ok(st().orphanDraftQueues[orphanKey], '旧副本删除失败时内存也不伪装删除');

// 删除恢复后重试成功，旧孤儿才永久消失；新队列 meta 完整。
storage.failOrphanWrites = false;
assert.equal(st().takeOrphanDraftMessage(orphanKey, orphan.queueId)?.queueId, orphan.queueId);
assert.equal(st().orphanDraftQueues[orphanKey], undefined);
assert.equal(JSON.parse(storage.getItem('cgui-orphan-draft-queues'))[orphanKey], undefined);
const persisted = JSON.parse(storage.getItem('cgui-message-queue'))['draft-project-a-d-new'][0];
assert.equal(persisted.opts.meta.displayText, '');
assert.equal(persisted.opts.meta.attachments[0].name, 'a.png');
assert.equal(persisted.opts.meta.attachments[0].path, '/tmp/a.png');

console.log('✓ check-r33-home-orphan-attachments: meta 恢复 + 新队列先落盘 + 失败零丢失窗口全过');
