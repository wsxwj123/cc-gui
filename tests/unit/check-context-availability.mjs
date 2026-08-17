#!/usr/bin/env node
// 单测:r11-⑨ 第三方精确上下文通路 + 徽章弹层永不报错。
// import 真函数(server/utils/context-tokens.js + client contextCache.js)+ 接线仪表化。
// 取证(2026-08-17,只读):CLI POST /v1/messages/count_tokens?beta=true、消费 .input_tokens
// (装机二进制字符串层);两代理此前均未实现该端点(anthropic-proxy 盲透传上游 404,
// openai-proxy 把它当生成请求转 chat/completions=真实计费调用)→ 第三方精确计算必超时;
// AA1 后台探测(弹层秒开缓存)在 55b3ce2 被删 → 首开只剩总量没组分。
// 变异哨兵(实际验证过红):
//   S1 estimateInputTokens 删本地估算回退(恒 0)→ t2 红
//   S2 applyExactResult 删「失败保持已显示组成」分支(失败清 data)→ t5 红
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  isCountTokensRequest, estimateInputTokens, parseUpstreamCountTokens,
  contextTimeoutBudget, COUNT_TOKENS_UPSTREAM_TIMEOUT_MS,
} from '../../server/utils/context-tokens.js';
import { pickBreakdownTier, applyExactResult, relativeAgeLabel } from '../../client/src/utils/contextCache.js';

// t1 count_tokens 请求判定(路径带 ?beta=true 是 CLI 实发形态)
{
  assert.equal(isCountTokensRequest('POST', '/v1/messages/count_tokens'), true, 't1: 裸路径');
  assert.equal(isCountTokensRequest('POST', '/v1/messages/count_tokens?beta=true'), true, 't1: CLI 实发形态(?beta=true)');
  assert.equal(isCountTokensRequest('POST', '/v1/messages'), false, 't1: 生成请求不误判');
  assert.equal(isCountTokensRequest('POST', '/v1/messages/count_tokens_x'), false, 't1: 前缀相似不误判');
  assert.equal(isCountTokensRequest('GET', '/v1/messages/count_tokens'), false, 't1: 非 POST 不判');
  assert.equal(COUNT_TOKENS_UPSTREAM_TIMEOUT_MS, 2000, 't1: 上游透传短超时 2s');
}

// t2 本地估算口径:JSON.stringify(messages+system+tools).length/4 量级,响应形态 {input_tokens}
{
  const body = {
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'x'.repeat(4000) }],
    system: 's'.repeat(400),
    tools: [{ name: 'Bash', description: 'd'.repeat(400) }],
  };
  const out = estimateInputTokens(body);
  assert.ok(Number.isFinite(out.input_tokens), 't2: 响应字段名必须是 input_tokens(CLI 只读它,二进制实证)');
  const expected = Math.ceil(JSON.stringify({ messages: body.messages, system: body.system, tools: body.tools }).length / 4);
  assert.equal(out.input_tokens, expected, 't2: 字符启发式 = 序列化长度/4');
  assert.ok(out.input_tokens > 1000, 't2: 4.8k 字符量级 → 千级 tokens');
  assert.deepEqual(Object.keys(out), ['input_tokens'], 't2: 不夹带多余字段');
  assert.equal(estimateInputTokens(null).input_tokens >= 0, true, 't2: 空 body 安全');
  const circ = {}; circ.self = circ;
  assert.equal(estimateInputTokens({ messages: [circ] }).input_tokens, 0, 't2: 序列化失败安全回 0');
}

// t3 上游响应校验:200 但缺数字 input_tokens 的垃圾体不透传(回退估算)
{
  assert.deepEqual(parseUpstreamCountTokens('{"input_tokens":123}'), { input_tokens: 123 }, 't3: 合法体透传');
  assert.equal(parseUpstreamCountTokens('{"tokens":5}'), null, 't3: 缺字段拒绝');
  assert.equal(parseUpstreamCountTokens('{"input_tokens":"12"}'), null, 't3: 非数字拒绝');
  assert.equal(parseUpstreamCountTokens('<html>gateway error</html>'), null, 't3: 非 JSON 拒绝');
}

// t4 快路超时预算自适应:基础 8s,每 100k +2s,上限 30s
{
  assert.equal(contextTimeoutBudget(0), 8000, 't4: 无已知规模 → 8s(旧行为)');
  assert.equal(contextTimeoutBudget(undefined), 8000, 't4: 缺省 → 8s');
  assert.equal(contextTimeoutBudget(99_999), 8000, 't4: <100k 不加');
  assert.equal(contextTimeoutBudget(100_000), 10000, 't4: 100k → +2s');
  assert.equal(contextTimeoutBudget(500_000), 18000, 't4: 500k → 18s');
  assert.equal(contextTimeoutBudget(1_100_000), 30000, 't4: 上限 30s');
  assert.equal(contextTimeoutBudget(9_999_999), 30000, 't4: 巨值仍 30s');
  assert.equal(contextTimeoutBudget(NaN), 8000, 't4: 非法按 0');
}

