#!/usr/bin/env node
// r26-I1【复现+反向】:拖拽排序 PUT 抹掉 hidden 项目的排位。
// 场景:服务端 projectOrder = [A, H, B, C](H 是隐藏项目,不在侧栏渲染);用户把 C 拖到
// 最前 → 组件的 preview 只含【可见非置顶】hash [C, A, B] → 整体覆盖 PUT → H 的排位被
// 静默抹掉(下次取消隐藏,H 掉到队尾/对账顺序全乱)。
// 修复后期望:松手 PUT 出去/落库的 projectOrder 里,H 仍在且保持原相对位次。
// 夹具用真 prefs 路由(6703)当后端,store 的 putSidebarView 走 fetch 桩打过去 ——
// 客户端合并 / 服务端增量并回 两种修法都能过;「整体覆盖」的 bug 形态必红。
// 注:若方案代理把合并做在组件层(构造 preview 时),本测试的调用点需同步上移 —— TEST-PLAN 已标注。
// Run: node tests/acceptance/r26/i1-drag-hidden-order.mjs
import assert from 'node:assert/strict';
import { listenWithRetry, stopServer, makeTmpHome, cleanupDirs, stubLocalStorage, stubWindowNoop } from './lib.mjs';

const TMP_HOME = makeTmpHome('i1'); // prefs.js 顶层固化 PREFS_PATH,先隔离 HOME
stubWindowNoop();
stubLocalStorage();

const express = (await import('express')).default;
const prefsRouter = (await import('../../../server/routes/prefs.js')).default;

const app = express();
app.use(express.json());
app.use('/api', prefsRouter);

let server = null;
let failure = null;
try {
  server = await listenWithRetry(6703, (p) => app.listen(p, '127.0.0.1'));
  const BASE = 'http://127.0.0.1:6703';

  // 服务端旧顺序:[A, H, B, C](H 隐藏)
  const seed = await fetch(`${BASE}/api/prefs/sidebar-view`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ groupMode: 'project', sortMode: 'manual', projectOrder: ['A', 'H', 'B', 'C'] }),
  });
  assert.equal(seed.status, 200, 'I1 夹具:旧顺序落库');

  // store 的 putSidebarView 打到真路由
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => realFetch(`${BASE}${url}`, opts);
  const { useStore } = await import('../../../client/src/stores/sessionStore.js');
  useStore.setState({ sidebarView: { groupMode: 'project', sortMode: 'manual', projectOrder: ['A', 'H', 'B', 'C'] } });

  // 模拟组件松手:preview 只有可见非置顶 [C, A, B](H 不在侧栏渲染,进不了 preview)
  await useStore.getState().putSidebarView({ projectOrder: ['C', 'A', 'B'] });
  globalThis.fetch = realFetch;

  // 核心断言(修前必红):H 的排位必须活下来(客户端并回或服务端增量,殊途同归)
  const finalOrder = useStore.getState().sidebarView.projectOrder;
  assert.ok(finalOrder.includes('H'),
    `I1: 拖拽 PUT 把隐藏项目 H 的排位抹掉了(落库顺序 ${JSON.stringify(finalOrder)})`);
  // 相对位次:H 原本在 A 之后 B 之前;可见项新顺序 C<A<B 下,H 不许掉到队尾
  assert.ok(finalOrder.indexOf('H') < finalOrder.indexOf('B'),
    `I1: H 应保持原相对位次(A 之后 B 之前一带),实际 ${JSON.stringify(finalOrder)}`);
  // 可见项的新排位本身不能丢(防修复变成「忽略拖拽」)
  assert.ok(finalOrder.indexOf('C') < finalOrder.indexOf('A'),
    `I1: 用户的拖拽结果(C 提到 A 前)必须生效,实际 ${JSON.stringify(finalOrder)}`);

  // 服务端落库口径与客户端一致(重开页面不回弹)
  const persisted = await (await realFetch(`${BASE}/api/prefs/sidebar-view`)).json();
  assert.ok(persisted.projectOrder.includes('H'), 'I1: 服务端落库顺序同样必须保住 H');
} catch (e) {
  failure = e;
} finally {
  await stopServer(server);
  cleanupDirs(TMP_HOME);
}
if (failure) throw failure;

console.log('PASS r26-i1-drag-hidden-order');
