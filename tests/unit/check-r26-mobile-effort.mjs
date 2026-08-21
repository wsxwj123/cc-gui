#!/usr/bin/env node
// r26-F3:手机端思考力度半套 → 补齐:caps 过滤菜单行 + 写 per-model 记忆 + 回落钩子。
// ①纯函数层:不支持的档 → effortAllowed 判 false,label 回落默认档(哨兵);
// ②useEffortFallback 存在于 effortCaps.js 且被两处挂载(桌面 EffortSelector +
//   手机 MobileEffortPage)—— 抽取后两端同一判据,漂移即红;
// ③MobileEffortPage onClick 写 cgui-effort-<provider>-<modelId> 记忆键(F6 键形);
// ④MobileMenu effortLabel 过 effortAllowed。
// (组件渲染进不了 node,按仓库惯例用源码哨兵 + 纯函数行为断言。)
// Run: node tests/unit/check-r26-mobile-effort.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { effortCapsFor, effortAllowed, useEffortFallback, effortMemoryKey } from '../../client/src/utils/effortCaps.js';

// ① 纯函数层:不支持的档 → 过滤/回落
{
  const meta = { 'm-low': { reasoning: true, efforts: ['low', 'medium'] }, 'm-nothink': { reasoning: false } };
  const caps = effortCapsFor(meta, 'm-low');
  assert.equal(effortAllowed(caps, 'xhigh'), false, 'F3: 不支持的档判 false(菜单行回落的判据)');
  assert.equal(effortAllowed(caps, 'low'), true);
  // 菜单行回落语义:非法档 → 显示默认档 label
  const label = (effortAllowed(caps, 'xhigh') ? '极高' : '默认');
  assert.equal(label, '默认', 'F3: 非法档 label 回落默认档');
  // 锁思考的模型:任何非空档都不可用
  assert.equal(effortAllowed(effortCapsFor(meta, 'm-nothink'), 'low'), false, 'F3: reasoning:false 锁全部非空档');
  assert.equal(typeof useEffortFallback, 'function', 'F3: 回落钩子已导出');
  assert.equal(typeof effortMemoryKey, 'function', 'F6/F3: 记忆键构造函数已导出');
}

// ②③④ 源码锚
const capsSrc = readFileSync(new URL('../../client/src/utils/effortCaps.js', import.meta.url), 'utf8');
assert.match(capsSrc, /export function useEffortFallback\(/, 'F3: 钩子定义在 effortCaps.js');

const chatInput = readFileSync(new URL('../../client/src/components/ChatInput.jsx', import.meta.url), 'utf8');
assert.match(chatInput, /useEffortFallback\(\{/, 'F3: 桌面 EffortSelector 挂载同一钩子(不再私有 effect)');
assert.doesNotMatch(chatInput, /const lastModelRef = useRef\(\{ permKey, model: bareModelId \}\)/,
  'F3: 旧私有 effect 必须删掉(两份判据 = 漂移源)');

const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
const effortPageStart = app.indexOf('function MobileEffortPage(');
assert.ok(effortPageStart > 0, 'F3: MobileEffortPage 不见了(重构后同步本锚)');
const effortPage = app.slice(effortPageStart, app.indexOf('function MobileReadingFontPage', effortPageStart));
assert.match(effortPage, /useEffortFallback\(\{/, 'F3: 手机 MobileEffortPage 挂载回落钩子(此前无任何回落)');
assert.match(effortPage, /localStorage\.setItem\(effortMemoryKey\(providerHint, bareModelId\)/,
  'F3: 手机端选档写 per-model 记忆(cgui-effort-<provider>-<modelId>,与桌面同键同语义)');

const menuStart = app.indexOf('function MobileMenu(');
const menu = app.slice(menuStart, menuStart + 4500);
assert.match(menu, /effortAllowed\(menuCaps, effort \|\| ''\)/, 'F3: 菜单行 effortLabel 必须过 caps 过滤');
assert.doesNotMatch(menu, /const effortLabel = \(EFFORT_LEVELS\.find/,
  'F3: 裸 EFFORT_LEVELS.find 不过 caps 是 bug 本体,不许回退');

console.log('PASS check-r26-mobile-effort');
