// r99 开发自测(③ 竞态):handleRetryTool 里"先停在飞回合、再截断会话文件"的调用顺序。
// 做法:把 App.jsx 里那段 async IIFE 的【真实源码】抠出来,注入 mock fetch 与桩 ref 后
// 真跑一遍,记录 fetch 的 URL 顺序 —— 不是转写一份等价代码来自证(那种测试只能测转写)。
// 跑法:node tests/unit/check-r99-dev-order.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const A = readFileSync(path.join(ROOT, 'client/src/App.jsx'), 'utf8');

let pass = 0;
const fails = [];
const t = (name, fn) => fn().then(() => { pass++; }, (e) => { fails.push(`${name}: ${e.message}`); });

// ── 从 App.jsx 抠出 handleRetryTool 里的 async IIFE 主体 ──────────────
const fnStart = A.indexOf('const handleRetryTool = useCallback');
const open = A.indexOf('(async () => {', fnStart);
const close = A.indexOf('})();', open);
assert.ok(fnStart > 0 && open > fnStart && close > open, '抠不出 handleRetryTool 的 async IIFE —— 结构变了,先看源码');
const BODY = A.slice(open + '(async () => {'.length, close);

const PARAMS = [
  'fetch', 'sel', 'projectHash', 'toolCall', 'opts', 'appendSystemPrompt',
  'killedRef', 'abortRef', 'activeProcRef', 'backgroundPidRef', 'stoppedPidsRef',
  'setBackgroundPid', 'updateStreaming', 'setStreamingText', 'setStreamingThinking',
  'setStreamingToolCalls', 'setStreamingBlocks', 'setStreamHistCutoff',
  'fetchMessagesForTab', 'resendReplacing', 'confirmDialog', 'setRetryActiveUuid',
  // R25:裁剪改走统一入口(App.jsx 顶部 import 的 utils/historyOps.js → runHistoryOp,
  // 内部"预览 → 提交"两步)。注入它不等于放松:替身只记录 op 名、返回成功信封,
  // 下面所有顺序断言一字未动(不注入 = 真实源码必抛 "runHistoryOp is not defined",
  // 三条用例会以"环境不成立"而不是"顺序错了"收场)。
  'runHistoryOp',
  // r146 R3 同族:裁剪返回后先复查"本窗格仍是发起重做的会话"(rtKey 是发起时的会话键)。注入同样
  // 不放松:替身恒答"仍在本会话",下面的顺序断言一字未动(不注入 = 真实源码必抛 "paneStillOn is
  // not defined",用例会以"环境不成立"收场)。
  'paneStillOn', 'rtKey',
  // r188:「重做此工具」的留存清表挪到裁剪成功之后(按截断点删)。替身只记录调用,用来断言它排在裁剪
  // 成功之后、裁剪失败时不调用。
  'dropRetainedSince', 'rtCutTs',
  // r188:先停、等它停稳、再裁。等停止与裁剪重试是 utils/historyOps.js 里的两个纯函数,注入的是【真实实现】
  // (停止走上面的 mock fetch、裁剪走 runHistoryOp 替身),身份取法注入真实的 resolveStopOwner;
  // 「回退进行中」标记与提示只是 ref / setter 替身。
  'resolveStopOwner', 'activeProcOwnerRef', 'stopTurnAndWait', 'runHistoryOpSettled',
  'rollbackBusyRef', 'setProviderSwitchNotice',
];
const { stopTurnAndWait, runHistoryOpSettled } = await import('../../client/src/utils/historyOps.js');
const { resolveStopOwner } = await import('../../client/src/utils/sessionFlowIdentity.js');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const run = new AsyncFunction(...PARAMS, BODY);

