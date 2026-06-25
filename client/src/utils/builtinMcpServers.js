// 内置 MCP server 精选模板库。选模板自动回填 McpForm 的 类型/命令(或URL)/名称/env 占位行,
// 用户只需补必填项(密钥/目录)再点添加。模式与 builtinProviders.js 一致。
//
// ⚠️ 需手动维护:下面的 npx 包名 / 远程 URL / env 变量名由各上游决定,会随版本变动。
// 装失败时优先看每条的 docs 链接核对官方当前写法。(2026-06 逐条核对官方 README/npm)
//
// 字段:
//   transport  'stdio' | 'http'
//   commandLine  stdio 用的整行命令(后端按空格拆 command + args)
//   url          http 用的端点
//   env          需密钥时预置的占位行 [{ k, hint }];回填到表单 env 区(value 留空,用户补)
//   needsArg     positional 参数提示(目前仅 filesystem);展示为一行提示,不自动填
//   note/docs    说明 + 官方文档

export const BUILTIN_MCP_SERVERS = [
  {
    id: 'filesystem',
    name: '文件系统',
    transport: 'stdio',
    commandLine: 'npx -y @modelcontextprotocol/server-filesystem',
    env: [],
    needsArg: '命令末尾补一个或多个「允许访问的目录绝对路径」,如 /Users/you/project',
    note: '读写指定目录下的文件。必须在命令末尾追加允许访问的目录,否则起不来。',
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
  },
  {
    id: 'github',
    name: 'GitHub',
    transport: 'http',
    url: 'https://api.githubcopilot.com/mcp/',
    env: [],
    note: 'GitHub 官方远程 MCP(npm 版已废弃)。首次使用会走 OAuth 授权登录,无需在此填 token。',
    docs: 'https://github.com/github/github-mcp-server',
  },
  {
    id: 'context7',
    name: 'Context7 文档',
    transport: 'http',
    url: 'https://mcp.context7.com/mcp',
    env: [],
    note: '实时拉取库/框架官方文档。官方远程端点,免 key 即可用。',
    docs: 'https://github.com/upstash/context7',
  },
  {
    id: 'playwright',
    name: 'Playwright 浏览器',
    transport: 'stdio',
    commandLine: 'npx -y @playwright/mcp@latest',
    env: [],
    note: '微软官方浏览器自动化(click/fill/截图等)。',
    docs: 'https://github.com/microsoft/playwright-mcp',
  },
  {
    id: 'sequential-thinking',
    name: '顺序思考',
    transport: 'stdio',
    commandLine: 'npx -y @modelcontextprotocol/server-sequential-thinking',
    env: [],
    note: '让模型把复杂问题拆成多步推理。无需配置。',
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
  },
  {
    id: 'memory',
    name: '记忆(知识图谱)',
    transport: 'stdio',
    commandLine: 'npx -y @modelcontextprotocol/server-memory',
    env: [],
    note: '跨会话持久记忆(知识图谱)。无需配置。',
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
  },
  {
    id: 'fetch',
    name: '网页抓取',
    transport: 'stdio',
    commandLine: 'uvx mcp-server-fetch',
    env: [],
    note: '抓取网页并转成 markdown。官方仅 Python 版,需先装 uv(提供 uvx 命令)。',
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
  },
  {
    id: 'tavily',
    name: 'Tavily 搜索',
    transport: 'stdio',
    commandLine: 'npx -y tavily-mcp@latest',
    env: [{ k: 'TAVILY_API_KEY', hint: 'Tavily API key,在 tavily.com 申请' }],
    note: '联网搜索与内容提取。需填 TAVILY_API_KEY。',
    docs: 'https://github.com/tavily-ai/tavily-mcp',
  },
  {
    id: 'brave-search',
    name: 'Brave 搜索',
    transport: 'stdio',
    commandLine: 'npx -y @brave/brave-search-mcp-server --transport stdio',
    env: [{ k: 'BRAVE_API_KEY', hint: 'Brave Search API key' }],
    note: '隐私搜索引擎。需填 BRAVE_API_KEY。(包名已从 @modelcontextprotocol 搬到 @brave)',
    docs: 'https://github.com/brave/brave-search-mcp-server',
  },
  {
    id: 'desktop-commander',
    name: 'Desktop Commander',
    transport: 'stdio',
    commandLine: 'npx -y @wonderwhy-er/desktop-commander@latest',
    env: [],
    note: '本地终端/文件/进程操作。无需配置。',
    docs: 'https://github.com/wonderwhy-er/DesktopCommanderMCP',
  },
];

export function findBuiltinMcp(id) {
  return BUILTIN_MCP_SERVERS.find((m) => m.id === id) || null;
}
