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

// ── 2. 等停止 / 裁剪重试(utils/historyOps.js,真跑)────────────────────────────────
const { stopTurnAndWait, runHistoryOpSettled, STOP_WAIT_MAX_MS, TRIM_RETRY_MAX_MS } = await import('../../client/src/utils/historyOps.js');
await t('2 没有在跑进程:不发停止、不等', async () => {
  let n = 0;
  const r = await stopTurnAndWait({ pid: null, fetchImpl: () => { n += 1; } });
  assert.deepEqual(r, { sent: false, replied: false });
  assert.equal(n, 0);
});
await t('2 带身份停止;身份不符(409)补发一次不带身份的', async () => {
  const bodies = [];
  const f = async (url, init) => { bodies.push(JSON.parse(init.body)); return { status: bodies.length === 1 ? 409 : 200 }; };
  const r = await stopTurnAndWait({ pid: 'p1', owner: 'sid-1', fetchImpl: f });
  assert.deepEqual(bodies, [{ hard: true, owner: 'sid-1' }, { hard: true }]);
  assert.equal(r.replied, true);
});
await t('2 停止迟迟不回话:等到上限就返回(上限在 1–6 秒之间)', async () => {
  assert.ok(STOP_WAIT_MAX_MS >= 1000 && STOP_WAIT_MAX_MS <= 6000);
  const t0 = Date.now();
  const r = await stopTurnAndWait({ pid: 'p1', fetchImpl: () => new Promise(() => {}), maxWaitMs: 300 });
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(r.replied, false);
});
await t('2 裁剪重试:只认 SESSION_RUNNING / SESSION_CHANGED,其它失败立即返回', async () => {
  for (const code of ['SESSION_RUNNING', 'SESSION_CHANGED']) {
    let n = 0;
    const r = await runHistoryOpSettled('s', 'trim', {}, { intervalMs: 10, runOp: async () => { n += 1; return n < 3 ? { ok: false, code } : { ok: true }; } });
    assert.equal(r.ok, true, code);
    assert.equal(n, 3, code);
  }
  let n = 0;
  const r = await runHistoryOpSettled('s', 'trim', {}, { intervalMs: 10, runOp: async () => { n += 1; return { ok: false, code: 'NOT_FOUND' }; } });
  assert.equal(r.ok, false);
  assert.equal(n, 1, '其它失败不重试');
});
await t('2 裁剪重试有上限:一直被拒就按时间上限返回最后一次失败', async () => {
  assert.ok(TRIM_RETRY_MAX_MS >= 4000 && TRIM_RETRY_MAX_MS <= 8000);
  let clock = 0;
  let n = 0;
  const r = await runHistoryOpSettled('s', 'trim', {}, {
    maxMs: 1000, intervalMs: 1, now: () => clock,
    runOp: async () => { n += 1; clock += 300; return { ok: false, code: 'SESSION_RUNNING' }; },
  });
  assert.equal(r.code, 'SESSION_RUNNING');
  assert.ok(n >= 3 && n <= 4, `尝试次数 ${n}`);
});

// ── 3. App.jsx 接线(handleRollback 无法在 node 里真跑,钉关键写法;改回旧写法会红)─────────
const { readFileSync } = await import('node:fs');
const A = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
const RB = A.slice(A.indexOf('const handleRollback = useCallback'), A.indexOf('useEffect(() => { handleRollbackRef.current = handleRollback; }'));
await t('3 回滚:先停(等回话)→ 还原文件 → 裁剪(带重试)', async () => {
  const iStop = RB.indexOf('await stopTurnAndWait({ pid: _rbPid, owner: _rbOwner });');
  const iRestore = RB.indexOf('// 1) git restore only for modes that explicitly include files.');
  const iTrim = RB.indexOf("await runHistoryOpSettled(sel.sessionId, 'trim', body)");
  assert.ok(iStop > 0 && iStop < iRestore && iRestore < iTrim, `${iStop} / ${iRestore} / ${iTrim}`);
  assert.ok(!/runHistoryOp\(sel\.sessionId, 'trim'/.test(RB), '回滚裁剪不许再走不重试的单次调用');
});
await t('3 回滚裁剪最终失败:不重发、不截界面,内容放回输入框,提示写明会话记录没有改动', async () => {
  const iFail = RB.indexOf('if (trimFailed) {\n      const where = placeBackForOwner();');
  assert.ok(iFail > 0, '失败分支');
  const failBlk = RB.slice(iFail, RB.indexOf('return;', iFail) + 7);
  assert.ok(failBlk.includes('会话记录没有改动'));
  assert.ok(!failBlk.includes('resendReplacing') && !failBlk.includes('truncateUi'));
  assert.ok(iFail < RB.indexOf('truncateUi();\n') && iFail < RB.indexOf('resendReplacing('), '失败分支在截界面与重发之前返回');
  assert.ok(!A.includes("text: '会话记录裁剪失败,回退可能不完整"), '旧的「照样重发」提示已去掉');
});
await t('3 「回退进行中」标记:入队门、流收尾排空、后台轮询排空三处都看它;回滚各出口清', async () => {
  assert.match(A, /!opts\.forceSend && \(streamingRef\.current \|\| backgroundPidRef\.current \|\| rollbackBusyRef\.current\)/);
  const drains = [...A.matchAll(/if \(rollbackBusyRef\.current\) return;\n\s*const (?:next|q) = useStore\.getState\(\)\.shiftMessage\(drainKey\);/g)];
  assert.equal(drains.length, 2, '两处排空都要在弹队之前看标记');
  assert.match(RB, /rollbackBusyRef\.current = rbBusy;\n\s*let rbHandedOff = false;\n\s*try \{/);
  assert.match(RB, /\} finally \{\n[^\n]*\n\s*if \(!rbHandedOff && rollbackBusyRef\.current === rbBusy\) rollbackBusyRef\.current = null;/);
  assert.ok(RB.indexOf('rbHandedOff = true;') < RB.indexOf('resendReplacing('), '交接在调 resendReplacing 之前');
  const RS = A.slice(A.indexOf('const resendReplacing = useCallback'), A.indexOf('// Auto-reattach:'));
  assert.match(RS, /if \(!paneStillOn\(ownerKey\)\) \{ releaseBusy\(\); onAbandon\?\.\(\); return; \}/, '放弃时清');
  assert.match(RS, /try \{\n\s*handleSendRef\.current\?\.\(text, \{ \.\.\.opts, forceSend: true \}\);\n\s*\} finally \{ releaseBusy\(\); \}/, '发出时清');
});

console.log(`\n[check-r188-rollback-flow] ${passed} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.error('  ✗ ' + f); process.exit(1); }
