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
  // r196:门里多了 bgSendAhead(本会话队首正在自动发出),仍在 !opts.forceSend && ( … ) 这一个括号里 —— 回退重发照旧豁免。
  assert.match(A, /!opts\.forceSend && \(streamingRef\.current \|\| backgroundPidRef\.current \|\| rollbackBusyFor\(rollbackBusyRef\.current, sessionQueueKey\) \|\| bgSendAhead\)\)/);
  assert.ok(!/if \(rollbackBusyRef\.current\) return;/.test(A), '排空不许只看标记在不在(要按会话键)');
  assert.match(RB, /const rbBusy = \{ key: rbKey \};/);
  assert.match(RB, /rbKey = draftKey;[^\n]*\n\s*rbBusy\.key = draftKey;/, '会话被裁空转草稿时标记跟着换键');
  assert.match(A, /const rtBusy = \{ key: rtKey \};/);
  const drains = [...A.matchAll(/if \(rollbackBusyFor\(rollbackBusyRef\.current, drainKey\)\) return;\n\s*const (?:next|q) = useStore\.getState\(\)\.shiftMessage\(drainKey\);/g)];
  assert.equal(drains.length, 2, '两处排空都要在弹队之前看标记');
  assert.match(RB, /rollbackBusyRef\.current = rbBusy;\n\s*let rbHandedOff = false;\n\s*try \{/);
  assert.match(RB, /\} finally \{\n[^\n]*\n\s*if \(!rbHandedOff && rollbackBusyRef\.current === rbBusy\) rollbackBusyRef\.current = null;/);
  assert.ok(RB.indexOf('rbHandedOff = true;') < RB.indexOf('resendReplacing('), '交接在调 resendReplacing 之前');
  const RS = A.slice(A.indexOf('const resendReplacing = useCallback'), A.indexOf('// Auto-reattach:'));
  assert.match(RS, /if \(!paneStillOn\(ownerKey\)\) \{ releaseBusy\(\); onAbandon\?\.\(\); return; \}/, '放弃时清');
  assert.match(RS, /try \{\n\s*handleSendRef\.current\?\.\(text, \{ \.\.\.opts, forceSend: true \}\);\n\s*\} finally \{ releaseBusy\(\); \}/, '发出时清');
});

const { rollbackBusyFor } = await import('../../client/src/utils/historyOps.js');
await t('3 标记按会话生效:属于会话甲时,乙的发送与排空不受影响,甲自己的受影响', async () => {
  const busy = { key: 'sess-A' };
  assert.equal(rollbackBusyFor(busy, 'sess-A'), true);
  assert.equal(rollbackBusyFor(busy, 'sess-B'), false);
  assert.equal(rollbackBusyFor(null, 'sess-A'), false);
  assert.equal(rollbackBusyFor(busy, null), false);
  assert.equal(rollbackBusyFor({}, 'sess-A'), false, '没有键的标记不作用于任何会话');
  busy.key = 'draft-X'; // 会话被裁空转草稿,同一个对象换键
  assert.equal(rollbackBusyFor(busy, 'sess-A'), false);
  assert.equal(rollbackBusyFor(busy, 'draft-X'), true);
});

await t('3 「正在停止」提示:两处显示都用常量 + 时长,回滚成功截界面后与切走分支、重做裁剪成功后按文本撤', async () => {
  assert.ok(!A.includes("'正在停止当前回合"), '提示文本不许再写成字面量');
  // r188b:两处显示都带发起回退的会话键(回退用 rbKey、重做此工具用 rtKey),不带键的旧写法不许再出现。
  const show = (s) => A.split(`setProviderSwitchNotice({ text: ROLLBACK_STOPPING_NOTICE, ttlMs: ROLLBACK_STOPPING_NOTICE_MS${s} });`).length - 1;
  assert.equal(show(', ownerKey: rbKey'), 1);
  assert.equal(show(', ownerKey: rtKey'), 1);
  assert.equal(show(''), 0, '「正在停止」提示必须带会话键');
  const CLR = 'setProviderSwitchNotice((cur) => (cur?.text === ROLLBACK_STOPPING_NOTICE ? null : cur));';
  assert.equal(A.split(CLR).length - 1, 3);
  const iT = RB.indexOf('    truncateUi();\n');
  assert.ok(iT > 0 && RB.indexOf(CLR, iT) - iT < 200, '截界面之后紧跟着撤');
});

