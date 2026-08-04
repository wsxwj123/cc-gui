// Q-a:计价必须按【这条消息实际用的模型】,不是当前 env 档位(provider.model)。
// Run: node tests/unit/check-pricing-permessage.mjs
// 原 bug:lookupPrice 的 deepseek / mimo 分支完全忽略传入的 model 参数,只看 provider.model。
// 后果 ①换档后回看旧会话按新档计价(v4-flash↔v4-pro 差 3×);②当前切到 deepseek/mimo 时
// 打开任何历史 Claude 会话,整条会话按 deepseek/mimo 单价算(差一个数量级)。
// REMOTE 置空(localStorage 返回 null),全部走内置表,数字可手算。
import assert from 'node:assert';

globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const { computeCost } = await import('../../client/src/utils/pricing.js');

const CNY = 7.2;
const IN1M = { input_tokens: 1_000_000 };
const IO1M = { input_tokens: 1_000_000, output_tokens: 1_000_000 };

// ① deepseek:env 档位在 flash,这条消息实际是 v4-pro → 必须按 v4-pro($0.435)计。
const dsPro = computeCost('deepseek-v4-pro', IN1M, { providerHint: 'deepseek', model: 'deepseek-v4-flash' });
assert.ok(Math.abs(dsPro.totalUsd - 0.435) < 1e-9, `per-message v4-pro ${dsPro?.totalUsd} != 0.435(被 env 档位 flash 覆盖?)`);
// 反向:env 在 pro、消息是 flash → 按 flash($0.14)计。
const dsFlash = computeCost('deepseek-v4-flash', IN1M, { providerHint: 'deepseek', model: 'deepseek-v4-pro' });
assert.ok(Math.abs(dsFlash.totalUsd - 0.14) < 1e-9, `per-message v4-flash ${dsFlash?.totalUsd} != 0.14`);

// ② 当前 provider 是 deepseek,但这条历史消息是 Claude Opus → 必须按 Claude 价($5)。
const crossClaude = computeCost('claude-opus-4-8', IN1M, { providerHint: 'deepseek', model: 'deepseek-v4-pro' });
assert.ok(Math.abs(crossClaude.totalUsd - 5) < 1e-9, `跨 provider 历史消息 ${crossClaude?.totalUsd} != 5(被 deepseek 档位吃掉?)`);

// ③ 回落路径不变:消息无 model(老 jsonl / 流式首帧)→ 仍按 provider.model 档位。
const dsNoModel = computeCost(null, IN1M, { providerHint: 'deepseek', model: 'deepseek-v4-pro' });
assert.ok(Math.abs(dsNoModel.totalUsd - 0.435) < 1e-9, `provider.model 回落 ${dsNoModel?.totalUsd} != 0.435`);
// 'deepseek-' 前缀补全的老逻辑保留:provider.model='v4-pro' → deepseek-v4-pro。
const dsPrefix = computeCost(null, IN1M, { providerHint: 'deepseek', model: 'v4-pro' });
assert.ok(Math.abs(dsPrefix.totalUsd - 0.435) < 1e-9, `deepseek- 前缀补全 ${dsPrefix?.totalUsd} != 0.435`);
// 全都查不到 → deepseek-chat 兜底($0.14),不返回 null。
// (provider.model 为空串时 lookupPrice 首行守卫直接 return null,是既有行为,不在本批改动范围。)
const dsUnknown = computeCost(null, IN1M, { providerHint: 'deepseek', model: 'nonexistent-xyz' });
assert.ok(Math.abs(dsUnknown.totalUsd - 0.14) < 1e-9, `deepseek 兜底 ${dsUnknown?.totalUsd} != 0.14`);

// ④ mimo 同构:env 档位在 pro(¥3/¥6),消息实际是 mimo-v2.5(¥1/¥2)。
const mimoBase = computeCost('mimo-v2.5', IO1M, { providerHint: 'mimo', model: 'mimo-v2.5-pro' });
assert.ok(Math.abs(mimoBase.totalUsd - (1 + 2) / CNY) < 1e-9, `per-message mimo-v2.5 ${mimoBase?.totalUsd} != ${(1 + 2) / CNY}`);
// mimo 回落:无 model → provider.model 档位,再兜底 pro。
const mimoNoModel = computeCost(null, IO1M, { providerHint: 'mimo', model: 'mimo-v2.5' });
assert.ok(Math.abs(mimoNoModel.totalUsd - (1 + 2) / CNY) < 1e-9, `mimo provider.model 回落 ${mimoNoModel?.totalUsd}`);
const mimoFallback = computeCost(null, IO1M, { providerHint: 'mimo', model: 'nonexistent-xyz' });
assert.ok(Math.abs(mimoFallback.totalUsd - (3 + 6) / CNY) < 1e-9, `mimo 兜底 pro ${mimoFallback?.totalUsd} != ${(3 + 6) / CNY}`);

// ⑤ 非这两家零影响:同一 usage 在 anthropic / 未知 hint / 无 provider 下结果逐位相同。
const base = computeCost('claude-opus-4-8', IO1M, { providerHint: 'anthropic', model: 'claude-opus-4-8' });
assert.strictEqual(base.totalUsd, computeCost('claude-opus-4-8', IO1M).totalUsd, 'anthropic 分支被改动影响');
assert.strictEqual(base.totalUsd, computeCost('claude-opus-4-8', IO1M, { providerHint: 'unknown', model: 'x' }).totalUsd, 'unknown 分支被改动影响');
assert.ok(Math.abs(base.totalUsd - (5 + 25)) < 1e-9, `opus-4-8 ${base.totalUsd} != 30`);

console.log('check-pricing-permessage OK');
