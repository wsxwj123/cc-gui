#!/usr/bin/env node
// r27-review1:respondPermission 把 403 识别为终态,不进递增退避重试通道。
// 根因:r26-H1 的 nonce 闸下,403 = nonce 与服务端 slot 逐字比对不符(终态)——
// 重试再多次 nonce 也不会变对。旧实现只有 r.ok / 卡片被撤两个出口,403 落无限
// 重试:hadCard=false 的 auto-allow 要等 15min TTL 命中 alreadyResolved 才收敛,
// 期间 CLI 挂起;有卡路径卡片转圈卡死(典型:手机缓存 H1 之前的旧前端,不带 nonce)。
//   t1 无卡路径(auto-allow):403 → 立即 false,恰好 1 次 fetch(不重试);
//   t2 有卡路径:403 → false + 卡片被撤(组件侧无失败展示路径,console+撤卡,不新造 UI);
//   t3 回归:非 403 失败(500)仍走重试通道,恢复后送达 true;
//   t4 源码哨兵:403 分支在 r.ok 之后、catch 重试之前。
// 运行:node tests/unit/check-r27-respond-403-terminal.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 浏览器全局垫片(store/hook 模块加载所需)
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.window = globalThis;
globalThis.document = { addEventListener() {}, removeEventListener() {} };

const { respondPermission } = await import('../../client/src/hooks/useWebSocket.js');
const { useStore } = await import('../../client/src/stores/sessionStore.js');

const calls = [];
let fetchImpl = null;
globalThis.fetch = (url, opts) => { calls.push({ url, opts }); return fetchImpl(url, opts); };
const forbidden403 = () => Promise.resolve({ ok: false, status: 403, json: async () => ({ error: 'nonce 无效或请求已过期' }) });
const ok200 = () => Promise.resolve({ ok: true, json: async () => ({ ok: true }) });

// t1 无卡(auto-allow 形态):403 终态,立即 false,不重试
calls.length = 0;
fetchImpl = forbidden403;
{
  const t0 = Date.now();
  const ok = await respondPermission('r27-a', { decision: 'allow' }); // 不带 nonce,模拟旧前端
  assert.equal(ok, false, 't1: 403 应返回 false(终态)');
  assert.equal(calls.length, 1, 't1: 403 后不得重试(恰好 1 次 fetch)');
  assert.ok(Date.now() - t0 < 900, 't1: 不得进递增退避(首轮退避 1s,应远小于它)');
}

// t2 有卡路径:403 → false + 撤卡(服务端仍 pending 的卡由 25s 对账补回,不静默丢)
calls.length = 0;
useStore.getState().addPendingPermission({ id: 'r27-b', toolName: 'Bash' });
{
  const ok = await respondPermission('r27-b', { decision: 'allow', nonce: 'stale-nonce' });
  assert.equal(ok, false, 't2: 有卡 403 同样终态 false');
  assert.equal(calls.length, 1, 't2: 恰好 1 次 fetch');
  assert.ok(!useStore.getState().pendingPermissions.some((p) => p.id === 'r27-b'), 't2: 卡片被撤(不留转圈卡死态)');
}

// t3 回归:非 403 的失败(500/网络)仍走重试通道 —— 终态识别不能误伤可恢复故障
calls.length = 0;
{
  let n = 0;
  fetchImpl = () => (++n === 1
    ? Promise.resolve({ ok: false, status: 500, json: async () => ({}) })
    : ok200());
  const ok = await respondPermission('r27-c', { decision: 'deny' });
  assert.equal(ok, true, 't3: 500 后重试送达仍 true');
  assert.equal(calls.length, 2, 't3: 500 不属于终态,应重试(2 次 fetch)');
}

// t4 源码哨兵:403 终态分支存在且位于重试回退之前
{
  const src = readFileSync(new URL('../../client/src/hooks/useWebSocket.js', import.meta.url), 'utf8');
  assert.match(src, /if \(r\.status === 403\) \{/, 't4: 必须有 403 终态分支');
  assert.ok(
    src.indexOf('if (r.ok) return true;') < src.indexOf('if (r.status === 403)'),
    't4: 403 判定须在 r.ok 之后(2xx 仍算送达)',
  );
  assert.match(src, /removePendingPermission\(id\);\s*\n\s*return false;/, 't4: 有卡 403 → 撤卡 + return false');
}

console.log('check-r27-respond-403-terminal: all assertions passed');
process.exit(0);
