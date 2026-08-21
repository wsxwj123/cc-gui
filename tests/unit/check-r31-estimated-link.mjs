#!/usr/bin/env node
// r31:第三方 provider /context 快路的 estimated 标记链路补通。
// 背景:加速 g3 已让 anthropic/openai 两个 proxy 在 count_tokens 响应顶层带 estimated:true,
// 但 SDK slot.query.getContextUsage() 不透传自定义字段 → mapSdkContextUsage 里 u.estimated
// 恒 undefined,估算值被前端误标成「精确·SDK 实测」。修法:proxy 与 chat.js 同在 server
// 进程,建一张共享最近结果表;proxy 返回前 record,快路按 model 回查,命中且 estimated
// 就把标记补进 usage 再进 mapSdkContextUsage。官方 provider 不走 proxy,不打标。
// 全本地单测:不起端口、不碰真实第三方 API、不读写 ~/.claude*/** 真实数据(HOME 不动)。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { recordCountTokensOutcome, latestCountTokensOutcome } =
  await import('../../server/utils/context-tokens.js');
const { applyCountTokensEstimated } = await import('../../server/routes/chat.js');

// ── t1:record → latest:基本记录 + 模型匹配 ──────────────────────────────────
{
  recordCountTokensOutcome({ model: 'model-a', estimated: true, inputTokens: 123 });
  const hit = latestCountTokensOutcome('model-a');
  assert.ok(hit, 't1: 应查到刚记录的 model-a 结果');
  assert.equal(hit.estimated, true, 't1: 结果带 estimated 布尔');
  assert.equal(hit.inputTokens, 123, 't1: 结果带 inputTokens');

  // 非字符串 model 归空串,按字符串匹配不串味
  recordCountTokensOutcome({ model: 42, estimated: true, inputTokens: 5 });
  assert.equal(latestCountTokensOutcome('model-a').model, 'model-a', 't1: 模型匹配按字符串');
  assert.equal(latestCountTokensOutcome('model-b'), null, 't1: 未记录的模型不命中');
}

// ── t2:时间窗 —— 3s 内命中,过期不命中(宁可不标也不错标) ──────────────────
{
  const now = Date.now();
  recordCountTokensOutcome({ model: 'model-window', estimated: true, inputTokens: 9 });
  // now 注入记录后 2.5s:仍未超 3s 窗 → 命中
  const hitNear = latestCountTokensOutcome('model-window', { now: now + 2500 });
  assert.ok(hitNear, 't2: 2.5s 内应命中');
  // now 注入记录后 3.5s:已超 3s 窗 → 不命中
  const hitFar = latestCountTokensOutcome('model-window', { now: now + 3500 });
  assert.equal(hitFar, null, 't2: 超 3s 窗不命中(过期)');
}

// ── t3:保留窗修剪 —— 压入大量记录仍可查(上限 MAX 不无限增长的行为哨兵) ──
{
  for (let i = 0; i < 30; i++) recordCountTokensOutcome({ model: 'model-stress', estimated: true, inputTokens: i });
  const hit = latestCountTokensOutcome('model-stress');
  assert.equal(hit.estimated, true, 't3: 压入 30 条仍可查(上限修剪正常)');
  assert.equal(hit.inputTokens, 29, 't3: 查到的是最新一条');
}

// ── t4:proxy 响应组装点接线哨兵(record 须在返回前接线) ─────────────────────
{
  const aSrc = readFileSync(new URL('../../server/services/anthropic-proxy.js', import.meta.url), 'utf8');
  const oSrc = readFileSync(new URL('../../server/services/openai-proxy.js', import.meta.url), 'utf8');
  // anthropic:精确路径(estimated:false)与估算回退路径(estimated:true)都要接线 record
  assert.match(aSrc,
    /recordCountTokensOutcome\(\{ model: parsedBody\.model, estimated: false, inputTokens: upstreamCount\.input_tokens \}\)/,
    't4: anthropic 精确路径须在返回前 record(estimated:false)');
  assert.match(aSrc,
    /recordCountTokensOutcome\(\{ model: parsedBody\.model, estimated: true, inputTokens: estimatedBody\.input_tokens \}\)/,
    't4: anthropic 估算回退路径须在返回前 record(estimated:true)');
  // openai:恒估算(estimated:true)须接线 record
  assert.match(oSrc,
    /recordCountTokensOutcome\(\{ model: parsedBody\.model, estimated: true, inputTokens: estimatedBody\.input_tokens \}\)/,
    't4: openai 估算路径须在返回前 record(estimated:true)');
}

// ── t5:快路补标行为(mock slot.query getContextUsage 的返回 + 预置记录) ──────
{
  // 预置一条估算记录,模拟第三方 provider 的 count_tokens 估算回落刚写入共享表
  recordCountTokensOutcome({ model: 'deepseek-chat', estimated: true, inputTokens: 888 });
  const sdkUsage = {
    model: 'deepseek-chat', totalTokens: 888, maxTokens: 64000, percentage: 1,
    categories: [], mcpTools: [],
  };
  // 第三方 + 命中估算记录 → 补 estimated:true,且不篡改 usage 数字
  const patched = applyCountTokensEstimated(sdkUsage, true);
  assert.equal(patched.estimated, true, 't5: 第三方 + 命中估算记录 → 补 estimated:true');
  assert.equal(patched.totalTokens, 888, 't5: 补标不篡改 usage 数字');
  // 官方(thirdParty=false)即使有同模型记录也绝不补标(防跨 provider 污染)
  const official = applyCountTokensEstimated({ ...sdkUsage }, false);
  assert.ok(!('estimated' in official), 't5: 官方会话不打标(防跨 provider 污染)');
  // 查不到记录 → 原样返回、不打标
  const miss = applyCountTokensEstimated({ ...sdkUsage, model: 'no-such-model' }, true);
  assert.ok(!('estimated' in miss), 't5: 查不到 → 宁可不标也不错标');
}

// ── t6:chat.js 快路顶层接线哨兵(补标函数在快路被真实调用) ──────────────────
{
  const src = readFileSync(new URL('../../server/routes/chat.js', import.meta.url), 'utf8');
  assert.match(src, /const patched = applyCountTokensEstimated\(usage, isThirdPartyProvider\(\)\);/,
    't6: 快路必须在 getContextUsage 后调 applyCountTokensEstimated,且带第三方 gate');
}

console.log('PASS check-r31-estimated-link');
