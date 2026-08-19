// r11-⑩:模型思考能力目录。用途:custom provider 拉取/保存模型列表时,对**未手动声明过**
// 的模型自动预填 modelMeta(标 source:'catalog');用户手动声明(source:'user' 或历史无
// source 条目)永远优先,预填绝不覆盖。查不到返回 null = 不预填(维持"未声明=全档可用")。
//
// r15-2 起分两层:
//  ① 实测数据表 server/data/thinking-levels.json(由 scripts/gen-thinking-levels.mjs 从
//     @earendil-works/pi-ai(MIT)提取)—— 主来源,按 model id 精确匹配;
//  ② 下面的家族正则 —— 只当表外新模型的兜底(表是快照,新模型总比表快)。
// 家族正则曾是唯一来源,被实测证伪多处(kimi-k2 全系判死、deepseek-chat-v3.1 判死),
// 那两行已撤:判错成 reasoning:false 会让 UI 锁灰 + 发送静默摘档(可见功能损失),而判错
// 成 null 只是维持全档(无害)—— 两个方向代价不对称,拿不准一律不进目录。
//
// 档位口径:CLI 2.1.235 的 `--effort` 只接受 low/medium/high/xhigh/max(**没有 minimal,
// 也没有 none**),故全集五档。'max' 在 openai 代理层折算为 xhigh。
import { readFileSync } from 'node:fs';

export const EFFORT_IDS = ['low', 'medium', 'high', 'xhigh', 'max'];

// 顺序即匹配优先级:更具体的规则在前(如 gpt-5*-codex / gpt-5*-chat 先于 gpt-5 通配)。
// caps.reasoning === false → 预填 {reasoning:false};
// caps.efforts 子集 → 预填 {efforts};
// caps.reasoning === true 且无 efforts → 全默认(目录命中但不产生预填条目)。
export const MODEL_CAPABILITY_CATALOG = [
  // ── DeepSeek ──────────────────────────────────────────────
  // r15-2 撤销 `deepseek-chat` 行(原判 reasoning:false):deepseek-chat-v3.1 起 chat 端
  // 本身就是混合思考(实测四档),被这条捡漏判死 → UI 直接锁灰显示"不支持"、发送时静默
  // 摘掉 effort,属可见功能损失。判错成 null(全档)只是维持现状、无害 —— 两个方向的
  // 代价不对称,拿不准一律不进目录。
  { family: 'deepseek-reasoner', re: /^deepseek-(reasoner|r\d)/i, caps: { reasoning: true } },
  { family: 'deepseek-v4', re: /^deepseek-v\d/i, caps: { reasoning: true } }, // v4 系混合思考
  // ── Kimi(Moonshot)────────────────────────────────────────
  { family: 'kimi-thinking', re: /^kimi-k\d[\w.-]*-thinking/i, caps: { reasoning: true } },
  { family: 'kimi-k3', re: /^kimi-k3/i, caps: { reasoning: true } }, // k3 系思考旗舰
  // r15-2 撤销 `kimi-k2` 行(原判 reasoning:false):k2.5 / k2.6 / k2.7-code 全都支持思考,
  // 只有 kimi-k2-0905-preview 这类老代际才非思考 —— 正则区分不了代际,同上不对称原则删除。
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
  // r15-2 新增:gpt-5*-chat(gpt-5-chat-latest 等)是非推理的 chat 变体,不吃
  // reasoning_effort。必须排在 ^gpt-5 通配之前,否则被它吞成"四档可选"。
  { family: 'gpt-5-chat', re: /^gpt-5[\d.]*-chat/i, caps: { reasoning: false } },
  // gpt-5 系:reasoning_effort low/medium/high(原写 minimal 起,CLI 不接受 minimal 已删)。
  { family: 'gpt-5', re: /^gpt-5/i, caps: { reasoning: true, efforts: ['low', 'medium', 'high'] } },
  // o 系推理模型:low/medium/high 三档。
  { family: 'o-series', re: /^o\d(-|$)/i, caps: { reasoning: true, efforts: ['low', 'medium', 'high'] } },
  // gpt-4 系(4o/4.1/4-turbo…):无 reasoning_effort,非思考。
  { family: 'gpt-4', re: /^gpt-4/i, caps: { reasoning: false } },
];

