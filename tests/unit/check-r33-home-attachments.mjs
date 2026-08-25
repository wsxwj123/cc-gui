#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_PERSISTED_ATTACHMENT_PREVIEW_CHARS,
  attachmentBlockReason,
  attachmentMetaForPersistence,
  buildAttachmentMessage,
  pendingAttachment,
  uploadAttachmentFile,
} from '../../client/src/utils/attachments.js';
import { enqueueHomeDraft } from '../../client/src/utils/home.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// 真实上传协议构造：原始 File/Blob 作 body，文件名与 MIME 走既有 headers。
{
  const file = { name: '报告 🧪.txt', type: 'text/plain', size: 7 };
  let request = null;
  const uploaded = await uploadAttachmentFile(file, {
    fetchImpl: async (url, init) => {
      request = { url, init };
      return { ok: true, status: 200, json: async () => ({ kind: 'text', path: '/tmp/report.txt', bytes: 7 }) };
    },
  });
  assert.equal(request.url, '/api/upload');
  assert.equal(request.init.body, file, '上传 body 保持原始文件，不另造首页协议');
  assert.equal(request.init.headers['Content-Type'], 'text/plain');
  assert.equal(decodeURIComponent(request.init.headers['X-Upload-Name']), file.name);
  assert.deepEqual(uploaded, {
    kind: 'text', path: '/tmp/report.txt', preview: null, name: file.name, bytes: 7, status: 'uploaded',
  });

  await assert.rejects(
    uploadAttachmentFile(file, {
      fetchImpl: async () => ({ ok: false, status: 413, json: async () => ({ error: '文件太大' }) }),
    }),
    /文件太大/,
    '上传失败必须抛给 UI，不能伪装成已上传',
  );
}

// 4MiB 图片的 data URL 约 5.6M 字符：Home 内存 meta 保留原图，队列克隆剥离超预算
// preview，同时 name/path/bytes/kind 完整可恢复。
{
  const fourMiB = Buffer.alloc(4 * 1024 * 1024, 0xab);
  const preview = `data:image/png;base64,${fourMiB.toString('base64')}`;
  const original = {
    displayText: '',
    attachments: [{ kind: 'image', name: 'large.png', path: '/tmp/large.png', bytes: fourMiB.length, preview }],
  };
  const persistedMeta = attachmentMetaForPersistence(original);
  assert.equal(original.attachments[0].preview, preview, '普通 composer/Home 当前内存预览不被突变');
  assert.equal(persistedMeta.attachments[0].preview, null, '超预算 preview 不进队列');
  assert.deepEqual(
    { ...persistedMeta.attachments[0], preview: undefined },
    { kind: 'image', name: 'large.png', path: '/tmp/large.png', bytes: fourMiB.length, preview: undefined },
    '恢复所需附件字段完整保留',
  );
  assert.ok(JSON.stringify(persistedMeta).length < MAX_PERSISTED_ATTACHMENT_PREVIEW_CHARS + 1024,
    '持久快照 preview 有明确总上限');

  const small = 'data:image/png;base64,' + 'a'.repeat(60 * 1024);
  const multi = attachmentMetaForPersistence({ attachments: [
    { path: '/tmp/1', preview: small },
    { path: '/tmp/2', preview: small },
  ] });
  assert.equal(multi.attachments[0].preview, small, '预算内缩略图保留');
  assert.equal(multi.attachments[1].preview, null, '多附件按整条消息总预算截断');
}

// 多文件 / attachment-only / 上传中与失败门禁共用同一消息构造器。
{
  const first = { kind: 'text', path: '/tmp/a.txt', name: 'a.txt', bytes: 1, status: 'uploaded' };
  const second = { kind: 'text', path: '/tmp/b.txt', name: 'b.txt', bytes: 2, status: 'uploaded' };
  const attachmentOnly = buildAttachmentMessage('', [first, second]);
  assert.equal(attachmentOnly.prompt, '请查看这些附件\n\n附件:\n@/tmp/a.txt\n@/tmp/b.txt');
  assert.equal(attachmentOnly.meta.attachments.length, 2, '一次发送保留两个附件');
  assert.equal(attachmentOnly.meta.displayText, '', 'attachment-only 气泡正文为空但仍有附件卡');
  assert.equal(buildAttachmentMessage('说明', [first]).prompt, '说明\n\n附件:\n@/tmp/a.txt');

  const uploading = pendingAttachment({ name: 'slow.txt', size: 1 });
  assert.equal(attachmentBlockReason([uploading]), 'uploading');
  assert.equal(buildAttachmentMessage('不能偷发', [uploading]), null, '上传中连纯文本也不得先发');
  const failed = { ...uploading, status: 'failed', error: '失败' };
  assert.equal(attachmentBlockReason([first, failed]), 'failed');
  assert.equal(buildAttachmentMessage('', [first, failed]), null, '失败附件未移除/重试前不得忽略它发送成功 sibling');
}

// enqueue 必须先于 pane；持久化失败时 pane 完全不建立。
{
  const calls = [];
  const draft = { draft: true, projectHash: 'p', projectPath: '/p' };
  const envelope = { text: 'prompt', queuedAt: 10, opts: { meta: { attachments: [{ path: '/tmp/a' }] } } };
  const okStore = {
    enqueueMessage: (_key, value) => { calls.push(['enqueue', value]); return { ...value, queueId: 'q1' }; },
    setPaneSession: () => calls.push(['pane']),
    setPaneMessages: () => calls.push(['messages']),
  };
  assert.ok(enqueueHomeDraft({ store: okStore, sessionKey: 'draft-p-d1', envelope, tabIndex: 0, draft }));
  assert.deepEqual(calls.map(([name]) => name), ['enqueue', 'pane', 'messages']);

  const failedCalls = [];
  const quotaStore = {
    enqueueMessage: () => { failedCalls.push('enqueue'); return null; },
    setPaneSession: () => failedCalls.push('pane'),
    setPaneMessages: () => failedCalls.push('messages'),
  };
  assert.equal(enqueueHomeDraft({ store: quotaStore, sessionKey: 'draft-p-d2', envelope, tabIndex: 0, draft }), null);
  assert.deepEqual(failedCalls, ['enqueue'], 'quota 后不建立/切换 pane');
}

