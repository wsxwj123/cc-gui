#!/usr/bin/env node
// 权限应答共享提交器(respondPermission)自检:半死连接下"送达为止"的核心语义。
//   ① 首次失败自动重试,连接恢复后送达 → true(不再报错推给用户手点);
//   ② HTTP 2xx(含 alreadyResolved)即算送达;
//   ③ 同 id 并发提交只跑一个,重入方立即 false 且不多发请求;
//   ④ 有卡路径:持续失败中卡片被 resolved 广播/对账撤掉 → 视为他端已解决,停止重试;
//   ⑤ 无卡路径(auto-allow/deny 分支从不入卡):不因"卡不存在"提前终止,重试到送达;
//   ⑥ cancelRespond 明确取消 → false 停止;
//   ⑦ 对账 remove 侧 in-flight 守卫:提交中的卡不被对账撤掉(时钟超前+GET 飞行
//      窗口新卡+用户秒点场景),非 in-flight 的残卡照常被撤。
// 运行:node tests/unit/check-permission-respond-retry.mjs(真实重试间隔,约 10s)
import assert from 'node:assert/strict';

// 浏览器全局垫片(store/hook 模块加载所需)
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = globalThis;
globalThis.document = { addEventListener() {}, removeEventListener() {} };

const { respondPermission, cancelRespond, refetchPendingPermissions } = await import('../../client/src/hooks/useWebSocket.js');
const { useStore } = await import('../../client/src/stores/sessionStore.js');

const calls = [];
let fetchImpl = null;
globalThis.fetch = (url, opts) => { calls.push({ url, opts }); return fetchImpl(url, opts); };
const fail = () => Promise.reject(new TypeError('network dead'));
const ok200 = () => Promise.resolve({ ok: true, json: async () => ({ ok: true }) });

// ① 失败→重试→送达
calls.length = 0;
let n = 0;
fetchImpl = () => (++n === 1 ? fail() : ok200());
assert.equal(await respondPermission('id-1', { decision: 'allow' }), true, '①重试后送达应返回 true');
assert.equal(calls.length, 2, '①应恰好发送 2 次(1 失败 + 1 成功)');
assert.ok(calls[0].url.endsWith('/id-1'), '①URL 带请求 id');
assert.equal(JSON.parse(calls[0].opts.body).decision, 'allow', '①body 原样透传');

// ② alreadyResolved(2xx)算送达
fetchImpl = () => Promise.resolve({ ok: true, json: async () => ({ ok: true, alreadyResolved: true }) });
assert.equal(await respondPermission('id-2', { decision: 'deny' }), true, '②alreadyResolved 算送达');

// ③ 并发重入:第二次立即 false,不多发请求
calls.length = 0;
let release;
fetchImpl = () => new Promise((r) => { release = () => r({ ok: true, json: async () => ({ ok: true }) }); });
const first = respondPermission('id-3', { decision: 'allow' });
assert.equal(await respondPermission('id-3', { decision: 'deny' }), false, '③重入应立即 false');
assert.equal(calls.length, 1, '③重入不应多发请求');
release();
assert.equal(await first, true, '③先行提交正常完成');

// ④ 有卡 + 持续失败 + 卡片被撤 → 他端已解决,true 收敛
useStore.getState().addPendingPermission({ id: 'id-4', toolName: 'Bash' });
fetchImpl = fail;
setTimeout(() => useStore.getState().removePendingPermission('id-4'), 1500);
assert.equal(await respondPermission('id-4', { decision: 'allow' }), true, '④卡片被撤应停止重试并返回 true');

// ⑤ 无卡(auto 分支):不因"卡不存在"提前终止 —— 失败两轮后恢复仍能送达
calls.length = 0;
n = 0;
fetchImpl = () => (++n <= 2 ? fail() : ok200());
assert.equal(await respondPermission('id-5', { decision: 'allow' }), true, '⑤无卡路径重试到送达');
assert.equal(calls.length, 3, '⑤应发送 3 次(2 失败 + 1 成功),而非首轮后误判"已解决"');

// ⑥ cancelRespond → false 停止
fetchImpl = fail;
setTimeout(() => cancelRespond('id-6'), 500);
assert.equal(await respondPermission('id-6', { decision: 'deny' }), false, '⑥取消应返回 false');