// ── 实测数据表(随包发布的静态资源,进程内读一次)────────────────────────────
// 形态:{ source, byId:{id→entry}, byProto:{id→{openai?,anthropic?}} }。
// entry 与 modelMeta 同构:{reasoning:false} | {efforts:[...]};全档模型不产生条目。
// byProto 只收【两种协议都有数据且结论不同】的少数 id(实测同一模型两种口径可以完全
// 不同:deepseek/deepseek-v4-pro openai=[high,xhigh] 而 anthropic=[low,medium,high])。
// 其余一律共用 byId —— 因为"表里没有某模型的 anthropic 条目"只说明上游没收录那个端点,
// 不代表它经 anthropic 协议就没有档位;严格分表会让用户那些 anthropic 协议中转全部落空。
// fail-safe:文件缺失/损坏 → THINKING_TABLE=null → 只走家族正则(绝不能让 /api/model 500)。
const THINKING_TABLE = (() => {
  try {
    const t = JSON.parse(readFileSync(new URL('../data/thinking-levels.json', import.meta.url), 'utf-8'));
    if (t && typeof t.byId === 'object' && typeof t.byProto === 'object') return t;
    console.warn('[thinking-levels] 数据表结构异常,已退回家族正则(档位判定会变宽松)');
    return null;
  } catch (e) {
    // 不静默:表缺失时行为是"全部退回家族正则"= 档位变宽松,用户端看不出异常,
    // 正是本轮修的那类隐身故障(功能在但悄悄不生效)。最常见成因是打包漏了
    // server/data/(Tauri bundle.resources 只列了 "../server" 整目录,理应递归带上,
    // 但 Windows 包无法本地验证)。留一行 warn 让 server.log 能查。
    console.warn('[thinking-levels] 数据表不可用,已退回家族正则(档位判定会变宽松):', e?.code || e?.message);
    return null;
  }
})();

// 查表一次(单个 id)。返回:undefined=表里没有(继续往下查);null=命中且全档(**不再下探**);
// 否则为表条目。区分"键不存在"与"值是 undefined"是关键:byProto 条目里缺某个协议键
// 表示"该协议下全档",此时必须停在这儿,落到 byId 会把另一协议的档位错安上去。
function tableLookup(id, protocol) {
  if (!THINKING_TABLE || !protocol) return undefined; // 不传 protocol = 只走正则(向后兼容)
  const pr = THINKING_TABLE.byProto[id];
  if (pr) return (protocol in pr) ? pr[protocol] : null;
  return (id in THINKING_TABLE.byId) ? THINKING_TABLE.byId[id] : undefined;
}

function matchCatalog(id) {
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
 * 目录查询:命中 → { family, reasoning, efforts|null };查不到 → null。
 *
 * @param {string} modelId  模型 id(可带命名空间前缀,如 openai/gpt-5.6-luna)
 * @param {string} [protocol] provider 的 type('openai' | 'anthropic')。
 *        **不传 = 跳过数据表、只走家族正则**(向后兼容旧调用点与纯正则单测)。
 *
 * 匹配顺序(逐条):
 *  1. byProto[id][protocol] —— 协议相关的少数模型;
 *  2. byId[id] —— 精确 id(聚合商的带前缀 id 与直连裸 id 天然是不同字符串,同表可区分);
 *  3. id 含 '/' → 取**最后一段**,重复 1、2;
 *  4. 家族正则(先全 id、再最后一段)—— 表外新模型的兜底;
 *  5. 都不中 → null(全档,维持现状)。
 *
 * r15 的剥前缀复查(第 3、4 步)是必需的:正则一律 ^ 锚定,而 OpenRouter 之类的 id 带
 * 命名空间前缀,不剥前缀直查 364 个模型命中 0 = 整套自适应对这些 provider 等于关着。
 * 只取最后一段:a/b/gpt-5 命中 gpt-5;openai/gpt-5/deprecated 的最后一段是 deprecated,
 * 不命中(不做逐段扫描——那会让任意中间段污染判定)。
 */
export function lookupModelCapabilities(modelId, protocol) {
  if (typeof modelId !== 'string' || !modelId.trim()) return null;
  const id = modelId.trim();
  const tail = id.includes('/') ? id.split('/').pop() : '';
  for (const key of tail ? [id, tail] : [id]) {
    const hit = tableLookup(key, protocol);
    if (hit === undefined) continue;
    return {
      family: 'table',
      reasoning: hit?.reasoning !== false,
      efforts: Array.isArray(hit?.efforts) ? [...hit.efforts] : null,
    };
  }
  return matchCatalog(id) || (tail ? matchCatalog(tail) : null);
}

/**
 * 目录命中 → modelMeta 预填条目(与 settings.js 存储形态同构,带 source:'catalog');
 * 查不到或命中但全默认(思考+全档)→ null(不产生条目,维持"未声明=全档")。
 */
export function catalogPrefillEntry(modelId, protocol) {
  const hit = lookupModelCapabilities(modelId, protocol);
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
 *
 * @param {string} [protocol] provider 的 type;不传 = 只走家族正则(向后兼容)。
 */
export function applyCatalogPrefill(models, meta, protocol) {
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
    const pre = catalogPrefillEntry(id, protocol);
    if (pre) out[id] = pre;
    else if (cur && cur.source === 'catalog') delete out[id];
  }
  // 防悬空:catalog 条目只为 models 内的模型存在(用户条目的悬空清理归调用方既有逻辑)。
  for (const id of Object.keys(out)) {
    if (out[id]?.source === 'catalog' && !idSet.has(id)) delete out[id];
  }
  return Object.keys(out).length ? out : null;
}
