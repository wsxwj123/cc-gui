#!/usr/bin/env node
// r26-F5:translateMaxEffort 判断顺序 —— reasoning===false(显式关思考)必须先于
// family!=='table 的「维持旧行为 xhigh」分支。
// 修前:正则判死的模型(名字命中家族正则、reasoning:false,family 是家族名非 'table')
// 走到 `if (hit?.family !== 'table') return 'xhigh'` 被提前截胡 → 非思考模型被下发
// reasoning_effort=xhigh。
// 哨兵:S1 把 reasoning===false 检查挪回 family 判断之后 → t1/t2 红。
import assert from 'node:assert/strict';
import { normalizeReasoningEffort } from '../../server/services/openai-proxy.js';

const at = (model, effort = 'max') => normalizeReasoningEffort({ model, effort });

// t1(★顺序哨兵,修前必红):正则判死(reasoning:false)的模型不得下发任何 effort
// gpt-4 系家族正则 caps.reasoning=false;gpt-4.9-turbo 不在数据表 → 纯正则命中
assert.equal(at('gpt-4.9-turbo'), null,
  't1: 正则判死的非思考模型(gpt-4 系)不得下发 xhigh(修前 family!==table 截胡返回 xhigh)');
assert.equal(at('qwen2.9-72b'), null,
  't1: qwen2 系正则 reasoning:false,同样不得下发');
assert.equal(at('qwen3.5-instruct'), null,
  't1: qwen-instruct 系正则 reasoning:false,不得下发');

// t2(顺序哨兵变体):表里判死 + 正则也判死,结论一致
assert.equal(at('gpt-4o'), null, 't2: 表说 gpt-4o 不思考 → 不下发(既有行为不回归)');

// t3(不破坏正路):表说支持思考的模型仍正常下发
assert.equal(at('deepseek-v4-pro'), 'max', 't3: 表说全档 → 直发 max');
assert.equal(at('gpt-5.2'), 'xhigh', 't3: 表说到 xhigh 为止 → xhigh');
assert.equal(at('claude-opus-5'), 'max', 't3: 表说全档(claude)→ max');

// t4(不破坏正路):表外 / 只被正则猜成「全档」的维持旧行为 xhigh
assert.equal(at('某个从未见过的模型-v9'), 'xhigh', 't4: 表外模型维持既有 xhigh');
assert.equal(at('minimax-m9-preview'), 'xhigh', 't4: 正则猜中全档不足以升档,维持 xhigh');

console.log('check-r26-f5-translate-effort-order: all passed');
