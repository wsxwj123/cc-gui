// r206-followups-1120 白盒单测:页面上造不出来的两条。
//   1. 回滚时裁剪请求已成功、请求回来之后「转成新草稿」那几步出错:不算裁剪失败,黄字照接口文件第 1 条写,
//      静默重新拉一次本会话的消息;中途切走那条路径也不说裁剪失败。
//   2. 历史操作已经回过页面之后才抛错:不再回 500、不多记一行 [history-op] 失败,只留一行诊断。
// 第 1 条把 App.jsx 回滚函数里的两段原样取出来,配上替身跑一遍(走的是真实代码,不是照抄);第 2 条直接调真实路由。
// 跑法:node tests/unit/check-r206-followups.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  trimFailureReason, rollbackFollowupFailedText, ROLLBACK_FOLLOWUP_FAILED_NOTICE, ROLLBACK_REFRESH_HINT,
  ROLLBACK_STOPPING_NOTICE,
} from '../../client/src/utils/historyOps.js';

let passed = 0;
const fails = [];
const t = async (name, fn) => {
  try { await fn(); passed += 1; } catch (err) { fails.push(`${name}: ${err.message}`); }
};

// 接口文件「对外行为变化」第 1 条的原文。
const FIRST = '会话记录已回退，但页面接着处理时出错，原定的重发没有发出。';
const REFRESH = '刷新后可看到最新的会话记录。';
const PLACED = '要重发的内容已放回输入框，确认后再发送。';
const RESTORED = '工作区文件已还原到这条消息发送前的状态。';

// ── 1a. 文案 ──────────────────────────────────────────────────────────────────────
await t('1a 常量与接口文件原文一致', () => {
  assert.equal(ROLLBACK_FOLLOWUP_FAILED_NOTICE, FIRST);
  assert.equal(ROLLBACK_REFRESH_HINT, REFRESH);
});
await t('1a 黄字顺序:第一句 → 放回输入框 → 文件结果 → 提示刷新;空段跳过', () => {
  assert.equal(rollbackFollowupFailedText({ where: PLACED, fileNote: RESTORED }), FIRST + PLACED + RESTORED + REFRESH);
  assert.equal(rollbackFollowupFailedText({ where: PLACED }), FIRST + PLACED + REFRESH);
  assert.equal(rollbackFollowupFailedText(), FIRST + REFRESH);
});
await t('1a 黄字里没有「裁剪失败」「会话记录没有改动」', () => {
  const s = rollbackFollowupFailedText({ where: PLACED, fileNote: RESTORED });
  assert.ok(!s.includes('裁剪失败') && !s.includes('会话记录没有改动'), s);
});

// ── 取出 App.jsx 回滚函数里的两段真实代码 ─────────────────────────────────────────
const A = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
const RB = A.slice(A.indexOf('const handleRollback = useCallback'), A.indexOf('useEffect(() => { handleRollbackRef.current = handleRollback; }'));
const cut = (from, to, incl = false) => {
  const i = RB.indexOf(from);
  const j = RB.indexOf(to, i + 1);
  assert.ok(i > 0 && j > i, `取不到代码段 ${from.slice(0, 30)} … ${to.slice(0, 30)}`);
  return RB.slice(i, incl ? j + to.length : j);
};
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// 段一:裁剪请求 + 请求回来之后的页面处理(转新草稿)。
const TRIM = cut('let tr = null;', '} catch { trimFollowupFailed = true; }', true);
const runTrim = new AsyncFunction('ctx', `
  let { runHistoryOpSettled, sel, body, stillHere, newDraftId, queueKeyFor, useStore, setSelectedSession, rbKey, rbBusy } = ctx;
  let trimFailed = false, trimFailure = null, wipedAway = false, sessionWasReset = false, trimFollowupFailed = false;
  ${TRIM}
  return { trimFailed, trimFailure, wipedAway, sessionWasReset, trimFollowupFailed, rbKey, rbBusyKey: rbBusy.key };
`);
const trimCtx = (over = {}) => ({
  runHistoryOpSettled: async () => ({ ok: true }),
  sel: { sessionId: 'sid-a', projectHash: 'ph' },
  body: {},
  stillHere: () => true,
  newDraftId: () => 'd1',
  queueKeyFor: (s) => (s.draftId ? `draft:${s.draftId}` : s.sessionId),
  useStore: { getState: () => ({ migrateSessionKey: () => {} }) },
  setSelectedSession: () => {},
  rbKey: 'sid-a',
  rbBusy: { key: 'sid-a' },
  ...over,
});
const boom = () => { throw new Error('page step failed'); };

