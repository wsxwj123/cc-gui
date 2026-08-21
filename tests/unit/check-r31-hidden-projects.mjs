#!/usr/bin/env node
// r31 钉子:隐藏项目列表多端同步双轨合一(store.hiddenProjects 为准)。
// 根因:①侧栏本地 `hidden` 集与 store.hiddenProjects 双轨——WS 'hidden-projects' 广播把
//       对端改动收敛进 store,但侧栏渲染用的是本地集(仅挂载 GET 时填),对端隐藏桌面侧栏
//       仍显示;②PUT /prefs/hidden-projects 全量覆盖,桌面再隐藏/恢复一个会把手机刚隐藏的
//       项目覆盖掉(本地集可能陈旧,不含对端最近的隐藏)。
// 修:侧栏本地集经 effect 镜像 store.hiddenProjects(store 为准,WS 广播即收敛到视图);
//      toggleHidden 以 store.hiddenProjects 为基(不再用陈旧本地集)构建 next,
//      更新 store(applyHiddenProjects)+ 同步本地集 + PUT 全量(store 派生,含对端隐藏,
//      不再覆盖对端)。
// 钉:①侧栏本地集跟随 store——WS 广播后侧栏视图即时更新(双轨合一哨兵);
//      ②toggleHidden 以 store 为基并反写 store;③PUT 服务端仍全量覆盖(客户端已保证发
//      的是全端收敛后的全量,不丢对端);④store 初始 null 时仍回退本地集(水合前兜底)。
// Run: node tests/unit/check-r31-hidden-projects.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sidebar = readFileSync(new URL('../../client/src/components/UnifiedSidebar.jsx', import.meta.url), 'utf8');
const prefs = readFileSync(new URL('../../server/routes/prefs.js', import.meta.url), 'utf8');

// ① 双轨合一:本地 hidden 经 effect 镜像 store.hiddenProjects(store 为准)
assert.match(sidebar, /const storeHiddenProjects = useStore\(\(s\) => s\.hiddenProjects\);?/,
  '侧栏必须订阅 store.hiddenProjects');
assert.match(sidebar, /if \(storeHiddenProjects != null\) setHidden\(new Set\(storeHiddenProjects\)\);?/,
  '本地 hidden 必须跟随 store.hiddenProjects(水合后),否则对端隐藏不达视图');

// ② toggleHidden 以 store 为基 + 反写 store
assert.match(sidebar, /const base = \(st\.hiddenProjects != null \? st\.hiddenProjects : \[\.\.\.hiddenRef\.current\]\);?/,
  'toggleHidden 基集必须是 store.hiddenProjects(水合后),不是本地集');
assert.match(sidebar, /st\.applyHiddenProjects\(\[\.\.\.next\]\);?/,
  'toggleHidden 必须反写 store(驱动本端视图 + 后续广播)');
assert.match(sidebar, /persistHidden\(next\);?/, 'toggleHidden 仍 PUT(store 派生全量)');

// ③ PUT 服务端仍全量覆盖(客户端保证发的是全端收敛后的全量)—— 钉住契约,防悄悄改成
//    增量语义导致别处读 prefs.hiddenProjects 的路径不一致
assert.match(prefs, /prefs\.hiddenProjects = hidden;?/, 'PUT hidden-projects 仍全量覆盖(客户端已发收敛全量)');
assert.match(prefs, /broadcast\(\{ type: 'hidden-projects', hidden \}\);?/, 'PUT 后仍 WS 广播(他端收敛入口)');
// WS reducer 消费点仍在(契约 C-I2)
const ws = readFileSync(new URL('../../client/src/hooks/useWebSocket.js', import.meta.url), 'utf8');
assert.match(ws, /case 'hidden-projects':?/, 'WS reducer 消费 hidden-projects');

// ④ store 初始 null 兜底(水合前不误判为空集)
const store = readFileSync(new URL('../../client/src/stores/sessionStore.js', import.meta.url), 'utf8');
assert.match(store, /hiddenProjects: null,?/, 'store.hiddenProjects 初始 null(水合前=未知)');
assert.match(sidebar, /storeHiddenProjects != null/, 'null 才走本地兜底(不能用 ||,[] truthy 骗底)');

console.log('PASS check-r31-hidden-projects');
