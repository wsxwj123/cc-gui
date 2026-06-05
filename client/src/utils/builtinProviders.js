// 内置 provider 模板库(Bug #2)。用户在添加 provider 时,可一键选模板,
// 自动填好 baseURL + 默认模型清单,只需填 API key。
//
// 价格表数据见 client/src/utils/pricing.js 的 PRICES。如发现某 provider 的
// 价格表过期 / 模型清单不全,直接改这里 + pricing.js;CLI 模型 id 与 provider
// 的 model id 是同一个字符串(传入 --model claude/CLI 协议都按这个 id 路由)。
//
// 价格调研日期 2026-06-05。Gemini / Grok 的版本号取自当时官方页面,GLM /
// MiniMax 因官网 JS 渲染未抓到数据,使用 2026 业内常识估值,**用户首次添加
// 后请到官网核对实际计费**。

export const BUILTIN_PROVIDERS = [
  // ─── OpenAI 兼容(走内置 openai-proxy 转 anthropic 协议给 claude CLI) ───
  {
    id: 'deepseek-official',
    name: 'DeepSeek 官方',
    type: 'openai',
    baseURL: 'https://api.deepseek.com',
    models: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash', 'deepseek-v4-pro'],
    note: 'OpenAI 兼容 API。deepseek-chat = v4-flash 非思考,deepseek-reasoner = v4-flash 思考。',
    docs: 'https://api-docs.deepseek.com/quick_start/pricing',
  },
  {
    id: 'openai',
    name: 'OpenAI 官方',
    type: 'openai',
    baseURL: 'https://api.openai.com/v1',
    models: ['gpt-5.5', 'gpt-5.5-pro', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.4-pro'],
    note: '官方 API。需 OpenAI API key(sk- 开头)。',
    docs: 'https://platform.openai.com/docs/pricing',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    type: 'openai',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: [
      'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite',
      'gemini-3-flash-preview', 'gemini-3.1-flash-lite', 'gemini-3.1-pro-preview', 'gemini-3.5-flash',
    ],
    note: 'Google AI Studio API key。OpenAI 兼容 endpoint。',
    docs: 'https://ai.google.dev/gemini-api/docs/pricing',
  },
  {
    id: 'moonshot',
    name: 'Moonshot Kimi',
    type: 'openai',
    baseURL: 'https://api.moonshot.cn/v1',
    models: [
      'kimi-k2.6',
      'moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k',
      'moonshot-v1-8k-vision-preview', 'moonshot-v1-32k-vision-preview', 'moonshot-v1-128k-vision-preview',
    ],
    note: 'kimi-k2.6 支持文/图/视频 + 256k 上下文,缓存命中价低。',
    docs: 'https://platform.moonshot.cn/docs/pricing/chat',
  },
  {
    id: 'xai-grok',
    name: 'xAI Grok',
    type: 'openai',
    baseURL: 'https://api.x.ai/v1',
    models: ['grok-4.3', 'grok-4.20-0309-reasoning', 'grok-4.20-0309-non-reasoning', 'grok-build-0.1'],
    note: 'OpenAI 兼容。grok-4.3 是当前推荐主力。',
    docs: 'https://docs.x.ai/docs/models',
  },
  {
    id: 'zhipu-glm',
    name: '智谱 GLM',
    type: 'openai',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4.6', 'glm-4.5', 'glm-4.5-air', 'glm-4-plus', 'glm-z1-flash'],
    note: 'OpenAI 兼容。⚠️ 价格表为 2026 业内估值,请到官网核对。',
    docs: 'https://open.bigmodel.cn/pricing',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    type: 'openai',
    baseURL: 'https://api.minimax.chat/v1',
    models: ['MiniMax-M2', 'MiniMax-M1', 'MiniMax-Text-01', 'abab7-chat-preview'],
    note: 'OpenAI 兼容。⚠️ 文本模型价格为 2026 业内估值,请到官网核对。',
    docs: 'https://platform.minimaxi.com',
  },

  // ─── Anthropic 协议原生(直传给 claude CLI,不走 proxy) ───
  {
    id: 'anthropic-official',
    name: 'Anthropic Claude 官方',
    type: 'anthropic',
    baseURL: 'https://api.anthropic.com',
    models: [
      'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5',
      'claude-sonnet-4-6', 'claude-sonnet-4-5',
      'claude-haiku-4-5',
    ],
    note: '原生 Anthropic API。若用订阅 OAuth 登录(claude /login),无需在此填 key。',
    docs: 'https://docs.anthropic.com/en/docs/about-claude/pricing',
  },
];

export function findBuiltin(id) {
  return BUILTIN_PROVIDERS.find((p) => p.id === id) || null;
}
