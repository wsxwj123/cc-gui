#!/usr/bin/env node
// r26-E2(store 侧):sessionsAccessError 全局单值污染 → 按 projectHash 隔离。
// 契约 C-E2:sessionsAccessErrorByProject: { [projectHash]: { hint, canOpenSettings } },
// 缺省 undefined = 正常;PKG-2 写、PKG-11 读。
// 哨兵:①A 403 → 仅 A 有错误态;②B 成功 → A 的错误不动(污染哨兵);
//       ③A 随后成功 → 只清 A;④fetchSessions(旧槽消费者)同口径;
//       ⑤旧全局字段 sessionsAccessError / sessionsAccessCanOpenSettings 已删除。
// Run: node tests/unit/check-r26-access-error-per-project.mjs
import assert from 'node:assert/strict';

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); },
};

// fetch 桩:A 先 403 后恢复;B 恒正常空列表
let aFail = true;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/api/projects/A/sessions') && aFail) {
    return { status: 403, ok: false, json: async () => ({ code: 'no-disk-access', hint: 'HINT_A', canOpenSettings: true }) };
  }
  return { status: 200, ok: true, json: async () => [] };
};

const { useStore } = await import('../../client/src/stores/sessionStore.js');
const st = () => useStore.getState();
const errOf = (h) => st().sessionsAccessErrorByProject?.[h];

// ⑤ 旧全局字段删除(契约换锚)
assert.ok(!('sessionsAccessError' in st()), 'E2: 旧全局字段 sessionsAccessError 必须删除');
assert.ok(!('sessionsAccessCanOpenSettings' in st()), 'E2: 旧全局字段 sessionsAccessCanOpenSettings 必须删除');

// ① A 拒访 → 仅 A 有错误态,值形 {hint, canOpenSettings}
await st().fetchSessionsForPanel('A');
assert.deepEqual(errOf('A'), { hint: 'HINT_A', canOpenSettings: true }, 'E2: A 的错误态按项目键记录(契约值形)');
assert.equal(errOf('B'), undefined, 'E2: 缺省 undefined = 正常');
assert.ok(Array.isArray(st().sessionsByProject.A), 'E2: 403 组列表落空数组占位(r22-① 不回归)');

// ② B 成功 → A 的错误不动(污染哨兵);B 的列表正常入位
await st().fetchSessionsForPanel('B');
assert.deepEqual(errOf('A'), { hint: 'HINT_A', canOpenSettings: true },
  'E2: B 成功不得清掉 A 的错误(全局单值污染回归)');
assert.equal(errOf('B'), undefined, 'E2: B 自身无错误态');
assert.ok(Array.isArray(st().sessionsByProject.B), 'E2: B 的会话列表正常入位');

// ③ A 恢复 → 只清 A
aFail = false;
await st().fetchSessionsForPanel('A');
assert.equal(errOf('A'), undefined, 'E2: A 恢复后只清 A 的错误键');

// ④ fetchSessions(旧 sessions 槽消费者)同口径
aFail = true;
await st().fetchSessions('A');
assert.deepEqual(errOf('A'), { hint: 'HINT_A', canOpenSettings: true }, 'E2: fetchSessions 403 也按项目键记录');
await st().fetchSessions('B');
assert.deepEqual(errOf('A'), { hint: 'HINT_A', canOpenSettings: true }, 'E2: fetchSessions 的 B 成功同样不碰 A');
aFail = false;
await st().fetchSessions('A');
assert.equal(errOf('A'), undefined, 'E2: fetchSessions 的 A 成功清 A');

console.log('PASS check-r26-access-error-per-project');
