#!/usr/bin/env node
// r26-I6 单测:全局搜索命中写聚焦窗格,不再恒抢 pane 0。
// t1 行为哨兵:真实 store 驱动 setActiveTabSession 链路(activeTabIndex=2 → pane 2 变、
//    pane 0 不变);t2 源码钉:handlePickHit 走与 handleSelect 同款聚焦窗格分支。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// sessionStore 初始化需要的最小浏览器面 stub
const lsMap = new Map();
globalThis.localStorage = {
  getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null),
  setItem: (k, v) => lsMap.set(k, String(v)),
  removeItem: (k) => lsMap.delete(k),
};
globalThis.window = globalThis;
if (!globalThis.addEventListener) globalThis.addEventListener = () => {};
if (!globalThis.removeEventListener) globalThis.removeEventListener = () => {};
if (!globalThis.matchMedia) globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const { useStore } = await import('../../client/src/stores/sessionStore.js');

// t1 行为哨兵:3 窗格、聚焦 pane 2 → setActiveTabSession 写 pane 2,pane 0 不动
{
  useStore.getState().setPaneCount(3);
  useStore.getState().setPaneSession(0, { sessionId: 'keep-me', projectHash: 'h0' });
  useStore.getState().setActiveTabIndex(2);
  const hit = { sessionId: 'hit-sess', projectHash: 'h1' };
  useStore.getState().setActiveTabSession(hit);
  const st = useStore.getState();
  assert.equal(st.paneSessions[2]?.sessionId, 'hit-sess', 't1: 命中写聚焦窗格 pane 2');
  assert.equal(st.paneSessions[0]?.sessionId, 'keep-me', 't1: pane 0 不被抢(核心哨兵)');
  assert.equal(st.paneSessions[1] ?? null, null, 't1: pane 1 不动');
}

// t2 源码钉:handlePickHit 的落会话分支与 handleSelect 同口径(splitMode → setActiveTabSession)
{
  const sb = readFileSync(new URL('../../client/src/components/UnifiedSidebar.jsx', import.meta.url), 'utf8');
  const pick = sb.match(/const handlePickHit = async \(hit\) => \{[\s\S]*?\n  \};/);
  assert.ok(pick, 't2: handlePickHit 应存在');
  assert.match(pick[0], /st2\.splitMode/, 't2: pickHit 分 splitMode');
  assert.match(pick[0], /st2\.setActiveTabSession\(target\)/, 't2: split 下写聚焦窗格');
  assert.match(pick[0], /fetchMessages\(target\.sessionId, target\.projectHash, \{ tab: st2\.activeTabIndex \}\)/, 't2: 消息也拉到聚焦窗格');
  assert.ok(!pick[0].match(/setPaneSession\(0,/), 't2: 不许再恒写 pane 0');
}

console.log('check-r26-i6-pick-hit-focused-pane: all passed');
