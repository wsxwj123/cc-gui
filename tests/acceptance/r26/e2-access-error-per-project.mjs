#!/usr/bin/env node
// r26-E2【复现+反向】:sessionsAccessError 全局单值污染。
// 场景:A 项目磁盘拒访(403 no-disk-access,hint='HINT_A')→ 全局唯一的
// sessionsAccessError 被置上;此时 B 项目的空态(真的没有会话)也读出这条错误 →
// B 的空态被染红成「无法读取」。反过来 B 任何一次成功刷新又把 A 的错误清掉 →
// 用户永远看不稳 A 的真实状态,还伴随 600ms watcher 抖动。
// 修复后期望:错误态按 projectHash 隔离 —— A 的错误在 B 成功后仍保留;A 自己成功后
// 只清 A 的。断言用「状态里还找不找得到 HINT_A」表达,不锁死具体字段名。
// Run: node tests/acceptance/r26/e2-access-error-per-project.mjs
import assert from 'node:assert/strict';
import { stubLocalStorage, stubWindowNoop } from './lib.mjs';

stubWindowNoop();
stubLocalStorage();

// fetch 桩:项目 A 403 拒访,项目 B 正常空列表,A 第二次恢复正常。
let aFail = true;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/api/projects/A/sessions') && aFail) {
    return { status: 403, ok: false, json: async () => ({ code: 'no-disk-access', hint: 'HINT_A_XQZ', canOpenSettings: true }) };
  }
  return { status: 200, ok: true, json: async () => [] };
};

const { useStore } = await import('../../../client/src/stores/sessionStore.js');

const stateHas = (needle) => JSON.stringify(useStore.getState()).includes(needle);

// ① A 拒访 → 错误被记录
await useStore.getState().fetchSessionsForPanel('A');
assert.ok(stateHas('HINT_A_XQZ'), 'E2 夹具:A 的拒访错误应被记录');

// ② B 正常拉取(空列表)—— A 的错误不许被 B 的成功清掉(修前被全局清除 → 红)
await useStore.getState().fetchSessionsForPanel('B');
assert.ok(stateHas('HINT_A_XQZ'),
  'E2: B 项目成功刷新把 A 项目的拒访错误清掉了(全局单值)—— A 的空态提示随 600ms watcher 时有时无');

// ③ B 的空态不许显示 A 的错误:B 自己的条目必须无错(按项目隔离时天然成立;
//    修前全局值会让 B 读出 HINT_A —— 用「B 的会话列表正常入位」+ ② 共同夹住)
assert.ok(Array.isArray(useStore.getState().sessionsByProject.B),
  'E2: B 的会话列表应正常入位(不被 A 的错误阻断)');

// ④ A 自己恢复正常 → 只清 A 的
aFail = false;
await useStore.getState().fetchSessionsForPanel('A');
assert.ok(!stateHas('HINT_A_XQZ'), 'E2: A 恢复后 A 自己的错误必须清掉');

console.log('PASS r26-e2-access-error-per-project');
