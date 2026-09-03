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
];
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const run = new AsyncFunction(...PARAMS, BODY);

// 桩:只记录调用,不做任何真实 IO。
function harness({ activePid = 'pid-1', bgPid = null, stopHangs = false, opts = {} } = {}) {
  const calls = [];
  const sent = [];
  const fetchMock = (url, init) => {
    calls.push(String(url));
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
    resendReplacing: (text, o) => { calls.push('resend'); sent.push({ text, o }); },
    confirmDialog: (m) => { calls.push('confirmDialog:' + m); },
    setRetryActiveUuid: noop,
  };
  return { calls, sent, ctx, go: () => run(...PARAMS.map((p) => ctx[p])) };
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

// ── ② 哨兵:两条路径各发什么 ─────────────────────────────────────
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
