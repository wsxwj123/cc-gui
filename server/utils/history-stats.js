// r151l 判官修正:会话历史的**全量**统计(与分页窗口无关)。
//
// 起因:客户端会话徽章/弹层/手机条的「费用、工具调用数、曾用模型」原来是对**已加载窗口**
// 逐条 reduce。300+ 条会话只加载最近 120 条时,同一张弹层里 token 是服务端全量、费用/工具数
// 却只算窗口 —— 数字互相矛盾。这里在服务端、在**完整 messages 已经算出之后**统一汇总:
//   total          消息总条数(= 响应里的 total)
//   totalToolCalls 全部回合的工具调用数
//   models         全部消息里出现过的模型(去重,按首次出现顺序)
//   usageByModel   按模型汇总的用量(含按峰/谷时段分桶),供客户端算**全量**费用
//
// 纯函数、零 IO:入参就是 getSessionMessages 返回的那份 messages,单测直接喂。
// 口径必须与客户端逐条计算逐字一致:
//   · 工具数 = 每条消息 toolCalls 的长度之和;
//   · 模型集合 = 有 model 字段的消息(去重);
//   · 费用 = 一条消息的 usageCalls 逐次调用计价;没有 usageCalls 的旧数据按整条 usage +
//     timestamp 算一次(与 client computeCostForMessage 的回落分支同口径)。
//   · 时段 = server/utils/pricing-rules.js 的 periodFor(客户端历史回看用的是同一份规则)。
// 非法用量(负数/非有限)不并入行 —— 并入会让整行模型变成 USAGE_INVALID、连正常调用也
// 算不出钱;客户端对那一条本来就按"费用未知"处理。

import { periodFor } from './pricing-rules.js';

const USAGE_FIELDS = [
  'input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens',
  'ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens',
];

/** 一条 usage 是否有客户端会判 USAGE_INVALID 的数字(负数/非有限)。非数字字段按 0(同客户端 num)。 */
function usableUsage(usage) {
  if (!usage || typeof usage !== 'object') return false;
  for (const field of USAGE_FIELDS) {
    const value = field.startsWith('ephemeral')
      ? usage.cache_creation?.[field]
      : usage[field];
    if (typeof value !== 'number') continue;
    if (!Number.isFinite(value) || value < 0) return false;
  }
  return true;
}

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** 一个统计桶:与 usageTotals 同名的五项 + 两档缓存写分项 + 调用次数。 */
function emptyUsageBucket() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    cacheCreation5m: 0,
    cacheCreation1h: 0,
    apiCalls: 0,
  };
}

function addUsage(bucket, usage) {
  bucket.input += num(usage.input_tokens);
  bucket.output += num(usage.output_tokens);
  bucket.cacheRead += num(usage.cache_read_input_tokens);
  bucket.cacheCreation += num(usage.cache_creation_input_tokens);
  bucket.cacheCreation5m += num(usage.cache_creation?.ephemeral_5m_input_tokens);
  bucket.cacheCreation1h += num(usage.cache_creation?.ephemeral_1h_input_tokens);
  bucket.apiCalls += 1;
}

const periodBucket = (row, key) => (key === 'peak'
  ? row.byPeriod.peak
  : (key === 'off-peak' ? row.byPeriod.offPeak : row.byPeriod.unknown));

/**
 * messages(完整列表)→ historyStats。
 * 不修改入参;非数组/异常条目按"没有统计"跳过,绝不抛错(读历史不该因一条脏记录整页 500)。
 */
export function buildHistoryStats(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const models = [];
  const seenModels = new Set();
  const byModel = new Map();
  let totalToolCalls = 0;
  let totalUserMessages = 0;
  let invalidUsageCalls = 0;

  for (const message of list) {
    if (!message || typeof message !== 'object') continue;
    if (message.type === 'user') totalUserMessages += 1;
    if (Array.isArray(message.toolCalls)) totalToolCalls += message.toolCalls.length;
    if (typeof message.model === 'string' && message.model && !seenModels.has(message.model)) {
      seenModels.add(message.model);
      models.push(message.model);
    }
    if (!message.model || !message.usage) continue;

    let row = byModel.get(message.model);
    if (!row) {
      row = {
        model: message.model,
        ...emptyUsageBucket(),
        byPeriod: {
          peak: emptyUsageBucket(),
          offPeak: emptyUsageBucket(),
          unknown: emptyUsageBucket(),
        },
      };
      byModel.set(message.model, row);
    }
    const calls = Array.isArray(message.usageCalls) && message.usageCalls.length
      ? message.usageCalls
      : [{ at: message.timestamp, usage: message.usage }];
    for (const call of calls) {
      const usage = call?.usage;
      if (!usableUsage(usage)) { invalidUsageCalls += 1; continue; }
      addUsage(row, usage);
      const period = periodFor(call?.at ?? message.timestamp).key;
      addUsage(periodBucket(row, period), usage);
    }
  }

  return {
    total: list.length,
    totalUserMessages,
    totalToolCalls,
    models,
    invalidUsageCalls,
    usageByModel: [...byModel.values()],
  };
}
