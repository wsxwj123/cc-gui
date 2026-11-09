// R8-5:MCP server 状态提示纯函数(从 App.jsx init 处理抽出供单测)。
// 语义依据:init 事件自带 mcp_servers: [{ name, status }];GUI 不用 --mcp-config,init 没有
// mcp_server_errors 字段(那是该 flag 专属)。
// r163(CLI 2.1.319 实测,2026-11-09):MCP 连接改成全异步、不阻塞启动,冷启动 init 时多数 server 还是
// pending(正在连,连完自然变 connected),真有问题的只有 needs-auth / failed。R8-5 当年(CLI 2.1.227)
// 只见 connected / needs-auth,「非 connected 都提示」没问题;现在照旧就是:15 个里 13 个弹黄字、10 个是虚惊,
// 而且每个新进程(回滚 / 空闲回收 / 新会话)都重弹一遍。SDK 的状态枚举:connected / failed / needs-auth / pending / disabled。

// 不算问题的状态:connected 已连上;pending 正在(异步)连接;disabled 是用户自己关掉的。
// 其余(needs-auth / failed / 以后新增的值)照旧提示 —— 宁可多报一个新状态,也不吞掉真问题。
const BENIGN_STATUSES = new Set(['connected', 'pending', 'disabled']);
// 账本里划掉该 server 的状态:已连上、或被用户关掉 —— 此刻它没有「待处理的问题」了,将来再坏要再提示。
const CLEARING_STATUSES = new Set(['connected', 'disabled']);
const norm = (s) => String(s).trim().toLowerCase();

// 只留有名字、状态是非空字符串的项;同名出现多次(CLI 的 name 本应唯一,脏数据防呆)以最后一次为准。
function validByName(mcpServers) {
  if (!Array.isArray(mcpServers)) return [];
  const byName = new Map();
  for (const s of mcpServers) {
    if (s && typeof s.name === 'string' && s.name && typeof s.status === 'string' && norm(s.status)) byName.set(s.name, s);
  }
  return [...byName.values()];
}

// init.mcp_servers → 有问题的项 [{ name, status }]。
// 字段缺失/非数组/空数组 → [](静默,不提示);name/status 缺失或状态是空白的项没法提示,跳过。
export function extractMcpServerIssues(mcpServers) {
  return validByName(mcpServers).filter((s) => !BENIGN_STATUSES.has(norm(s.status))).map(({ name, status }) => ({ name, status }));
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
// 状态变了(failed → needs-auth)、或恢复 / 被关掉之后又坏,才再提示。
//   · pending 既不提示也不清账(重连中,连完多半又回到原状态);
//   · connected / disabled 把该 server 从账本里划掉(没有待处理的问题了,将来再坏要再报);
//   · 状态值按「去空白、转小写」比较,Failed 与 failed 是同一个状态。
// 已知局限(接受):清账只靠 init 里看到 connected / disabled —— 异步连接下一个慢 server 在 init 里恒为 pending,
// 它「授权后又失效」的情形这次运行里不会重提;只在内存,重开应用后第一次 init 会再提示一次。
// 模块级用一个实例(分屏多 pane / 重挂载共享)。
export function createMcpNoticeLedger() {
  const told = new Map(); // server name → 已提示过的状态(去空白、小写)
  return {
    /**
     * 一个 init 的 mcp_servers → 这次该提示的问题项(新出现的 / 状态变了的)。
     * record 缺省 true:返回的同时记账。调用方「这条提示其实没人看到」(窗口在后台)时传 false —— 不记账,
     * 下一次 init 还会再给出来,免得唯一的一次提示被白白用掉。清账(connected / disabled)不受 record 影响。
     */
    take(mcpServers, { record = true } = {}) {
      const servers = validByName(mcpServers);
      for (const s of servers) if (CLEARING_STATUSES.has(norm(s.status))) told.delete(s.name);
      const fresh = servers
        .filter((s) => !BENIGN_STATUSES.has(norm(s.status)) && told.get(s.name) !== norm(s.status))
        .map(({ name, status }) => ({ name, status }));
      if (record) for (const i of fresh) told.set(i.name, norm(i.status));
      return fresh;
    },
  };
}
