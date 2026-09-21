#!/usr/bin/env node
// r122 R1 单测:过程块自动折叠开关(INTERFACE-r122 A1/A2/A4/A5;用户 2026-09-21 要求默认**不**折叠)。
//   t1 默认关:localStorage 干净时 autoFoldProcess=false,且只读不写;
//   t2 setter 双写:store 与 localStorage['cgui-auto-fold-process'] 一起变('1' / '0');
//   t3 持久化:预置 '1' 重新求值模块 → 开;'0' / 脏值 → 关(A1:只有 '1' 算开);
//   t4 接线守卫:CoworkBlocks 用 store 布尔选择器订阅、open 自动态并上"开关关闭"、聊天模式分支不用它;
//      设置面板有 #set-auto-fold 区块 + role=switch 控件 + SETTINGS_INDEX 登记(搜索"折叠"可达)。
//
// 变异哨兵(逐条验证过红):
//   ① store 初值写成 !== '0'(缺省变开)→ t1 红;② setter 只 set 不写 localStorage → t2 红;
//   ③ open 表达式退回 `stripAutoCtx || isLive`(开关失效)→ t4-b 红;
//   ④ 渲染里直接读 localStorage 而不是订阅 store → t4-a 红;⑤ SETTINGS_INDEX 漏登记 → t4-d 红。
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

// t4 接线守卫
{
  const turn = src('client/src/components/TurnBubble.jsx');
  const start = turn.indexOf('export function CoworkBlocks(');
  assert.ok(start > 0, 't4: 找得到 CoworkBlocks');
  const body = turn.slice(start, turn.indexOf('\n}\n', start));
  // a. 订阅 store,不在渲染里读 localStorage
  assert.ok(/useStore\(\(s\) => s\.autoFoldProcess\)/.test(body), 't4-a: CoworkBlocks 用 store 布尔选择器订阅 autoFoldProcess');
  assert.ok(!/localStorage\.(getItem|setItem|removeItem)\(/.test(body), 't4-a: 渲染路径里不读写 localStorage(只认真实调用,注释里提到不算)');
  // b. 自动态 = 异常收尾 ∨ 正在生成 ∨ 开关关闭;手动覆盖(stripOpen)仍优先
  assert.ok(/const open = stripOpen === null \? \(stripAutoCtx \|\| isLive \|\| !autoFold\) : stripOpen;/.test(body),
    't4-b: open 的自动态必须并上"开关关闭 → 展开",且手动态优先');
  // c. 聊天模式分支不受开关影响:该分支(到 data-strip-state="off" 为止)不引用 autoFold
  const chatBranch = body.slice(body.indexOf('if (chatMode) {'), body.indexOf('data-strip-state="off"'));
  assert.ok(chatBranch.length > 0 && !/autoFold/.test(chatBranch), 't4-c: 聊天模式分支不用 autoFold(BRIEF R1-6)');

  const panel = src('client/src/components/SettingsPanel.jsx');
  // d. 搜索索引登记在 general(默认页),标题与关键词含「折叠」
  assert.ok(/\{ id: 'set-auto-fold', tab: 'general', title: '过程块自动折叠', keys: '[^']*折叠[^']*' \}/.test(panel),
    't4-d: SETTINGS_INDEX 登记 set-auto-fold 于 general,标题「过程块自动折叠」,关键词含「折叠」');
  // e. 区块根节点 id + role=switch 控件(button,不用 input[type=checkbox])+ aria-checked 反映状态
  assert.ok(/<div id="set-auto-fold"><AutoFoldSection \/><\/div>/.test(panel), 't4-e: GeneralTab 里有 id="set-auto-fold" 的区块');
  const sec = panel.slice(panel.indexOf('function AutoFoldSection('), panel.indexOf('function GeneralTab('));
  assert.ok(/useStore\(\(s\) => s\.autoFoldProcess\)/.test(sec) && /useStore\(\(s\) => s\.setAutoFoldProcess\)/.test(sec), 't4-e: 区块读写都走 store');
  assert.ok(/<button[^>]*role="switch"[^>]*aria-checked=\{on\}/.test(sec), 't4-e: 开关是 role=switch 的 button,aria-checked 反映状态');
  assert.ok(!/type="checkbox"/.test(sec), 't4-e: 不用 input[type=checkbox](面板 Esc 逻辑会截住它)');
  assert.ok(/过程块自动折叠/.test(sec), 't4-e: 区块标题含「过程块自动折叠」');
}

console.log('check-r122-auto-fold: all passed');
