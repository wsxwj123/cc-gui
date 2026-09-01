// 修正批#6:Provider 列表统一数据选择器 —— 管理页(ProviderManager)、顶栏切换卡片
// (ProviderSwitchList)、手机 Provider 页共用同一套合并/排序/去重逻辑,单一列表代替
// 来源分组(来源降为行内小徽章,视觉降噪)。
// 输入 = /api/providers 返回的三组原始数组 + 可选 hidden(已隐藏 id 集合);
// 输出 = 统一行(原字段保留):
//   { ...p, source: 'official' | 'ccswitch' | 'openai' | 'custom', dupOf?: [{id,source,isCurrent}] }
// 规则:
//   1. 官方 Anthropic(category==='official')恒排第一(切换高亮由调用方按 rowIsCurrent 判);
//   2. 其余按名称排序(zh locale);// ponytail: 没有"最近使用"时间戳可排,先按名称;
//      以后想按最近使用,给 /api/provider/switch 记一个 lastUsed 即可升级
//   3. 去重(审计批挂账收紧):**标准化名称相同 且 双方都有 baseURL 且 baseURL 相同**
//      才吞并 —— 原来仅按名称吞,同名异后端的导入项被吞掉后无法切换(根治)。
//      cc-switch 只读组不向客户端暴露 baseURL → 天然不再被吞,恢复可切;一次性导入
//      后的重复项(custom vs custom/openai,带 baseURL)仍正常合并。自定义(可编辑)
//      优先留下,被合并的记进 dupOf(含 isCurrent,供当前高亮兼配)。官方项永不被合并掉。
//   4. hidden(可选):已隐藏的条目在**合并前**先过滤 —— 隐藏的导入项不参与吞并,
//      不再给保留行挂「含导入」徽章。纯展示层合并:cc-switch.db 只读、
//      custom-providers.json 不迁移,随时可回退。
export function mergeProviderLists({ providers = [], openaiProviders = [], customProviders = [], hidden = null } = {}) {
  let rows = [
    ...customProviders.map((p) => ({ ...p, source: 'custom' })),
    ...openaiProviders.map((p) => ({ ...p, source: 'openai' })),
    ...providers.map((p) => ({ ...p, source: p.category === 'official' ? 'official' : 'ccswitch' })),
  ];
  if (hidden && typeof hidden.has === 'function') rows = rows.filter((r) => !hidden.has(r.id));
  const norm = (s) => String(s || '').trim().toLowerCase();
  // baseURL 归一化:去尾斜杠+小写。字段兼容 baseURL / baseUrl 两种拼写。
  const normUrl = (p) => {
    const u = p.baseURL ?? p.baseUrl;
    return u ? String(u).trim().replace(/\/+$/, '').toLowerCase() : null;
  };
  const seen = new Map();
  const out = [];
  for (const r of rows) {
    const k = norm(r.name);
    const kept = seen.get(k);
    // 收紧的吞并条件:同名 + 双方 baseURL 已知且相同;官方项永远单独成行。
    const keptUrl = kept ? normUrl(kept) : null;
    const rUrl = normUrl(r);
    if (kept && r.source !== 'official' && keptUrl != null && rUrl != null && keptUrl === rUrl) {
      (kept.dupOf = kept.dupOf || []).push({ id: r.id, source: r.source, isCurrent: !!r.isCurrent });
      continue;
    }
    if (!kept) seen.set(k, r);
    out.push(r);
  }
  out.sort((a, b) =>
    ((a.source === 'official' ? 0 : 1) - (b.source === 'official' ? 0 : 1))
    || String(a.name || '').localeCompare(String(b.name || ''), 'zh'));
  return out;
}

// 当前激活判定(审计批挂账:兼配被吞并进 dupOf 的 id)——激活的是被合并掉的那个
// 导入项时,保留行同样高亮打勾,避免"切了却没有当前项"的观感。
export function rowIsCurrent(p, activeId) {
  if (activeId != null) return p.id === activeId || (p.dupOf || []).some((d) => d.id === activeId);
  return !!(p.isCurrent || (p.dupOf || []).some((d) => d.isCurrent));
}

// 来源徽章文案(单处定义,两端一致)。
export const SOURCE_BADGE = {
  official: '官方',
  ccswitch: '导入',
  openai: '导入·代理',
  custom: '自定义',
};

// r78:provider 头像的形态判定。纯函数放在 server/utils/(Tauri 只打包 server 与
// client/dist,共享核心必须落在会被打包的那棵树上;见 utils/plan.js 的事故注释),
// 这里再导出,前端一律从 providerList.js 取。
export { parseAvatar, AVATAR_MARKS, AVATAR_FILE_RE, searchMarks } from '../../../server/utils/avatar.js';