// ── 4. r188b 重入守卫(页面用例只有 B6「连点两次仅回退消息」;下面守没有页面用例的路径)──────────
const { ROLLBACK_BUSY_NOTICE } = await import('../../client/src/utils/historyOps.js');
const RT = A.slice(A.indexOf('const handleRetryTool = useCallback'), A.indexOf('const handleRetryToolRef'));
const RS4 = A.slice(A.indexOf('const resendReplacing = useCallback'), A.indexOf('// Auto-reattach:'));
const cutGuard = (src, head) => {
  const s = src.indexOf(head);
  assert.ok(s > 0, `找不到守卫:${head}`);
  const e = src.indexOf('      return;\n    }\n', s);
  assert.ok(e > s);
  return { start: s, code: src.slice(s, e + '      return;\n    }\n'.length) };
};
const RBG = cutGuard(RB, 'if (rollbackBusyFor(rollbackBusyRef.current, rbKey)');
const RTG = cutGuard(RT, 'if (rollbackBusyFor(rollbackBusyRef.current, rtKey)');
// 抠出回退函数里的守卫真跑:返回 'pass' = 没拦、往下走;返回 undefined = 拦下。
const runRbGuard = new Function('rollbackBusyFor', 'rollbackBusyRef', 'rbKey', 'mode', 'resendText', 'placeBackForOwner', 'setProviderSwitchNotice', 'ROLLBACK_BUSY_NOTICE',
  RBG.code + "\nreturn 'pass';");