await t('1b 请求成功、会话被裁空、迁移设置时抛错 → 不算裁剪失败,记成页面处理出错', async () => {
  const r = await runTrim(trimCtx({
    runHistoryOpSettled: async () => ({ ok: true, sessionReset: true }),
    useStore: { getState: () => ({ migrateSessionKey: boom }) },
  }));
  assert.equal(r.trimFailed, false);
  assert.equal(r.trimFailure, null);
  assert.equal(r.trimFollowupFailed, true);
});
await t('1b 请求成功、换窗格会话时抛错 → 同上', async () => {
  const r = await runTrim(trimCtx({ runHistoryOpSettled: async () => ({ ok: true, sessionReset: true }), setSelectedSession: boom }));
  assert.equal(r.trimFailed, false);
  assert.equal(r.trimFollowupFailed, true);
});
await t('1b 裁剪请求本身抛异常 → 裁剪失败(请求没有发出去),不算页面处理出错', async () => {
  const r = await runTrim(trimCtx({ runHistoryOpSettled: async () => { throw new Error('network'); } }));
  assert.equal(r.trimFailed, true);
  assert.deepEqual(r.trimFailure, { thrown: true });
  assert.equal(trimFailureReason(r.trimFailure), '原因：请求没有发出去。');
  assert.equal(r.trimFollowupFailed, false);
});
await t('1b 接口回失败 → 裁剪失败,原因取失败结果', async () => {
  const fail = { ok: false, code: 'SESSION_RUNNING', error: 'x' };
  const r = await runTrim(trimCtx({ runHistoryOpSettled: async () => fail }));
  assert.equal(r.trimFailed, true);
  assert.equal(r.trimFailure, fail);
  assert.equal(r.trimFollowupFailed, false);
});
await t('1b 回归:会话被裁空且各步正常 → 转成新草稿,标记换键,无失败', async () => {
  const r = await runTrim(trimCtx({ runHistoryOpSettled: async () => ({ ok: true, sessionReset: true }) }));
  assert.deepEqual([r.trimFailed, r.trimFollowupFailed, r.sessionWasReset, r.rbKey, r.rbBusyKey], [false, false, true, 'draft:d1', 'draft:d1']);
});
await t('1b 回归:会话被裁空时窗格已切走 → 只记 wipedAway,不做窗格动作', async () => {
  const r = await runTrim(trimCtx({ runHistoryOpSettled: async () => ({ ok: true, sessionReset: true }), stillHere: () => false, setSelectedSession: boom }));
  assert.deepEqual([r.trimFailed, r.trimFollowupFailed, r.wipedAway, r.sessionWasReset], [false, false, true, false]);
});

// 段二:裁剪之后的分支(切走 / 裁剪失败 / 页面处理出错),到「3) 清流式显示」之前为止。
const POST = cut('// r146 R3:裁剪期间切走', '// 3) 在跑的回合已在破坏性阶段开头停下(r188)');
const POST_NAMES = ['stillHere', 'trimFailed', 'queueKeyFor', 'sel', 'dropRetainedSince', 'rbCutTs', 'setProviderSwitchNotice',
  'ROLLBACK_STOPPING_NOTICE', 'trimFollowupFailed', 'leaveForOwner', 'diskNotes', 'ROLLBACK_REFRESH_HINT', 'trimFailureReason',
  'trimFailure', 'wipedAway', 'rbFileOutcome', 'placeBackForOwner', 'rollbackFollowupFailedText', 'fetchMessagesForTab', 'projectHash'];
