#!/usr/bin/env node
// r25-②:启动水合的 activeTabIndex 必须夹到 [0, paneCount-1]。
// 其余三个写入点(setPaneCount / closePane / setActiveTabIndex)都夹紧了,只有水合这处
// 原来只校验 0..5 —— 陈旧存储(上个版本开着 6 窗格,这次启动 paneCount=1)或手改存储会让
// 聚焦索引指向一个不存在的窗格。后果不止是渲染:Home 的默认目录读
// paneSessions[activeTabIndex],越界 → 新建会话开到另一个窗格的项目里(r24 那条新逻辑的输入)。
// 变异哨兵(实际验证过红):把 sessionStore 的 INITIAL_ACTIVE_TAB 去掉 Math.min 夹紧
//   (改回 `n >= 0 && n <= 5 ? n : 0`)→ 下面「越界索引」两条断言红。
// Run: node tests/unit/check-pane-index-clamp.mjs
import assert from 'node:assert/strict';

// 陈旧存储:上次开了 5 个窗格并聚焦第 5 个,这次启动只有 2 个窗格。
const storage = new Map([
  ['cgui-pane-count', '2'],
  ['cgui-active-tab-index', '4'],
]);
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); },
};

const { useStore } = await import('../../client/src/stores/sessionStore.js');
const st = () => useStore.getState();

// ① 越界索引被夹到最后一个真实窗格(不是 4,也不是 0 —— 夹紧不等于清零)
assert.equal(st().paneCount, 2, '前提:paneCount 从存储水合为 2');
assert.equal(st().activeTabIndex, 1, '水合的 activeTabIndex 夹到 paneCount-1');

// ② 越界的直接后果:聚焦窗格的会话。夹紧前读的是 paneSessions[4](另一个窗格/undefined),
//    夹紧后读 paneSessions[1] —— 与 App.jsx 里 Home 取默认目录的选择器同一条链路。
//    夹具区分度:两个窗格挂的是**不同**项目,越界读到的第 4 格再挂第三个项目,
//    夹紧失效时落点必然不同(不会碰巧还对)。
st().setPaneSession(0, { sessionId: 's0', projectHash: 'h-p0', projectPath: '/w/p0' });
st().setPaneSession(1, { sessionId: 's1', projectHash: 'h-p1', projectPath: '/w/p1' });
st().setPaneSession(4, { sessionId: 's4', projectHash: 'h-ghost', projectPath: '/w/ghost' });
const focusedProjectHash = (s) => s.paneSessions?.[s.activeTabIndex]?.projectHash || null;
assert.equal(focusedProjectHash(st()), 'h-p1', '聚焦项目取自真实窗格,不是越界的那格(h-ghost)');

// ③ 夹紧只管上界:合法索引原样保留(别把「夹紧」写成「一律归零」)
assert.equal(st().activeTabIndex, 1, '合法范围内的索引不被改写');
st().setActiveTabIndex(0);
assert.equal(focusedProjectHash(st()), 'h-p0', '切回 0 号窗格 → 默认目录跟着换');

// ④ 运行期写入点仍夹紧(回归守卫,与水合同一不变量)
st().setActiveTabIndex(5);
assert.equal(st().activeTabIndex, 1, 'setActiveTabIndex 夹到 paneCount-1');
st().setPaneCount(1);
assert.equal(st().activeTabIndex, 0, 'setPaneCount 收窄后聚焦索引跟着回落');

console.log('check-pane-index-clamp: all passed');
