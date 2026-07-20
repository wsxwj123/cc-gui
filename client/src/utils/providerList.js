// 修正批#6:Provider 列表统一数据选择器 —— 管理页(ProviderManager)、顶栏切换卡片
// (ProviderSwitchList)、手机 Provider 页共用同一套合并/排序/去重逻辑,单一列表代替
// 来源分组(来源降为行内小徽章,视觉降噪)。
// 输入 = /api/providers 返回的三组原始数组;输出 = 统一行(原字段保留):
//   { ...p, source: 'official' | 'ccswitch' | 'openai' | 'custom', dupOf?: [{id,source}] }
// 规则:
//   1. 官方 Anthropic(category==='official')恒排第一(切换高亮由调用方按 isCurrent 判);
//   2. 其余按名称排序(zh locale);// ponytail: 没有"最近使用"时间戳可排,先按名称;
//      以后想按最近使用,给 /api/provider/switch 记一个 lastUsed 即可升级
//   3. 去重:标准化名称相同的条目只显示一条 —— 自定义(custom-providers.json,可编辑)
//      优先于 cc-switch 导入项,被合并的记进 dupOf(展示端标"含 cc-switch 导入项")。
//      官方项永不被合并掉。纯展示层合并:cc-switch.db 保持只读、custom-providers.json
//      不做迁移,随时可回退。
export function mergeProviderLists({ providers = [], openaiProviders = [], customProviders = [] } = {}) {
  const rows = [
    ...customProviders.map((p) => ({ ...p, source: 'custom' })),
    ...openaiProviders.map((p) => ({ ...p, source: 'openai' })),
    ...providers.map((p) => ({ ...p, source: p.category === 'official' ? 'official' : 'ccswitch' })),
  ];
  const norm = (s) => String(s || '').trim().toLowerCase();
  const seen = new Map();
  const out = [];
  for (const r of rows) {
    const k = norm(r.name);
    const kept = seen.get(k);
    // 官方项永远单独成行(即使有人把自定义项起了同名,也不吞掉官方入口)。
    if (kept && r.source !== 'official') {
      (kept.dupOf = kept.dupOf || []).push({ id: r.id, source: r.source });
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

// 来源徽章文案(单处定义,两端一致)。
export const SOURCE_BADGE = {
  official: '官方',
  ccswitch: '导入',
  openai: '导入·代理',
  custom: '自定义',
};