// 桩:只记录调用,不做任何真实 IO。
function harness({ activePid = 'pid-1', bgPid = null, stopHangs = false, opts = {}, trimFails = false, trimRunningTimes = 0, owner = null, paneStays = true } = {}) {
  const calls = [];
  const sent = [];
  const stopBodies = [];
  const busySeen = [];
  let trimTries = 0;
  const rollbackBusyRef = { current: null };
  const fetchMock = (url, init) => {
    calls.push(String(url));
    if (String(url).includes('/stop')) { stopBodies.push(JSON.parse(init?.body || '{}')); busySeen.push(rollbackBusyRef.current != null); }
    if (String(url).includes('/stop') && stopHangs) return new Promise(() => {}); // 永不 resolve
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  };
  const noop = () => {};
  const ctx = {
    fetch: fetchMock,
    sel: { sessionId: 'sess-1' },
    projectHash: 'ph-1',
    toolCall: { id: 'toolB', name: 'Bash', input: {} },
    opts,
    appendSystemPrompt: 'SYS',
    killedRef: { current: false },
    abortRef: { current: { abort: () => calls.push('abort') } },
    activeProcRef: { current: activePid },
    backgroundPidRef: { current: bgPid },
    stoppedPidsRef: { current: new Set() },
    setBackgroundPid: noop,
    updateStreaming: noop,
    setStreamingText: noop, setStreamingThinking: noop,
    setStreamingToolCalls: noop, setStreamingBlocks: noop, setStreamHistCutoff: noop,
    fetchMessagesForTab: async () => { calls.push('refetch'); },
    resendReplacing: (text, o) => { calls.push('resend'); sent.push({ text, o, busyAtResend: rollbackBusyRef.current != null }); },
    confirmDialog: (m) => { calls.push('confirmDialog:' + m); },
    setRetryActiveUuid: noop,
    // R25 的统一入口替身:记 `runHistoryOp:<op>`(下面的 idx 用 includes 找 'trim-before-tool',
    // 同时证明这次裁剪确实经统一入口,不是又冒出一条自拼 fetch 的旁路)。
    runHistoryOp: async (sessionId, op, params = {}) => {
      calls.push(`runHistoryOp:${op}${params.toolUseId ? ':' + params.toolUseId : ''}`);
      busySeen.push(rollbackBusyRef.current != null);
      trimTries += 1;
      if (trimTries <= trimRunningTimes) return { ok: false, status: 409, code: 'SESSION_RUNNING', error: 'running' };
      if (trimFails) return { ok: false, status: 500, code: 'WRITE_FAILED', error: 'boom' };
      return { ok: true, status: 200, data: {} };
    },
    paneStillOn: () => paneStays,
    rtKey: 'sess-1',
    dropRetainedSince: (k, cut) => { calls.push(`dropRetainedSince:${k}:${cut}`); },
    rtCutTs: 12345,
    resolveStopOwner,
    activeProcOwnerRef: { current: owner ? { pid: activePid, owner } : null },
    stopTurnAndWait, runHistoryOpSettled,
    rollbackBusyRef,
    setProviderSwitchNotice: noop,
  };
  return { calls, sent, ctx, stopBodies, busySeen, rollbackBusyRef, trimTries: () => trimTries, go: () => run(...PARAMS.map((p) => ctx[p])) };
}

const idx = (calls, needle) => calls.findIndex((c) => c.includes(needle));

await t('③ 在飞回合先停,再截断会话文件', async () => {
  const h = harness();
  await h.go();
  const s = idx(h.calls, '/stop');
  const tr = idx(h.calls, 'trim-before-tool');
  assert.ok(s >= 0, 'stop 没被调用');
  assert.ok(tr >= 0, 'trim 没被调用');
  assert.ok(s < tr, `stop@${s} 必须早于 trim@${tr};实际顺序:${h.calls.join(' → ')}`);
});

await t('③ 后台化回合(无 activeProc)同样先停后 trim', async () => {
  const h = harness({ activePid: null, bgPid: 'pid-bg' });
  await h.go();
  assert.ok(idx(h.calls, '/stop') < idx(h.calls, 'trim-before-tool'), h.calls.join(' → '));
});

await t('③ stop 卡死时超时兜底放行,不把回退永久挂住', async () => {
  const h = harness({ stopHangs: true });
  const t0 = Date.now();
  await h.go();
  const dt = Date.now() - t0;
  assert.ok(idx(h.calls, 'trim-before-tool') >= 0, `超时后必须继续 trim;实际:${h.calls.join(' → ')}`);
  assert.ok(dt >= 1000 && dt < 6000, `兜底等待应在秒级,实际 ${dt}ms`);
});

await t('③ 无在飞进程时不空等,直接 trim', async () => {
  const h = harness({ activePid: null, bgPid: null });
  const t0 = Date.now();
  await h.go();
  assert.equal(idx(h.calls, '/stop'), -1, '没有在飞进程就不该发 stop');
  assert.ok(idx(h.calls, 'trim-before-tool') >= 0);
  assert.ok(Date.now() - t0 < 500, '没有 stop 就不该等超时');
});

await t('③ 顺序全景:stop → trim → refetch → resend', async () => {
  const h = harness();
  await h.go();
  const seq = ['/stop', 'trim-before-tool', 'refetch', 'resend'].map((n) => idx(h.calls, n));
  assert.ok(seq.every((v) => v >= 0), `有环节缺失:${h.calls.join(' → ')}`);
  for (let i = 1; i < seq.length; i++) {
    assert.ok(seq[i - 1] < seq[i], `顺序错:${h.calls.join(' → ')}`);
  }
});

