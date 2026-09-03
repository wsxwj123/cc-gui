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
  // r15-3 撤销 `gpt-5-chat` 行(r15-2 加的,判 reasoning:false):与 584 条数据表条目对撞,
  // 唯一"正则判死而表说能思考"的方向性冲突就是它 —— gpt-5.2-chat-latest 实测四档。
  // ⚠️置信度口径:表是 pi-ai 某版的【快照】而非我们自己实测,同一族里它自己也不完全一致
  //   (gpt-5-chat-latest 判非思考、gpt-5.2-chat-latest 却给四档)。撤行后表外的
  //   gpt-5.1-chat-latest 会从"非思考"变成有档可选——方向仍是本轮既定的"宁可全档别判死"。
  // 传了 protocol 时表压过正则不出事,但正则恰恰只对【表里没有的模型】生效,那正是最容易
  // 判错的场景,且方向是本轮明令避免的"判死"。表里已有 8 条 *chat* 判 reasoning:false,
  // 覆盖足够;表外的新 chat 变体退回全档(无害)。
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
//
// ⚠️ 一处有意的不对称(加正则行前必读):生成脚本对"全档"的处理两表不同 ——
//   byId 只写非全档条目(全档 = 不产条目),所以【表说全档】在 byId 里查不到 → 会继续
//   下探家族正则,正则若判死就判死了(表压不住);
//   byProto 条目缺某协议键即表示"该协议全档",tableLookup 命中 byProto 就**停止下探**,
//   正则压不进来。
// 即:表能压住正则的只有 byProto 分支与 byId 的非全档条目。新增正则行时别假设"表里有
// 就轮不到我",要按表外模型的最坏情况判断(方向上宁可全档,别判死)。
//
// fail-safe:文件缺失/损坏 → THINKING_TABLE=null → 只走家族正则(绝不能让 /api/model 500)。
// typeof null === 'object',所以两个键必须先做真值判断,否则 {"byId":null} 这种畸形文件
// 会通过守卫、在查表时抛(GET /api/providers 没有错误兜底 → 500 = provider 列表打不开)。
const THINKING_TABLE = (() => {
  try {
    const t = JSON.parse(readFileSync(new URL('../data/thinking-levels.json', import.meta.url), 'utf-8'));
    if (t && t.byId && t.byProto && typeof t.byId === 'object' && typeof t.byProto === 'object') return t;
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
  // 值也要验形态:byProto 里塞个字符串/数组时 `protocol in pr` 会抛(in 不吃基本类型)。
  const pr = THINKING_TABLE.byProto[id];
  if (pr && typeof pr === 'object') return (protocol in pr) ? pr[protocol] : null;
  return (id in THINKING_TABLE.byId) ? THINKING_TABLE.byId[id] : undefined;
}

// ── r105:变体 id 的逐级回退候选(纯函数,导出仅为可单测)──────────────────────
// `deepseek-v4-flash-vision-exp` → ['deepseek-v4-flash-vision','deepseek-v4-flash','deepseek-v4']。
// 表是快照,厂商发新变体(-vision-exp / -0731 / -preview)比表快,精确 miss 就落家族正则
// = 全五档,正是用户报的"DeepSeek 仍然有五档"。
// 三条边界:
//  ① 命名空间前缀(`deepseek/…`)原样保留,只在最后一段上剥 —— 网关口径与直连口径不同
//     (OpenRouter 把 DeepSeek 的 max 重命名成 xhigh 且不透传 low),跨命名空间回退会把
//     网关模型污染成直连档位;
//  ② 至多 3 级(再往上剥只剩泛化的家族名,命中的已不是"同一个模型的变体");
//  ③ 剥到只剩首段(gpt / deepseek)即停 —— 单段名太宽泛,不作为候选。
// 跨家族的拦截不在这里(纯词法看不出 gpt-5-codex 与 gpt-5 是两个家族),在调用点按
// matchCatalog 的 family 比对。
export function variantBaseIds(modelId, maxLevels = 3) {
  const id = typeof modelId === 'string' ? modelId.trim() : '';
  if (!id) return [];
  const ns = id.slice(0, id.lastIndexOf('/') + 1); // 无 '/' 时 lastIndexOf=-1 → ''
  let base = id.slice(ns.length);
  const out = [];
  while (out.length < maxLevels) {
    const cut = base.lastIndexOf('-');
    if (cut <= 0) break;
    base = base.slice(0, cut);
    if (!base.includes('-')) break; // 只剩首段
    out.push(ns + base);
  }
  return out;
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

// ── 视觉能力目录(r26-G6)──────────────────────────────────────────────────
// r63:目录与 lookupVisionCapability 抽到 vision-capability.js(纯模块,零 node 依赖)
// —— 前端黄条警告(ChatInput)要与服务端同一份判定口径,而本文件顶层 import node:fs
// 进不了 vite bundle。消费方(openai-proxy / ChatInput / 单测)一律直连新模块,
// 这里不留 re-export:check-model-capabilities t11 按「单文件拷走」验证数据表缺失
// fail-safe,本文件不能新增静态相对依赖。

/**
 * 目录查询:命中 → { family, reasoning, efforts|null };查不到 → null。
 *
 * @param {string} modelId  模型 id(可带命名空间前缀,如 openai/gpt-5.6-luna)
 * @param {string} [protocol] provider 的 type('openai' | 'anthropic')。
 *        **不传 = 跳过数据表、只走家族正则**(向后兼容旧调用点与纯正则单测)。
 *
 * 匹配顺序(逐条):
 *  1. byProto[id][protocol] / byId[id] —— 精确 id(聚合商的带前缀 id 与直连裸 id 天然是
 *     不同字符串,同表可区分);
 *  2. r105:id 的**变体回退**(去尾段,≤3 级,不跨命名空间/家族)—— 命中标 table-variant;
 *  3. id 含 '/' → 取**最后一段**,重复 1、2;
 *  4. 家族正则(先全 id、再最后一段)—— 表外新模型的兜底;
 *  5. 都不中 → null(全档,维持现状)。
 *
 * r15 的剥前缀复查(第 3、4 步)是必需的:正则一律 ^ 锚定,而 OpenRouter 之类的 id 带
 * 命名空间前缀,不剥前缀直查 364 个模型命中 0 = 整套自适应对这些 provider 等于关着。
 * 只取最后一段:a/b/gpt-5 命中 gpt-5;openai/gpt-5/deprecated 的最后一段是 deprecated,
 * 不命中(不做逐段扫描——那会让任意中间段污染判定)。
 *
 * r105 的变体回退排在"剥前缀"之前(第 2 步先于第 3 步),否则
 * `deepseek/deepseek-v4-flash-vision-exp` 会经剥前缀落到**直连**的
 * `deepseek-v4-flash-vision-exp` 上,拿到直连档位([low,high,max])——而网关口径是
 * [high,xhigh];先走带命名空间的回退才能落到同命名空间的 `deepseek/deepseek-v4-flash`。
 */
export function lookupModelCapabilities(modelId, protocol) {
  if (typeof modelId !== 'string' || !modelId.trim()) return null;
  const id = modelId.trim();
  const tail = id.includes('/') ? id.split('/').pop() : '';
  const toHit = (hit, viaId) => ({
    family: 'table',
    reasoning: hit?.reasoning !== false,
    efforts: Array.isArray(hit?.efforts) ? [...hit.efforts] : null,
    ...(viaId ? { source: 'table-variant', viaId } : {}),
  });
  for (const key of tail ? [id, tail] : [id]) {
    const exact = tableLookup(key, protocol);
    if (exact !== undefined) return toHit(exact);
    // 变体回退:同家族才算数(纯词法剥不出 gpt-5-codex-x → gpt-5 是跨家族)。
    const fam = matchCatalog(key)?.family ?? null;
    for (const cand of variantBaseIds(key)) {
      if ((matchCatalog(cand)?.family ?? null) !== fam) break;
      const hit = tableLookup(cand, protocol);
      if (hit !== undefined) return toHit(hit, cand);
    }
  }
  return matchCatalog(id) || (tail ? matchCatalog(tail) : null);
}

// r105:机器所有的两种 source —— 'catalog'(精确命中/正则)与 'table-variant'(变体回退)。
// 二者语义相同(可被新目录覆盖、可被用户声明压过),只是后者多带 viaId 供 UI 说明来源。
// 判"是否用户声明"的地方一律用它,别再写 `source !== 'catalog'`(会把变体条目当成用户声明,
// 从此再不刷新)。
export const CATALOG_SOURCES = ['catalog', 'table-variant'];
export const isCatalogSource = (s) => s === 'catalog' || s === 'table-variant';

/**
 * 目录命中 → modelMeta 预填条目(与 settings.js 存储形态同构,带 source:'catalog';
 * 变体回退命中则为 source:'table-variant' + viaId=实际命中的基名);
 * 查不到或命中但全默认(思考+全档)→ null(不产生条目,维持"未声明=全档")。
 */
export function catalogPrefillEntry(modelId, protocol) {
  const hit = lookupModelCapabilities(modelId, protocol);
  if (!hit) return null;
  const via = hit.source === 'table-variant' && hit.viaId
    ? { source: 'table-variant', viaId: hit.viaId } : { source: 'catalog' };
  if (!hit.reasoning) return { reasoning: false, ...via };
  const eff = (hit.efforts || []).filter((e) => EFFORT_IDS.includes(e));
  if (eff.length && eff.length < EFFORT_IDS.length) return { efforts: eff, ...via };
  return null; // 全默认,无需条目
}

/**
 * 保存/拉取路径的预填合并(纯函数):
 *  - 用户声明(source==='user' 或历史无 source 的存量条目)逐字保留,永不覆盖;
 *  - 无声明或机器所有(source==='catalog'/'table-variant')的模型 → 以目录最新预填为准(目录不再命中/命中
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
    if (cur && !isCatalogSource(cur.source)) continue; // 用户声明优先,永不覆盖
    const pre = catalogPrefillEntry(id, protocol);
    if (pre) out[id] = pre;
    else if (cur && isCatalogSource(cur.source)) delete out[id];
  }
  // 防悬空:catalog 条目只为 models 内的模型存在(用户条目的悬空清理归调用方既有逻辑)。
  for (const id of Object.keys(out)) {
    if (isCatalogSource(out[id]?.source) && !idSet.has(id)) delete out[id];
  }
  return Object.keys(out).length ? out : null;
}
