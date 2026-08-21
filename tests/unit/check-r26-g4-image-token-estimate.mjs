#!/usr/bin/env node
// r26-G4:estimateInputTokens 不得把 image 块的 base64 data 按文本字符计入估算。
// 修前:1MB base64 图 ≈ 104 万字符 → chars/4 虚高 ~26 万 tokens;
// 修后:image 块按固定当量 ESTIMATED_TOKENS_PER_IMAGE(1500)/图,文本照旧 chars/4。
// 哨兵:S1 删掉图片剔除(回到整块序列化)→ t1 红(虚高回 ~26 万);
//       S2 把图片记 0(不给了当量)→ t1 的下界断言红。
import assert from 'node:assert/strict';
import { estimateInputTokens, ESTIMATED_TOKENS_PER_IMAGE } from '../../server/utils/context-tokens.js';

// t1(量级哨兵):1MB base64 图 + 100 字文本 → ≈1500+25 量级,而非 25 万
{
  const body = {
    model: 'claude-sonnet-4-6',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'x'.repeat(100) },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(1024 * 1024) } },
        ],
      },
    ],
  };
  const est = estimateInputTokens(body).input_tokens;
  assert.ok(est < 5000, `t1: 1MB 图 + 100 字估算须 <5000(实际 ${est};修前 ~26 万虚高)`);
  assert.ok(est >= ESTIMATED_TOKENS_PER_IMAGE, `t1: 图片当量必须计入(实际 ${est} < ${ESTIMATED_TOKENS_PER_IMAGE})`);
  assert.equal(ESTIMATED_TOKENS_PER_IMAGE, 1500, 't1: 固定当量 1500/图(Anthropic 经验中位)');
}

// t2 两张图 → 当量叠加
{
  const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(100000) } };
  const one = estimateInputTokens({ messages: [{ role: 'user', content: [img] }] }).input_tokens;
  const two = estimateInputTokens({ messages: [{ role: 'user', content: [img, img] }] }).input_tokens;
  assert.equal(two - one, ESTIMATED_TOKENS_PER_IMAGE, 't2: 每多一张图 +1500');
}

// t3(纯文本回归哨兵):无图片输入与旧口径逐字节一致
{
  const body = {
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'x'.repeat(4000) }],
    system: 's'.repeat(400),
    tools: [{ name: 'Bash', description: 'd'.repeat(400) }],
  };
  const expected = Math.ceil(JSON.stringify({ messages: body.messages, system: body.system, tools: body.tools }).length / 4);
  assert.equal(estimateInputTokens(body).input_tokens, expected, 't3: 纯文本估算与旧口径逐字节一致');
  assert.deepEqual(Object.keys(estimateInputTokens(body)), ['input_tokens'], 't3: 不夹带多余字段');
  // content 为字符串形态(非数组)的消息不受图片剔除影响
  const s = estimateInputTokens({ messages: [{ role: 'user', content: 'hello' }] }).input_tokens;
  assert.equal(s, Math.ceil(JSON.stringify({ messages: [{ role: 'user', content: 'hello' }], system: '', tools: [] }).length / 4),
    't3: 字符串 content 口径不变');
}

// t4 边角:空 body / 序列化失败仍安全
{
  assert.ok(estimateInputTokens(null).input_tokens >= 0, 't4: 空 body 安全');
  const circ = {}; circ.self = circ;
  assert.equal(estimateInputTokens({ messages: [circ] }).input_tokens, 0, 't4: 序列化失败安全回 0');
}

console.log('check-r26-g4-image-token-estimate: all passed');
