// 内置 provider 模板库。选模板自动填好 name/type/baseURL,用户只需填 API key,
// 再点「获取模型」拉取该 provider 当前的模型列表(或手填)。
//
// 不再内置 models 清单:provider 的模型会随时更新,写死的模型名很快过期、还会误导
// (如 deepseek 的 anthropic 端点实际按 claude-* 名映射,但具体可用 id 由上游决定)。
// 模型一律由「获取模型」实时拉取或用户手填。价格表见 client/src/utils/pricing.js。

export const BUILTIN_PROVIDERS = [
  // ─── OpenAI 兼容(走内置 openai-proxy 转 anthropic 协议给 claude CLI) ───
  {
    id: 'deepseek-official',
    name: 'DeepSeek 官方',
    type: 'openai',
    baseURL: 'https://api.deepseek.com',
    note: 'OpenAI 兼容 API。模型用「获取模型」拉取。',
    docs: 'https://api-docs.deepseek.com/quick_start/pricing',
  },
  {
    id: 'openai',
    name: 'OpenAI 官方',
    type: 'openai',
    baseURL: 'https://api.openai.com/v1',
    note: '官方 API。需 OpenAI API key(sk- 开头)。',
    docs: 'https://platform.openai.com/docs/pricing',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    type: 'openai',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    note: 'Google AI Studio API key。OpenAI 兼容 endpoint。',
    docs: 'https://ai.google.dev/gemini-api/docs/pricing',
  },
  {
    id: 'moonshot',
    name: 'Moonshot Kimi',
    type: 'openai',
    baseURL: 'https://api.moonshot.cn/v1',
    note: 'Moonshot 开放平台 API key。OpenAI 兼容。',
    docs: 'https://platform.moonshot.cn/docs/pricing/chat',
  },
  {
    id: 'xai-grok',
    name: 'xAI Grok',
    type: 'openai',
    baseURL: 'https://api.x.ai/v1',
    note: 'OpenAI 兼容。',
    docs: 'https://docs.x.ai/docs/models',
  },
  {
    id: 'zhipu-glm',
    name: '智谱 GLM',
    type: 'openai',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    note: 'OpenAI 兼容。',
    docs: 'https://open.bigmodel.cn/pricing',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    type: 'openai',
    baseURL: 'https://api.minimax.chat/v1',
    note: 'OpenAI 兼容。',
    docs: 'https://platform.minimaxi.com',
  },

  // ─── Anthropic 协议(直接发 anthropic 格式给端点) ───
  {
    id: 'anthropic-official',
    name: 'Anthropic Claude 官方',
    type: 'anthropic',
    baseURL: 'https://api.anthropic.com',
    note: '原生 Anthropic API。若用订阅 OAuth 登录(claude /login),无需在此填 key。',
    docs: 'https://docs.anthropic.com/en/docs/about-claude/pricing',
  },
  {
    id: 'deepseek-anthropic',
    name: 'DeepSeek(Anthropic 协议)',
    type: 'anthropic',
    baseURL: 'https://api.deepseek.com/anthropic',
    note: 'DeepSeek 的 Anthropic 兼容端点。可填 deepseek 模型 id,也可填 claude-* 名(上游会映射:claude-opus→deepseek-v4-pro,claude-sonnet/haiku→deepseek-v4-flash)。',
    docs: 'https://api-docs.deepseek.com/guides/anthropic_api',
  },
  {
    id: 'openrouter-anthropic',
    name: 'OpenRouter(Anthropic 协议)',
    type: 'anthropic',
    baseURL: 'https://openrouter.ai/api/v1',
    note: 'OpenRouter 聚合平台的 Anthropic 兼容端点。模型 ID 需带 provider 前缀(anthropic/、google/ 等)。',
    docs: 'https://openrouter.ai/docs',
  },
  {
    id: 'glm-anthropic',
    name: '智谱 GLM(Anthropic 协议)',
    type: 'anthropic',
    baseURL: 'https://open.bigmodel.cn/api/anthropic',
    note: '⚠️ 智谱官网未公开标注 Anthropic 兼容文档,实际可用性请自行测试(社区有反馈可用)。',
    docs: 'https://docs.bigmodel.cn/',
  },
];

export function findBuiltin(id) {
  return BUILTIN_PROVIDERS.find((p) => p.id === id) || null;
}
