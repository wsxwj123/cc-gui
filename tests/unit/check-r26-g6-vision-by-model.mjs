#!/usr/bin/env node
// r26-G6:upstreamNoVision 主判据从 baseURL 正则改为模型名能力表
// (model-capabilities.js 新增 lookupVisionCapability),baseURL 正则降为
// 「模型名查无记录」时的兜底;判定按 `${baseURL}|${model}` 缓存。
// 哨兵:S1 删掉模型名主判据(回到纯 baseURL 正则)→ t1/t2 红;
//       S2 删掉兜底分支 → t3 红;S3 视觉表判反 → t1/t2 红。
import assert from 'node:assert/strict';
import { setOpenAIUpstream, upstreamNoVision } from '../../server/services/openai-proxy.js';
// r63:lookupVisionCapability 抽到独立纯模块(前端复用),import 路径随迁
import { lookupVisionCapability } from '../../server/utils/vision-capability.js';

const judge = (baseURL, model) => { setOpenAIUpstream({ baseURL, apiKey: 'k', model }); return upstreamNoVision(); };

// t1(误判哨兵,修前必红):已知视觉模型 + 含 deepseek 字样的陌生/同名部署 baseURL → 不剥图
assert.equal(judge('https://api.deepseek.com/v1', 'gpt-4o'), false,
  't1: gpt-4o 有视觉,即使 baseURL 含 deepseek 字样也不剥图(修前按 baseURL 误判剥图)');
assert.equal(judge('https://deepseek-gateway.internal.example/v1', 'claude-sonnet-4-6'), false,
  't1: claude 有视觉,网关同名部署不误判');

// t2(漏判哨兵,修前必红):已知无视觉模型 + 官方/陌生 URL → 剥图
assert.equal(judge('https://api.openai.com/v1', 'deepseek-chat'), true,
  't2: deepseek-chat 无视觉,即使走官方 URL 也剥图(修前 baseURL 不含 deepseek → 漏判)');
assert.equal(judge('https://aggregator.example/v1', 'deepseek-v4-flash'), true,
  't2: 聚合站 URL 不含 deepseek 字样,模型名判无视觉仍剥图');

// t3(兜底哨兵):查无记录模型 → 回落旧 baseURL 正则,行为不变
assert.equal(judge('https://api.deepseek.com/v1', 'some-unknown-model-x'), true,
  't3: 查无记录模型 + deepseek baseURL → 兜底正则命中,剥图(旧行为保留)');
assert.equal(judge('https://api.openai.com/v1', 'some-unknown-model-x'), false,
  't3: 查无记录模型 + 普通 baseURL → 不剥图(旧行为保留)');
assert.equal(judge('http://127.0.0.1:8798/opencode', 'some-unknown-model-x'), false,
  't3: opencode + 非 deepseek 系未知模型 → 不剥图(旧行为保留)');

// t4 能力表本身:三态 + 命名空间剥前缀
assert.equal(lookupVisionCapability('deepseek-chat'), false, 't4: deepseek 判无视觉');
assert.equal(lookupVisionCapability('gpt-4o'), true, 't4: gpt-4o 判有视觉');
assert.equal(lookupVisionCapability('openrouter/deepseek-chat'), false, 't4: 带前缀剥尾段同判');
assert.equal(lookupVisionCapability('totally-unknown-9'), null, 't4: 查无记录 → null(不猜)');
assert.equal(lookupVisionCapability(''), null, 't4: 空模型安全');

// t6(r37,修前必红):DeepSeek 识图系必须压过全系 false 的一刀切(目录首命中即返回,
// 例外行必须排在一刀切之前)。上游已实测:openai 端点收 image_url、anthropic 端点收
// image block(纯色图各答对)。变异:删掉/下移 vision 例外行 → 下面全部红。
for (const id of [
  'deepseek-v4-flash-vision-exp',
  'deepseek-v4-flash-vision-exp[1m]',          // GUI 配置里的 1M 后缀形态
  'openrouter/deepseek-v4-flash-vision-exp',   // 命名空间前缀剥尾段
  // org 恰为 deepseek 的聚合商形态:全 id 会先撞一刀切,例外行必须自己吃下含 / 的全 id
  // (剥尾段重试轮不到)。变异:例外行字符类去掉 / → 本条红。
  'deepseek/deepseek-v4-flash-vision-exp',
]) {
  assert.equal(lookupVisionCapability(id), true, `t6: ${id} 判有视觉`);
}
assert.equal(judge('https://api.deepseek.com/v1', 'deepseek-v4-flash-vision-exp'), false,
  't6: deepseek 识图模型即使走官方 deepseek URL 也不剥图(修前被一刀切剥掉)');
assert.equal(judge('http://127.0.0.1:8798/opencode', 'deepseek-v4-flash-vision-exp'), false,
  't6: opencode 聚合下的 deepseek 识图模型不剥图(修前 baseURL 兜底也会剥)');
assert.equal(lookupVisionCapability('deepseek-v4-flash'), false,
  't6: 非识图的 deepseek 模型仍判无视觉(例外不扩大)');

// t5 缓存:同 key 不重算(换 upstream 后 key 失效重算 —— 由 t1↔t2 交叉驱动已隐含验证,
// 这里钉「同 key 第二次调用结果一致且不受中间状态污染」)
{
  setOpenAIUpstream({ baseURL: 'https://api.deepseek.com/v1', apiKey: 'k', model: 'gpt-4o' });
  const a = upstreamNoVision();
  const b = upstreamNoVision();
  assert.equal(a, b, 't5: 同 key 缓存命中,结果一致');
  assert.equal(a, false, 't5: 缓存值正确(gpt-4o 不剥图)');
}
setOpenAIUpstream(null); // 收尾:不污染同进程后续测试

console.log('check-r26-g6-vision-by-model: all passed');
