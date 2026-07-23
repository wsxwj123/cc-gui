// 会话路由核心逻辑回归测试 —— 串扰家族(≥5 轮回归)的防线。
// 覆盖:init 归属判定 / draft 队列迁移 / 历史模型回退 / 发送模型解析。
// 跑法:npm run test:routing
import assert from 'node:assert/strict';
import { isInitBindingOrigin, migrateDraftQueue, resolveHistModel, resolveSendModel }
  from '../client/src/utils/routing.js';

// ── isInitBindingOrigin ──────────────────────────────────────────
// 正常:draft A 发起,init 时仍选中 A → 绑
assert.equal(isInitBindingOrigin(true, 'd1', { sessionId: null, draftId: 'd1' }), true, 'same draft binds');
// v0.2.129 串扰:draft A 发起,init 在途新建 draft B(不同 draftId)→ 不绑
assert.equal(isInitBindingOrigin(true, 'd1', { sessionId: null, draftId: 'd2' }), false, 'different draft must NOT bind');
// v0.2.131 回归路径:发起于真会话(resume),当前是 draft → 永不抢绑
assert.equal(isInitBindingOrigin(false, undefined, { sessionId: null, draftId: 'd2' }), false, 'resume stream never binds a draft');
// 兼容:升级前 localStorage 旧 draft(两边都无 draftId)→ 回退旧行为绑定
assert.equal(isInitBindingOrigin(true, undefined, { sessionId: null }), true, 'both-undefined legacy drafts bind');
// 安全失败方向:一边有一边无 = 拒绝(漏加 draftId 的创建点不能复活串扰)
assert.equal(isInitBindingOrigin(true, 'd1', { sessionId: null }), false, 'origin-has/current-lacks rejects');
assert.equal(isInitBindingOrigin(true, undefined, { sessionId: null, draftId: 'd9' }), false, 'origin-lacks/current-has rejects');
// 当前选中已是真会话 → 不绑
assert.equal(isInitBindingOrigin(true, 'd1', { sessionId: 'sid-x', draftId: 'd1' }), false, 'real session selected never rebinds');
// 当前无选中 → 不绑
assert.equal(isInitBindingOrigin(true, 'd1', null), false, 'no selection no bind');

// ── migrateDraftQueue ────────────────────────────────────────────
// 正常迁移:draft 队列全部搬到真 sid,draft key 删除
{
  const mq = { 'draft-P': [{ text: 'a' }, { text: 'b' }], other: [{ text: 'x' }] };
  const next = migrateDraftQueue(mq, 'draft-P', 'sid-A');
  assert.deepEqual(next['sid-A'].map((m) => m.text), ['a', 'b'], 'queue moved to sid');
  assert.equal('draft-P' in next, false, 'draft key removed');
  assert.deepEqual(next.other, [{ text: 'x' }], 'unrelated keys untouched');
  assert.deepEqual(mq['draft-P'].length, 2, 'input map not mutated');
}
// 追加而非覆盖:sid 下已有排队消息时合并;无 queuedAt 时 stable sort 保持拼接序
{
  const next = migrateDraftQueue({ 'draft-P': [{ text: 'b' }], 'sid-A': [{ text: 'a' }] }, 'draft-P', 'sid-A');
  assert.deepEqual(next['sid-A'].map((m) => m.text), ['a', 'b'], 'appends after existing');
}
// draft+real 混合必须按 queuedAt 升序:draft 期入队的 A(早)不能排在 init 后入队的 B(晚)
// 之后 —— 简单拼接会让先发的 A 后出队,顺序颠倒(判官盲审#3)
{
  const next = migrateDraftQueue(
    { 'draft-P': [{ text: 'a', queuedAt: 100 }], 'sid-A': [{ text: 'b', queuedAt: 200 }] },
    'draft-P', 'sid-A');
  assert.deepEqual(next['sid-A'].map((m) => m.text), ['a', 'b'], 'merged by queuedAt asc');
  const rev = migrateDraftQueue(
    { 'draft-P': [{ text: 'b', queuedAt: 200 }], 'sid-A': [{ text: 'a', queuedAt: 100 }] },
    'draft-P', 'sid-A');
  assert.deepEqual(rev['sid-A'].map((m) => m.text), ['a', 'b'], 'queuedAt wins over concat order');
  // 无 queuedAt 的历史数据按 0 兜底(排最前)
  const legacy = migrateDraftQueue(
    { 'draft-P': [{ text: 'new', queuedAt: 300 }], 'sid-A': [{ text: 'old' }] },
    'draft-P', 'sid-A');
  assert.deepEqual(legacy['sid-A'].map((m) => m.text), ['old', 'new'], 'missing queuedAt falls back to 0');
}
// no-op:空队列 / 无此 key / 缺 sid / key===sid → null(调用方不 setState)
assert.equal(migrateDraftQueue({ 'draft-P': [] }, 'draft-P', 'sid'), null, 'empty queue no-op');
assert.equal(migrateDraftQueue({}, 'draft-P', 'sid'), null, 'missing key no-op');
assert.equal(migrateDraftQueue({ 'draft-P': [{ text: 'a' }] }, 'draft-P', ''), null, 'no sid no-op');
assert.equal(migrateDraftQueue({ k: [{ text: 'a' }] }, 'k', 'k'), null, 'same key no-op');

