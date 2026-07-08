// 官方插件(Anthropic 自维护,marketplace = claude-plugins-official)精选清单。
// 一键安装:`claude plugin install <id>@claude-plugins-official`(非交互,见 server/routes/mcp.js)。
// 只挑通用、稳定、装了即用(0/极低配置)的;需登录/key/Docker/LSP 二进制的故意不收。
//
// 插件 vs MCP:插件是上层打包格式,可内含 MCP server。playwright/context7 本体就是一条 MCP,
// 走插件安装比手填 MCP config 更省事(还带 plugin update 版本管理)——所以这两个从 MCP 精选
// 清单移到这里(去重)。带 agents/commands/hooks 的复合插件(feature-dev 等)无 MCP 等价物,
// 是插件清单的独占价值。

export const BUILTIN_PLUGINS = [
  { id: 'commit-commands',      name: 'Commit Commands',     desc: 'git commit / push / PR 工作流命令' },
  { id: 'feature-dev',          name: 'Feature Dev',         desc: '特性开发全流程(探索→架构→评审)agents' },
  { id: 'pr-review-toolkit',    name: 'PR Review Toolkit',   desc: 'PR 多维度评审(6 个 agent)' },
  { id: 'code-review',          name: 'Code Review',         desc: 'PR 自动评审,置信度打分滤误报' },
  { id: 'code-simplifier',      name: 'Code Simplifier',     desc: '简化 / 重构近期改动的代码' },
  { id: 'claude-md-management', name: 'CLAUDE.md 管理',       desc: '审计 / 维护项目 CLAUDE.md(项目记忆)' },
  { id: 'frontend-design',      name: 'Frontend Design',     desc: '生成有设计感、非 AI 通用审美的前端' },
  { id: 'skill-creator',        name: 'Skill Creator',       desc: '创建 / 优化 skill' },
  { id: 'hookify',              name: 'Hookify',             desc: '用 markdown 规则快速造 hook 拦行为' },
  { id: 'claude-code-setup',    name: 'Claude Code Setup',   desc: '扫码库推荐该配的 hooks / skills / MCP / subagents' },
  { id: 'playwright',           name: 'Playwright',          desc: '浏览器自动化(内含 MCP,自动 npx 拉起)', mcp: true },
  { id: 'context7',             name: 'Context7',            desc: '实时官方文档检索(内含 MCP,免 key)', mcp: true },
  // 非官方源插件:带 repo/marketplace,安装端点会先 `marketplace add <repo>` 再装。
  { id: 'ponytail',             name: 'Ponytail',            desc: '懒惰资深开发风格:能不写的代码就不写,优先 stdlib/原生(第三方源)', repo: 'DietrichGebert/ponytail', marketplace: 'ponytail' },
  { id: 'superpowers',          name: 'Superpowers',         desc: 'obra 出品工作流技能合集:头脑风暴/写计划/TDD/系统调试等(第三方源;skill 随插件装到 ~/.claude/plugins,以 superpowers:xxx 命名,不进 ~/.claude/skills)', repo: 'obra/superpowers-marketplace', marketplace: 'superpowers-marketplace' },
];
