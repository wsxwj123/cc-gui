#!/usr/bin/env node
// r26-H1(client store 透传,契约 C-H1):nonce 经 permission:request broadcast 的
// nonce 键下发;sessionStore pendingPermissions 条目透传该字段(addPendingPermission
// 展开不剥字段);useWebSocket 的 respond 链路必须把它送回服务端。
// (permissions.js / hook / PermissionPrompt.jsx 归 PKG-10;本包钉 store 透传 +
//  respond 提交器的 nonce 附带。)
// ①store:broadcast 带来的 nonce 原样入卡(逐字相等);对账补拉同路径;
// ②源码哨兵:auto-allow 分支带 req.nonce;respondPermission 在 body 缺 nonce 时
//   从卡片补 X-CGUI-Nonce 头。
// Run: node tests/unit/check-r26-permission-nonce-passthrough.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => storage.get(k) ?? null,
  setItem: (k, v) => { storage.set(k, String(v)); },
  removeItem: (k) => { storage.delete(k); },
};

const { useStore } = await import('../../client/src/stores/sessionStore.js');
const st = () => useStore.getState();

// ① nonce 透传(broadcast 形态:字段在 request 对象上,addPendingPermission 展开保留)
st().addPendingPermission({ id: 'perm-1', toolName: 'Bash', toolInput: { command: 'ls' }, sessionId: 's1', nonce: 'nonce-abc-123' });
const card = st().pendingPermissions.find((p) => p.id === 'perm-1');
assert.equal(card?.nonce, 'nonce-abc-123', 'H1: nonce 必须随卡入 store(逐字相等)');
// 无 nonce 的旧广播(升级窗口)不崩
st().addPendingPermission({ id: 'perm-2', toolName: 'Read', sessionId: 's1' });
assert.equal(st().pendingPermissions.find((p) => p.id === 'perm-2')?.nonce, undefined,
  'H1: 无 nonce 的旧形态卡片照常入列(兼容)');
// 去重语义不回归(同 id 重放不双卡,nonce 以首份为准)
st().addPendingPermission({ id: 'perm-1', toolName: 'Bash', nonce: 'nonce-CHANGED' });
assert.equal(st().pendingPermissions.filter((p) => p.id === 'perm-1').length, 1, 'H1: 同 id 去重');
assert.equal(st().pendingPermissions.find((p) => p.id === 'perm-1')?.nonce, 'nonce-abc-123', 'H1: 重放不覆盖首份(与 receivedAt 同语义)');

// ② respond 链路源码锚
const ws = readFileSync(new URL('../../client/src/hooks/useWebSocket.js', import.meta.url), 'utf8');
assert.match(ws, /respondPermission\(req\.id, \{ decision: 'allow', nonce: req\.nonce \}\)/,
  'H1: 白名单 auto-allow 必须带 req.nonce(否则被 nonce 闸 403 锁死)');
assert.match(ws, /headers\['X-CGUI-Nonce'\] = cardNonce/,
  'H1: respondPermission 在 body 缺 nonce 时必须从卡片补 X-CGUI-Nonce 头');
assert.match(ws, /pendingPermissions\.find\(\(p\) => p\.id === id\)\?\.nonce/,
  'H1: 卡片 nonce 从 store 现取(重连补拉的卡也带)');

console.log('PASS check-r26-permission-nonce-passthrough');