const runPost = new AsyncFunction('ctx', `let { ${POST_NAMES.join(', ')} } = ctx;\n${POST}\nreturn 'continued';`);
const postCtx = (over = {}) => {
  const log = { notices: [], leave: [], fetches: [], dropped: [] };
  const ctx = {
    stillHere: () => true, trimFailed: false, trimFollowupFailed: false, trimFailure: null, wipedAway: false,
    queueKeyFor: (s) => s.sessionId, sel: { sessionId: 'sid-a', projectHash: 'ph' }, projectHash: 'ph', rbCutTs: 123,
    dropRetainedSince: (k, ts) => log.dropped.push([k, ts]),
    setProviderSwitchNotice: (v) => log.notices.push(v),
    ROLLBACK_STOPPING_NOTICE, ROLLBACK_REFRESH_HINT, trimFailureReason, rollbackFollowupFailedText,
    leaveForOwner: (o) => log.leave.push(o), diskNotes: ['磁盘提示。'], rbFileOutcome: 'restored',
    placeBackForOwner: () => PLACED,
    fetchMessagesForTab: async (...a) => { log.fetches.push(a); },
    ...over,
  };
  return { ctx, log };
};

await t('1c 留在本会话、页面处理出错:黄字照接口文件,静默重拉本会话,不往下走(不截界面、不重发)', async () => {
  const { ctx, log } = postCtx({ trimFollowupFailed: true });
  assert.equal(await runPost(ctx), undefined, '应在这个分支里返回');
  assert.equal(log.notices.length, 1);
  assert.equal(log.notices[0].text, FIRST + PLACED + RESTORED + REFRESH);
  assert.deepEqual(log.fetches, [['sid-a', 'ph', { silent: true }]]);
  assert.deepEqual(log.dropped, [['sid-a', 123]], '磁盘已裁:留存副本按截断点删');
  assert.equal(log.leave.length, 0);
});
await t('1c 回归:留在本会话、裁剪失败 → 仍说裁剪失败与原因,不重拉', async () => {
  const { ctx, log } = postCtx({ trimFailed: true, trimFailure: { thrown: true } });
  assert.equal(await runPost(ctx), undefined);
  assert.equal(log.notices[0].text, '会话记录裁剪失败，会话记录没有改动，原定的重发没有发出。原因：请求没有发出去。' + PLACED + RESTORED);
  assert.equal(log.fetches.length, 0);
  assert.equal(log.dropped.length, 0);
});
await t('1d 中途切走、页面处理出错:按已裁空留给本会话并提示刷新,不说裁剪失败,不替别的窗格拉历史', async () => {
  const { ctx, log } = postCtx({ trimFollowupFailed: true, stillHere: () => false });
  assert.equal(await runPost(ctx), undefined);
  assert.equal(log.leave.length, 1);
  assert.deepEqual(log.leave[0], { notes: ['磁盘提示。', REFRESH], wiped: true });
  assert.equal(log.fetches.length, 0);
  assert.deepEqual(log.dropped, [['sid-a', 123]]);
});
await t('1d 回归:中途切走、裁剪成功 → trimOk 为真;裁剪失败 → 带原因', async () => {
  const ok = postCtx({ stillHere: () => false });
  await runPost(ok.ctx);
  assert.deepEqual(ok.log.leave[0], { notes: ['磁盘提示。'], trimOk: true, trimReason: '', wiped: false });
  const bad = postCtx({ stillHere: () => false, trimFailed: true, trimFailure: { thrown: true } });
  await runPost(bad.ctx);
  assert.deepEqual(bad.log.leave[0], { notes: ['磁盘提示。'], trimOk: false, trimReason: '原因：请求没有发出去。', wiped: false });
});
await t('1d 已裁空的留言(leaveForOwner 的 wiped 分支)本身不说裁剪失败', () => {
  const i = RB.indexOf('const leaveForOwner = (');
  const wipedBlk = RB.slice(i, RB.indexOf('return;', i));
  assert.ok(wipedBlk.includes('会话记录已清空，原定的重发没有发出。') && !wipedBlk.includes('裁剪失败'));
});
await t('1e 回归:都正常 → 往下走到清流式显示', async () => {
  const { ctx, log } = postCtx();
  assert.equal(await runPost(ctx), 'continued');
  assert.equal(log.notices.length, 0);
  assert.equal(log.fetches.length, 0);
});

