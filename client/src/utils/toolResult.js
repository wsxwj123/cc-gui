// tool_result.content 在多数 provider 下不是字符串,而是内容块数组
// [{type:'text', text:'正文\n\n第二段'}]。直接 JSON.stringify 会把整段连同字面 \n
// 序列化成 JSON 原文(子代理/后台任务回复显示成 JSON 的根因 AZ4)。
// 抽出可读文本;字符串原样返回;其它兜底 String()。
export function extractToolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && (b.type === 'text' || typeof b.text === 'string'))
      .map((b) => b.text || '')
      .join('\n');
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return content == null ? '' : String(content);
}

// 停止(真杀进程,turnAborted=killedRef)时给未回执的普通工具补一个合成终态,
// 否则 tool_result 永不到达 → 卡片(SkillCard/ToolCallRow 只看 result)永久转圈。
// gate 必须是 turnAborted:detach/后台化(killedRef=false)进程还在跑、tool_result 会迟到,
// 不能提前标终态。tc.result 短路天然不覆盖已有回执(含 run_in_background 的"已派发"result)。
// ⚠️ 排除 Task/Agent:其卡片状态走 activeAgents + TaskCard 的 isInterrupted(=!agent&&!result)。
// 给它补 result 会让【无 agent 的 Task】(不发父流事件的 provider)从"已停止"翻成绿勾"完成"。
export function finalizePendingToolCalls(toolCalls, turnAborted) {
  return (toolCalls || []).map((tc) => {
    const isAgent = tc && (tc.name === 'Task' || tc.name === 'Agent');
    return {
      ...tc,
      category: tc.category || 'call',
      result: (tc.result || !turnAborted || isAgent)
        ? tc.result
        : { content: '', isError: false, synthetic: true, interrupted: true },
    };
  });
}

// 把 finalize 后的 toolCalls 按 id 回写进有序 blocks(fable 判官阻断项):官方 CLI
// includePartialMessages 恒开必发 stream_event → tool_use 进 blocks → TurnBubble 有
// blocks 时【只渲染 blocks】,只 finalize toolCalls 修不到主路径,卡片照样永久转圈。
// 只替换"原本无 result 且 finalize 后拿到 result"的 tool_use 块;已有 result 的块
// 与非工具块原引用返回,不打穿下游 memo。
export function applyFinalizedToBlocks(blocks, finalizedCalls) {
  if (!Array.isArray(blocks) || blocks.length === 0) return blocks;
  const byId = new Map((finalizedCalls || []).filter((t) => t && t.id).map((t) => [t.id, t]));
  return blocks.map((b) => {
    if (!b || b.type !== 'tool_use' || !b.toolCall || b.toolCall.result) return b;
    const fin = byId.get(b.toolCall.id);
    return fin && fin.result ? { ...b, toolCall: fin } : b;
  });
}