// 真 store：quota 写失败不改内存；恢复后持久化公开信封 {text,queuedAt,opts:{meta}}。
{
  class QuotaStorage {
    constructor() { this.values = new Map(); this.failQueueWrites = false; this.maxQueueChars = Infinity; }
    get length() { return this.values.size; }
    key(index) { return [...this.values.keys()][index] ?? null; }
    getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
    setItem(key, value) {
      if (key === 'cgui-message-queue' && (this.failQueueWrites || String(value).length > this.maxQueueChars)) {
        throw new DOMException('quota', 'QuotaExceededError');
      }
      this.values.set(key, String(value));
    }
    removeItem(key) { this.values.delete(key); }
  }
  const storage = new QuotaStorage();
  globalThis.localStorage = storage;
  const { useStore } = await import(`../../client/src/stores/sessionStore.js?r33=${Date.now()}`);
  useStore.setState({ messageQueue: {} });
  storage.failQueueWrites = true;
  const envelope = { text: '附件 prompt', queuedAt: 20, opts: { meta: { attachments: [{ path: '/tmp/a' }] } } };
  assert.equal(useStore.getState().enqueueMessage('draft-quota', envelope), null, 'quota 返回失败');
  assert.deepEqual(useStore.getState().messageQueue, {}, 'quota 不得留下仅内存的伪队列');

  storage.failQueueWrites = false;
  const queued = useStore.getState().enqueueMessage('draft-ok', envelope);
  assert.ok(queued?.queueId);
  const persisted = JSON.parse(storage.getItem('cgui-message-queue'))['draft-ok'][0];
  assert.equal(persisted.text, envelope.text);
  assert.equal(persisted.queuedAt, envelope.queuedAt);
  assert.deepEqual(persisted.opts.meta, envelope.opts.meta);

  // 同一个真实 store + 4MiB preview：原 envelope 会超过模拟 quota；Home 持久化克隆可入队。
  const hugePreview = `data:image/png;base64,${Buffer.alloc(4 * 1024 * 1024, 0xcd).toString('base64')}`;
  const rawMeta = { displayText: '', attachments: [{
    kind: 'image', name: 'quota.png', path: '/tmp/quota.png', bytes: 4 * 1024 * 1024, preview: hugePreview,
  }] };
  storage.maxQueueChars = 200 * 1024;
  assert.ok(JSON.stringify(rawMeta).length > storage.maxQueueChars, '夹具确实会触发 quota');
  const boundedEnvelope = {
    text: '请查看这些附件\n\n附件:\n@/tmp/quota.png',
    queuedAt: 21,
    opts: { meta: attachmentMetaForPersistence(rawMeta) },
  };
  assert.ok(useStore.getState().enqueueMessage('draft-large-image', boundedEnvelope), '有界 meta 可真实入队');
  const largePersisted = JSON.parse(storage.getItem('cgui-message-queue'))['draft-large-image'][0];
  assert.equal(largePersisted.opts.meta.attachments[0].preview, null);
  assert.equal(largePersisted.opts.meta.attachments[0].name, 'quota.png');
  assert.equal(largePersisted.opts.meta.attachments[0].path, '/tmp/quota.png');
  assert.equal(largePersisted.opts.meta.attachments[0].bytes, 4 * 1024 * 1024);
}

// 稳定 selector 是接口接线哨兵；核心上传/队列行为均由上面的真实函数与 store 覆盖。
{
  const app = readFileSync(join(root, 'client/src/App.jsx'), 'utf8');
  const pendingList = readFileSync(join(root, 'client/src/components/PendingAttachmentList.jsx'), 'utf8');
  const bubble = readFileSync(join(root, 'client/src/components/MessageBubble.jsx'), 'utf8');
  for (const testId of ['home-attachment-add', 'home-send', 'project-selector', 'attachment-error']) {
    assert.ok(app.includes(`data-testid="${testId}"`), `Home 接入 ${testId}`);
  }
  assert.ok(pendingList.includes('data-testid="attachment-item"'));
  assert.ok(pendingList.includes('data-testid="attachment-remove"'));
  assert.ok(bubble.includes('data-testid="message-card"'));
}

// r60(用户实报):首页输入框粘贴/拖放文件必须与聊天框同逻辑成为附件,不许退化成路径文本。
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
  const i = src.indexOf('data-cgui="home-input"');
  const seg = src.slice(i, i + 1600);
  if (!/onPaste=\{/.test(seg)) throw new Error('r60: 首页输入框缺 onPaste 附件处理');
  if (!/kind === 'file'/.test(seg) || !/uploadHomeAttachment\(f\)/.test(seg)) throw new Error('r60: 粘贴文件须走 uploadHomeAttachment');
  if (!/handledFile\) e\.preventDefault\(\)/.test(seg)) throw new Error('r60: 粘贴文件后须 preventDefault(防路径文本落入)');
  if (!/onDrop=\{/.test(seg) || !/dataTransfer/.test(seg)) throw new Error('r60: 拖放文件同样入附件');
  console.log('✓ r60: 首页输入框粘贴/拖放附件与聊天框对齐');
}

console.log('✓ check-r33-home-attachments: 共用上传/消息构造 + 多文件/仅附件 + 门禁/失败 + quota 原子入队 + pane 顺序全过');