// ── 2. 历史操作入口外层 catch ──────────────────────────────────────────────────────
const { default: router } = await import('../../server/routes/session-history.js');
const layer = router.stack.find((l) => l.route?.path === '/sessions/:sessionId/trim' && l.route.methods?.post);
const handle = layer?.route?.stack?.[0]?.handle;
const callWithWarnCapture = async (res) => {
  const lines = [];
  const orig = console.warn;
  console.warn = (...a) => { lines.push(a.join(' ')); };
  try {
    // 身份不合法 → 入口先回 400(这是一次真实失败,记一行 [history-op])。
    await handle({ params: { sessionId: 'not a valid id' }, body: { projectHash: 'ph', dryRun: false }, headers: {} }, res);
  } finally { console.warn = orig; }
  return lines;
};

await t('2a 找得到裁剪入口', () => { assert.equal(typeof handle, 'function'); });
await t('2b 已回过页面之后才抛错:不再回 500,不多记失败行,只留一行诊断', async () => {
  const sent = [];
  const res = {
    headersSent: false,
    status(code) { sent.push(code); return this; },
    json() { this.headersSent = true; const e = new Error('写完之后出错 /Users/x/secret.jsonl'); e.code = 'EPIPE'; throw e; },
  };
  const lines = await callWithWarnCapture(res);
  assert.deepEqual(sent, [400], `只回过一次 400,实际 ${JSON.stringify(sent)}`);
  const opLines = lines.filter((l) => l.includes('[history-op]'));
  assert.equal(opLines.length, 1, `[history-op] 只应有真实失败那一行,实际 ${JSON.stringify(lines)}`);
  assert.match(opLines[0], /status=400/);
  const diag = lines.filter((l) => l.includes('已回过页面之后出错'));
  assert.equal(diag.length, 1, JSON.stringify(lines));
  assert.ok(!diag[0].includes('[history-op'), diag[0]);
  assert.match(diag[0], /op=trim/);
  assert.match(diag[0], /err=EPIPE/);
  assert.ok(!diag[0].includes('/Users/') && !diag[0].includes('secret'), '不记错误原文(可能含路径)');
});
await t('2c 回归:还没回过页面就抛错 → 照旧记一行失败并回 500', async () => {
  const sent = [];
  let first = true;
  const res = {
    headersSent: false,
    status(code) {
      if (first) { first = false; throw new Error('first send failed'); } // 发送前就出错,响应头没发
      sent.push(code); return this;
    },
    json(body) { this.headersSent = true; this.body = body; return this; },
  };
  const lines = await callWithWarnCapture(res);
  assert.deepEqual(sent, [500]);
  assert.equal(res.body?.code, 'SESSION_OPERATION_FAILED');
  const opLines = lines.filter((l) => l.includes('[history-op]'));
  assert.equal(opLines.length, 2, JSON.stringify(lines));
  assert.match(opLines[1], /code=SESSION_OPERATION_FAILED status=500/);
  assert.ok(!lines.some((l) => l.includes('已回过页面之后出错')));
});

console.log(`\n[check-r206-followups] ${passed} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.error('  ✗ ' + f); process.exit(1); }
process.exit(0);
