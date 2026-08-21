#!/usr/bin/env node
// r27-review2:store.hiddenProjects 初始值 [] → null(水合前=「未知」),
// UnifiedSidebar 两处 watcherRefreshTargets 调用 `||` → `??`。
// 根因:[] 是 truthy,`st.hiddenProjects || hiddenRef.current` 的 ref 兜底是死代码;
// 而 store 只在 HomeState 挂载 GET 与 WS 广播两处水合 —— 冷启动直进会话页(不挂
// HomeState)时 store 恒为 [],watcher 跳过 hidden 组(I7②)与启动补拉(r27)的
// hidden 过滤整轮失效:隐藏组仍被 600ms 轮询拉取、其 403 还写进
// sessionsAccessErrorByProject。
//   t1 store 初始为 null;applyHiddenProjects 水合后为数组(契约不变);
//   t2 语义模拟:store null 时用本地兜底集过滤;水合后用 store 集过滤;
//   t3 消费端 null 安全:new Set(null) 不炸(App 的 hiddenHashes 派生路径);
//   t4 源码哨兵:侧栏两处 `??`、无残留 `|| hiddenRef`、store 初始 null。
// 运行:node tests/unit/check-r27-hidden-fallback.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => storage.get(k) ?? null,
  setItem: (k, v) => { storage.set(k, String(v)); },
  removeItem: (k) => { storage.delete(k); },
};

const { useStore } = await import('../../client/src/stores/sessionStore.js');
const { watcherRefreshTargets } = await import('../../client/src/utils/projectPanel.js');
const st = () => useStore.getState();

// t1 初始 null(水合前未知),水合后数组契约不变
assert.equal(st().hiddenProjects, null, 't1: 初始必须为 null(水合前=未知,非空集)');

// t2 语义模拟(与 UnifiedSidebar 的 `st.hiddenProjects ?? hiddenRef.current` 同式):
//    store null → 走本地兜底集;store 水合 → 走 store 集
{
  const localFallback = new Set(['h-local']); // 侧栏自己 GET 水合的本地集
  // 水合前:store null,本地兜底生效 —— 隐藏组被过滤
  const before = watcherRefreshTargets(['a', 'h-local'], st().hiddenProjects ?? localFallback);
  assert.deepEqual(before, ['a'], 't2: store 初始 null 时,本地兜底集参与过滤(隐藏组不被轮询)');
  // 水合后:store 集为准(本地集里有的 h-local 不在 store 集 → 不再过滤它)
  st().applyHiddenProjects(['h-store']);
  const after = watcherRefreshTargets(['a', 'h-local', 'h-store'], st().hiddenProjects ?? localFallback);
  assert.deepEqual(after, ['a', 'h-local'], 't2: 水合后以 store 集为准(全量替换语义)');
  // 关键对照:若误用 `||`,水合前 [] truthy → 不过滤(回归钉)
  assert.deepEqual(
    watcherRefreshTargets(['a', 'h-local'], [] || localFallback),
    ['a', 'h-local'],
    't2: 对照组——`||` 在空数组下不过滤(这正是被修的 bug 形态)',
  );
}

// t3 消费端 null 安全:App 的 hiddenHashes 派生 `new Set(hiddenProjectsList)`
{
  st().applyHiddenProjects(null); // 复位 reducer 语义:非数组 → [](不代表初始态)
  const { hiddenProjects } = st();
  assert.deepEqual(hiddenProjects, [], 't3: reducer 非数组输入仍收敛空表');
  // 初始 null 直接进 new Set 不炸(App.jsx hiddenHashes 路径)
  const s = new Set(null);
  assert.equal(s.size, 0, 't3: new Set(null)=空集,App 消费端 null 安全');
}

// t4 源码哨兵
{
  const sb = readFileSync(new URL('../../client/src/components/UnifiedSidebar.jsx', import.meta.url), 'utf8');
  const hits = sb.match(/st\.hiddenProjects \?\? hiddenRef\.current/g) || [];
  assert.equal(hits.length, 2, 't4: 侧栏两处(watcher + r27 启动补拉)都必须用 ?? 兜底');
  assert.doesNotMatch(sb, /st\.hiddenProjects \|\| hiddenRef\.current/, 't4: 不得残留 ||(死兜底 bug 形态)');
  const store = readFileSync(new URL('../../client/src/stores/sessionStore.js', import.meta.url), 'utf8');
  assert.match(store, /hiddenProjects: null,/, 't4: store 初始值必须为 null');
}

console.log('check-r27-hidden-fallback: all assertions passed');
process.exit(0);
