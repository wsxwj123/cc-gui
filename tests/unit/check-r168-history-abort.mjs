#!/usr/bin/env node
// r168 白盒自检(前端):历史请求「作废即取消」+ 切会话只发一次。
// 用真 store + 可控的假 fetch(尊重取消信号,可手动给响应),验证:
//   - 切会话 / 同线新刷新 → 旧的在飞请求被取消,按过期收尾、不报错;
//   - refresh 与 older 两条线互不取消,切会话两条一起取消;
//   - 判为过期或失败而不读的响应,响应体被取消;
//   - skipIfInFlight 只在本窗格本会话已有有效刷新在路上时跳过,普通刷新照常发。
import assert from 'node:assert/strict';

const calls = [];
let ignoreAbort = false; // true = 模拟"响应头已到、取消来得太晚",验证落地时的过期分支
globalThis.fetch = (url, init = {}) => {
  const call = { url, signal: init.signal, cancelled: 0 };
  calls.push(call);
  return new Promise((resolve, reject) => {
    call.respond = (payload, { ok = true, status = 200 } = {}) => resolve({
      ok,
      status,
      body: { cancel: () => { call.cancelled += 1; return Promise.resolve(); } },
      json: async () => payload,
    });
    init.signal?.addEventListener('abort', () => {
      if (!ignoreAbort) reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
    });
  });
};

const { useStore } = await import('../../client/src/stores/sessionStore.js');
const st = () => useStore.getState();
const sess = (id) => ({ sessionId: id, projectHash: 'h' });
const page = (sid, n, total = n) => ({
  messages: Array.from({ length: n }, (_, i) => ({ uuid: `${sid}-${total - n + i}`, role: 'assistant', text: `${sid}#${total - n + i}` })),
  total,
  beforeCursor: total - n,
  hasMore: total - n > 0,
});

// 1) 切会话:A 的在飞刷新被取消,不报错;B 正常落地
st().setSelectedSession(sess('A'));
const pA = st().fetchMessages('A', 'h');
const cA = calls.at(-1);
assert.ok(cA.signal, '历史请求必须带取消信号');
st().setSelectedSession(sess('B'));
assert.equal(cA.signal.aborted, true, '切会话 → 上一个会话的在飞历史请求被取消');
const pB = st().fetchMessages('B', 'h');
const cB = calls.at(-1);
assert.equal(await pA, false, '被取消的请求按过期返回 false');
assert.equal(st().error, null, '取消不向用户报错');
cB.respond(page('B', 3));
assert.equal(await pB, true);
assert.equal(st().paneMessagesSid[0], 'B');
assert.equal(st().paneMessages[0].length, 3);
assert.equal(st().loading, false, '最新请求落地后 loading 收尾');

// 2) 同线新刷新顶替旧刷新 → 旧的取消;新的照常落地
const p1 = st().fetchMessages('B', 'h', { silent: true });
const c1 = calls.at(-1);
const p2 = st().fetchMessages('B', 'h', { silent: true });
const c2 = calls.at(-1);
assert.equal(c1.signal.aborted, true, '同窗格新刷新 → 旧刷新被取消');
assert.equal(c2.signal.aborted, false);
c2.respond(page('B', 4, 10));
assert.equal(await p1, false);
assert.equal(await p2, true);
assert.equal(st().historyPagingByTab[0].beforeCursor, 6);
assert.equal(st().historyPagingByTab[0].hasMore, true);

// 3) older 与 refresh 两条线互不取消;切会话两条一起取消,收尾规则同过期分支
const pOlder = st().loadOlderMessages('B', 'h');
const cOlder = calls.at(-1);
assert.match(cOlder.url, /before=6/);
const pR = st().fetchMessages('B', 'h', { silent: true });
const cR = calls.at(-1);
assert.equal(cOlder.signal.aborted, false, '刷新不取消在飞的「加载更早」');
cR.respond(page('B', 4, 10));
assert.equal(await pR, true);
assert.equal(st().historyPagingByTab[0].loading, true, '刷新落地不抹掉加载更早的 loading');
st().setSelectedSession(sess('C'));
assert.equal(cOlder.signal.aborted, true, '切会话 → 加载更早一并取消');
assert.equal(await pOlder, false);
assert.equal(st().historyPagingByTab[0].loading, false, '被取消的加载更早不让按钮停在转圈');
assert.equal(st().error, null);

// 4) 响应头已到才判过期(取消没赶上)→ 不读,响应体被取消,不写列表
ignoreAbort = true;
st().setSelectedSession(sess('D'));
const pD = st().fetchMessages('D', 'h', { silent: true });
const cD = calls.at(-1);
st().setSelectedSession(sess('E'));
cD.respond(page('D', 2));
assert.equal(await pD, false);
assert.equal(cD.cancelled, 1, '过期响应:返回前取消响应体');
assert.notEqual(st().paneMessagesSid[0], 'D', '过期响应不写列表');
ignoreAbort = false;

