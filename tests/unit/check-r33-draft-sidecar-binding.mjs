#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bindDraftAttachmentSidecarsOnInit,
  createAttachmentSidecarOutbox,
  draftSidecarBindingsForSessions,
  recoverAttachmentSidecarBindings,
} from '../../client/src/utils/attachments.js';
import { createDraftSessionBindingsStore } from '../../server/services/draft-session-bindings.js';

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

const payload = {
  text: '带附件的首条消息\n\n附件:\n@/tmp/a.png',
  displayText: '带附件的首条消息',
  attachments: [{ kind: 'image', name: 'a.png', path: '/tmp/a.png', bytes: 9, preview: null }],
};
const startedDraft = {
  draft: true,
  draftId: 'd-origin',
  projectHash: '-work-project',
  projectPath: '/work/project',
  sessionId: null,
};

// init 到达时屏幕已切到别的 pane：绑定只读发起流闭包 startedDraft，不读当前 pane。
const switchedStorage = new MemoryStorage();
let switchedPost = null;
const switchedOutbox = createAttachmentSidecarOutbox({
  storage: switchedStorage,
  fetchImpl: async (url, init) => { switchedPost = { url, body: JSON.parse(init.body) }; return { ok: true }; },
});
await switchedOutbox.stage({ ownerKey: 'draft--work-project-d-origin', payload });
const currentPane = { draft: true, draftId: 'd-other', projectHash: '-other', sessionId: null };
assert.notEqual(currentPane.draftId, startedDraft.draftId, '夹具确认 init 时当前 pane 已不是发起 draft');
assert.equal((await bindDraftAttachmentSidecarsOnInit(startedDraft, '11111111-1111-1111-1111-111111111111', {
  bindImpl: switchedOutbox.flushOwner,
})).ok, true);
assert.equal(switchedPost.url, '/api/sessions/11111111-1111-1111-1111-111111111111/attachments');
assert.deepEqual(switchedPost.body, payload);
assert.equal(switchedOutbox.read().length, 0, '切 pane 后收到 init 仍绑定并清账');

// App/manager 在 init 前卸载，服务端先持久记录 CLI 权威映射；新实例只凭 session list 恢复。
const restartStorage = new MemoryStorage();
const beforeRestart = createAttachmentSidecarOutbox({ storage: restartStorage });
await beforeRestart.stage({ ownerKey: 'draft--work-project-d-origin', payload });
const bindingHome = await mkdtemp(join(tmpdir(), 'cgui-r33-draft-binding-'));
const bindingStore = createDraftSessionBindingsStore({
  file: join(bindingHome, 'draft-session-bindings.json'),
  now: () => 1234,
  makeTempId: () => 'tmp',
});
await bindingStore.record({
  draftId: 'd-origin',
  sessionId: '22222222-2222-2222-2222-222222222222',
  projectHash: '-work-project',
});
const sessionList = await bindingStore.mergeIntoSessions([
  { sessionId: '22222222-2222-2222-2222-222222222222', firstPrompt: '带附件的首条消息' },
], '-work-project');
assert.equal(sessionList[0].draftId, 'd-origin', '重启后的既有 sessions 水合携带恢复索引');

let restartPost = null;
const afterRestart = createAttachmentSidecarOutbox({
  storage: restartStorage,
  fetchImpl: async (url, init) => { restartPost = { url, body: JSON.parse(init.body) }; return { ok: true }; },
});
const recoveredBindings = draftSidecarBindingsForSessions(sessionList, '-work-project');
assert.deepEqual(recoveredBindings, [{
  ownerKey: 'draft--work-project-d-origin',
  sessionId: '22222222-2222-2222-2222-222222222222',
}]);
const recovery = await recoverAttachmentSidecarBindings(recoveredBindings, {
  bindImpl: afterRestart.flushOwner,
  ownerKeys: afterRestart.ownerKeys(),
});
assert.equal(recovery.results[0].ok, true);
assert.equal(restartPost.url, '/api/sessions/22222222-2222-2222-2222-222222222222/attachments');
assert.deepEqual(restartPost.body, payload);
assert.equal(afterRestart.read().length, 0, '新 manager 从持久映射恢复未绑定 outbox');

// CLI 尚未发 init 就退出时没有真实 session 可伪造；outbox 保持原 owner，重发同 draft 后可绑定。
const noInitStorage = new MemoryStorage();
const noInit = createAttachmentSidecarOutbox({ storage: noInitStorage, fetchImpl: async () => ({ ok: true }) });
await noInit.stage({ ownerKey: 'draft--work-project-d-origin', payload });
assert.equal(noInit.read()[0].sessionId, null);
assert.equal((await bindDraftAttachmentSidecarsOnInit(startedDraft, '33333333-3333-3333-3333-333333333333', {
  bindImpl: noInit.flushOwner,
})).ok, true, '同一持久 draft 重发取得 init 后恢复旧条目');
assert.equal(noInit.read().length, 0);

// session 列表最多可有 256 条映射；恢复前必须按真实 outbox owner 过滤，空项不写。
let filteredCalls = 0;
const manyBindings = draftSidecarBindingsForSessions(Array.from({ length: 256 }, (_, index) => ({
  draftId: `d-${index}`,
  sessionId: `real-${index}`,
})), '-work-project');
const filtered = await recoverAttachmentSidecarBindings(manyBindings, {
  ownerKeys: new Set(['draft--work-project-d-73']),
  bindImpl: async (ownerKey, sessionId) => {
    filteredCalls += 1;
    assert.equal(ownerKey, 'draft--work-project-d-73', 'ownerKey 同时包含 projectHash 与 draftId');
    assert.equal(sessionId, 'real-73');
    return { ok: true, retained: false };
  },
});
assert.equal(filteredCalls, 1, '256条恢复映射只处理真实存在的outbox owner');
assert.equal(filtered.matched, 1);

console.log('✓ check-r33-draft-sidecar-binding: 切pane init、跨重启映射与init前退出重发恢复全过');
