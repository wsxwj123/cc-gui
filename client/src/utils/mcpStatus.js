// R8-5:MCP server 状态提示纯函数(从 App.jsx init 处理抽出供单测)。
// 语义依据:init 事件自带 mcp_servers: [{ name, status }];GUI 不用 --mcp-config,init 没有
// mcp_server_errors 字段(那是该 flag 专属)。
// r163(CLI 2.1.319 实测,2026-11-09):MCP 连接改成全异步、不阻塞启动,冷启动 init 时多数 server 还是
// pending(正在连,连完自然变 connected),真有问题的只有 needs-auth / failed。R8-5 当年(CLI 2.1.227)
// 只见 connected / needs-auth,「非 connected 都提示」没问题;现在照旧就是:15 个里 13 个弹黄字、11 个是虚惊,
// 而且每个新进程(回滚 / 空闲回收 / 新会话)都重弹一遍。

// 不算问题的状态:connected 已连上;pending 正在(异步)连接;disabled 是用户自己关掉的。
// 其余(needs-auth / failed / 以后新增的值)照旧提示 —— 宁可多报一个新状态,也不吞掉真问题。
const BENIGN_STATUSES = new Set(['connected', 'pending', 'disabled']);
const norm = (s) => String(s).trim().toLowerCase();

// init.mcp_servers → 有问题的项 [{ name, status }]。
// 字段缺失/非数组/空数组 → [](静默,不提示);name/status 缺失的项没法提示,跳过。
export function extractMcpServerIssues(mcpServers) {
  if (!Array.isArray(mcpServers)) return [];
  return mcpServers.filter((s) => s && typeof s.name === 'string' && s.name
    && typeof s.status === 'string' && s.status && !BENIGN_STATUSES.has(norm(s.status)));
}

// 问题项 → 一条合并文案(多个 server 合并,不逐个弹);空 → null。
// 文案客观陈述:needs-auth 附授权入口说明,其余状态如实报状态值。
export function formatMcpServerNotice(issues) {
  if (!Array.isArray(issues) || !issues.length) return null;
  return issues
    .map(({ name, status }) => `MCP 服务器 ${name} 状态:${status}${status === 'needs-auth' ? '(需在 MCP 面板完成授权)' : ''}`)
    .join(';');
}

// 跨进程去重账本:同一个 server 同一种状态,这次运行(页面生命周期)里只提示一次。
// 进程重建(回滚 / 空闲回收 / 新会话)后 MCP 会重连、init 会再报一遍同样的问题,不该每次都弹;
// 状态变了(failed → needs-auth)、或恢复(connected)之后又坏,才再提示。
//   · pending 既不提示也不清账(重连中,连完多半又回到原状态);
//   · connected 把该 server 从账本里划掉(恢复了,将来再坏要再报)。
// 模块级用一个实例(分屏多 pane / 重挂载共享),账本只在内存里:重开应用后第一次 init 会再提示一次。
export function createMcpNoticeLedger() {
  const told = new Map(); // server name → 已提示过的状态
  return {
    /** 一个 init 的 mcp_servers → 这次该提示的问题项(新出现的 / 状态变了的),并记账。 */
    take(mcpServers) {
      if (!Array.isArray(mcpServers)) return [];
      for (const s of mcpServers) {
        if (s && typeof s.name === 'string' && typeof s.status === 'string' && norm(s.status) === 'connected') told.delete(s.name);
      }
      const fresh = extractMcpServerIssues(mcpServers).filter((i) => told.get(i.name) !== i.status);
      for (const i of fresh) told.set(i.name, i.status);
      return fresh;
    },
  };
}
