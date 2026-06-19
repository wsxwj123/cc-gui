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
