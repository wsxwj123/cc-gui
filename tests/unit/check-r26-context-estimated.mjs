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

// r26-G3(前端标注,契约 C-G3):估算路径响应顶层带 estimated:true,前端徽章/上下文
// 面板标「估算」,估算不得冒充精确值。
// (PKG-9 产出 estimated 字段、PKG-3 在 /context 快路透传;本包只负责展示标注。)
// ①store:setCtxMeasured 透传 estimated(展开 payload,不剥字段);
// ②源码哨兵:弹层口径标注按 estimated 区分「估算(约数)/精确」;
//   徽章脚注 winSource 按 measuredCtx.estimated 标「估算/实测缓存」;
//   /context 回写 setCtxMeasured 带 estimated 字段;
// ③互斥口径:contextCache.isValidContextResponse 不剥 estimated(额外字段放行,
//   行为断言,防有人把它加成严格白名单把字段滤掉)。
// Run: node tests/unit/check-r26-context-estimated.mjs
import { readFileSync } from 'node:fs';

const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => storage.get(k) ?? null,
  setItem: (k, v) => { storage.set(k, String(v)); },
  removeItem: (k) => { storage.delete(k); },
};

const { useStore } = await import('../../client/src/stores/sessionStore.js');
const { isValidContextResponse } = await import('../../client/src/utils/contextCache.js');

// ① store 透传
useStore.getState().setCtxMeasured('sid-e', { totalTokens: 1234, windowTokens: 200000, estimated: true });
assert.equal(useStore.getState().ctxMeasuredBySession['sid-e']?.estimated, true,
  'G3: setCtxMeasured 必须保留 estimated 字段(徽章标注的数据源)');
useStore.getState().setCtxMeasured('sid-p', { totalTokens: 100, windowTokens: 200000 });
assert.equal(useStore.getState().ctxMeasuredBySession['sid-p']?.estimated, undefined,
  'G3: 精确路径不带 estimated(互斥哨兵)');

// ③ isValidContextResponse 放行 estimated(估算了也得能进缓存,标注才有数据)
{
  const valid = {
    source: 'cli', sampledAt: new Date().toISOString(), model: 'm', totalTokens: 10,
    windowTokens: 200000, pct: 1, categories: [], mcpServers: [], estimated: true,
  };
  assert.equal(isValidContextResponse(valid), true, 'G3: 带 estimated 的响应不得被校验剥掉');
}

// ② 源码哨兵
const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
assert.match(app, /estimated: d\.estimated === true/, 'G3: /context 回写必须带 estimated');
assert.match(app, /data\?\.estimated \? '估算（约数）' : '精确'/, 'G3: 弹层口径标注按 estimated 区分');
assert.match(app, /measuredCtx\?\.estimated \? '估算' : '实测'/, 'G3: 徽章脚注按 estimated 标「估算」');

console.log('PASS check-r26-context-estimated');