// ── resolveHistModel ─────────────────────────────────────────────
const T0 = Date.parse('2026-01-01T00:00:00Z');
// 取最近一条真实模型
assert.equal(resolveHistModel([
  { model: 'old-m', timestamp: '2026-01-02T00:00:00Z' },
  { model: 'new-m', timestamp: '2026-01-03T00:00:00Z' },
]), 'new-m', 'latest real model wins');
// /compact 伪 id 跳过继续往前找(实测 /compact 后必现的"模型不存在")
assert.equal(resolveHistModel([
  { model: 'real-m', timestamp: '2026-01-02T00:00:00Z' },
  { model: '<synthetic>', timestamp: '2026-01-03T00:00:00Z' },
]), 'real-m', 'synthetic ids skipped');
// U1/U4 epoch 门控:切 provider 前的消息不作数
assert.equal(resolveHistModel([
  { model: 'mimo-v2.5-pro', timestamp: '2025-12-31T00:00:00Z' },
], T0), null, 'pre-epoch history distrusted');
assert.equal(resolveHistModel([
  { model: 'after-m', timestamp: '2026-01-02T00:00:00Z' },
], T0), 'after-m', 'post-epoch history trusted');
// 无 timestamp 的消息在 epoch 门控下不信任
assert.equal(resolveHistModel([{ model: 'no-ts' }], T0), null, 'timestampless distrusted under epoch');
assert.equal(resolveHistModel([], 0), null, 'empty history null');
assert.equal(resolveHistModel(null, 0), null, 'null history null');

// ── resolveSendModel ─────────────────────────────────────────────
const AVAIL = [{ id: 'deepseek-v4' }, { id: 'deepseek-v4-flash' }];
// 列表未加载 → 不校验,维持 pin||hist||global(绝不误杀)
assert.equal(resolveSendModel({ pin: 'anything', hist: null, globalModel: 'g', availableModels: [], customModels: [], officialAnthropic: false }), 'anything', 'no lists no validation');
// pin 在白名单 → 用 pin
assert.equal(resolveSendModel({ pin: 'deepseek-v4', hist: 'x', globalModel: 'g', availableModels: AVAIL, customModels: [], officialAnthropic: false }), 'deepseek-v4', 'valid pin wins');
// BK-0:跨 provider 残留 pin 被拦,回退 hist
assert.equal(resolveSendModel({ pin: 'mimo-v2.5-pro', hist: 'deepseek-v4', globalModel: 'g', availableModels: AVAIL, customModels: [], officialAnthropic: false }), 'deepseek-v4', 'stale pin blocked, hist used');
// pin/hist 都残留 → global;global 也不在 → null(不传 --model)
assert.equal(resolveSendModel({ pin: 'stale1', hist: 'stale2', globalModel: 'deepseek-v4-flash', availableModels: AVAIL, customModels: [], officialAnthropic: false }), 'deepseek-v4-flash', 'falls to global');
assert.equal(resolveSendModel({ pin: 'stale1', hist: 'stale2', globalModel: 'stale3', availableModels: AVAIL, customModels: [], officialAnthropic: false }), null, 'nothing valid → null');
// [1m] 后缀按裸 id 匹配且不被剥掉(1M 逻辑不破坏)
assert.equal(resolveSendModel({ pin: 'deepseek-v4[1m]', hist: null, globalModel: 'g', availableModels: AVAIL, customModels: [], officialAnthropic: false }), 'deepseek-v4[1m]', '[1m] suffix matched bare, returned intact');
// custom 手填 id 放行(不误杀)
assert.equal(resolveSendModel({ pin: 'my-custom', hist: null, globalModel: 'g', availableModels: AVAIL, customModels: ['my-custom'], officialAnthropic: false }), 'my-custom', 'custom model allowed');
// 官方下 claude-* 一律放行(用户实证"选 sonnet-4-6 实跑 haiku"的修复)
assert.equal(resolveSendModel({ pin: 'claude-sonnet-4-6', hist: null, globalModel: 'g', availableModels: [{ id: 'claude-haiku-4-5' }], customModels: [], officialAnthropic: true }), 'claude-sonnet-4-6', 'official claude-* bypasses whitelist');
// 第三方下 claude-* 不放行(仍走白名单)
assert.equal(resolveSendModel({ pin: 'claude-sonnet-4-6', hist: null, globalModel: 'deepseek-v4', availableModels: AVAIL, customModels: [], officialAnthropic: false }), 'deepseek-v4', 'third-party claude-* NOT bypassed');

console.log('check-routing: all assertions passed');
