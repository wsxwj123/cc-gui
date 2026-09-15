import React from 'react';
import { displayUsd, formatCost } from '../../utils/pricing.js';
import { MISSING_TITLE } from '../../utils/subagentCost.js';

// A 项(2026-09-11):子代理花费显示在它自己的位置上(契约 INTERFACE §10.3)。
// 索引的算法在 utils/subagentCost.js(纯逻辑、可单测),这里只负责画。
//
// 为什么用 context 而不是逐层 prop:TaskCard 有四条渲染路径(renderRichToolCard /
// ToolCallsGroup / WorkGroup / CoworkBlocks),逐层加 prop 要改 5 个签名 8 个调用点,
// 漏一条就有一条卡片没金额(与 TaskOwnerContext 同一个理由)。
//
// 口径(纯展示层,服务端零字段):
//   有金额 → 金额(同一 toolUseId 名下 N 个 agent 之和;算不出来的不参与求和)
//   有记录但全算不出来 → 小标「未能计价」+ 原因词
//   一条记录都没有 → 小标「未能计价」+ MISSING_TITLE(成因客户端分不清)
//   母会话没打开 / 正在流式 → 一个元素都不渲染(showMissing 由调用方按"数据加载了没有"给)
export const SubagentCostContext = React.createContext(null);

/** 一处金额/小标。entry 缺席 = 没有可计价记录,此时只有 showMissing 才画小标。 */
export function SubagentCostTag({ entry, showMissing = false, title = '' }) {
  if (entry && entry.priced > 0) {
    return (
      <span className="shrink-0 inline-flex items-center gap-1 text-[10px]"
        title={title || '该子代理的费用（不含在主回合金额里）'}>
        <span className="font-mono text-accent/80">{formatCost(displayUsd(entry.usd, entry.currency))}</span>
        {entry.failed > 0 && (
          <span className="text-[9px] text-ink-faint font-body" title={entry.reason || MISSING_TITLE}>
            另有 {entry.failed} 个未能计价
          </span>
        )}
      </span>
    );
  }
  if (!showMissing) return null;
  return (
    <span className="shrink-0 text-[9px] px-1 py-px bg-canvas-deep text-ink-muted rounded font-body"
      title={entry?.reason || MISSING_TITLE}>
      未能计价
    </span>
  );
}
