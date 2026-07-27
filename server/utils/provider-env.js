// 宿主(Claude Desktop / 一个 claude 会话的终端)透传给 GUI server 的 provider 路由、
// 鉴权与档位 env。这些键**只描述宿主自己的 provider**,对 GUI 毫无意义:
//   · 子 CLI 的 env 由 cleanChildEnv() 单独构造(见 routes/chat.js);
//   · server 自己判断"当前是哪个 provider"只认 ~/.claude/settings.json。
// 键清单是单一真相源,chat.js 的 cleanChildEnv 与 index.js 的 boot 清理共用。
export const PROVIDER_ROUTING_ENV_KEYS = [
  'ANTHROPIC_MODEL', 'CLAUDE_MODEL',
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME', 'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME', 'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME', 'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME',
  'ANTHROPIC_REASONING_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_PERMISSION_MODE', 'CLAUDE_PERMISSION_MODE', 'CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS',
];

// 从给定 env(默认 = server 自己的 process.env)里删掉上述键。
// boot 时对 process.env 调用一次,即堵死所有"读点兜底 process.env"的污染:
// model-resolver 的 getAvailableModels(provider 名 / CLI 别名行)、getDefaultModel
// 第 4 步、GET /api/provider 的 baseUrl+model 兜底 —— 官方 provider(settings.json 里
// 没有 ANTHROPIC_BASE_URL)时它们会读到宿主的第三方路由,界面显示成 DeepSeek。
export function stripInheritedProviderEnv(env = process.env) {
  for (const k of PROVIDER_ROUTING_ENV_KEYS) delete env[k];
  return env;
}
