#!/usr/bin/env node
// 单测(源码锚):r148 P6 —— 会话汇总不每次渲染重算;输入框做了记忆化且拿到的回调是稳定的。
//
// 现象 ①:会话组件每渲染一次,就把全部历史消息过一遍算费用(逐条查价)、工具数、模型集合。流式时每帧一次。
//   这段代码位于组件的"提前 return"之后,所以一直是普通计算(那里加 hook 会在切会话时白屏)。
// 现象 ②:输入框没有记忆化,而且会话组件传给它 4 个每次渲染都新建的内联回调 —— 就算加了记忆化也挡不住。
//
// 为什么 ① 只能钉源码:"重算了几次"在界面外面数不出来(查价函数是模块内部函数,不往产品代码里加
// 只供测试用的计数器)。② 的界面量(流式期间输入框渲染几次)见 tests/acceptance/r148-perf 的 P6。
// Run: node tests/unit/check-r148-p6-summary-memo.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => readFileSync(root + p, 'utf8');
let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.log(`  ✗ ${name}\n      ${String(e && e.message || e).split('\n').join('\n      ')}`); }
};

console.log('r148 P6 会话汇总记忆化 / 输入框记忆化');

const app = read('client/src/App.jsx');
const lineOf = (idx) => app.slice(0, idx).split('\n').length;
// 会话组件里第一处提前 return(没有选中会话 → 首页 / 空态)。hook 只能出现在它之前。
const earlyReturn = app.indexOf('return homeView({ hasSession: false, projectCount })');
// 逐条查价的那一处(会话汇总的费用)
const costAt = app.indexOf('computeCostForMessage(m, currentProvider)');

await check('锚点都在(源码改名时这条先红,提示更新锚点)', async () => {
  assert.ok(earlyReturn > 0, '找不到会话组件的提前 return');
  assert.ok(costAt > 0, '找不到逐条查价的汇总');
  assert.equal(app.indexOf('computeCostForMessage(m, currentProvider)', costAt + 1), -1, '逐条查价的汇总应只有一处');
});

await check('① 费用汇总挪到了提前 return 之前(hook 区)—— 之后的位置不能用 useMemo', async () => {
  assert.ok(costAt < earlyReturn, `逐条查价在第 ${lineOf(costAt)} 行,提前 return 在第 ${lineOf(earlyReturn)} 行`);
});

await check('① 费用 / 工具数 / 模型集合 包在 useMemo 里,依赖是消息列表与 provider', async () => {
  const before = app.slice(Math.max(0, costAt - 1500), costAt);
  const memoAt = before.lastIndexOf('useMemo(');
  assert.ok(memoAt >= 0, '逐条查价前面没有 useMemo(');
  // 从这个 useMemo( 起到它的依赖数组为止
  const start = Math.max(0, costAt - 1500) + memoAt;
  const tail = app.slice(start, start + 4000);
  const deps = tail.match(/\},\s*\[([^\]]*)\]\s*\)/);
  assert.ok(deps, '找不到这个 useMemo 的依赖数组');
  assert.match(deps[1], /currentProvider/, `依赖里应有 provider:[${deps[1]}]`);
  assert.match(deps[1], /Messages|renderChat/, `依赖里应有消息列表:[${deps[1]}]`);
  const body = tail.slice(0, tail.indexOf(deps[0]));
  assert.match(body, /toolCalls\?\.length/, '工具数应在同一个记忆化里');
  assert.match(body, /new Set\(/, '模型集合应在同一个记忆化里');
});

await check('② 输入框以记忆化组件导出', async () => {
  const src = read('client/src/components/ChatInput.jsx');
  assert.match(src, /export const ChatInput = (React\.)?memo\(/, 'ChatInput 不是 memo 组件');
});

await check('② 会话组件传给输入框的属性里没有内联函数(每次渲染新建 = 记忆化白做)', async () => {
  const at = app.indexOf('<ChatInput\n');
  assert.ok(at > 0, '找不到 <ChatInput 的使用处');
  const end = app.indexOf('\n      />', at);
  const block = app.slice(at, end).split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const inline = block.split('\n').filter((l) => /=>/.test(l));
  assert.equal(inline.length, 0, `还有 ${inline.length} 处内联函数:\n${inline.map((l) => l.trim()).join('\n')}`);
});

if (failed) { console.log(`\n${failed} 项失败`); process.exit(1); }
console.log('\n全部通过');
