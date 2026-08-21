#!/usr/bin/env node
// r26-B5【复现】:同项目双 draft 共用 draft-<hash> 队列键,串窗格。
// 场景:同项目开两个 draft(A/B),队列键都是 `draft-<projectHash>`(App.jsx:2784 不含
// draftId)→ A 的排队消息会出现在 B 的窗格/被 B 的会话继承;migrateSessionKey 把整个
// 共享队列并进先 init 的一方。
// 修复后期望:队列键必须能把同项目的两个 draft 区分开(如带 draftId),或等价的按条目
// 归属隔离 —— 可观测锚点:App.jsx 里 sessionQueueKey 对 draft 的推导不再是裸
// `draft-${projectHash}`(不含 draftId 的表达式就是 bug 本体)。
// 注:若方案代理改选「drain 按条目归属过滤」等不动键表达式的方案,本钉子的断言锚需同步
// 迁移(届时修的是入队/出队归属而非键本身)——TEST-PLAN 已标注。
// Run: node tests/acceptance/r26/b5-draft-queue-key.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../../../client/src/App.jsx', import.meta.url), 'utf8');

// 键推导仍然存在(守卫别因重构改名而空转)
assert.match(app, /sessionQueueKey/, 'B5: sessionQueueKey 推导点应仍存在(改名则本钉子需换锚)');

// bug 本体:draft 的队列键只看 projectHash,同项目所有 draft 共享一个键
assert.doesNotMatch(
  app,
  /`draft-\$\{selectedSession\?\.projectHash \|\| 'none'\}`/,
  'B5: draft 队列键仍是裸 draft-<projectHash> —— 同项目两个 draft 共用一个队列,必然串窗格',
);

// 行为层佐证(纯数据,不依赖键推导):同键共享时迁移会把别的 draft 的消息并走。
// 修好后若键带 draftId,同项目的两个 draft 在 messageQueue 里是两个键,互不迁移。
const { migrateDraftQueue } = await import('../../../client/src/utils/routing.js');
{
  // 修复后的世界:A 的队列键与 B 的队列键不同 → 迁移 A 不动 B。
  const mq = {
    'draft-h-A': [{ queueId: 'a1', text: 'A 的', queuedAt: 1 }],
    'draft-h-B': [{ queueId: 'b1', text: 'B 的', queuedAt: 2 }],
  };
  const next = migrateDraftQueue(mq, 'draft-h-A', 'sid-a');
  assert.deepEqual((next?.['draft-h-B'] || []).map((m) => m.queueId), ['b1'],
    'B5: 按 draft 分键后,迁移 A 不得带走 B 的排队消息');
  assert.equal(next?.['draft-h-A'], undefined, 'B5: 迁移后 A 的 draft 键清空');
}

console.log('PASS r26-b5-draft-queue-key');
