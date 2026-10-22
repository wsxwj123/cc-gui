// r151l 窄复审②:会话统计口径的唯一判据 + 展示文案。
//
// 为什么单独抽出来:费用的计算入口(sessionSummary 里的 aggregateHistoryCost)和
// 「全量 / 仅已加载」标签原来各判各的 —— 费用看 historyStats.usageByModel/models 两个
// 数组,标签只看 `!!serverHistoryStats`。字段异常(有 historyStats 但缺数组)时会
// 出现"标着全量、实际按已加载窗口算费用"的自相矛盾。两处必须调同一个函数。
//
// 单测:tests/unit/check-r151l-history-stats.mjs(t5)。

/**
 * historyStats 是否足以按全量算费用 / 工具数 / 模型。
 * 判据与 aggregateHistoryCost 的输入要求一致:usageByModel/models 都必须是数组。
 * false → 调用方回退到"已加载窗口"口径,标签也必须标「仅已加载」。
 */
export function hasFullHistoryStats(stats) {
  return !!stats && typeof stats === 'object'
    && Array.isArray(stats.usageByModel)
    && Array.isArray(stats.models);
}

/**
 * 统计范围标签(徽章弹层 / 手机条 / tooltip 共用一句)。
 * full 时消息条数取服务端全量 total(缺失回落到已加载条数);否则如实标"仅已加载"。
 */
export function historyStatsScopeLabel(stats, loaded, total) {
  const loadedCount = Number.isFinite(loaded) ? loaded : 0;
  if (!hasFullHistoryStats(stats)) {
    return `统计范围:仅已加载的最近 ${loadedCount} 条消息(服务端未返回全量统计)`;
  }
  const totalCount = Number.isFinite(total) ? total : loadedCount;
  return `统计范围:全量 ${totalCount} 条消息(服务端聚合,与是否分页无关)`;
}

/**
 * 费用估算口径说明(窄复审②选的处理方式①:不逐条重算历史,统一标成估算)。
 *
 * 全量费用走 aggregateCost 的"当前价目表 + 固定代表时刻",与逐条历史调用按各自时刻
 * 计价**不保证逐位相等**,偏差来源:
 *   · 跨价目生效日:旧调用按现行价目算(例如 DeepSeek 峰谷价 2026-08-17 才生效);
 *   · 长提示分档:按模型汇总后没有单次提示量,长上下文档只能按基础档算;
 *   · TTL 分项缺失:同模型混有/无 5m/1h 分项时,整行写费可能被判未知(逐条只丢无分项那条);
 *   · 子代理口径:token(usageTotals)含 sidechain/子代理记录,费用只聚合主文件消息。
 * 这句必须显示在费用旁边,不能只在代码注释里。
 *
 * r151q:只在走全量汇总时显示(本窗格还有更早消息没加载)。全部已加载时 App.jsx 改按逐条消息计价
 * (与回复气泡同一算法),上面这些偏差都不存在,页面文字和金额悬停提示里都不再挂这句。
 */
export const HISTORY_COST_ESTIMATE_NOTE = '费用按当前价目表估算;跨价目生效日、分档/TTL 分项缺失时可能偏差。用量含子代理记录,费用按主文件消息聚合,口径略有差异。';
