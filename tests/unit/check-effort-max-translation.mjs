#!/usr/bin/env node
// r15-4:openai-proxy 里 'max' 档的折算必须按目标模型的实测档位,不能一刀切降成 xhigh。
//
// 旧行为 `if (raw === 'max') return 'xhigh'` 的来历是 OpenAI codex 系(认 xhigh 不认 max),
// 但套到所有 OpenAI 兼容端点就错了:DeepSeek 官方 reasoning_effort 只认 low/high/max,
// 且把 xhigh 映射回 high —— 中转站上「高」与「极限」发出去的是同一个东西,max 档白给。
//
// 判据只信数据表(lookupModelCapabilities 的 family==='table');正则命中的"全档"是兜底
// 猜测,不足以据此升档 → 维持旧的 xhigh(保守,不改变未知模型现状)。
import assert from 'node:assert/strict';
import { normalizeReasoningEffort } from '../../server/services/openai-proxy.js';

const at = (model, effort = 'max') => normalizeReasoningEffort({ model, effort });

// ① 表里明确支持 max 的 → 直发 max(本轮要修的核心场景)
for (const m of ['deepseek-v4-pro', 'deepseek-v4-flash', 'kimi-k3', 'glm-5.2', 'glm-5.3']) {
  assert.equal(at(m), 'max', `${m}: 表说支持 max,必须直发 max(旧代码降成 xhigh → DeepSeek 侧又被映射回 high)`);
}

// ② 表里不支持 max 的 → 落该模型真实的最高档,而不是无脑 xhigh
assert.equal(at('gpt-5.2'), 'xhigh', 'gpt-5.2: efforts 到 xhigh 为止');
assert.equal(at('gpt-5.2-codex'), 'xhigh', 'gpt-5.2-codex: 认 xhigh');
assert.equal(at('gpt-5-codex'), 'high', 'gpt-5-codex: 表里只到 high,发 xhigh 会触发上游剥参重试');
assert.equal(at('mimo-v2.5-pro'), 'high', 'mimo: 纯开关型,最高档 high');
assert.equal(at('qwen3.8-max'), 'xhigh', 'qwen3.8-max: 官方 low/medium/xhigh');

// ③ 表说不思考 → 干脆不下发 reasoning_effort
assert.equal(at('gpt-4o'), null, 'gpt-4o 非推理模型,不应下发 reasoning_effort');

// ④ 表外 / 只被家族正则猜中 → 维持旧行为 xhigh(不拿猜测去升档)
assert.equal(at('某个从未见过的模型-v9'), 'xhigh', '表外模型维持既有 xhigh 行为');
assert.equal(at('minimax-m9-preview'), 'xhigh', '只被正则猜成"全档"的,不足以据此发 max');

// ⑤ 带命名空间前缀的按表走(剥前缀复查在 lookupModelCapabilities 里)
assert.equal(at('openai/gpt-5.6-luna'), 'max', 'openrouter 形态:表说全档 → 认 max');

// ⑥ 非 max 档一律原样透传,不受本次改动影响
for (const e of ['low', 'medium', 'high', 'xhigh', 'minimal', 'none']) {
  assert.equal(at('deepseek-v4-pro', e), e, `${e} 档必须原样透传`);
}
assert.equal(normalizeReasoningEffort({ model: 'x', effort: 'bogus' }), null, '非法档位返回 null');
assert.equal(normalizeReasoningEffort({ model: 'x' }), null, '没有 effort 返回 null');
// 三个入参形态都要认(GUI 走 effort,原生 Anthropic 走 thinking.effort)
assert.equal(normalizeReasoningEffort({ model: 'deepseek-v4-pro', reasoning_effort: 'max' }), 'max', 'reasoning_effort 入参');
assert.equal(normalizeReasoningEffort({ model: 'deepseek-v4-pro', thinking: { effort: 'max' } }), 'max', 'thinking.effort 入参');
// model 缺失不能抛
assert.equal(normalizeReasoningEffort({ effort: 'max' }), 'xhigh', '无 model 时维持旧行为、不抛');

// ⑦ r15-4 判官必修:[1m] 后缀(GUI 给 1M 会话追加、chat.js 原样 --model 下发)不能让查表落空。
// 漏了它 = 整套折算对 1M 会话失效,而 DeepSeek/MiMo/Kimi 这批中转正是 1M 开关的主要使用者。
for (const m of ['deepseek-v4-pro', 'kimi-k3', 'glm-5.2']) {
  assert.equal(at(`${m}[1m]`), at(m), `${m}[1m] 必须与裸 id 同判定(客户端 effortCaps.js 早已剥后缀)`);
  assert.equal(at(`${m}[1m]`), 'max', `${m}[1m] 应发 max`);
}
assert.equal(at('gpt-4o[1m]'), null, '[1m] 剥离后仍认得非推理模型');

// ⑧ r15-4 判官必修:表里"全档"必须可表达。原先生成脚本把全档模型整条丢弃,于是
// claude-opus-5/sonnet-5/gpt-5.6-luna 等 58 个主力模型落回家族正则 → max 被降成 xhigh。
for (const m of ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'gpt-5.6-luna']) {
  assert.equal(at(m), 'max', `${m}: 全档模型必须直发 max(此前因表无法表达全档而降成 xhigh)`);
}

console.log('check-effort-max-translation: all passed');
