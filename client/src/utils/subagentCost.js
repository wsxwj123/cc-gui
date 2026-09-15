// A 项(2026-09-11)子代理花费的展示层索引(纯逻辑,无 JSX/React,node 直跑可测)。
// 数据来源只有一份:母会话消息里的 `turn.subUsage.agents[]`(服务端按归属挂好的)。
// 计价走契约 §10.3 的唯一出口 computeCostForAgents,本文件只做"摊开成卡片能直接取的形状"。
import { computeCostForAgents, costUnavailableReason } from './pricing.js';

/** 「未能计价」小标的默认说明(成因客户端分不清,只说"没读到",不说"算不出来")。 */
export const MISSING_TITLE = '未读到该子代理的用量记录，因此不显示金额';

/** 该 agent 算不出来时的原因词(逐字取契约 §10.11⑦ 的 detail 表)。 */
export function costReasonOf(agent, provider) {
  return costUnavailableReason(agent?.model ?? null, agent?.usage, provider, { at: agent?.timestamp })?.detail
    || '没有该模型的可用价格';
}

const emptyEntry = () => ({ usd: 0, currency: null, priced: 0, failed: 0, reason: '' });

/**
 * `subUsage.agents[]` + provider → 两个索引:
 *   byToolUseId: 工具卡片用 —— 该 tool_use.id 名下全部 agent 的合计(普通 Task 卡片名下
 *                只有 1 个;Workflow 卡片名下是 N 个 = 「内部全部 agent 的合计」)
 *   byAgentId:   监控面板的 workflow 内层行用(行 id = 裸 agentId,故按去 'agent-' 前缀的键)
 * 每项:{ usd, currency, priced, failed, reason } —— usd 只含算得出来的(costUsd null 不参与求和),
 * failed = 算不出来的条数(卡片上的「另有 N 个未能计价」)。
 */
export function buildSubagentCostIndex(agents, provider) {
  const list = Array.isArray(agents) ? agents : [];
  const result = computeCostForAgents(list, provider);
  const byToolUseId = new Map();
  const byAgentId = new Map();
  result.agents.forEach((priced, i) => {
    const raw = list[i] || {};
    const failed = priced.costUsd == null;
    const reason = failed ? costReasonOf(raw, provider) : '';
    if (priced.agentSessionId) {
      byAgentId.set(String(priced.agentSessionId).replace(/^agent-/, ''), {
        usd: failed ? 0 : priced.costUsd, currency: priced.currency ?? null,
        priced: failed ? 0 : 1, failed: failed ? 1 : 0, reason,
      });
    }
    if (!priced.toolUseId) return;
    if (!byToolUseId.has(priced.toolUseId)) byToolUseId.set(priced.toolUseId, emptyEntry());
    const entry = byToolUseId.get(priced.toolUseId);
    entry.usd += failed ? 0 : priced.costUsd;
    entry.priced += failed ? 0 : 1;
    entry.failed += failed ? 1 : 0;
    if (!entry.reason && reason) entry.reason = reason;
    // 币种:先到先得;一旦出现第二种就记空串(按原数显示、不折算)—— null 表示"还没有"。
    if (priced.currency) {
      if (entry.currency == null) entry.currency = priced.currency;
      else if (entry.currency !== priced.currency) entry.currency = '';
    }
  });
  return { byToolUseId, byAgentId };
}
