// R8-5:MCP server 状态提示纯函数(从 App.jsx init 处理抽出供单测)。
// 语义依据(spike-a 实测,CLI 2.1.227):init 事件自带 mcp_servers: [{ name, status }],
// status 实测见 'connected' / 'needs-auth';GUI 不用 --mcp-config,init 没有
// mcp_server_errors 字段(那是该 flag 专属)。非 connected 的任何值(needs-auth /
// failed / 未来新增)都值得提示 —— 此前这些 server 静默不可用,用户只看到工具调不动。

// init.mcp_servers → 非 connected 项 [{ name, status }]。
// 字段缺失/非数组/空数组 → [](静默,不提示);name/status 缺失的项没法提示,跳过。
export function extractMcpServerIssues(mcpServers) {
  if (!Array.isArray(mcpServers)) return [];
  return mcpServers.filter((s) => s && typeof s.name === 'string' && s.name
    && typeof s.status === 'string' && s.status && s.status !== 'connected');
}

// 问题项 → 一条合并文案(多个 server 合并,不逐个弹);空 → null。
// 文案客观陈述:needs-auth 附授权入口说明,其余状态如实报状态值。
export function formatMcpServerNotice(issues) {
  if (!Array.isArray(issues) || !issues.length) return null;
  return issues
    .map(({ name, status }) => `MCP 服务器 ${name} 状态:${status}${status === 'needs-auth' ? '(需在 MCP 面板完成授权)' : ''}`)
    .join(';');
}
