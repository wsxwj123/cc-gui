#!/usr/bin/env node
// 普通会话「回合进行中发大图」不得被本地存储配额硬拒。
// 背景:入队现在是"写进 localStorage 并回读核验,写不进就返回 null"(不再静默伪装已入队),
// 于是任何超配额的队列条目都会变成用户可见的"本地存储空间不足"。而 meta.attachments[].preview
// 是整张图的 data URL —— 4MiB 图 ≈ 5.6M 字符,单条就顶穿 WKWebView 的约 5MB 配额。
// Home 路径(App.jsx 的 enqueueHomeDraft 调用点)早就过 attachmentMetaForPersistence 剥 preview,
// 普通会话的入队点漏了这一步 = 流式中发大图必失败。
// 本文件:① 真 store + 真配额上限的假 localStorage,证明"剥 / 不剥"是成败分界;
//        ② 源码守卫:普通会话唯一的 enqueueMessage 调用点必须剥 preview 后再入队。
// Run: node tests/unit/check-r33-queue-attachment-preview.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachmentMetaForPersistence } from '../../client/src/utils/attachments.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// WKWebView 的每源配额(约 5MB)。真实行为:超限 setItem 抛 QuotaExceededError,
// 且【不写入】—— 回读拿到旧值,persistQueueSnapshot 的 verify 因此也会失败。
const QUOTA_BYTES = 5 * 1024 * 1024;
const store = new Map();
const usedBytes = (skipKey) => [...store.entries()]
  .reduce((sum, [k, v]) => (k === skipKey ? sum : sum + k.length + v.length), 0);
globalThis.localStorage = {
  get length() { return store.size; },
  key: (i) => [...store.keys()][i] ?? null,
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, value) => {
    const next = String(value);
    if (usedBytes(key) + key.length + next.length > QUOTA_BYTES) {
      const err = new Error('QuotaExceededError');
      err.name = 'QuotaExceededError';
      throw err;
    }
    store.set(key, next);
  },
  removeItem: (key) => { store.delete(key); },
};

const { useStore } = await import('../../client/src/stores/sessionStore.js');

const fourMiB = Buffer.alloc(4 * 1024 * 1024, 0xab);
const preview = `data:image/png;base64,${fourMiB.toString('base64')}`;
const rawMeta = {
  displayText: '看看这张图',
  attachments: [{ kind: 'image', name: 'shot.png', path: '/tmp/shot.png', bytes: fourMiB.length, preview }],
};
assert.ok(preview.length > QUOTA_BYTES, `单张 4MiB 图的 data URL(${preview.length} 字符)本就超配额`);

// ── ① 不剥 preview:入队被配额硬拒(= 用户看到"本地存储空间不足") ──────────
useStore.setState({ messageQueue: {} });
const rejected = useStore.getState().enqueueMessage('sess-r33-img', {
  text: '看看这张图', queuedAt: 1, opts: { meta: rawMeta },
});
assert.equal(rejected, null, '原始 meta(带整图 data URL)必然超配额 → 入队失败');
assert.equal((useStore.getState().messageQueue['sess-r33-img'] || []).length, 0, '失败不留半条脏数据');

// ── ② 剥掉超预算 preview 后:同一条消息正常入队,恢复所需字段完整 ───────────
useStore.setState({ messageQueue: {} });
const boundedMeta = attachmentMetaForPersistence(rawMeta);
const queued = useStore.getState().enqueueMessage('sess-r33-img', {
  text: '看看这张图', queuedAt: 1, opts: { meta: boundedMeta },
});
assert.ok(queued, '剥掉超预算 preview 后必须入队成功 —— 这正是普通会话缺的那一步');
const item = useStore.getState().messageQueue['sess-r33-img'][0];
assert.equal(item.opts.meta.attachments[0].preview, null, '进队列的克隆不带整图 data URL');
assert.deepEqual(
  { ...item.opts.meta.attachments[0], preview: undefined },
  { kind: 'image', name: 'shot.png', path: '/tmp/shot.png', bytes: fourMiB.length, preview: undefined },
  '出队重发所需的 kind/name/path/bytes 一个不少',
);
assert.equal(rawMeta.attachments[0].preview, preview, '内存里的预览不被突变(界面照常显示缩略图)');

// ── ③ 源码守卫:普通会话入队点必须剥 preview ────────────────────────────────
const app = readFileSync(join(root, 'client/src/App.jsx'), 'utf8');
const callSites = app.split('const queueOpts = { ...opts };');
assert.equal(callSites.length, 2, 'App.jsx 只应有一个普通会话入队点(queueOpts 构造处)');
const enqueueBlock = callSites[1].slice(0, callSites[1].indexOf('enqueueMessage('));
assert.match(enqueueBlock, /queueOpts\.meta\s*=\s*attachmentMetaForPersistence\(queueOpts\.meta\)/,
  '入队前必须把 queueOpts.meta 过 attachmentMetaForPersistence(只剥进 localStorage 的克隆)');
assert.match(app, /opts:\s*\{\s*meta:\s*attachmentMetaForPersistence\(built\.meta\)\s*\}/,
  'Home 入队点的同款处理仍在(两条入队路径口径一致)');

console.log('✓ check-r33-queue-attachment-preview: 流式中发大图不再被 localStorage 配额硬拒');