const rbCase = ({ busyKey = 'k', mode, resendText = null }) => {
  const log = { placed: 0, notices: [] };
  const ref = { current: busyKey ? { key: busyKey } : null };
  const r = runRbGuard(rollbackBusyFor, ref, 'k', mode, resendText,
    () => { log.placed += 1; return '要重发的内容已放回输入框，确认后再发送。'; },
    (n) => log.notices.push(n), ROLLBACK_BUSY_NOTICE);
  return { blocked: r !== 'pass', ...log, refAfter: ref.current };
};
await t('4 编辑重发的发出被拦:新内容放回输入框,提示带会话键并接上放回结果;标记不动', async () => {
  const c = rbCase({ mode: 'both', resendText: { prompt: '新写的内容', options: {} } });
  assert.equal(c.blocked, true);
  assert.equal(c.placed, 1);
  assert.deepEqual(c.notices, [{ text: ROLLBACK_BUSY_NOTICE + '要重发的内容已放回输入框，确认后再发送。', ownerKey: 'k' }]);
  assert.deepEqual(c.refAfter, { key: 'k' });
});
await t('4 其它被拦的操作(仅回退 / 消息和文件 / 重做回复 / 只还原文件 / 两种定向压缩)不往输入框放东西', async () => {
  for (const mode of ['message', 'both', 'files', 'summarize-before', 'summarize-after']) {
    const c = rbCase({ mode });
    assert.equal(c.blocked, true, mode);
    assert.equal(c.placed, 0, mode);
    assert.deepEqual(c.notices, [{ text: ROLLBACK_BUSY_NOTICE, ownerKey: 'k' }], mode);
  }
});
await t('4 不误拦:编辑后重发的回填、没有回退在进行、别的会话在回退', async () => {
  assert.equal(rbCase({ mode: 'edit' }).blocked, false, 'edit 回填不拦');
  for (const mode of ['message', 'both', 'files', 'summarize-before']) {
    assert.equal(rbCase({ busyKey: null, mode }).blocked, false, mode);
    assert.equal(rbCase({ busyKey: 'other', mode }).blocked, false, mode);
  }
  assert.equal(rbCase({ mode: 'edit', resendText: { prompt: 'x' } }).blocked, true, 'edit 带着新内容 = 发出,要拦');
});
await t('4 回退函数的守卫排在定向压缩 / 只还原文件的确认框与挂标记之前、放回输入框那一段之后', async () => {
  assert.ok(RB.indexOf('const placeBackForOwner = () => {') < RBG.start);
  for (const mark of ["if (mode === 'summarize-before' || mode === 'summarize-after') {", "if (mode === 'files') {", "if (mode === 'edit' && (composerText || hasAttach)) {", 'rollbackBusyRef.current = rbBusy;', 'killedRef.current = true;']) {
    const i = RB.indexOf(mark);
    assert.ok(i > RBG.start, `守卫应在「${mark}」之前`);
  }
  assert.ok(!/await|confirmDialog|killedRef|abortRef|rollbackBusyRef\.current =/.test(RBG.code), '被拦下的这一次不等待、不弹框、不碰窗格状态与标记');
});
await t('4 重做此工具:守卫在乐观截断与一切副作用之前,被拦时只给带键提示', async () => {
  for (const mark of ['const projectHash =', 'setProviderSwitchNotice({ text: \'正在回退会话', 'setLocalMessages(', 'setRetryActiveUuid(turn.uuid)', '(async () => {', 'rollbackBusyRef.current = rtBusy;']) {
    const i = RT.indexOf(mark);
    assert.ok(i > RTG.start, `守卫应在「${mark}」之前`);
  }
  assert.ok(!/onTrimmed|await|killedRef|abortRef|rollbackBusyRef\.current =/.test(RTG.code));
  const run = new Function('rollbackBusyFor', 'rollbackBusyRef', 'rtKey', 'setProviderSwitchNotice', 'ROLLBACK_BUSY_NOTICE', RTG.code + "\nreturn 'pass';");
  const n = [];
  assert.equal(run(rollbackBusyFor, { current: { key: 'k' } }, 'k', (x) => n.push(x), ROLLBACK_BUSY_NOTICE), undefined);
  assert.deepEqual(n, [{ text: ROLLBACK_BUSY_NOTICE, ownerKey: 'k' }]);
  assert.equal(run(rollbackBusyFor, { current: null }, 'k', (x) => n.push(x), ROLLBACK_BUSY_NOTICE), 'pass');
  assert.equal(run(rollbackBusyFor, { current: { key: 'other' } }, 'k', (x) => n.push(x), ROLLBACK_BUSY_NOTICE), 'pass');
});
await t('4 重发函数只清调用方传入的那个标记:标记是参数,不在被调用时读槽;三个调用点各传自己的', async () => {
  assert.match(RS4, /const resendReplacing = useCallback\(\(text, opts = \{\}, busy = null\) => \{/);
  assert.ok(!RS4.includes('= rollbackBusyRef.current;'), '不许再在被调用时读槽当自己的标记');
  const line = RS4.match(/const releaseBusy = [^\n]*/)[0];
  const rel = new Function('busy', 'rollbackBusyRef', `${line}\nreleaseBusy();`);
  const mine = { key: 'k' }; const second = { key: 'k' };
  const ref = { current: second };
  rel(mine, ref);
  assert.equal(ref.current, second, '槽里已是第二次的标记:第一次的重发不得清掉它');
  rel(second, ref);
  assert.equal(ref.current, null);
  ref.current = mine; rel(null, ref);
  assert.equal(ref.current, mine, '没传标记时什么都不清');
  assert.equal(RB.split(', rbBusy);').length - 1, 2, '回退函数两处调用都传 rbBusy');
  assert.match(RT, /\{ appendSystemPrompt, hiddenUserMessage: true \},\n\s*rtBusy,\n\s*\);/);
});

console.log(`\n[check-r188-rollback-flow] ${passed} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.error('  ✗ ' + f); process.exit(1); }
