#!/usr/bin/env node
// r207 自检(前端 store):第一次加载会话历史失败的记录(historyLoadByTab)。真 store + 可控的假 fetch。
//   - 窗格里还没有这个会话的消息时:504 → failed:'timeout';500 / 503 → 'failed';网络出错 → 'failed';404 不记;
//   - 重新请求成功 → 记成 ok、失败消失、消息落地;
//   - 已经显示着消息时后台刷新失败不记;成功加载过的空会话,之后刷新失败也不记;
//   - 切会话(setSelectedSession / setPaneSession)清掉;分屏窗格各记各的。
import assert from 'node:assert/strict';

const calls = [];
globalThis.fetch = (url, init = {}) => {
  const call = { url, signal: init.signal };
  calls.push(call);
  return new Promise((resolve, reject) => {
    call.respond = (payload, status = 200) => resolve({
      ok: status >= 200 && status < 300,
      status,
      body: { cancel: () => Promise.resolve() },
      json: async () => payload,
    });
    call.fail = () => reject(new TypeError('Failed to fetch'));
    init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
};

const { useStore } = await import('../../client/src/stores/sessionStore.js');
const st = () => useStore.getState();
const sess = (id) => ({ sessionId: id, projectHash: 'h' });
const page = (sid, n) => ({
  messages: Array.from({ length: n }, (_, i) => ({ uuid: `${sid}-${i}`, type: 'user', text: `${sid}#${i}` })),
  total: n, beforeCursor: 0, hasMore: false,
});
let passed = 0;
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); passed += 1; };
const load = (tab = 0) => st().historyLoadByTab[tab];
async function fetchWith(sid, respond, opts = {}) {
  const p = st().fetchMessages(sid, 'h', opts);
  const call = calls.at(-1);
  respond(call);
  return p;
}

// 504:第一次加载失败 → timeout
st().setSelectedSession(sess('A'));
eq(await fetchWith('A', (c) => c.respond({ ok: false, code: 'HISTORY_READ_TIMEOUT', error: '读取会话历史超时' }, 504)), false, '504 返回 false');
eq(load(), { sessionId: 'A', failed: 'timeout' }, '504 → failed:timeout');
eq(st().loading, false, '失败后 loading 收尾');
// 再失败一次(仍是 504)照旧
await fetchWith('A', (c) => c.respond({}, 504));
eq(load(), { sessionId: 'A', failed: 'timeout' }, '重试仍 504 → 还是 timeout');
// 重试成功
eq(await fetchWith('A', (c) => c.respond(page('A', 3))), true, '重试成功');
eq(load(), { sessionId: 'A', ok: true }, '成功 → ok,失败记录清掉');
eq(st().paneMessages[0].length, 3, '消息落地');
// 已显示消息时后台刷新失败:不记
await fetchWith('A', (c) => c.respond({}, 500), { silent: true });
eq(load(), { sessionId: 'A', ok: true }, '已显示消息时后台刷新 500:不记失败');
await fetchWith('A', (c) => c.fail(), { silent: true });
eq(load(), { sessionId: 'A', ok: true }, '已显示消息时后台刷新网络出错:不记失败');
eq(st().paneMessages[0].length, 3, '消息照旧');

// 切会话清掉;500 → failed
st().setSelectedSession(sess('B'));
eq(load(), null, '切会话 → 清掉');
await fetchWith('B', (c) => c.respond({ ok: false, code: 'HISTORY_READ_FAILED', error: '读取会话历史失败' }, 500));
eq(load(), { sessionId: 'B', failed: 'failed' }, '500 → failed:failed');
st().setSelectedSession(sess('C'));
await fetchWith('C', (c) => c.respond({}, 503));
eq(load(), { sessionId: 'C', failed: 'failed' }, '503 → failed');
st().setSelectedSession(sess('D'));
await fetchWith('D', (c) => c.fail());
eq(load(), { sessionId: 'D', failed: 'failed' }, '网络出错 → failed');
st().setSelectedSession(sess('E'));
await fetchWith('E', (c) => c.respond({ ok: false, code: 'SESSION_NOT_FOUND' }, 404));
eq(load(), null, '404 不算读取失败');

// 成功加载过的空会话:之后刷新失败不记
st().setSelectedSession(sess('F'));
await fetchWith('F', (c) => c.respond(page('F', 0)));
eq(load(), { sessionId: 'F', ok: true }, '空会话加载成功 → ok');
await fetchWith('F', (c) => c.respond({}, 504), { silent: true });
eq(load(), { sessionId: 'F', ok: true }, '成功加载过的空会话,刷新失败不记');

// 被顶替 / 切走的旧请求失败:不记到新会话上
st().setSelectedSession(sess('G'));
const pG = st().fetchMessages('G', 'h');
const cG = calls.at(-1);
st().setSelectedSession(sess('H'));
cG.respond({}, 504);
await pG;
eq(load(), null, '切走后旧请求失败不记');

// 分屏窗格各记各的;setPaneSession 换会话清掉
st().setPaneCount?.(2);
st().setPaneSession(1, sess('P'));
await fetchWith('P', (c) => c.respond({}, 504), { tab: 1 });
eq(load(1), { sessionId: 'P', failed: 'timeout' }, '窗格 1 记自己的');
eq(load(0), null, '窗格 0 不受影响');
st().setPaneSession(1, sess('Q'));
eq(load(1), null, 'setPaneSession 换会话 → 清掉');

console.log(`check-r207-history-load-error: OK (${passed} assertions)`);
