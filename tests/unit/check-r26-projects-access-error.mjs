#!/usr/bin/env node
// r26-E3(client 半,契约 C-E3):/api/projects 403 + no-disk-access → projectsAccessError
// 单值(projects 是顶层单列表,按 hash 存无意义);成功即清。PKG-11 的侧栏项目空态
// 只读 store.projectsAccessError 渲染提示,不自拉。
// 哨兵:①403 → projectsAccessError = { hint, canOpenSettings } 且 projects 落空(不染 error 字段);
//       ②随后成功 → 清回 null;③其他失败(catch)不置 projectsAccessError。
// Run: node tests/unit/check-r26-projects-access-error.mjs
import assert from 'node:assert/strict';

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); },
};

let mode = 'denied';
globalThis.fetch = async () => {
  if (mode === 'denied') return { status: 403, ok: false, json: async () => ({ code: 'no-disk-access', hint: 'HINT_TOP', canOpenSettings: true }) };
  if (mode === 'ok') return { status: 200, ok: true, json: async () => [{ hash: 'p1', path: '/tmp/p1' }] };
  throw new Error('network-down');
};

const { useStore } = await import('../../client/src/stores/sessionStore.js');
const st = () => useStore.getState();

// ① 403 → 单值错误态
await st().fetchProjects();
assert.deepEqual(st().projectsAccessError, { hint: 'HINT_TOP', canOpenSettings: true },
  'E3: 顶层 projects 403 必须置 projectsAccessError(契约 C-E3 值形)');
assert.deepEqual(st().projects, [], 'E3: 403 时项目列表落空(不冒充"没有项目"之外不留陈旧)');
assert.equal(st().error, null, 'E3: 拒访不是通用 error(那是网络失败的槽)');

// ② 成功 → 清
mode = 'ok';
await st().fetchProjects();
assert.equal(st().projectsAccessError, null, 'E3: 成功后 projectsAccessError 清回 null');
assert.equal(st().projects.length, 1, 'E3: 成功路径列表正常入位');

// ③ 网络失败(catch)→ 不置 projectsAccessError(那是"加载失败"不是"被拒访")
mode = 'throw';
await st().fetchProjects();
assert.equal(st().projectsAccessError, null, 'E3: catch 路径不得置 projectsAccessError');
assert.ok(st().error, 'E3: catch 路径 error 字段照旧');

console.log('PASS check-r26-projects-access-error');
