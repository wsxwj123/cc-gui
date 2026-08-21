#!/usr/bin/env node
// r26-F2:手机菜单模型行绕过解析链(裸 pin||global)→ 改调 resolveSelectorModel。
// ①行为层:resolveSelectorModel 可直接以状态对象驱动(纯函数)—— pin 被 modelGuard
//   拒绝、globalModel 可用的场景,输出 === 全局默认而非残留 pin(菜单行现在逐字等于
//   这个输出,因为它直接渲染该函数的返回值);pin 合法 → 输出 pin(回归哨兵)。
// ②源码哨兵:MobileMenu 的模型行必须是 resolveSelectorModel(s, permKey),不再是
//   modelBySession[permKey] || currentModel 裸链。
// Run: node tests/unit/check-r26-mobile-menu-model.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveSelectorModel } from '../../client/src/utils/routing.js';

// ① 行为层(与菜单行渲染值同一函数、同一输入形态)
const fakeState = (over = {}) => ({
  availableModels: [{ id: 'deepseek-v4' }],
  customModels: [],
  currentProvider: { providerHint: 'deepseek' },
  currentModel: 'deepseek-v4',
  modelBySession: { 'sid-1': 'claude-sonnet-4-6' }, // 别的 provider 的残留 pin
  paneSessions: [],
  selectedSession: null,
  context1mBySession: {},
  providerEpoch: 0,
  ...over,
});
// pin 被 guard 拒 + globalModel 可用 → 输出全局默认(修前菜单行显示残留 pin)
assert.equal(resolveSelectorModel(fakeState(), 'sid-1'), 'deepseek-v4',
  'F2: pin 被 guard 拒 → 菜单行文本 === resolveSelectorModel 输出(全局默认)');
// pin 合法 → 显示 pin(回归哨兵)
assert.equal(resolveSelectorModel(fakeState({ modelBySession: { 'sid-1': 'deepseek-v4' } }), 'sid-1'),
  'deepseek-v4', 'F2: pin 合法 → 菜单行显示 pin');
// 1m 标记叠加(与桌面徽章同口径)
assert.equal(resolveSelectorModel(fakeState({ modelBySession: { 'sid-1': 'deepseek-v4' }, context1mBySession: { 'sid-1': true } }), 'sid-1'),
  'deepseek-v4[1m]', 'F2: context1m 后缀与桌面同口径');

// ② 源码哨兵
const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
const menuStart = app.indexOf('function MobileMenu(');
assert.ok(menuStart > 0, 'F2: MobileMenu 不见了(重构后同步本锚)');
const menu = app.slice(menuStart, menuStart + 4000);
assert.match(menu, /resolveSelectorModel\(s, permKey\)/, 'F2: 手机菜单模型行必须走 resolveSelectorModel');
assert.doesNotMatch(menu, /s\.modelBySession\[permKey\] \|\| s\.currentModel/,
  'F2: 裸 pin||global 链是 bug 本体,不许回退');

console.log('PASS check-r26-mobile-menu-model');
