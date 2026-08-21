#!/usr/bin/env node
// r26-F1:徽章兜底 globalModel 不过 guard —— 显示当前 provider 不支持的残留模型。
// 修法:兜底链末位也过 modelGuard;全链被拒且曾有值 → 显示固定文案「默认模型」。
// ①源码哨兵:globalModel 必须过 guard、固定文案兜底存在;
// ②行为层:用真 makeProviderModelGuard 复算解析链 —— pin 与 globalModel 同口径,
//   全拒场景输出 === '默认模型' 固定串(非任何残留变量);开机窗口(列表未加载)不误杀。
// Run: node tests/unit/check-r26-badge-fallback.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeProviderModelGuard } from '../../client/src/utils/routing.js';

// ② 行为层:与 App.jsx 相同的解析链,guard 用真实现
const resolve = (guard, { pin, hist, globalModel }) =>
  (guard(pin) ? pin : null) || (guard(hist) ? hist : null) || (guard(globalModel) ? globalModel : null);
const headerOf = (guard, { pin, hist, globalModel }, currentModel) =>
  (guard(pin) ? pin : null) || currentModel
  || ((pin || hist || globalModel) ? '默认模型' : null);

const guard = makeProviderModelGuard({ availableModels: [{ id: 'deepseek-v4' }], customModels: [], officialAnthropic: false });

// pin 与 globalModel 同口径:pin 合法 → 用 pin;pin 拒 + global 合法 → global
assert.equal(headerOf(guard, { pin: 'deepseek-v4', hist: null, globalModel: 'claude-x' }, resolve(guard, { pin: 'deepseek-v4', hist: null, globalModel: 'claude-x' })),
  'deepseek-v4', 'F1: pin 合法 → 显示 pin(同口径哨兵)');
assert.equal(headerOf(guard, { pin: 'claude-sonnet-4-6', hist: null, globalModel: 'deepseek-v4' }, resolve(guard, { pin: 'claude-sonnet-4-6', hist: null, globalModel: 'deepseek-v4' })),
  'deepseek-v4', 'F1: pin 被 guard 拒 → 落到合法 globalModel');

// 核心哨兵:globalModel 被 guard 拒 + 无 pin → 徽章文案 === '默认模型' 固定串(不是残留旧值)
{
  const base = resolve(guard, { pin: null, hist: null, globalModel: 'claude-sonnet-4-6' });
  assert.equal(base, null, 'F1: 被拒的 globalModel 不得进入解析结果(残留旧值哨兵)');
  const header = headerOf(guard, { pin: null, hist: null, globalModel: 'claude-sonnet-4-6' }, base);
  assert.equal(header, '默认模型', 'F1: 全链被拒 → 固定文案「默认模型」');
  assert.notEqual(header, 'claude-sonnet-4-6', 'F1: 绝不显示 provider 不支持的残留模型');
}

// 开机窗口:两列表都空 → guard 一律放行(不误杀);全无值 → 徽章隐藏(不闪「默认模型」)
{
  const bootGuard = makeProviderModelGuard({ availableModels: [], customModels: [], officialAnthropic: false });
  assert.equal(resolve(bootGuard, { pin: null, hist: null, globalModel: 'anything' }), 'anything',
    'F1: 列表未加载时一律放行(与既有口径一致)');
  assert.equal(headerOf(guard, { pin: null, hist: null, globalModel: null }, null), null,
    'F1: 从无上过值(开机)→ 徽章隐藏,固定文案只兜「曾有值但被拒」');
}

// ① 源码哨兵
const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
assert.match(app, /\|\| \(modelGuard\(globalModel\) \? globalModel : null\)/,
  'F1: 兜底链末位 globalModel 必须过 modelGuard');
assert.match(app, /\?\? |\|\| \(\(pinnedModel \|\| historyModel \|\| globalModel\) \? '默认模型' : null\)/,
  'F1: 徽章末位兜底必须是「默认模型」固定串');
assert.doesNotMatch(app, /\|\| \(modelGuard\(historyModel\) \? historyModel : null\)\s*\n\s*\|\| globalModel;/,
  'F1: 裸 globalModel 兜底是 bug 本体,不许回退');

console.log('PASS check-r26-badge-fallback');