// 5) 当前请求失败(非 2xx)→ 响应体被取消,保留已有内容
st().setSelectedSession(sess('F'));
const pF1 = st().fetchMessages('F', 'h');
calls.at(-1).respond(page('F', 2, 9));
assert.equal(await pF1, true);
const pF2 = st().fetchMessages('F', 'h', { silent: true });
const cF2 = calls.at(-1);
cF2.respond({ ok: false, error: 'x' }, { ok: false, status: 500 });
assert.equal(await pF2, false);
assert.equal(cF2.cancelled, 1, '失败响应不读,响应体被取消');
assert.equal(st().paneMessages[0].length, 2, '失败不清空已有内容');

// 6) 加载更早:响应头到时已过期 → 响应体被取消,不前插
ignoreAbort = true;
const pFo = st().loadOlderMessages('F', 'h');
const cFo = calls.at(-1);
st().setSelectedSession(sess('G'));
cFo.respond(page('F', 2, 7));
assert.equal(await pFo, false);
assert.equal(cFo.cancelled, 1, '过期的加载更早响应:返回前取消响应体');
ignoreAbort = false;

// 7) skipIfInFlight:本窗格本会话已有有效刷新在路上 → 不重复发、不顶替它
st().setSelectedSession(sess('H'));
const pH = st().fetchMessages('H', 'h');
const cH = calls.at(-1);
const before = calls.length;
assert.equal(await st().fetchMessages('H', 'h', { silent: true, skipIfInFlight: true }), false);
assert.equal(calls.length, before, '切过来就加载:同会话刷新已在路上 → 不再发第二次');
assert.equal(cH.signal.aborted, false, '跳过时不取消在飞的那条');
cH.respond(page('H', 2));
assert.equal(await pH, true);
assert.equal(st().paneMessagesSid[0], 'H', '在飞那条照常落地');

// 8) 没有在飞刷新(上一条已落地)→ skipIfInFlight 照常发起
const pH2 = st().fetchMessages('H', 'h', { silent: true, skipIfInFlight: true });
assert.equal(calls.length, before + 1, '没有在飞的刷新 → 照常拉');
calls.at(-1).respond(page('H', 2));
assert.equal(await pH2, true);

// 9) 不带 skipIfInFlight 的刷新(回合结束对账等)即使有在飞的也照常发起并顶替它
const pH3 = st().fetchMessages('H', 'h', { silent: true });
const cH3 = calls.at(-1);
const pH4 = st().fetchMessages('H', 'h', { silent: true });
assert.equal(cH3.signal.aborted, true, '普通刷新必须拿新数据:顶替并取消在飞的那条');
calls.at(-1).respond(page('H', 3));
assert.equal(await pH3, false);
assert.equal(await pH4, true);

// 10) 在飞的是别的窗格 / 已被切会话作废 → 不算"在路上"
st().setSelectedSession(sess('I'));
const pI = st().fetchMessages('I', 'h');
st().setSelectedSession(sess('J'));
st().setSelectedSession(sess('I')); // 切走又切回:I 的旧请求已随切会话取消
const n10 = calls.length;
const pI2 = st().fetchMessages('I', 'h', { silent: true, skipIfInFlight: true });
assert.equal(calls.length, n10 + 1, '旧请求已作废 → 切回时照常重新拉');
calls.at(-1).respond(page('I', 1));
assert.equal(await pI, false);
assert.equal(await pI2, true);

// 11) 服务端单页按大小截断后,刷新返回的窗口可能比已加载的小:
//     有交集 → 保留已加载的旧前缀;无交集 → 以服务端为准,hasMore 正确
st().setSelectedSession(sess('K'));
const pK = st().fetchMessages('K', 'h');
calls.at(-1).respond(page('K', 6, 10)); // [4,10)
assert.equal(await pK, true);
const pK2 = st().fetchMessages('K', 'h', { silent: true });
calls.at(-1).respond(page('K', 2, 10)); // [8,10),与已加载的有交集
assert.equal(await pK2, true);
assert.deepEqual(st().paneMessages[0].map((m) => m.uuid), ['K-4', 'K-5', 'K-6', 'K-7', 'K-8', 'K-9'], '有交集:旧前缀保留');
assert.equal(st().historyPagingByTab[0].beforeCursor, 4);
assert.equal(st().historyPagingByTab[0].hasMore, true);
const pK3 = st().fetchMessages('K', 'h', { silent: true });
calls.at(-1).respond(page('K', 2, 30)); // [28,30),无交集
assert.equal(await pK3, true);
assert.deepEqual(st().paneMessages[0].map((m) => m.uuid), ['K-28', 'K-29'], '无交集:以服务端为准');
assert.equal(st().historyPagingByTab[0].beforeCursor, 28);
assert.equal(st().historyPagingByTab[0].hasMore, true);
assert.equal(st().historyPagingByTab[0].total, 30);

console.log('check-r168-history-abort: OK');
