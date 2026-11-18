#!/usr/bin/env node
// r197:发送接口回 504 CHAT_START_TIMEOUT(带 pid)时,页面把这一轮当作还在跑:不当发送失败、照常接流,
// 提示同一轮只显示一次(本地提示,按 pid 去重),排队消息等流收尾再发。
// 纯函数白盒(client/src/utils/chatStartTimeout.js)+ App.jsx 接线的源码文本锁。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  CHAT_START_TIMEOUT_TEXT, isChatStartTimeoutResponse, isChatStartTimeoutEvent,
  makeChatStartTimeoutNotice, appendChatStartTimeoutNotice,
} from '../../client/src/utils/chatStartTimeout.js';
import { isLocalNotice, isLocalOnlyEntry, dropLocalNoticesOf } from '../../client/src/utils/localNotice.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = readFileSync(path.join(here, '../../client/src/App.jsx'), 'utf8');

let n = 0;
const t = (name, fn) => {
  try { fn(); n++; } catch (e) { console.error(`FAIL ${name}`); throw e; }
};

const TIMEOUT_BODY = {
  ok: false, code: 'CHAT_START_TIMEOUT', error: CHAT_START_TIMEOUT_TEXT,
  pid: 'p-7', runId: 'p-7', model: 'm', delivered: 'unknown', status: 'running',
};

// ── isChatStartTimeoutResponse ──
t('504 + CHAT_START_TIMEOUT + pid(字符串 / 数字)→ 是', () => {
  assert.equal(isChatStartTimeoutResponse(504, TIMEOUT_BODY), true);
  assert.equal(isChatStartTimeoutResponse(504, { ...TIMEOUT_BODY, pid: 4242 }), true);
});
t('启动失败(500 CHAT_START_FAILED,同样带 pid)→ 否', () => {
  assert.equal(isChatStartTimeoutResponse(500, { ok: false, code: 'CHAT_START_FAILED', error: '会话进程启动失败：x', pid: 'p-8' }), false);
  assert.equal(isChatStartTimeoutResponse(500, { ...TIMEOUT_BODY }), false, '状态码不是 504 不认');
});
t('不带 pid 的 504 / 别的码 / 200 / 空应答 → 否', () => {
  assert.equal(isChatStartTimeoutResponse(504, { ...TIMEOUT_BODY, pid: undefined }), false);
  assert.equal(isChatStartTimeoutResponse(504, { ...TIMEOUT_BODY, pid: '' }), false);
  assert.equal(isChatStartTimeoutResponse(504, { ...TIMEOUT_BODY, pid: null }), false);
  assert.equal(isChatStartTimeoutResponse(504, { ...TIMEOUT_BODY, code: 'GATEWAY_TIMEOUT' }), false);
  assert.equal(isChatStartTimeoutResponse(200, { ok: true, pid: 'p-1' }), false);
  assert.equal(isChatStartTimeoutResponse(504, null), false);
  assert.equal(isChatStartTimeoutResponse(504, undefined), false);
});

// ── isChatStartTimeoutEvent ──
t('流里的同一判决 → 是;别的错误 / 别的类型 / 空 → 否', () => {
  assert.equal(isChatStartTimeoutEvent({ type: 'error', code: 'CHAT_START_TIMEOUT', delivered: 'unknown', error: CHAT_START_TIMEOUT_TEXT }), true);
  assert.equal(isChatStartTimeoutEvent({ type: 'error', error: 'bad-line' }), false);
  assert.equal(isChatStartTimeoutEvent({ type: 'error', error: 'exit 1' }), false);
  assert.equal(isChatStartTimeoutEvent({ type: 'result', code: 'CHAT_START_TIMEOUT' }), false);
  assert.equal(isChatStartTimeoutEvent(null), false);
});

// ── makeChatStartTimeoutNotice ──
t('提示条目:本地提示(只活在本地),带后端原文,去重键是 pid 字符串,不带历史接管字段', () => {
  const m = makeChatStartTimeoutNotice({ pid: 4242, text: CHAT_START_TIMEOUT_TEXT, ownerKey: 'sid-1', model: 'm', now: 1700000000000 });
  assert.equal(m.type, 'turn');
  assert.equal(isLocalNotice(m), true);
  assert.equal(isLocalOnlyEntry(m), true);
  assert.equal(m.startTimeoutPid, '4242');
  assert.equal(m.ownerKey, 'sid-1');
  assert.ok(m.uuid.startsWith('chat-start-timeout-'), 'uuid 前缀 chat-(未写盘的本地条目)');
  assert.ok(m.text[0].includes(CHAT_START_TIMEOUT_TEXT));
  assert.equal(m.blocks.length, 1);
  assert.equal(m.blocks[0].content, m.text[0]);
  assert.ok(!m.text[0].includes('❌'), '中性提示,不是报错块');
  assert.ok(!('srcUuids' in m) && !('roundStartTs' in m));
});
t('没带文字时用后端原文兜底', () => {
  assert.ok(makeChatStartTimeoutNotice({ pid: 'p', text: '', ownerKey: 'k' }).text[0].includes(CHAT_START_TIMEOUT_TEXT));
  assert.ok(makeChatStartTimeoutNotice({ pid: 'p', ownerKey: 'k' }).text[0].includes(CHAT_START_TIMEOUT_TEXT));
});

