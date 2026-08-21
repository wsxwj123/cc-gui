#!/usr/bin/env node
// r31 钉子:新建会话继承(力度/权限)落键必须与窗格 permKey 同构(queueKeyFor)。
// 根因:seedNewSessionDefaults 手写旧形态 draft-${hash}(无 draftId 段),而新建 draft 窗格的
// permKey = queueKeyFor(draft) = draft-<hash>-<draftId>(r26-B5 起)。两键不相等 → seed 写到
// 孤儿键 draft-<hash>,新会话 getEffortFor(permKey) 读不到 → 「新建会话不继承思考强度」。
// 修:键一律走 queueKeyFor;seed 目标键由调用方传 draftId 生成 draft-<hash>-<draftId>。
// 钉:①seedNewSessionDefaults 的 prev/draft 键都用 queueKeyFor;②调用方(App.jsx 提交)
//      先领 draftId 再 seed + buildHomeDraft 用同一个 draftId;③queueKeyFor 产出与窗格 permKey
//      相同的键(draft 带 draftId 段,真会话返回 sessionId);④未传 draftId 退回旧形态(兼容)。
// Run: node tests/unit/check-r31-seed-new-session-key.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { queueKeyFor } from '../../client/src/utils/steerQueue.js';

const sidebar = readFileSync(new URL('../../client/src/components/UnifiedSidebar.jsx', import.meta.url), 'utf8');
const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');

// ① 源码钉:seed 键走 queueKeyFor
{
  const seed = sidebar.slice(sidebar.indexOf('export const seedNewSessionDefaults'), sidebar.indexOf('// r13-①'));
  assert.match(seed, /const prevKey = prev \? queueKeyFor\(prev\) : null;?/,
    '① prev 键必须走 queueKeyFor(prev 是 draft 时带 draftId)');
  assert.match(seed, /const draftKey = draftId != null?/,
    '① draftKey 按 draftId 区分生成');
  assert.match(seed, /queueKeyFor\(\{ projectHash: draftProjectHash \|\| 'none', draftId \}\)/,
    '① draftKey 用 queueKeyFor 生成 draft-<hash>-<draftId>');
  assert.match(seed, /`draft-\$\{draftProjectHash \|\| 'none'\}`/,
    '① 未传 draftId 退回旧形态兜底(兼容)');
}

// ② App.jsx 提交路径:先领 draftId → seed 同 draftId → buildHomeDraft 同 draftId
{
  const submit = app.slice(app.indexOf('const submit = () => {'), app.indexOf('const browse = () => {'));
  assert.match(submit, /const _did = newDraftId\(\);?/, '② 提交路径先领 draftId');
  assert.match(submit, /seedNewSessionDefaults\(project\.hash, _did\)/, '② seed 传 draftId');
  assert.match(submit, /buildHomeDraft\(project, _did\)/, '② buildHomeDraft 用同一个 draftId');
  assert.doesNotMatch(submit, /newDraftId\(\)\);?\s*\n\s*seedNewSessionDefaults\(/,
    '② 不再 seed 后才领 draftId(旧顺序会落孤儿键)');
}

// ③ queueKeyFor 与窗格 permKey 同构(单一构造点)
assert.equal(queueKeyFor({ projectHash: 'abc', draftId: 'd5' }), 'draft-abc-d5', '③ draft 键带 draftId 段(与窗格 permKey 一致)');
assert.equal(queueKeyFor({ sessionId: 's1' }), 's1', '③ 真会话返回 sessionId');
assert.equal(queueKeyFor({ projectHash: 'abc', draftId: 'd5' }), queueKeyFor({ projectHash: 'abc', draftId: 'd5' }), '③ 同 draftId 键恒定');

// ④ 极旧路径兼容:未传 draftId 时 queueKeyFor 兜底 -none
assert.equal(queueKeyFor({ projectHash: 'abc' }), 'draft-abc-none', '④ queueKeyFor 无 draftId 兜底 -none');

console.log('PASS check-r31-seed-new-session-key');