// ── r188:留存清表只在裁剪成功之后 ─────────────────────────────────────
await t('r188 裁剪成功后才按截断点清表(排在裁剪之后、重发之前)', async () => {
  const h = harness();
  await h.go();
  const d = idx(h.calls, 'dropRetainedSince:');
  assert.ok(d > idx(h.calls, 'trim-before-tool'), `清表必须在裁剪之后:${h.calls.join(' → ')}`);
  assert.ok(d < idx(h.calls, 'resend'), `清表在重发之前:${h.calls.join(' → ')}`);
  assert.ok(h.calls.includes('dropRetainedSince:sess-1:12345'), '按截断点删');
});
await t('r188 裁剪失败时不清表、不重发', async () => {
  const h = harness({ trimFails: true });
  await h.go();
  assert.equal(idx(h.calls, 'dropRetainedSince:'), -1, `裁剪失败不许清表:${h.calls.join(' → ')}`);
  assert.equal(idx(h.calls, 'resend'), -1, '裁剪失败不许重发');
  assert.ok(idx(h.calls, 'confirmDialog:') >= 0, '裁剪失败要提示');
});

await t('r188 回合进行中重做:停止带能证明的身份与 hard,裁剪被 SESSION_RUNNING 拒绝两次后重试成功并重发', async () => {
  const h = harness({ owner: 'sess-1', trimRunningTimes: 2 });
  await h.go();
  assert.deepEqual(h.stopBodies, [{ hard: true, owner: 'sess-1' }], '停止请求体');
  assert.equal(h.trimTries(), 3, '裁剪应重试到成功');
  assert.equal(h.sent.length, 1, '重试成功后重发');
  assert.ok(idx(h.calls, 'dropRetainedSince:') > 0, '重试成功后清表');
});
await t('r188 给不出身份时停止不带 owner', async () => {
  const h = harness();
  await h.go();
  assert.deepEqual(h.stopBodies, [{ hard: true }]);
});
await t('r188 裁剪一直被 SESSION_RUNNING 拒绝:约 6 秒后放弃,不清表、不重发', async () => {
  const h = harness({ trimRunningTimes: 1000 });
  const t0 = Date.now();
  await h.go();
  const dt = Date.now() - t0;
  assert.ok(dt >= 5000 && dt < 7000, `重试上限约 6 秒,实际 ${dt}ms`);
  assert.equal(idx(h.calls, 'dropRetainedSince:'), -1);
  assert.equal(h.sent.length, 0);
});
await t('r188 「回退进行中」标记:停止与裁剪期间挂着,交给重发时仍挂着(由 resendReplacing 清)', async () => {
  const h = harness();
  await h.go();
  assert.ok(h.busySeen.length >= 2 && h.busySeen.every(Boolean), `等待期间标记必须挂着:${h.busySeen}`);
  assert.equal(h.sent[0].busyAtResend, true);
});
await t('r188 「回退进行中」标记:裁剪失败 / 切走放弃 / 抛错的出口都清掉', async () => {
  for (const o of [{ trimFails: true }, { paneStays: false }]) {
    const h = harness(o);
    await h.go();
    assert.equal(h.rollbackBusyRef.current, null, `出口 ${JSON.stringify(o)} 没清标记`);
  }
  const h = harness();
  h.ctx.runHistoryOp = async () => { throw new Error('net'); };
  await h.go();
  assert.equal(h.rollbackBusyRef.current, null, '抛错出口没清标记');
});
await t('r188 别人挂的标记不被这次的出口清掉', async () => {
  const h = harness({ trimFails: true });
  const other = {};
  h.ctx.runHistoryOp = async () => { h.rollbackBusyRef.current = other; return { ok: false, code: 'X' }; };
  await h.go();
  assert.equal(h.rollbackBusyRef.current, other);
});

// ── ② 哨兵:两条路径各发什么─────────────────────────────────────
await t('② 既有「工具重做」仍发带 tool= 的重试哨兵(逐字不变)', async () => {
  const h = harness();
  await h.go();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].text, '<cgui-tool-retry tool="Bash">继续</cgui-tool-retry>');
  assert.equal(h.sent[0].o.hiddenUserMessage, true);
});

await t('② 内容审核路径不注入重试哨兵,只发续跑指令', async () => {
  const h = harness({ opts: { contentRisk: true, continuePrompt: '不要重新执行同一个工具' } });
  await h.go();
  assert.equal(h.sent.length, 1);
  assert.doesNotMatch(h.sent[0].text, /tool="/, '不许出现 tool= 重试哨兵');
  assert.match(h.sent[0].text, /不要重新执行同一个工具/);
  assert.equal(h.sent[0].o.hiddenUserMessage, true, '仍须隐藏(否则刷新后变成看不懂的用户气泡)');
});

await t('① 内容审核路径不再自动重发用户消息', async () => {
  const h = harness({ opts: { contentRisk: true, continuePrompt: 'P', carryText: '还是不行' } });
  await h.go();
  assert.doesNotMatch(h.sent[0].text, /还是不行/, 'carryText 绝不能被自动重发');
});

console.log(`\n[check-r99-dev-order] ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.error('  ✗ ' + f); process.exit(1); }