// ── appendChatStartTimeoutNotice ──
t('同一个 pid 只追加一次(应答处 + 流里 + 重新接上的回放),原数组原样返回', () => {
  const base = [{ type: 'user', uuid: 'u1' }];
  const a = appendChatStartTimeoutNotice(base, makeChatStartTimeoutNotice({ pid: 'p-7', ownerKey: 'sid-1', now: 1 }));
  assert.equal(a.length, 2);
  const b = appendChatStartTimeoutNotice(a, makeChatStartTimeoutNotice({ pid: 'p-7', ownerKey: 'sid-1', now: 2 }));
  assert.equal(b, a, '已有同 pid 的提示 → 原数组');
  const c = appendChatStartTimeoutNotice(b, makeChatStartTimeoutNotice({ pid: 7, ownerKey: 'draft-x', now: 3 }));
  assert.equal(c.length, 3, '别的 pid(另一轮新拉起的进程)各一条');
  const d = appendChatStartTimeoutNotice(c, makeChatStartTimeoutNotice({ pid: '7', ownerKey: 'sid-1', now: 4 }));
  assert.equal(d, c, 'pid 数字与字符串同口径');
});
t('空 / 坏输入不抛错', () => {
  const x = makeChatStartTimeoutNotice({ pid: 'p', ownerKey: 'k' });
  assert.deepEqual(appendChatStartTimeoutNotice(undefined, x), [x]);
  const l = [];
  assert.equal(appendChatStartTimeoutNotice(l, null), l);
});
t('同一会话发下一条消息时由发送入口撤掉(dropLocalNoticesOf,草稿键 / 真实 id 两种归属都认)', () => {
  const n1 = makeChatStartTimeoutNotice({ pid: 'p-1', ownerKey: 'draft-x' });
  const n2 = makeChatStartTimeoutNotice({ pid: 'p-2', ownerKey: 'sid-1' });
  const other = makeChatStartTimeoutNotice({ pid: 'p-3', ownerKey: 'sid-9' });
  assert.deepEqual(dropLocalNoticesOf([n1, n2, other], ['draft-x', 'sid-1']), [other]);
});

// ── App.jsx 接线 ──
const at = (needle, from = 0) => { const i = APP.indexOf(needle, from); assert.ok(i >= 0, `找不到锚点 ${needle}`); return i; };
t('发送应答:先认初始化超时,点卡片那条与普通发送都不把它当失败', () => {
  const respAt = at('const respJson = await res.json();');
  const judgeAt = at('const startTimedOut = isChatStartTimeoutResponse(res.status, respJson);', respAt);
  const xsAt = at('if (opts.xsProcess && !startTimedOut && (!res.ok || !respJson.pid)) {', respAt);
  const throwAt = at('if (startTimedOut) {', respAt);
  const elseThrowAt = at('} else if (!res.ok || !respJson.pid) throw new Error(', throwAt);
  assert.ok(judgeAt < xsAt && xsAt < throwAt && throwAt < elseThrowAt, '次序:判定 → 点卡片分支 → 抛错分支');
  assert.equal((APP.match(/if \(!res\.ok \|\| !respJson\.pid\) throw new Error\(/g) || []).length, 1, '发送失败抛错只有一处');
});
t('认领 pid 之后画提示(让位 return 之后、接流之前),按 pid 去重', () => {
  const claimAt = at('pid = respJson.pid;');
  const noticeAt = at('appendChatStartTimeoutNotice(prev, makeChatStartTimeoutNotice({', claimAt);
  const attachAt = at('const controller = new AbortController();', claimAt);
  assert.ok(noticeAt < attachAt, '提示在接流之前、认领之后');
  const seg = APP.slice(claimAt, attachAt);
  assert.match(seg, /if \(startTimedOut\) \{\s*setChatMessages\(\(prev\) => appendChatStartTimeoutNotice\(prev, makeChatStartTimeoutNotice\(\{\s*pid, text: respJson\.error,/);
});
t('流里:同一判决不算服务端报错、不 break,只画一次后接着读', () => {
  assert.match(APP, /if \(event\.type === 'error' && event\.error !== 'bad-line' && !isChatStartTimeoutEvent\(event\)\) sawServerErrorEvent = true;/);
  const badLineAt = at("if (event.error === 'bad-line') continue;");
  const branchAt = at('if (isChatStartTimeoutEvent(event)) {', badLineAt);
  const budgetAt = at("if (event.subtype === 'error_max_budget_usd') {", badLineAt);
  assert.ok(branchAt < budgetAt, '在通用报错处理之前');
  const body = APP.slice(branchAt, budgetAt);
  assert.match(body, /appendChatStartTimeoutNotice\(prev, makeChatStartTimeoutNotice\(\{\s*pid, text: event\.error,/);
  assert.match(body, /continue;/);
  assert.ok(!/\bbreak;/.test(body) && !/sawError = true/.test(body), '不结束这条流、不记为报错');
});

console.log(`check-r197-start-timeout: ${n} passed`);
