// r26-G2:并行 tool_calls「真实 tool_result 全局扫描」的共用纯函数。
//
// 背景:CLI 调 Skill 等 context-modifying 工具时不发 anthropic tool_result block,
// 两个代理都要给「缺结果的 tool_use」补假桩,否则严格端点(DeepSeek/Kimi)报 400
// "tool_calls 后必须跟 tool 消息"。但判定「缺不缺」必须全局扫描:并行 tool_calls
// 的真实形态是 assistant(tool_use A) → assistant(tool_use B) → user(result A),
// A 的结果不在「紧邻段」里 —— 只扫紧邻段会把 A 误判缺失、插假桩,同一个
// tool_call_id 出现两条 tool 消息,严格端点报 "tool call id is not found"。
// (anthropic-proxy 已在 realResultIds 上踩过并修复;r26-G2 把同一方案移植到
// openai-proxy,并把「收集真实结果 id」抽到这里共用,防两路口径再裂。)
//
// 一个函数通吃两种线格式:
//   · anthropic 形态:user 消息 content 数组里的 {type:'tool_result', tool_use_id};
//   · openai 形态:{role:'tool', tool_call_id} 独立消息。

/**
 * 收集消息序列里全部真实存在的 tool_result id(任意位置,不限紧邻段)。
 * @param {Array} messages anthropic 或 openai 形态的消息数组
 * @returns {Set<string>} 真实 tool_result 的 id 集;插桩判定以此为准——
 *   在集内的 id 一律不插假桩,不在的(才)是真缺失。
 */
export function collectRealToolResultIds(messages) {
  const ids = new Set();
  for (const m of messages || []) {
    if (!m || typeof m !== 'object') continue;
    // openai 形态:独立 tool 消息
    if (m.role === 'tool') {
      if (m.tool_call_id) ids.add(m.tool_call_id);
      continue;
    }
    // anthropic 形态:user 消息 content 里的 tool_result 块
    if (m.role === 'user' && Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c && typeof c === 'object' && c.type === 'tool_result' && c.tool_use_id) {
          ids.add(c.tool_use_id);
        }
      }
    }
  }
  return ids;
}
