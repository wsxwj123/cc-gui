// OpenAI 兼容上游的 usage → Anthropic 命名归一(零依赖纯函数,openai-proxy 流式/非流式共用)。
//
// 各家在 OpenAI 口报缓存命中的字段互不相同,一张候选表兜住(顺序即优先级,自相矛盾时先到先得):
//   1. usage.prompt_tokens_details.cached_tokens        OpenAI 原生 / GLM / Qwen
//   2. usage.prompt_cache_hit_tokens                    DeepSeek(官方:prompt_tokens = hit + miss)
//   3. usage.cached_tokens(顶层)                       Kimi / Moonshot(官方 schema 就在顶层)
//   4. usage.cache_read_input_tokens(顶层)             把 anthropic 命名透出到 OpenAI 口的中转
//   5. usage.prompt_tokens_details.cache_read_input_tokens   同上的嵌套形态
// 缓存写量(R22)同理有一张候选表:details.cache_write_tokens > cache_write_tokens >
// cache_creation_input_tokens > details.cache_creation_input_tokens。
//
// 三条硬规则:
// - 取「第一个 >0 的候选」而不是「第一个非 null 的候选」:上游同时给显式 0 的 details.cached_tokens
//   和有值的顶层字段时,?? 链会短路在 0 上,回落分支永远不生效。
// - prompt_tokens 是【含读写】的总输入 → 减掉 read 与 creation 才是 Anthropic 语义的
//   input_tokens(未命中的新 token);上游不给 prompt_tokens 时回落 usage.input_tokens ——
//   那是 anthropic 命名,语义上本就只含未命中部分,不能再减。
// - cache_creation_input_tokens 只透传上游明说的,永不由 prompt/read 推算:凭空合成会同时
//   抬高徽章分母和费用(creation 单价高于 read)。
// - 负数/非有限/超 Number.MAX_SAFE_INTEGER 的字段标 USAGE_INVALID(码词表与
//   utils/usage-normalize.js 的 USAGE_CODES 同一套),原值一并透出供说明;
//   read + creation 超过 prompt_tokens 标 USAGE_INCONSISTENT。两者都写在 ccgui_usage 上
//   随 usage 透传(CLI 会把 usage 原样落进会话转写)。
//
// 零依赖是本模块的硬不变量(守卫单测焊死,代理两条路都要 import 它):上界就是 JS 语言
// 常量,不是可配置数据 —— 不为了取 Number.MAX_SAFE_INTEGER 去 import 整个 usage-normalize.js。
// 两边阈值必须同为语言常量,已由 check-r96-cache-openai 的 1.1 跨模块钉住,不会各漂各的。
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const firstPositive = (...vals) => { for (const v of vals) { const n = num(v); if (n) return n; } return 0; };
const boundedPositive = (...vals) => { for (const v of vals) { const n = num(v); if (n && n <= MAX_SAFE) return n; } return 0; };

function firstInvalid(...vals) {
  for (const v of vals) {
    if (v === undefined || v === null) continue;
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n) || n < 0 || n > MAX_SAFE) return true;
  }
  return false;
}

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
  const creation = firstPositive(
    d.cache_write_tokens,
    u.cache_write_tokens,
    u.cache_creation_input_tokens,
    d.cache_creation_input_tokens,
  );
  const prompt = num(u.prompt_tokens);
  const invalid = firstInvalid(
    u.prompt_tokens,
    u.completion_tokens,
    d.cached_tokens,
    d.cache_write_tokens,
    u.prompt_cache_hit_tokens,
    u.cache_creation_input_tokens,
  );
  const codes = [];
  if (invalid) codes.push('USAGE_INVALID');
  // 总输入装不下读写量:上游数字自相矛盾,不静默改写,标出来并保留原始数字。
  if (prompt > 0 && read + creation > prompt) codes.push('USAGE_INCONSISTENT');

  const output = boundedPositive(u.completion_tokens, u.output_tokens);
  const input = prompt > 0
    ? Math.max(0, prompt - read - creation)
    : num(u.input_tokens);

  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: read,
    cache_creation_input_tokens: creation,
    ...(codes.length ? {
      // 随 usage 透传到会话转写(CLI 原样落盘),供 /api/sessions/:id/messages 的
      // usageTotals 带上稳定 code;原始数字一并留着,展示处要能回读。
      ccgui_usage: {
        codes,
        raw: {
          prompt_tokens: Number.isFinite(Number(u.prompt_tokens)) ? Number(u.prompt_tokens) : null,
          completion_tokens: Number.isFinite(Number(u.completion_tokens)) ? Number(u.completion_tokens) : null,
          cached_tokens: read,
          cache_write_tokens: creation,
        },
      },
    } : {}),
  };
}
