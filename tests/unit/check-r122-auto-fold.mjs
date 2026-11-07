#!/usr/bin/env node
// r122 R1 单测:过程块自动折叠开关(INTERFACE-r122 A1/A2/A4/A5;用户 2026-09-21 要求默认**不**折叠)。
//   t1 默认关:localStorage 干净时 autoFoldProcess=false,且只读不写;
//   t2 setter 双写:store 与 localStorage['cgui-auto-fold-process'] 一起变('1' / '0');
//   t3 持久化:预置 '1' 重新求值模块 → 开;'0' / 脏值 → 关(A1:只有 '1' 算开);
//   t4 (r159 起)反向守卫:CoworkBlocks 不再订阅开关,设置面板 / 搜索索引里没有 set-auto-fold。
//
// 变异哨兵(逐条验证过红):
//   ① store 初值写成 !== '0'(缺省变开)→ t1 红;② setter 只 set 不写 localStorage → t2 红;
//   (r159 前的 ③~⑤ 针对已删的接线,随 t4 改判作废。)
// Run: node tests/unit/check-r122-auto-fold.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

// 内存 localStorage 替身:store 是浏览器模块,模块加载期就会读一次初值。
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
const STORE = new URL('../../client/src/stores/sessionStore.js', import.meta.url).href;
const KEY = 'cgui-auto-fold-process';

// t1 默认关(BRIEF R1-2):没有键 → false;没动过开关不往 localStorage 塞值
{
  const { useStore } = await import(STORE);
  assert.equal(useStore.getState().autoFoldProcess, false, 't1: 无历史设置时自动折叠默认关');
  assert.equal(mem.has(KEY), false, 't1: 只读不写');
}

// t2 setter 双写(A1 存储约定)
{
  const { useStore } = await import(STORE);
  useStore.getState().setAutoFoldProcess(true);
  assert.equal(useStore.getState().autoFoldProcess, true, 't2: 打开后 store 是 true');
  assert.equal(mem.get(KEY), '1', 't2: 打开必须落盘 1(A1)');
  useStore.getState().setAutoFoldProcess(false);
  assert.equal(useStore.getState().autoFoldProcess, false, 't2: 关掉后 store 是 false');
  assert.equal(mem.get(KEY), '0', 't2: 关掉落盘 0(A1:0 与没有键都表示关)');
}

// t3 持久化(A8):重新求值模块 = 模拟下次启动
{
  mem.set(KEY, '1');
  assert.equal((await import(`${STORE}?fold=on`)).useStore.getState().autoFoldProcess, true, 't3: 上次开着,重启后仍开');
  mem.set(KEY, '0');
  assert.equal((await import(`${STORE}?fold=off`)).useStore.getState().autoFoldProcess, false, 't3: 上次关着,重启后仍关');
  mem.set(KEY, 'true');
  assert.equal((await import(`${STORE}?fold=dirty`)).useStore.getState().autoFoldProcess, false, 't3: 非 1 的脏值按关处理(A1 只认 1)');
  mem.delete(KEY);
}

// t4(r159 改判,2026-11-07):用户要求去掉过程条摘要行与「过程块自动折叠」开关,只是前端不再显示,
// store / localStorage 接口保留(上面 t1–t3 仍守着)。原 t4-a~e(CoworkBlocks 订阅 + 设置面板区块)作废,
// 改成反向守卫:CoworkBlocks 不再读这个开关,设置面板与搜索索引里也没有这一项。
{
  const turn = src('client/src/components/TurnBubble.jsx');
  const start = turn.indexOf('export function CoworkBlocks(');
  assert.ok(start > 0, 't4: 找得到 CoworkBlocks');
  const body = turn.slice(start, turn.indexOf('\n}\n', start));
  assert.ok(!/useStore\(\(s\) => s\.autoFoldProcess\)/.test(body), 't4-a: CoworkBlocks 不再订阅 autoFoldProcess');
  const panel = src('client/src/components/SettingsPanel.jsx');
  assert.ok(!/set-auto-fold/.test(panel), 't4-b: 设置面板与 SETTINGS_INDEX 里没有 set-auto-fold');
  assert.ok(!/function AutoFoldSection\(/.test(panel), 't4-b: AutoFoldSection 已删');
}

console.log('check-r122-auto-fold: all passed');
