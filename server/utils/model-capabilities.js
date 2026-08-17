// r11-⑩:常见模型家族的思考能力目录(纯数据+纯函数,零 I/O)。
// 用途:custom provider 拉取/保存模型列表时,对**未手动声明过**的模型自动预填
// modelMeta(标 source:'catalog');用户手动声明(source:'user' 或历史无 source 条目)
// 永远优先,预填绝不覆盖。目录外模型返回 null = 不预填(维持"未声明=全档可用")。
//
// 口径与 openai-proxy 的 effort 翻译一致:effort id 全集 = minimal/low/medium/high/
// xhigh/max('max' 在 openai 代理层折算为 xhigh);efforts 子集只在模型有【离散档位
// 语义】(如 OpenAI reasoning_effort)时声明;思考为"开/关或连续预算"的模型(DeepSeek/
// GLM/Qwen/Kimi/MiniMax 思考形态)不限制档位(=全默认,预填不产生条目)。
// reasoning:false 才是目录的主要产出:非思考模型不再下发思考参数。

export const EFFORT_IDS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// 顺序即匹配优先级:更具体的规则在前(如 kimi-k2-thinking 先于 kimi-k2)。
// caps.reasoning === false → 预填 {reasoning:false};
// caps.efforts 子集 → 预填 {efforts};
// caps.reasoning === true 且无 efforts → 全默认(目录命中但不产生预填条目)。
export const MODEL_CAPABILITY_CATALOG = [
  // ── DeepSeek ──────────────────────────────────────────────
  { family: 'deepseek-chat', re: /^deepseek(-v[\d.]+)?-chat/i, caps: { reasoning: false } },
  { family: 'deepseek-reasoner', re: /^deepseek-(reasoner|r\d)/i, caps: { reasoning: true } },
  { family: 'deepseek-v4', re: /^deepseek-v\d/i, caps: { reasoning: true } }, // v4 系混合思考
  // ── Kimi(Moonshot)────────────────────────────────────────
  { family: 'kimi-thinking', re: /^kimi-k\d[\w.-]*-thinking/i, caps: { reasoning: true } },
  { family: 'kimi-k3', re: /^kimi-k3/i, caps: { reasoning: true } }, // k3 系思考旗舰
  { family: 'kimi-k2', re: /^kimi-k2/i, caps: { reasoning: false } }, // k2 instruct 非思考
  // ── 智谱 GLM ──────────────────────────────────────────────
  { family: 'glm', re: /^glm-[45]/i, caps: { reasoning: true } }, // 4.5 起混合思考
  // ── Qwen ─────────────────────────────────────────────────
  { family: 'qwen-instruct', re: /^qwen[\w.-]*-instruct/i, caps: { reasoning: false } },
  { family: 'qwen2', re: /^qwen2/i, caps: { reasoning: false } }, // qwen2.x 非思考代际
  { family: 'qwen', re: /^qwen/i, caps: { reasoning: true } }, // qwen3 系混合思考
  // ── MiniMax ──────────────────────────────────────────────
  { family: 'minimax', re: /^minimax/i, caps: { reasoning: true } },
  // ── MiMo(小米)────────────────────────────────────────────
  { family: 'mimo', re: /^mimo/i, caps: { reasoning: true } },
  // ── OpenAI ───────────────────────────────────────────────
  // gpt-5 codex 系:reasoning_effort low/medium/high/xhigh(无 minimal;max 由代理折算)。
  { family: 'gpt-codex', re: /^gpt-5[\d.]*-codex/i, caps: { reasoning: true, efforts: ['low', 'medium', 'high', 'xhigh'] } },
  // gpt-5 系:reasoning_effort minimal/low/medium/high。
  { family: 'gpt-5', re: /^gpt-5/i, caps: { reasoning: true, efforts: ['minimal', 'low', 'medium', 'high'] } },
  // o 系推理模型:low/medium/high 三档。
  { family: 'o-series', re: /^o\d(-|$)/i, caps: { reasoning: true, efforts: ['low', 'medium', 'high'] } },
  // gpt-4 系(4o/4.1/4-turbo…):无 reasoning_effort,非思考。
  { family: 'gpt-4', re: /^gpt-4/i, caps: { reasoning: false } },
];

/** 目录查询:命中 → { family, reasoning, efforts|null };目录外 → null。 */
export function lookupModelCapabilities(modelId) {
  if (typeof modelId !== 'string' || !modelId.trim()) return null;
  const id = modelId.trim();
  for (const row of MODEL_CAPABILITY_CATALOG) {
    if (row.re.test(id)) {
      return {
        family: row.family,
        reasoning: row.caps.reasoning !== false,
        efforts: Array.isArray(row.caps.efforts) ? [...row.caps.efforts] : null,
      };
    }
  }
  return null;
}

/**
 * 目录命中 → modelMeta 预填条目(与 settings.js 存储形态同构,带 source:'catalog');
 * 目录外或命中但全默认(思考+全档)→ null(不产生条目,维持"未声明=全档")。
 */
export function catalogPrefillEntry(modelId) {
  const hit = lookupModelCapabilities(modelId);
  if (!hit) return null;
  if (!hit.reasoning) return { reasoning: false, source: 'catalog' };
  const eff = (hit.efforts || []).filter((e) => EFFORT_IDS.includes(e));
  if (eff.length && eff.length < EFFORT_IDS.length) return { efforts: eff, source: 'catalog' };
  return null; // 全默认,无需条目
}

/**
 * 保存/拉取路径的预填合并(纯函数):
 *  - 用户声明(source==='user' 或历史无 source 的存量条目)逐字保留,永不覆盖;
 *  - 无声明或 source==='catalog' 的模型 → 以目录最新预填为准(目录不再命中/命中
 *    但全默认时,撤掉旧的 catalog 条目——catalog 条目归机器所有);
 *  - 返回合并后的 meta;一条不剩返回 null(与 sanitizeModelMeta 空态口径一致)。
 */
export function applyCatalogPrefill(models, meta) {
  const out = {};
  const src = meta && typeof meta === 'object' ? meta : {};
  const ids = Array.isArray(models) ? models : [];
  const idSet = new Set(ids);
  // 先保留全部既有条目(含不在 models 内的交由调用方剔除;此处不越权)。
  for (const [id, entry] of Object.entries(src)) {
    if (entry && typeof entry === 'object') out[id] = entry;
  }
  for (const id of ids) {
    const cur = out[id];
    if (cur && cur.source !== 'catalog') continue; // 用户声明优先,永不覆盖
    const pre = catalogPrefillEntry(id);
    if (pre) out[id] = pre;
    else if (cur && cur.source === 'catalog') delete out[id];
  }
  // 防悬空:catalog 条目只为 models 内的模型存在(用户条目的悬空清理归调用方既有逻辑)。
  for (const id of Object.keys(out)) {
    if (out[id]?.source === 'catalog' && !idSet.has(id)) delete out[id];
  }
  return Object.keys(out).length ? out : null;
}
