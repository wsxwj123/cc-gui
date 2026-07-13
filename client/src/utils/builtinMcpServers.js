// 内置 MCP server 精选模板库。选模板自动回填 McpForm 的 类型/命令(或URL)/名称/env 占位行,
// 用户只需补必填项(密钥/目录)再点添加。模式与 builtinProviders.js 一致。
//
// ⚠️ 需手动维护:下面的 npx/uvx 包名 / 远程 URL / env 变量名由各上游决定,会随版本变动。
// 装失败时优先看每条的 docs 链接核对官方当前写法。(2026-06 逐条核对官方 README/npm)
//
// 字段:
//   name         展示名,统一用 GitHub 英文名(回填到表单「名称」)
//   transport    'stdio' | 'http'
//   commandLine  stdio 用的整行命令(后端按空格拆 command + args)
//   url          http 用的端点
//   env          需密钥时预置的占位行 [{ k, hint }];回填到表单 env 区(value 留空,用户补)
//   needsArg     positional 参数提示(目前仅 filesystem);展示为一行提示,不自动填
//   needsSetup   true=选了不能立刻用(要 key/目录/登录),下拉里归入「需配置」组
//   setupTag     需配置项在下拉选项名后的小尾巴(如「要 key」「填目录」),一眼看清
//   repo         GitHub 作者/项目(owner/repo),展示为可点击小字,点开跳 docs
//   note/docs    说明 + 官方文档(repo 链接即指向 docs)

export const BUILTIN_MCP_SERVERS = [
  {
    id: 'filesystem',
    name: 'Filesystem',
    transport: 'stdio',
    commandLine: 'npx -y @modelcontextprotocol/server-filesystem',
    env: [],
    needsArg: '命令末尾补一个或多个「允许访问的目录绝对路径」,如 /Users/you/project',
    needsSetup: true,
    setupTag: '填目录',
    note: '读写指定目录下的文件。必须在命令末尾追加允许访问的目录,否则起不来。',
    repo: 'modelcontextprotocol/servers',
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
  },
  {
    id: 'github',
    name: 'GitHub',
    transport: 'http',
    url: 'https://api.githubcopilot.com/mcp/',
    env: [],
    needsSetup: true,
    setupTag: '首次登录',
    note: 'GitHub 官方远程 MCP(npm 版已废弃)。首次使用会走 OAuth 授权登录,无需在此填 token。',
    repo: 'github/github-mcp-server',
    docs: 'https://github.com/github/github-mcp-server',
  },
  // 注:Context7 / Playwright 已移到「官方插件」精选(builtinPlugins.js)——它们本体就是
  // 一条 MCP,走 `claude plugin install` 更省事(自动配 + 版本管理),此处去重不再重复列出。
  {
    id: 'sequential-thinking',
    name: 'Sequential Thinking',
    transport: 'stdio',
    commandLine: 'npx -y @modelcontextprotocol/server-sequential-thinking',
    env: [],
    note: '让模型把复杂问题拆成多步推理。无需配置。',
    repo: 'modelcontextprotocol/servers',
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
  },
  {
    id: 'memory',
    name: 'Memory',
    transport: 'stdio',
    commandLine: 'npx -y @modelcontextprotocol/server-memory',
    env: [],
    note: '跨会话持久记忆(知识图谱)。无需配置。',
    repo: 'modelcontextprotocol/servers',
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
  },
  {
    id: 'fetch',
    name: 'Fetch',
    transport: 'stdio',
    commandLine: 'uvx mcp-server-fetch',
    env: [],
    note: '抓取网页并转成 markdown。官方仅 Python 版,需先装 uv(提供 uvx 命令)。',
    repo: 'modelcontextprotocol/servers',
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
  },
  {
    id: 'tavily',
    name: 'Tavily',
    transport: 'stdio',
    commandLine: 'npx -y tavily-mcp@latest',
    env: [{ k: 'TAVILY_API_KEY', hint: 'Tavily API key,在 tavily.com 申请' }],
    needsSetup: true,
    setupTag: '要 key',
    note: '联网搜索与内容提取。需填 TAVILY_API_KEY。',
    repo: 'tavily-ai/tavily-mcp',
    docs: 'https://github.com/tavily-ai/tavily-mcp',
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    transport: 'stdio',
    commandLine: 'npx -y @brave/brave-search-mcp-server --transport stdio',
    env: [{ k: 'BRAVE_API_KEY', hint: 'Brave Search API key' }],
    needsSetup: true,
    setupTag: '要 key',
    note: '隐私搜索引擎。需填 BRAVE_API_KEY。(包名已从 @modelcontextprotocol 搬到 @brave)',
    repo: 'brave/brave-search-mcp-server',
    docs: 'https://github.com/brave/brave-search-mcp-server',
  },
  {
    id: 'paper-search-mcp',
    name: 'Paper Search',
    transport: 'stdio',
    // 该 PyPI 包不提供同名可执行入口,`uvx paper-search-mcp` 会报 "does not provide any
    // executables" → 连不上。正确启动方式是跑模块 paper_search_mcp.server。
    commandLine: 'uvx --from paper-search-mcp python -m paper_search_mcp.server',
    env: [],
    note: '检索/下载学术论文(arXiv/PubMed/bioRxiv 等)。Python 版,需先装 uv。核心源免 key;部分源(Unpaywall/IEEE/ACM 等)需各自 PAPER_SEARCH_MCP_* env,见 README。',
    repo: 'openags/paper-search-mcp',
    docs: 'https://github.com/openags/paper-search-mcp',
  },
  {
    id: 'desktop-commander',
    name: 'Desktop Commander',
    transport: 'stdio',
    commandLine: 'npx -y @wonderwhy-er/desktop-commander@latest',
    env: [],
    note: '本地终端/文件/进程操作。无需配置。',
    repo: 'wonderwhy-er/DesktopCommanderMCP',
    docs: 'https://github.com/wonderwhy-er/DesktopCommanderMCP',
  },
  {
    id: 'notion',
    name: 'Notion',
    transport: 'http',
    url: 'https://mcp.notion.com/mcp',
    env: [],
    needsSetup: true,
    setupTag: '首次登录',
    note: 'Notion 官方远程 MCP。首次使用走 OAuth 授权登录,无需在此填 token。',
    repo: 'makenotion/notion-mcp-server',
    docs: 'https://developers.notion.com/docs/mcp',
  },
  {
    id: 'zotero',
    name: 'Zotero',
    transport: 'stdio',
    commandLine: 'uvx zotero-mcp',
    env: [
      { k: 'ZOTERO_LOCAL', hint: '填 true 用本地模式(需 Zotero 7 桌面开着,并在 设置→高级 勾选允许本地 API);只读免密钥' },
      { k: 'ZOTERO_API_KEY', hint: '仅 Web API 模式需要,在 zotero.org/settings/keys 申请;本地模式留空' },
      { k: 'ZOTERO_LIBRARY_ID', hint: '仅 Web API 模式需要,即你的 Zotero 用户 ID;本地模式留空' },
    ],
    needsSetup: true,
    setupTag: '要 key/开桌面',
    note: '连接 Zotero 文献库。Python 版,需先装 uv。两种模式:本地(ZOTERO_LOCAL=true,需 Zotero 7 桌面开着并开本地 API,只读免 key)或 Web API(填 KEY + LIBRARY_ID)。',
    repo: '54yyyu/zotero-mcp',
    docs: 'https://github.com/54yyyu/zotero-mcp',
  },
];

export function findBuiltinMcp(id) {
  return BUILTIN_MCP_SERVERS.find((m) => m.id === id) || null;
}
