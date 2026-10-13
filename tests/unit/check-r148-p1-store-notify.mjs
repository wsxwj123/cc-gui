#!/usr/bin/env node
// 单测:r148 P1 —— 内容没变的写入不通知订阅者;根组件 / 会话组件不再整库订阅。
//
// 现象:App.jsx 有两处 `useStore()`(不带选择器 = 订阅整个 state);而每 1.5 秒一次的运行状态
// 写入(setRunningStatus)在内容没变时返回 `{}` —— zustand 5 里返回 `{}` 照样换一个新的 state 对象
// 并通知所有订阅者(只有返回原 state 才不通知)。两者叠加:空闲时根组件、侧栏、所有窗格每 1.5 秒
// 整体重渲染一遍。
//
// 可数的量:订阅者被通知的次数(①)、源码里整库订阅的处数(②)、渲染期直接读标题的处数(③)。
// 界面层的"空闲时不重渲染"见 tests/acceptance/r148-perf 的 P1。
// Run: node tests/unit/check-r148-p1-store-notify.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => readFileSync(root + p, 'utf8');
let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.log(`  ✗ ${name}\n      ${String(e && e.message || e).split('\n').join('\n      ')}`); }
};

console.log('r148 P1 内容没变的写入不通知 / 不整库订阅');

const { useStore } = await import(root + 'client/src/stores/sessionStore.js');

await check('① 运行状态内容没变:连写 10 次,订阅者被通知 0 次,state 对象还是原来那个', async () => {
  useStore.getState().setRunningStatus(new Set(['sid-a']), new Set(['/proj/a']));
  const before = useStore.getState();
  let notified = 0;
  const unsub = useStore.subscribe(() => { notified += 1; });
  for (let i = 0; i < 10; i += 1) useStore.getState().setRunningStatus(new Set(['sid-a']), new Set(['/proj/a']));
  unsub();
  assert.equal(notified, 0, `内容没变却通知了 ${notified} 次(每次都会让所有订阅组件重算一遍)`);
  assert.equal(useStore.getState(), before, '内容没变,state 对象不应被换掉');
});

await check('① 运行状态内容变了:照常通知 1 次,新集合落进 store(没把"该通知的"也吞掉)', async () => {
  let notified = 0;
  const unsub = useStore.subscribe(() => { notified += 1; });
  useStore.getState().setRunningStatus(new Set(['sid-a', 'sid-b']), new Set(['/proj/a']));
  unsub();
  assert.equal(notified, 1);
  assert.deepEqual([...useStore.getState().runningSessionIds].sort(), ['sid-a', 'sid-b']);
  assert.deepEqual([...useStore.getState().runningCwds], ['/proj/a']);
});

await check('① 只有一边变了:没变的那一边保持原来的集合对象(侧栏按引用判断要不要重画)', async () => {
  const cwdsBefore = useStore.getState().runningCwds;
  useStore.getState().setRunningStatus(new Set(['sid-c']), new Set(['/proj/a']));
  assert.equal(useStore.getState().runningCwds, cwdsBefore, '目录集合内容没变,引用应保持');
  assert.deepEqual([...useStore.getState().runningSessionIds], ['sid-c']);
});

const app = read('client/src/App.jsx');

await check('② App.jsx 里没有不带选择器的 useStore()(整库订阅)', async () => {
  const hits = app.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /\buseStore\(\s*\)/.test(l));
  assert.equal(hits.length, 0, `还有 ${hits.length} 处整库订阅:\n${hits.map(([n, l]) => `${n}: ${l.trim()}`).join('\n')}`);
});

await check('③ 渲染时不再直接从 store 现读会话标题(那样只有别的原因触发重渲染时才会更新)', async () => {
  const hits = app.split('\n').map((l, i) => [i + 1, l])
    .filter(([, l]) => /useStore\.getState\(\)\.(customTitles|autoTitles)\[/.test(l));
  assert.equal(hits.length, 0, `还有 ${hits.length} 处在渲染时现读标题:\n${hits.map(([n, l]) => `${n}: ${l.trim()}`).join('\n')}`);
});

if (failed) { console.log(`\n${failed} 项失败`); process.exit(1); }
console.log('\n全部通过');
