#!/usr/bin/env node
// r151b 复审建议 1(接口 X.3.6 "2026-10-15 复审后补"):点卡片【处理】发出的回合遇到会触发既有自动重发的错误
// (1M 被拒 / 思考签名 / 会话失效转 draft / 自动档不可用 ×2)时,不重发、不重新认领;该回合由服务端按出错结算,
// 前端按最新状态刷新卡片。普通发送的自动重发行为不变。
// 白盒:五处自动重发共同经过的 App.jsx retryLater 从源码原样取出来跑(依赖换成可观察的替身);
// utils/xsession.js 真 import,服务端换成按路径应答的 fetch 替身。
// node tests/unit/check-r151b-xs-no-autoretry.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ── 浏览器全局的最小替身 ──
const mem = new Map();
globalThis.localStorage = {
  get length() { return mem.size; }, key: (i) => [...mem.keys()][i] ?? null,
  getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); }, clear: () => mem.clear(),
};
if (!globalThis.window) globalThis.window = globalThis;
if (!globalThis.addEventListener) { globalThis.addEventListener = () => {}; globalThis.removeEventListener = () => {}; }

const calls = [];
const routes = {};
globalThis.fetch = async (url, opts = {}) => {
  const method = (opts && opts.method) || 'GET';
  const u = new URL(url, 'http://127.0.0.1:6997');
  calls.push(`${method} ${u.pathname}`);
  const h = routes[`${method} ${u.pathname}`];
  const r = h ? h(u) : { status: 404, body: { ok: false } };
  return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async () => { for (let i = 0; i < 6; i += 1) await sleep(0); };
const count = (s) => calls.filter((c) => c === s).length;
let checks = 0;
const ok = (v, m) => { assert.ok(v, m); checks += 1; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks += 1; };

const xs = await import('../../client/src/utils/xsession.js');

const B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const M1 = '11111111-0000-4000-8000-000000000001';
const msg = (status, heldReason) => ({
  id: M1, createdAt: '2026-10-15T01:00:00.000Z', status, chainId: M1, hop: 1,
  from: { kind: 'user', sessionId: null, title: '' }, to: { sessionId: B, title: '乙' },
  body: '正文', bodyBytes: 6, via: 'card', heldReason, heldText: heldReason ? '模型返回了错误' : null,
});
let serverMsgs = [msg('processing', null)];
routes['GET /api/xsession/config'] = () => ({ status: 200, body: { enabled: true, nativeGuard: { lastFailureAt: null }, stored: { unfinished: 0 } } });
routes['GET /api/xsession/pending'] = () => ({ status: 200, body: { total: 0, sessions: [] } });
routes['GET /api/xsession/messages'] = () => ({ status: 200, body: { messages: serverMsgs } });
routes[`POST /api/xsession/messages/${M1}/claim`] = () => ({ status: 200, body: { ok: true, token: 'cccccccc-0000-4000-8000-00000000000c' } });

await xs.loadXsConfig();
const unwatch = xs.watchXsInbox(B);
await settle();
const card = () => (xs.useXsStore.getState().inbox[B] || []).find((m) => m.id === M1);
eq(card()?.status, 'processing', '前置:卡片是"处理中"');

// ── 1. xsAutoRetrySkipped:按最新状态刷新卡片、不认领、返回"未自动重发"提示 ──
{
  serverMsgs = [msg('pending', 'turn-error')]; // 服务端已按出错结算
  const g0 = count('GET /api/xsession/messages');
  const text = xs.xsAutoRetrySkipped({ messageId: M1, sessionId: B });
  await settle();
  eq(text, '跨会话消息的处理回合出错，未自动重发。卡片已按最新状态刷新；如需重试，在卡片上点【处理】。', '提示文案');
  eq(count('GET /api/xsession/messages') - g0, 1, '重拉一次该会话的收件箱');
  eq(count(`POST /api/xsession/messages/${M1}/claim`), 0, '不认领');
  eq([card()?.status, card()?.heldReason], ['pending', 'turn-error'], '卡片按最新状态显示"回合出错"');
  const n0 = calls.length;
  for (const bad of [null, undefined, {}, { messageId: M1, sessionId: 'not-a-uuid' }]) eq(typeof xs.xsAutoRetrySkipped(bad), 'string', '凭据对象不合规也返回提示');
  await settle();
  eq(calls.length, n0, '凭据对象不合规:不发任何请求');
  // r151c 先修 2:调用点刚弹的会话级修正提示保留,只把"并重发本条"换成"未自动重发",再接卡片提示
  const HINT = '卡片已按最新状态刷新；如需重试，在卡片上点【处理】。';
  const rewrite = (shown) => xs.xsAutoRetrySkipped({ messageId: M1, sessionId: 'not-a-uuid' }, shown);
  eq(rewrite('订阅未开通 1M 上下文按量额度（usage credits），已自动切回标准上下文并重发本条。如需 1M：先到 claude.ai/settings/usage 开启 usage credits，再打开模型菜单的 1M 开关。'),
    `订阅未开通 1M 上下文按量额度（usage credits），已自动切回标准上下文，未自动重发。如需 1M：先到 claude.ai/settings/usage 开启 usage credits，再打开模型菜单的 1M 开关。${HINT}`, '1M:保留"已切回标准上下文"与开通说明');
  eq(rewrite('历史思考块签名不被当前 provider 接受，已自动剥离并重发本条。'), `历史思考块签名不被当前 provider 接受，已自动剥离，未自动重发。${HINT}`, '签名:保留"已自动剥离"');
  eq(rewrite('当前模型 / 账户不支持「自动」权限档，已回退「逐步确认」并重发本条。'), `当前模型 / 账户不支持「自动」权限档，已回退「逐步确认」，未自动重发。${HINT}`, '自动档:保留"已回退逐步确认"');
  for (const plain of [null, undefined, '', '别的提示', 42]) eq(rewrite(plain), `跨会话消息的处理回合出错，未自动重发。${HINT}`, `没有可改写的提示(${String(plain)}):用通用文案`);
}

// ── 2. retryLater 原样取出来跑 ──
const APP = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
const HEAD = '    const retryLater = (nextOpts, expectKey = null) => {\n';
const s0 = APP.indexOf(HEAD);
ok(s0 > 0 && APP.indexOf(HEAD, s0 + 1) < 0, 'retryLater 只定义一处');
const retrySrc = APP.slice(s0, APP.indexOf('\n    };\n', s0) + '\n    };'.length);
const PROMPT = '（跨会话消息）';
function makeRetryLater(pane = () => true) {
  const log = { pane: [], notice: [], skipped: [], sent: [], shown: [] };
  const deps = {
    paneStillOn: (...a) => { log.pane.push(a); return pane(...a); },
    sessionQueueKey: 'sqk-B',
    streamSid: B,
    handleSendRef: { current: (p, o) => log.sent.push([p, o]) },
    prompt: PROMPT,
    setProviderSwitchNotice: (v) => log.notice.push(v),
    xsAutoRetrySkipped: (p, shown) => { log.skipped.push(p); log.shown.push(shown); return '提示-X'; },
  };
  // eslint-disable-next-line no-new-func
  const fn = new Function(...Object.keys(deps), `${retrySrc}\nreturn retryLater;`)(...Object.values(deps));
  return { fn, log };
}
const XP = { messageId: M1, sessionId: B };
// a. 带 xsProcess:四种重发标记都不重发、不起定时器;刷新这条卡片一次;窗格仍是本会话 → 提示改写
for (const flag of ['oneMRetry', 'signatureRetry', 'freshRetry', 'autoRetry']) {
  const { fn, log } = makeRetryLater();
  const ret = fn({ hiddenUserMessage: true, xsProcess: XP, [flag]: true });
  await sleep(150);
  eq(ret, undefined, `${flag}:不起重发定时器`);
  eq(log.sent, [], `${flag}:不重发(也就不会再认领)`);
  eq(log.skipped, [XP], `${flag}:按最新状态刷新这条卡片`);
  eq(log.notice, [{ text: '提示-X' }], `${flag}:提示改写成"未自动重发"`);
  eq(log.pane, [['sqk-B', B]], `${flag}:提示按发起会话判窗格`);
}
{ // 会话失效那一支带 expectKey:提示按 expectKey 判窗格
  const { fn, log } = makeRetryLater();
  fn({ xsProcess: XP, freshRetry: true }, 'draft-key');
  await sleep(150);
  eq([log.pane, log.sent, log.skipped], [[['draft-key']], [], [XP]], 'expectKey:按它判窗格,不重发,刷新卡片');
}
{ // r151c 先修 2:调用点传进来的提示原样交给 xsAutoRetrySkipped 改写;没传时为 null
  const { fn, log } = makeRetryLater();
  fn({ xsProcess: XP, oneMRetry: true }, null, '刚弹的提示并重发本条。');
  fn({ xsProcess: XP, autoRetry: true });
  await sleep(150);
  eq([log.shown, log.notice, log.sent], [['刚弹的提示并重发本条。', null], [{ text: '提示-X' }, { text: '提示-X' }], []], '调用点提示交给改写;不重发');
}
{ // 窗格已换走:不弹提示(提示条是窗格级的),卡片照样刷新
  const { fn, log } = makeRetryLater(() => false);
  fn({ xsProcess: XP, autoRetry: true });
  await sleep(150);
  eq([log.notice, log.skipped, log.sent], [[], [XP], []], '窗格已换走:不弹提示,刷新卡片,不重发');
}
// b. 普通发送:与改动前相同 —— 80ms 后原样重发;窗格换走不发;不碰卡片与提示
{
  const { fn, log } = makeRetryLater();
  const o = { oneMRetry: true, appendSystemPrompt: 'x' };
  ok(fn(o) != null, '普通:起重发定时器');
  await sleep(20);
  eq(log.sent, [], '普通:80ms 前不发');
  await sleep(130);
  eq(log.sent, [[PROMPT, o]], '普通:80ms 后原样重发(prompt 与 opts 原样)');
  eq([log.skipped, log.notice], [[], []], '普通:不刷新卡片、不改提示');
}
{
  const { fn, log } = makeRetryLater(() => false);
  fn({ autoRetry: true });
  await sleep(150);
  eq(log.sent, [], '普通:窗格已换走不发');
}
{
  const { fn, log } = makeRetryLater();
  fn({ freshRetry: true }, 'draft-key');
  await sleep(150);
  eq([log.pane, log.sent.length], [[['draft-key']], 1], '普通 expectKey:按它判窗格后重发');
}

// ── 3. 源码:五处自动重发都经 retryLater;普通发送的定时器与改动前逐字相同;认领只在发送块 ──
const compact = (s) => s.replace(/\s+/g, '');
ok(compact(retrySrc).includes(compact(`return setTimeout(() => {
  if (expectKey ? !paneStillOn(expectKey) : !paneStillOn(sessionQueueKey, streamSid)) return;
  handleSendRef.current?.(prompt, nextOpts);
}, 80);`)), '普通发送的重发定时器与改动前逐字相同(忽略缩进)');
eq([...APP.matchAll(/retryLater\(\{ \.\.\.opts, (\w+): true \}/g)].map((m) => m[1]),
  ['oneMRetry', 'signatureRetry', 'freshRetry', 'freshRetry', 'autoRetry', 'autoRetry'], '五处自动重发都经 retryLater(会话失效那一处按是否点卡片分两支)');

// r151c 先修 2:四处弹了会话级修正提示再重发的调用点,弹的那句与交给 retryLater 的是同一个常量,且都含"并重发本条"
{
  const sites = [...APP.matchAll(/const (_notice\w+) = '([^']*)';/g)].map((m) => ({ name: m[1], text: m[2] }));
  eq(sites.map((s) => s.name), ['_notice1m', '_noticeSig', '_noticeAuto', '_noticeAutoSpawn'], '四处调用点各一个提示常量');
  for (const s of sites) {
    ok(s.text.includes('并重发本条'), `${s.name}:含"并重发本条"(改写依据)`);
    ok(APP.includes(`setProviderSwitchNotice({ text: ${s.name} })`), `${s.name}:弹的就是它`);
    ok(new RegExp(`retryLater\\(\\{ \\.\\.\\.opts, \\w+: true \\}, null, ${s.name}\\)`).test(APP), `${s.name}:同一句交给 retryLater`);
  }
}

// ── 4. r151c 先修 1:会话失效那一支原样取出来跑 —— 点卡片发出的回合不转新草稿、不重发、不记「未发出的消息」 ──
{
  const NC_HEAD = '            if (/No conversation found/i.test(msg) && !opts.freshRetry && prompt) {\n';
  const n0 = APP.indexOf(NC_HEAD);
  ok(n0 > 0 && APP.indexOf(NC_HEAD, n0 + 1) < 0, '会话失效分支只有一处');
  const ncSrc = APP.slice(n0, APP.indexOf('\n            }\n', n0) + '\n            }'.length);
  ok(/sawError = true;\s*break;\s*\}$/.test(ncSrc), '取到的是整个分支(以 sawError / break 收尾)');
  function runNoConv({ xsProcess, pane = true, hidden = false }) {
    const log = { retry: [], notice: [], migrate: [], select: [], orphan: [], here: [] };
    const deps = {
      msg: 'No conversation found with session ID: x', prompt: PROMPT, hiddenUserMessage: hidden, streamOwnerPh: 'ph-1', meta: null,
      opts: xsProcess ? { xsProcess, hiddenUserMessage: true } : {},
      sessionQueueKey: 'sqk-B', streamSid: B,
      paneStillOn: () => pane,
      retryLater: (...a) => log.retry.push(a),
      getLocalSession: () => ({ sessionId: B, projectHash: 'ph-1' }),
      newDraftId: () => 'nd-1',
      queueKeyFor: ({ projectHash, draftId }) => `draft-${projectHash}-${draftId}`,
      useStore: { getState: () => ({ migrateSessionKey: (...a) => log.migrate.push(a), addOrphanDraftMessage: (...a) => { log.orphan.push(a); return true; } }) },
      setSelectedSession: (v) => log.select.push(v),
      setProviderSwitchNotice: (v) => log.notice.push(v),
      orphanKeyFor: (ph) => `orphan-${ph}`, createQueueId: (p) => `${p}-q`, attachmentMetaForPersistence: (m) => m,
      showNoticeHere: (t) => log.here.push(t),
    };
    // eslint-disable-next-line no-new-func
    new Function(...Object.keys(deps), `let accumulatedText, accumulatedThinking, currentToolCalls, sawError;\nfor (;;) {\n${ncSrc}\nbreak;\n}`)(...Object.values(deps));
    return log;
  }
  const xl = runNoConv({ xsProcess: XP });
  eq([xl.migrate, xl.select, xl.notice, xl.orphan, xl.here], [[], [], [], [], []], '点卡片:不转新草稿、不换窗格、不弹"已自动新建会话并重发"、不记未发出的消息');
  eq(xl.retry, [[{ xsProcess: XP, hiddenUserMessage: true, freshRetry: true }]], '点卡片:只经 retryLater 拦截一次(不带 expectKey,窗格按原会话判)');
  const xa = runNoConv({ xsProcess: XP, pane: false });
  eq([xa.retry.length, xa.orphan, xa.here], [1, [], []], '点卡片且窗格已换走:照样经 retryLater 刷新卡片,不把占位提示记成未发出的消息');
  const nl = runNoConv({});
  eq([nl.migrate.length, nl.select.length, nl.notice, nl.retry], [1, 1, [{ text: '原会话历史已失效，已自动新建会话并重发本条。' }], [[{ freshRetry: true }, 'draft-ph-1-nd-1']]],
    '普通发送:与改动前相同(转新草稿、弹提示、按新草稿键重发)');
  const na = runNoConv({ pane: false });
  eq([na.retry, na.orphan.length, na.here.length], [[], 1, 1], '普通发送且窗格已换走:与改动前相同(记成未发出的消息)');
}
ok(!/handleSendRef\.current\?\.\(prompt,\s*\{\s*\.\.\.opts/.test(APP), '没有绕过 retryLater、直接带原 opts 重发的地方');
eq((APP.match(/claimXsForSend\(/g) || []).length, 1, '认领只在发送块一处(只有重发才会再走到)');

unwatch();
console.log(`check-r151b-xs-no-autoretry: ${checks} checks passed`);
process.exit(0);
