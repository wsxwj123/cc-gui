#!/usr/bin/env node
// 单测:r26-G3(契约 C-G3)/context 快路透传 estimated。
// 契约:估算标记字段名固定为响应顶层 'estimated';PKG-9 在代理/估算点产出
// (usage.estimated),本包(PKG-3)在 chat.js /context 快路 mapSdkContextUsage 透传,
// PKG-2 前端据此标「(估算)」。字段名逐字按契约。
// 变异哨兵(实际验证过红):S1 删掉透传行 → t1 红。
import assert from 'node:assert/strict';
import { mapSdkContextUsage, validContextPayload } from '../../server/routes/chat.js';

const usage = {
  model: 'synthetic-model',
  totalTokens: 120,
  maxTokens: 1000,
  percentage: 12,
  categories: [{ name: 'Synthetic', tokens: 120 }],
  mcpTools: [{ serverName: 'fixture', tokens: 20 }],
};

// t1 估算路径:usage.estimated → 响应顶层 estimated:true
{
  const payload = mapSdkContextUsage({ ...usage, estimated: true });
  assert.equal(payload.estimated, true, 't1: 估算 usage 必须透传 estimated:true');
  assert.equal(validContextPayload(payload), true, 't1: 带 estimated 的载荷仍须过服务端校验');
}

// t2 互斥哨兵:精确路径(无 estimated)响应不含该键
{
  const payload = mapSdkContextUsage(usage);
  assert.ok(!('estimated' in payload), 't2: 精确路径不得带 estimated 键(有无哨兵,非真值)');
  assert.equal(validContextPayload(payload), true, 't2: 精确载荷过校验');
}

// t3  falsy 标记同样不带键(estimated:false 不应漏出)
{
  const payload = mapSdkContextUsage({ ...usage, estimated: false });
  assert.ok(!('estimated' in payload), 't3: estimated:false 不落到响应');
}

console.log('PASS r26-g3-context-estimated-passthrough');
