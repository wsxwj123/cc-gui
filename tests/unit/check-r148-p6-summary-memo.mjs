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
// 逐条查价的汇总:r151q 起提成模块级函数 sumMessagesCostUsd(与回复气泡同一算法)。会话组件分两份调用它:
// 已落盘列表单独记忆(流式时不跟着重算),直播部分在汇总的记忆里叠加。
const costFnAt = app.indexOf('function sumMessagesCostUsd(');
const perMessageCalls = [...app.matchAll(/computeCostForMessage\(/g)].map((m) => m.index);
const costCalls = [...app.matchAll(/(?<!function )sumMessagesCostUsd\(/g)].map((m) => m.index);
const finalizedAt = app.indexOf('sumMessagesCostUsd(finalizedMessages, currentProvider)');
const liveCalls = costCalls.filter((i) => i !== finalizedAt);

// 包住位置 at 的那个 useMemo:取 at 前最近的 useMemo(,往后找它的依赖数组(函数体是 {…} 或单个表达式都认)。
// 依赖数组在 at 之后才算包住;否则返回 null —— at 处是每次渲染都跑的普通计算。
const memoAround = (at) => {
  const memoAt = app.lastIndexOf('useMemo(', at);
  if (memoAt < 0) return null;
  const deps = /[)}]\s*,\s*\[([^\]]*)\]\s*,?\s*\)/.exec(app.slice(memoAt, memoAt + 6000));
  if (!deps || memoAt + deps.index < at) return null;
  const name = /const\s+(\w+)\s*=\s*(?:React\.)?$/.exec(app.slice(Math.max(0, memoAt - 80), memoAt));
  return { name: name && name[1], body: app.slice(memoAt, memoAt + deps.index), deps: deps[1] };
};

await check('锚点都在(源码改名时这条先红,提示更新锚点)', async () => {
  assert.ok(earlyReturn > 0, '找不到会话组件的提前 return');
  assert.ok(costFnAt > 0, '找不到逐条查价的汇总(函数 sumMessagesCostUsd)');
  // 逐条查价只此一处:会话费用都经这个函数,别处不许另写一份逐条查价
  assert.equal(perMessageCalls.length, 1, `逐条查价(computeCostForMessage 调用)应只有一处,现在 ${perMessageCalls.length} 处`);
  assert.ok(perMessageCalls[0] > costFnAt && perMessageCalls[0] < app.indexOf('\n}\n', costFnAt), '逐条查价不在 sumMessagesCostUsd 函数体里');
  assert.ok(finalizedAt > 0, '找不到已落盘列表的逐条查价 sumMessagesCostUsd(finalizedMessages, currentProvider)');
  assert.equal(app.indexOf('sumMessagesCostUsd(finalizedMessages, currentProvider)', finalizedAt + 1), -1, '已落盘列表的逐条查价应只有一处');
  assert.ok(liveCalls.length > 0, '找不到直播部分的逐条查价(汇总里叠加的那份)');
});

await check('① 费用汇总挪到了提前 return 之前(hook 区)—— 之后的位置不能用 useMemo', async () => {
  const after = costCalls.filter((i) => i > earlyReturn);
  assert.equal(after.length, 0, `逐条查价在第 ${after.map(lineOf).join('、')} 行,提前 return 在第 ${lineOf(earlyReturn)} 行`);
});

await check('① 费用 / 工具数 / 模型集合 包在 useMemo 里,依赖是消息列表与 provider', async () => {
  for (const at of costCalls) assert.ok(memoAround(at), `第 ${lineOf(at)} 行的逐条查价不在 useMemo 里(每次渲染都重算)`);
  // 已落盘列表单独记忆:只随列表、provider、价目版本变;直播部分变了不该把整份历史重新查价
  const finalized = memoAround(finalizedAt);
  assert.ok(finalized.name, '已落盘部分的 useMemo 没有赋给变量');
  assert.match(finalized.deps, /\bfinalizedMessages\b/, `已落盘部分的依赖里应有消息列表:[${finalized.deps}]`);
  assert.match(finalized.deps, /\bcurrentProvider\b/, `已落盘部分的依赖里应有 provider:[${finalized.deps}]`);
  assert.match(finalized.deps, /\bpricingVersion\b/, `已落盘部分的依赖里应有价目版本:[${finalized.deps}]`);
  assert.doesNotMatch(finalized.deps, /\brenderChat\b/, `已落盘部分不该随直播部分重算:[${finalized.deps}]`);
  // 汇总:费用 = 已落盘的缓存 + 直播部分;工具数、模型集合在同一个记忆里
  const summary = memoAround(liveCalls[0]);
  const usesCache = new RegExp(`\\b${finalized.name}\\b`);
  assert.match(summary.deps, /\bcurrentProvider\b/, `依赖里应有 provider:[${summary.deps}]`);
  assert.match(summary.deps, /Messages|renderChat/, `依赖里应有消息列表:[${summary.deps}]`);
  assert.match(summary.deps, /\bpricingVersion\b/, `依赖里应有价目版本:[${summary.deps}]`);
  assert.match(summary.body, usesCache, `汇总没用已落盘部分的缓存 ${finalized.name}`);
  assert.match(summary.deps, usesCache, `依赖里应有 ${finalized.name}:[${summary.deps}]`);
  assert.match(summary.body, /toolCalls\?\.length/, '工具数应在同一个记忆化里');
  assert.match(summary.body, /new Set\(/, '模型集合应在同一个记忆化里');
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
