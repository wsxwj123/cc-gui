#!/usr/bin/env node
// r26-G5:空 thinking 块两路一致处置 —— 两路 proxy 都滤(thinking.trim()==='' 丢弃),
// openai 路不再产出空 reasoning_content;非空 thinking 必须保留(过滤过宽哨兵)。
// 修前:anthropic-proxy 只滤空 text 不滤空 thinking;openai-proxy 把空 thinking
// 翻成 reasoning_content:"" 下发。
// 哨兵:S1 anthropic 路摘掉 thinking 分支 → t2 红;S2 openai 路恢复空串入列 → t1 红;
//       S3 滤成「凡 thinking 皆丢」→ t3 红。
import assert from 'node:assert/strict';
import { anthropicToOpenAIMessages } from '../../server/services/openai-proxy.js';
import { normalizeMessagesForCompat } from '../../server/services/anthropic-proxy.js';

const runAnthropic = (messages) =>
  JSON.parse(normalizeMessagesForCompat(Buffer.from(JSON.stringify({ messages }))).toString('utf-8')).messages;

// t1 openai 路(对齐哨兵):空/纯空白 thinking + text → 输出无 reasoning_content 字段
{
  const out = anthropicToOpenAIMessages([
    { role: 'assistant', content: [{ type: 'thinking', thinking: '  ' }, { type: 'text', text: 'x' }] },
  ], null);
  const msg = out.find((m) => m.role === 'assistant');
  assert.equal(msg.content, 'x', 't1: text 保留');
  assert.ok(!('reasoning_content' in msg), 't1: 空 thinking 不得产出空 reasoning_content(修前会下发 "")');
}
{
  // thinking:'' / 缺失字段同样滤
  const out = anthropicToOpenAIMessages([
    { role: 'assistant', content: [{ type: 'thinking', thinking: '' }, { type: 'thinking' }, { type: 'text', text: 'y' }] },
  ], null);
  const msg = out.find((m) => m.role === 'assistant');
  assert.ok(!('reasoning_content' in msg), 't1b: 空串/缺字段 thinking 同滤');
}

// t2 anthropic 路(对齐哨兵):空 thinking 块从 content 里消失
{
  const msgs = runAnthropic([
    { role: 'user', content: '问' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: '   ' }, { type: 'text', text: '答' }] },
  ]);
  const asst = msgs.find((m) => m.role === 'assistant');
  assert.deepEqual(asst.content, [{ type: 'text', text: '答' }],
    't2: anthropic 路必须滤掉空 thinking 块(修前只滤空 text)');
}
{
  // 纯空 thinking 的 assistant 消息整条删(与空 text 同语义)
  const msgs = runAnthropic([
    { role: 'user', content: '问' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: '' }] },
    { role: 'user', content: '续' },
  ]);
  assert.ok(!msgs.some((m) => m.role === 'assistant'), 't2b: 纯空 thinking 消息整条删');
}

// t3 过滤过宽哨兵:非空 thinking 两路都必须保留
{
  const out = anthropicToOpenAIMessages([
    { role: 'assistant', content: [{ type: 'thinking', thinking: '让我想想' }, { type: 'text', text: '结论' }] },
  ], null);
  const msg = out.find((m) => m.role === 'assistant');
  assert.equal(msg.reasoning_content, '让我想想', 't3: openai 路非空 thinking 必须保留(deepseek 续聊依赖)');
  const msgs = runAnthropic([
    { role: 'assistant', content: [{ type: 'thinking', thinking: '推理过程' }, { type: 'text', text: '答' }] },
  ]);
  const asst = msgs.find((m) => m.role === 'assistant');
  assert.ok(asst.content.some((c) => c.type === 'thinking' && c.thinking === '推理过程'),
    't3: anthropic 路非空 thinking 必须保留');
}

console.log('check-r26-g5-empty-thinking: all passed');
