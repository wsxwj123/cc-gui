// r151a 场景:几种第三方 provider(都是自定义 provider,base URL = 本地假接口的一条车道)。
// 每个用例自己调 provider(key) 建 / 重置它,不依赖别的用例先跑过。
import { ensureProvider } from './api.mjs';

export const LONG_MODEL = `r151-${'长'.repeat(60)}-${'x'.repeat(200)}`;   // 超长名字(> 256 个 UTF-16 单元)

export const PROVIDERS = {
  main: { models: ['r151-chat', 'r151-reasoner'], defaultModel: 'r151-chat', tierModels: null },
  other: { models: ['r151-chat', 'r151-reasoner'], defaultModel: 'r151-chat', tierModels: null },
  // 该 provider 自己就配了 opus / haiku 档(用来验证"其它档位映射保持不变")
  tiers: { models: ['r151-chat', 'r151-reasoner', 'r151-mini'], defaultModel: 'r151-chat', tierModels: { opus: 'r151-reasoner', haiku: 'r151-mini' } },
  // 显式设了 sonnet 档
  sonnet: { models: ['r151-chat', 'r151-reasoner'], defaultModel: 'r151-chat', tierModels: { sonnet: 'r151-reasoner' } },
  // 配置里没有模型、没有默认模型、也没有档位(切过去后 settings.json 不写任何模型键;实测配置里有模型时会拿第一个当默认)
  nodef: { models: [], laneModels: ['r151-chat'], defaultModel: '', tierModels: null },
  // 模型列表取不到:配置里没有,上游模型列表接口 500
  down: { models: [], laneModels: 'http500', defaultModel: '', tierModels: null },
  // 模型列表为空:配置里没有,上游模型列表接口返回空
  empty: { models: [], laneModels: 'empty', defaultModel: '', tierModels: null },
  // 列表里有 CLI 不认的审核型号(前缀、大小写)与近似但可用的名字
  claude: { models: ['claude-sonnet-5-5', 'Claude-Opus-5-5-20261101', 'claude-sonnet-5', 'claude-sonnet-4-6', 'r151-chat'], defaultModel: 'r151-chat', tierModels: null },
  // 中文名、特殊字符、超长名字
  odd: { models: ['深度求索-对话', 'org/model:v1@2', LONG_MODEL, 'r151-chat'], defaultModel: 'r151-chat', tierModels: null },
};

/** 建 / 重置 key 对应的 provider,返回 id。车道名 = tp-<key>。 */
export const provider = (key) => ensureProvider(`tp-${key}`, PROVIDERS[key]);
