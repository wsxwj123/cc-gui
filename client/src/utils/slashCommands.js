// 斜杠命令的共享纯函数(会话内 ChatInput 与首页 HomeState 同一份实现)。
// 零 React / 零 store:node 可直接 import 做单测。

/** 第三方端点下完全不兼容的命令(requiresAnthropic === 'full')不可选。 */
export function slashBlocked(cmd, isAnthropic) {
  return cmd?.requiresAnthropic === 'full' && !isAnthropic;
}

/**
 * 整串小写前缀匹配;第三方端点下被阻止的命令沉底,其余保持服务端给的顺序
 * (Array#sort 稳定)。不以 `/` 开头一律返回空。
 */
export function filterSlashCommands(commands, text, isAnthropic) {
  const q = String(text ?? '').toLowerCase();
  if (!q.startsWith('/') || !Array.isArray(commands)) return [];
  return commands
    .filter((c) => typeof c?.name === 'string' && c.name.toLowerCase().startsWith(q))
    .sort((a, b) => {
      const ab = slashBlocked(a, isAnthropic);
      const bb = slashBlocked(b, isAnthropic);
      if (ab !== bb) return ab ? 1 : -1;
      return 0;
    });
}

/**
 * 拉取命令列表。cwd 为空时不带查询串(= 只有内置命令)。
 * 故意不检查 HTTP 状态码:服务端异常时按字段兜底成空列表,与改动前逐字同行为
 * (列表"空"而不是"永远不弹")。
 */
export async function fetchSlashCommands(cwd, { fetchImpl = fetch } = {}) {
  const r = await fetchImpl(`/api/slash-commands${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`);
  const d = await r.json();
  return {
    commands: d.commands || [],
    provider: d.provider || 'Anthropic',
    isAnthropic: d.isAnthropic !== false,
  };
}