// t5 弹层三级回退 + 失败静默降级(⑨产品原则:任何情况不弹报错)
{
  assert.equal(pickBreakdownTier({ cached: true, localTokens: 0 }), 'cached', 't5: 精确缓存优先');
  assert.equal(pickBreakdownTier({ cached: false, localTokens: 1234 }), 'local', 't5: 无缓存 → 本地估算组成');
  assert.equal(pickBreakdownTier({ cached: false, localTokens: 0 }), 'skeleton', 't5: 全新会话 → 骨架');
  const shown = { totalTokens: 100, categories: [{ name: 'x', tokens: 100, pct: 1 }], localOnly: true };
  const fail = applyExactResult(shown, { ok: false, reason: 'timeout' });
  assert.equal(fail.data, shown, 't5: 失败必须保持已显示组成不动(不清空)');
  assert.equal(fail.exactUnavailable, true, 't5: 失败置"精确暂不可用"标记');
  const exact = { totalTokens: 120, categories: [], source: 'sdk' };
  const ok = applyExactResult(shown, { ok: true, data: exact });
  assert.equal(ok.data, exact, 't5: 成功无感原位替换');
  assert.equal(ok.exactUnavailable, false, 't5: 成功清标记');
  assert.equal(relativeAgeLabel(new Date(Date.now() - 5 * 60_000).toISOString()), '5 分钟前', 't5: 缓存新鲜度标注');
  assert.equal(relativeAgeLabel('garbage'), '', 't5: 非法时间安全');
}

// t6 接线仪表化:两代理拦截 + /context 两段式 + 弹层无报错路径
{
  const ap = readFileSync(new URL('../../server/services/anthropic-proxy.js', import.meta.url), 'utf8');
  assert.match(ap, /isCountTokensRequest\(req\.method, req\.url\)/, 't6: anthropic-proxy 拦截 count_tokens');
  assert.match(ap, /up\.baseURL \+ req\.url/, 't6: 只转发到当前 upstream(红线)');
  assert.match(ap, /estimateInputTokens\(parsedBody\)/, 't6: 上游失败回退本地估算');
  assert.match(ap, /COUNT_TOKENS_UPSTREAM_TIMEOUT_MS/, 't6: 2s 短超时接线');
  const op = readFileSync(new URL('../../server/services/openai-proxy.js', import.meta.url), 'utf8');
  const opIntercept = /if \(isCountTokensRequest\(req\.method, req\.url\)\) \{[\s\S]{0,700}?\n  \}/.exec(op)?.[0] || '';
  assert.ok(opIntercept, 't6: openai-proxy 拦截 count_tokens');
  assert.match(opIntercept, /estimateInputTokens\(parsedBody\)/, 't6: openai 协议直接本地估算');
  assert.doesNotMatch(opIntercept, /fetch\(/, 't6: openai 协议的 count_tokens 不外发任何请求(红线)');
  const chat = readFileSync(new URL('../../server/routes/chat.js', import.meta.url), 'utf8');
  assert.match(chat, /contextTimeoutBudget\(request\.knownTokens\)/, 't6: 快路超时预算自适应');
  const fastPath = /r11-⑨ 两段式[\s\S]*?^  \}/m.exec(chat)?.[0] || '';
  assert.doesNotMatch(fastPath, /status\(504\)|status\(500\)/, 't6: 快路超时/失败不再直接 5xx(回落慢路径)');
  assert.match(chat, /knownTokens/, 't6: knownTokens 参数在');
  const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /applyExactResult\(prev, \{ ok: false \}\)/, 't6: 失败走静默降级 reducer');
  assert.match(app, /精确计算暂不可用/, 't6: 底部小字在');
  assert.doesNotMatch(app, /精确计算失败：/, 't6: 「精确计算失败」类红字全删');
  assert.match(app, /口径：分子 = 单次请求实测/, 't6: 分子口径脚注在');
  assert.match(app, /winSource/, 't6: 分母来源说明接线');
  assert.match(app, /knownTokens: String\(Math\.max\(0, Math\.round\(contextTokens \|\| 0\)\)\)/, 't6: 前端上报已知规模');
  assert.match(app, /if \(sessionId\) setTimeout\(\(\) => \{ load\(\); \}, 0\);/, 't6: 打开弹层自动触发后台精确计算');
}

console.log('check-context-availability: all passed');
