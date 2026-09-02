// OpenAI 兼容上游的 usage → Anthropic 命名归一(零依赖纯函数,openai-proxy 流式/非流式共用)。
//
// 各家在 OpenAI 口报缓存命中的字段互不相同,一张候选表兜住(顺序即优先级,自相矛盾时先到先得):
//   1. usage.prompt_tokens_details.cached_tokens        OpenAI 原生 / GLM / Qwen
//   2. usage.prompt_cache_hit_tokens                    DeepSeek(官方:prompt_tokens = hit + miss)
//   3. usage.cached_tokens(顶层)                       Kimi / Moonshot(官方 schema 就在顶层)
//   4. usage.cache_read_input_tokens(顶层)             把 anthropic 命名透出到 OpenAI 口的中转
//   5. usage.prompt_tokens_details.cache_read_input_tokens   同上的嵌套形态
//
// 两条硬规则:
// - 取「第一个 >0 的候选」而不是「第一个非 null 的候选」:上游同时给显式 0 的 details.cached_tokens
//   和有值的顶层字段时,?? 链会短路在 0 上,回落分支永远不生效。
// - cache_creation_input_tokens 只透传上游明说的,永不由 prompt/read 推算:OpenAI 协议没有
//   cache write 概念,凭空合成会同时抬高徽章分母和费用(creation 单价高于 read)。

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const firstPositive = (...vals) => { for (const v of vals) { const n = num(v); if (n) return n; } return 0; };

export function normalizeOpenAIUsage(usage) {
  const u = (usage && typeof usage === 'object') ? usage : {};
  const d = (u.prompt_tokens_details && typeof u.prompt_tokens_details === 'object') ? u.prompt_tokens_details : {};
  const read = firstPositive(
    d.cached_tokens,
    u.prompt_cache_hit_tokens,
    u.cached_tokens,
    u.cache_read_input_tokens,
    d.cache_read_input_tokens,
  );
  const creation = firstPositive(u.cache_creation_input_tokens, d.cache_creation_input_tokens);
  const prompt = num(u.prompt_tokens);
  return {
    // prompt_tokens 是【含缓存】的总输入(DeepSeek 明写 = hit + miss)→ 减掉 read 与 creation
    // 才是 Anthropic 语义的 input_tokens(未命中的新 token),否则徽章会把缓存部分算两遍。
    // 上游不给 prompt_tokens 时回落 usage.input_tokens —— 那是 anthropic 命名,语义上本就
    // 只含未命中部分,不能再减。
    input_tokens: prompt > 0 ? Math.max(0, prompt - read - creation) : num(u.input_tokens),
    output_tokens: firstPositive(u.completion_tokens, u.output_tokens),
    cache_read_input_tokens: read,
    cache_creation_input_tokens: creation,
  };
}
