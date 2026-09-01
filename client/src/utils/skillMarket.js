// r71:技能市场浏览层(搜索 / 来源分面 / 排序)的纯函数。只做视图筛选,不碰安装。
//
// 实测的条目真实字段(GET /api/skills/official,六源 1108 条):{ id, name, description,
// version, installed } —— 没有 category / tags / 下载量 / 更新时间,所以分面只建在
// **来源** 与 **安装状态** 两维,排序只有名称与来源,不造任何不存在的维度。
//
// 两条来自实测的硬约束:
// ① 服务端 DESC_CAP=30,超过就只列名不预取描述 —— composio(864)+ hermes(196)共 1060 条
//    (占 96%)description 恒为空,name 也退化成 id。所以检索必须把 id 当一等文本,
//    否则大源等于搜不到。
// ② 跨源 id 会撞(实测 1108 条里 19 个,如 anthropic 与 composio 都有 docx):合并列表的
//    列表 key / 选中集 / 忙碌标记一律用 `source:id`,用裸 id 会串行为。
export const ALL_SOURCES = '__all__';

export const marketKey = (s) => `${s?.source || ''}:${s?.id || ''}`;

// 查询词切成多个词元,全部命中才算匹配。市场 id 是 kebab-case,用户打「web design」
// 这种带空格的自然写法时整串子串匹配一定落空(命中不了 web-design-engineer)。
const tokenize = (q) => String(q || '').trim().toLowerCase().split(/\s+/).filter(Boolean);

// 大小写不敏感;中文靠原样子串匹配(toLowerCase 对 CJK 是恒等,不影响)。
export function matchSkill(s, tokens) {
  if (!tokens.length) return true;
  const hay = `${s?.id || ''} ${s?.name || ''} ${s?.description || ''}`.toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

// installed:'all' | 'installed' | 'available'
export function filterMarket(list, { q = '', source = ALL_SOURCES, installed = 'all' } = {}) {
  const arr = Array.isArray(list) ? list : [];
  const tokens = tokenize(q);
  // 三个维度都不筛时返回原数组身份,调用方的 memo/引用比较不被无谓打断。
  if (!tokens.length && (source === ALL_SOURCES || !source) && installed === 'all') return arr;
  return arr.filter((s) => {
    if (source && source !== ALL_SOURCES && s?.source !== source) return false;
    if (installed === 'installed' && !s?.installed) return false;
    if (installed === 'available' && s?.installed) return false;
    return matchSkill(s, tokens);
  });
}

// order:'name'(A→Z)| 'name-desc'(Z→A)| 'source'(按 sourceOrder 给的源次序,组内按名称)
// sourceOrder 传内置源的声明顺序,让排序结果与来源按钮行的次序一致;不在表内的源排到最后。
export function sortMarket(list, order = 'name', sourceOrder = []) {
  const arr = Array.isArray(list) ? list : [];
  if (order !== 'name' && order !== 'name-desc' && order !== 'source') return arr;
  const label = (s) => String(s?.name || s?.id || '');
  const byName = (a, b) => label(a).localeCompare(label(b)) || String(a?.id || '').localeCompare(String(b?.id || ''));
  const rank = (s) => {
    const i = sourceOrder.indexOf(s?.source);
    return i === -1 ? sourceOrder.length : i;
  };
  const cmp = order === 'name-desc'
    ? (a, b) => -byName(a, b)
    : order === 'source'
      ? (a, b) => (rank(a) - rank(b)) || String(a?.source || '').localeCompare(String(b?.source || '')) || byName(a, b)
      : byName;
  return [...arr].sort(cmp);
}

// 来源分面计数:{ [sourceId]: n }。只数列表里真有的条目,没加载过的源不会凭空出现。
export function countBySource(list) {
  const out = {};
  for (const s of (Array.isArray(list) ? list : [])) {
    const k = s?.source;
    if (k) out[k] = (out[k] || 0) + 1;
  }
  return out;
}

// 安装状态计数:{ total, installed, available }
export function countInstalled(list) {
  const arr = Array.isArray(list) ? list : [];
  const installed = arr.filter((s) => s?.installed).length;
  return { total: arr.length, installed, available: arr.length - installed };
}
