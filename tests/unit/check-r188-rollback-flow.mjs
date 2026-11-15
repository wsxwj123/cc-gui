// r188-rollback-flow 白盒单测:回滚流程三处(回合在跑时先停再裁 / 只删停止时刻不早于截断点的留存 /
// 「重做此工具」裁剪成功后才清表)。页面用例在 tests/acceptance/r182-stop-keep-partial/(K6、B2–B5),
// 这里守没有页面用例的路径。
// 跑法:node tests/unit/check-r188-rollback-flow.mjs
import assert from 'node:assert/strict';
import {
  addRetained, dropRetainedSince, cutTsOf, listRetained, makeRetainedEntry, __resetRetainedForTest,
} from '../../client/src/utils/retainedCopies.js';

let passed = 0;
const fails = [];
const t = async (name, fn) => {
  try { await fn(); passed += 1; } catch (err) { fails.push(`${name}: ${err.message}`); }
};

// ── 1. 按停止时刻删(dropRetainedSince)────────────────────────────────────────
const T0 = Date.parse('2026-11-15T10:00:00.000Z');
const mk = (id, startMs, stopMs) => makeRetainedEntry({
  kind: 'stop', ownerKey: 'k', turn: { uuid: id, type: 'turn', text: ['x'] },
  srcUuids: [], roundStartTs: T0 + startMs, stopTs: T0 + stopMs, prompt: null,
});
const ids = (key) => listRetained(key).map((e) => e.id);

await t('1 截断点晚于更早轮次的停止时刻:更早轮次留下', () => {
  __resetRetainedForTest();
  addRetained('s', mk('chat-a', 0, 1000));
  addRetained('s', mk('chat-b', 3000, 5000));
  dropRetainedSince('s', T0 + 2000, T0 + 9000);
  assert.deepEqual(ids('s'), ['chat-a']);
});
await t('1 截断点早于所有停止时刻:全删', () => {
  __resetRetainedForTest();
  addRetained('s', mk('chat-a', 0, 1000));
  addRetained('s', mk('chat-b', 3000, 5000));
  dropRetainedSince('s', T0 - 1, T0 + 9000);
  assert.deepEqual(ids('s'), []);
});
await t('1 截断点等于停止时刻:删(不早于即删)', () => {
  __resetRetainedForTest();
  addRetained('s', mk('chat-a', 0, 1000));
  dropRetainedSince('s', T0 + 1000, T0 + 9000);
  assert.deepEqual(ids('s'), []);
});
await t('1 截断点晚于所有停止时刻:全留,表不变', () => {
  __resetRetainedForTest();
  addRetained('s', mk('chat-a', 0, 1000));
  addRetained('s', mk('chat-b', 3000, 5000));
  assert.equal(dropRetainedSince('s', T0 + 6000, T0 + 9000), false);
  assert.deepEqual(ids('s'), ['chat-a', 'chat-b']);
});
await t('1 截断点无效(NaN / null / undefined / 字符串):整表删', () => {
  for (const bad of [NaN, null, undefined, '2026-11-15T10:00:02.000Z', Infinity]) {
    __resetRetainedForTest();
    addRetained('s', mk('chat-a', 0, 1000));
    addRetained('s', mk('chat-b', 3000, 5000));
    dropRetainedSince('s', bad, T0 + 9000);
    assert.deepEqual(ids('s'), [], `cutTs=${String(bad)}`);
  }
});
await t('1 多条目:只删停止时刻不早于截断点的,顺序保持', () => {
  __resetRetainedForTest();
  addRetained('s', mk('chat-a', 0, 1000));
  addRetained('s', mk('chat-b', 1500, 1999));
  addRetained('s', mk('chat-c', 2100, 2500));
  addRetained('s', mk('chat-d', 3000, 4000));
  dropRetainedSince('s', T0 + 2000, T0 + 9000);
  assert.deepEqual(ids('s'), ['chat-a', 'chat-b']);
});
await t('1 墓碑按回退时刻记,不按截断点:被这次回退中断的流(起流晚于截断点、早于回退时刻)迟到写入被拒', () => {
  __resetRetainedForTest();
  addRetained('s', mk('chat-a', 0, 1000));
  dropRetainedSince('s', T0 + 2000, T0 + 9000);
  assert.equal(addRetained('s', mk('chat-late', 3000, 9500)), false, '起流 3000 早于回退时刻 9000,应被墓碑拒收');
  assert.equal(addRetained('s', mk('chat-new', 9100, 9800)), true, '回退之后开始的回合照收');
  assert.deepEqual(ids('s'), ['chat-a', 'chat-new']);
});
await t('1 其它会话键不受影响', () => {
  __resetRetainedForTest();
  addRetained('s', mk('chat-a', 3000, 5000));
  addRetained('o', mk('chat-o', 3000, 5000));
  dropRetainedSince('s', T0, T0 + 9000);
  assert.deepEqual(ids('o'), ['chat-o']);
});
await t('1 cutTsOf:ISO 串 / 毫秒数 / 取不到', () => {
  assert.equal(cutTsOf('2026-11-15T10:00:00.000Z'), T0);
  assert.equal(cutTsOf(T0), T0);
  assert.ok(Number.isNaN(cutTsOf(undefined)));
  assert.ok(Number.isNaN(cutTsOf('')));
  assert.ok(Number.isNaN(cutTsOf('not a date')));
});

console.log(`\n[check-r188-rollback-flow] ${passed} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.error('  ✗ ' + f); process.exit(1); }
