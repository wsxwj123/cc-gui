#!/usr/bin/env node
// 单测:r150 P4 —— 写死的模型清单里缺 5.5 系列的地方(能确定取值的)。
//
// 上下文窗口兜底表(client/src/utils/contextWindow.js 的 nativeContextWindow):
//   它在 CLI 的实测窗口缺席时(新会话 / 探测超时)当上下文徽章的分母,也决定「1M」开关上"原生 1M"的说明。
//   原来的规则 opus-?[5-9](?![\d-]) 把 "-5" 后面再跟 "-" 的一律挡掉(本意是挡带日期的新代),
//   于是 claude-opus-5-5 / claude-sonnet-5-5 落到 200K;haiku 全系写死 200K。
//   依据:本机 CLI 2.1.296 自带模型目录,三个 5.5 模型都是 context:{window:1e6,native_1m:true}。
// 思考强度、视觉能力两处对 5.5 的结果本来就对(见下方对照),不改。
// Run: node tests/unit/check-r150-model-lists.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.log(`  ✗ ${name}\n      ${String(e && e.message || e).split('\n').slice(0, 14).join('\n      ')}`); }
};

const { nativeContextWindow } = await import(root + 'client/src/utils/contextWindow.js');
const { lookupModelCapabilities } = await import(root + 'server/utils/model-capabilities.js');
const { lookupVisionCapability } = await import(root + 'server/utils/vision-capability.js');

console.log('r150 P4:写死的模型清单里的 5.5 系列');

await check('上下文窗口:三个 5.5 模型是原生 1M(原来:200K)', async () => {
  for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']) {
    assert.equal(nativeContextWindow(id), 1_000_000, id);
  }
});
await check('上下文窗口:5.5 的其他写法同样是 1M(带日期后缀、点写法、带 anthropic/ 前缀、大写)', async () => {
  for (const id of ['claude-opus-5-5-20260901', 'claude-haiku-5-5-20260901', 'anthropic/claude-sonnet-5.5', 'anthropic/claude-haiku-5.5', 'Claude-Opus-5-5']) {
    assert.equal(nativeContextWindow(id), 1_000_000, id);
  }
});
await check('上下文窗口对照:既有结论不变', async () => {
  const want = {
    'claude-opus-5': 1_000_000, 'claude-sonnet-5': 1_000_000, 'claude-opus-4-7': 1_000_000, 'claude-opus-4-8': 1_000_000,
    'claude-fable-5-1': 1_000_000, 'opus': 1_000_000, 'sonnet': 1_000_000,
    'claude-opus-4-6': 200_000, 'claude-sonnet-4-6': 200_000, 'claude-sonnet-4-5': 200_000, 'claude-opus-4-5': 200_000,
    'claude-haiku-4-5': 200_000, 'claude-haiku-4-5-20251001': 200_000, 'claude-3-5-haiku-20241022': 200_000, 'haiku': 200_000,
    'claude-sonnet-5-20260101': 200_000,   // 5 代带日期:原来就按保守 200K,不动
    'claude-opus-5-50': 200_000,           // 不是 5.5
    'claude-opus-4-6[1m]': 1_000_000, 'gpt-5.6-sol': 1_050_000, 'kimi-k3': 1_048_576, 'deepseek-chat': 131_072,
  };
  for (const [id, win] of Object.entries(want)) assert.equal(nativeContextWindow(id), win, id);
});
await check('对照(不改):思考强度 —— 5.5 三档都是全档(opus / sonnet 经变体回退命中 5 代的全档条目,haiku 未登记 = 全档)', async () => {
  const all = ['low', 'medium', 'high', 'xhigh', 'max'];
  assert.deepEqual(lookupModelCapabilities('claude-opus-5-5', 'anthropic')?.efforts, all);
  assert.deepEqual(lookupModelCapabilities('claude-sonnet-5-5', 'anthropic')?.efforts, all);
  assert.equal(lookupModelCapabilities('claude-haiku-5-5', 'anthropic'), null, '未登记 = 全档(维持现状)');
});
await check('对照(不改):视觉能力 —— 5.5 三档都判为支持图片', async () => {
  for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']) assert.equal(lookupVisionCapability(id), true, id);
});

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
