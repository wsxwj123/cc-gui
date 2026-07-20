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