// ⑦ 对账 remove 侧 in-flight 守卫:id-7 提交中(POST 持续失败),id-8 只是残卡;
//    服务端 pending 为空 → 对账应撤 id-8、保 id-7(否则 hadCard 判据误判"他端已解决")。
//    A2 后判据是【客户端入列戳 receivedAt】< fetchStart(不再用服务端 createdAt),
//    显式传 receivedAt:0 构造"入列早于本次拉取"的残卡。
useStore.getState().addPendingPermission({ id: 'id-7', toolName: 'Bash', receivedAt: 0 });
useStore.getState().addPendingPermission({ id: 'id-8', toolName: 'Bash', receivedAt: 0 });
fetchImpl = (url) => (String(url).includes('/pending')
  ? Promise.resolve({ ok: true, json: async () => ({ items: [] }) })
  : fail());
const inflight = respondPermission('id-7', { decision: 'allow' }); // 立即失败,进重试等待
await refetchPendingPermissions();
const left = useStore.getState().pendingPermissions.map((p) => p.id);
assert.ok(left.includes('id-7'), '⑦in-flight 的卡不被对账撤掉');
assert.ok(!left.includes('id-8'), '⑦非 in-flight 的残卡照常被撤');
cancelRespond('id-7');
assert.equal(await inflight, false, '⑦收尾:取消在途提交');
useStore.getState().removePendingPermission('id-7');

// ⑧ A2:GET 飞行窗口内刚入列的新卡(receivedAt 由 store 自动打,≥fetchStart)
//    不被对账误删 —— 这正是 receivedAt 换掉跨机时钟 createdAt 要保住的场景。
fetchImpl = (url) => {
  if (String(url).includes('/pending')) {
    // 模拟拉取飞行期间 WS 广播进来的新请求(服务端快照里自然没有它)
    useStore.getState().addPendingPermission({ id: 'id-9', toolName: 'Bash' });
    return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
  }
  return fail();
};
await refetchPendingPermissions();
assert.ok(useStore.getState().pendingPermissions.some((p) => p.id === 'id-9'), '⑧飞行期新卡不被对账误删');
assert.ok(useStore.getState().pendingPermissions.find((p) => p.id === 'id-9').receivedAt > 0, '⑧入列自动打 receivedAt 戳');
useStore.getState().removePendingPermission('id-9');

// ⑨ A1 切档 POST 串行化:同会话在途未 settle 时连切两档 → 不并发发送;在途 settle
//    后只补发一次且是【最新档】(cancelled 方案召不回已发出的 fetch,旧档可迟到反超;
//    串行化保证新档必然在旧档 settle 后才发出)。经 store.setPermissionMode 触发真实链路。
{
  calls.length = 0;
  const pendingReleases = [];
  // 审计批A2 后 setPermissionMode 还会 fire-and-forget PUT /api/prefs/session-sync
  // (偏好同步,失败静默、与切档 POST 互不依赖)—— 只悬挂 /chat/permission-mode,
  // 其余请求即回 200,保持 ⑨ 只考察切档串行化本身。
  fetchImpl = (url) => (String(url).includes('/chat/permission-mode')
    ? new Promise((r) => { pendingReleases.push(() => r({ ok: true, json: async () => ({ ok: true }) })); })
    : Promise.resolve({ ok: true, json: async () => ({ ok: true }) }));
  const modeCalls = () => calls.filter((c) => String(c.url).includes('/chat/permission-mode'));
  useStore.getState().setPermissionMode('bypassPermissions', 'sid-9');
  await new Promise((r) => setTimeout(r, 20)); // 首个 POST 发出并悬挂
  assert.equal(modeCalls().length, 1, '⑨首个切档发出一条在途');
  useStore.getState().setPermissionMode('acceptEdits', 'sid-9');
  useStore.getState().setPermissionMode('default', 'sid-9');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(modeCalls().length, 1, '⑨在途未 settle 时连切档不并发发送');
  pendingReleases.shift()(); // settle 首个(bypass)
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(modeCalls().length, 2, '⑨settle 后恰好补发一次');
  assert.equal(JSON.parse(modeCalls()[1].opts.body).mode, 'default', '⑨补发的是最新档(中间档被合并跳过)');
  pendingReleases.shift()(); // settle 补发
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(modeCalls().length, 2, '⑨目标未再变,循环收敛不再发送');
}

console.log('check-permission-respond-retry: all assertions passed');
process.exit(0);