// ── r76:助手气泡头的名字 ─────────────────────────────────────────
// 官方端点恒显 Claude;走第三方中转时显示【用户在设置里给该 provider 起的名字】
// (p.name,不是内部 id / providerHint)。
// r78:头像与名字同源 —— 判定挪进 resolveAssistantProvider(返回那一行 provider),
// resolveAssistantName 变成读 name 的薄封装(判定逻辑逐字未改,r76 单测原样过)。
export const OFFICIAL_ASSISTANT_NAME = 'Claude';

// 模型 id 归一:去掉 [1m] 之类后缀 + 大小写。清单里存的和 jsonl 里回来的常差这一层。
const normModel = (m) => String(m || '').replace(/\[.*?\]/g, '').trim().toLowerCase();

// 一行 provider 的显示名;官方行恒 Claude。名字为空 → null(交给下一级回落)。
function rowDisplayName(p) {
  if (!p) return null;
  if (p.source === 'official' || p.category === 'official') return OFFICIAL_ASSISTANT_NAME;
  const n = String(p.name || '').trim();
  if (!n) return null;
  // 用户把中转项就命名成 Anthropic 时不制造两种叫法。
  return n.toLowerCase() === 'anthropic' ? OFFICIAL_ASSISTANT_NAME : n;
}

// 一行 provider 是否官方。
const rowIsOfficial = (p) => !!p && (p.source === 'official' || p.category === 'official');

/**
 * 解析一条助手消息该署谁的名字 **以及它属于哪一行 provider**(头像要的是行,名字
 * 要的是字符串,两者必须来自同一次判定 —— 各解析一遍迟早出现"名字是 A、头像是 B")。
 * 返回 { official, row, name }:official=官方端点(头像恒用 cc-gui 自有标识);
 * row=命中的 provider 行(可能为 null,交给按名字关键字/首字母的默认回落)。
 * 判定逻辑与 r76 逐字相同,四级优先级见下。
 *   ① 官方端点下的 claude-* 模型 → 'Claude'(官方订阅/官方 API 恒 Claude);
 *   ② model id 在【唯一一个】已配置 provider 的模型清单里命中 → 该 provider 的 name
 *      (命中 0 个或 ≥2 个都算没确证,继续往下 —— 宁可回落也不标错名);
 *   ③ 当前激活 provider 的显示名(这条消息正在该 provider 下渲染);
 *   ④ 'Claude'。
 * @param {object}   a
 * @param {string}   a.model          该消息的 model id(jsonl 里的原值,可为空)
 * @param {Array}    a.providers      已配置 provider 行(mergeProviderLists 的输出)
 * @param {string}   a.activeName     当前激活 provider 的显示名(/api/model 的 provider)
 * @param {boolean}  a.activeOfficial 当前是否官方端点(providerHint === 'anthropic')
 */
export function resolveAssistantProvider({ model = '', providers = [], activeName = '', activeOfficial = true } = {}) {
  const id = normModel(model);
  // ① 官方端点 + claude 系模型 = 确证官方。必须排在 ② 前面,否则某个中转 provider
  //    的清单里也写了 claude-opus-5 时会把官方消息标成它的名字。
  if (activeOfficial && id.startsWith('claude')) return { official: true, row: null, name: OFFICIAL_ASSISTANT_NAME };
  // ② 唯一命中某个 provider 的模型清单
  if (id && Array.isArray(providers)) {
    const hits = providers.filter((p) => Array.isArray(p?.models) && p.models.some((m) => normModel(m) === id));
    if (hits.length === 1) {
      const name = rowDisplayName(hits[0]);
      if (name) return { official: rowIsOfficial(hits[0]), row: hits[0], name };
    }
  }
  // ③ 当前激活 provider
  if (activeOfficial) return { official: true, row: null, name: OFFICIAL_ASSISTANT_NAME };
  const active = String(activeName || '').trim();
  if (active && active.toLowerCase() !== 'anthropic') {
    // 头像要行,名字只要串:按【显示名】回找那一行,保证头像与署名同属一个 provider。
    // 找不到(列表还没水合/名字对不上)→ row=null,回落到按名字关键字取图。
    const row = (Array.isArray(providers) ? providers : []).find((p) => rowDisplayName(p) === active) || null;
    return { official: false, row, name: active };
  }
  // ④ 兜底
  return { official: true, row: null, name: OFFICIAL_ASSISTANT_NAME };
}

/** r76 原签名:只要名字。判定全在 resolveAssistantProvider,此处不许有第二份逻辑。 */
export function resolveAssistantName(a) {
  return resolveAssistantProvider(a).name;
}
