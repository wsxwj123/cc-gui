// r151b T-X3:跨会话目标解析(纯函数,PLAN X.1.7)。权威地址是会话 id,标题只是给人和模型看的名字:
// 不把标题同步进 CLI 登记表;改名后旧标题自然不再命中,已在收件箱里的消息存的是会话 id,不受影响。
// 会话项形状:{ sessionId, shortId, title, project }(GET /api/xsession/sessions 的列表项)。

export const SHORT_ID_LEN = 8;

const commonPrefixLen = (a, b) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
};

/**
 * 短 id:会话 id 的前 8 位;与其它会话冲突时加长到不冲突(两个 id 只差大小写或完全相同时只能给全长)。
 * 比较不分大小写(uuid 的十六进制大小写同义)。冲突要对【全部】会话判,不能只对筛选后的那几条判。
 * 排序后与某个 id 公共前缀最长的,必是它的相邻项 → 只比左右邻居。返回 Map<会话id, 短id>。
 */
export function assignShortIds(ids) {
  const sorted = [...new Set(ids)].map((id) => ({ id, key: id.toLowerCase() }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const out = new Map();
  sorted.forEach(({ id, key }, i) => {
    let shared = 0;
    if (i > 0) shared = Math.max(shared, commonPrefixLen(key, sorted[i - 1].key));
    if (i + 1 < sorted.length) shared = Math.max(shared, commonPrefixLen(key, sorted[i + 1].key));
    out.set(id, id.slice(0, Math.max(SHORT_ID_LEN, shared + 1)));
  });
  return out;
}

/**
 * 目标列表的筛选(list 已按最近活动倒序)。exclude 总是生效;给了 ids 时只留这些(不存在的跳过、重复的只留一次),
 * query 与 limit 不起作用;否则按 query 对标题或目录名做不分大小写的子串过滤,再取前 limit 个。id 比较不分大小写。
 */
export function selectXsSessions(list, { query = '', limit = 30, exclude = null, ids = null } = {}) {
  const ex = exclude ? exclude.toLowerCase() : null;
  let out = ex ? list.filter((s) => s.sessionId.toLowerCase() !== ex) : list;
  if (ids) {
    const want = new Set(ids.map((id) => id.toLowerCase()));
    return out.filter((s) => want.has(s.sessionId.toLowerCase()));
  }
  const q = query.toLowerCase();
  if (q) out = out.filter((s) => s.title.toLowerCase().includes(q) || s.project.toLowerCase().includes(q));
  return out.slice(0, limit);
}

const candidateOf = ({ sessionId, shortId, title, project }) => ({ sessionId, shortId, title, project });

/**
 * 把一个目标写法解析成会话。按顺序:会话 id 或其前缀(≥8 位、不分大小写,能唯一确定才算)→ 标题(去首尾空白后逐字相等)。
 * 返回 { ok:true, session } | { ok:false, reason:'ambiguous', candidates } | { ok:false, reason:'not-found' }。
 * 重名(同一标题命中多个)或前缀命中多个 → ambiguous,不替调用方挑,candidates 每项带短 id 与目录名,让它改用短 id;
 * 改名后旧标题、或根本没有的写法 → not-found(让调用方重新列一次)。
 */
export function resolveTarget(spec, sessions) {
  const want = typeof spec === 'string' ? spec.trim() : '';
  const list = Array.isArray(sessions) ? sessions : [];
  if (!want) return { ok: false, reason: 'not-found' };
  if (/^[0-9a-f-]{8,36}$/i.test(want)) {
    const key = want.toLowerCase();
    const hits = list.filter((s) => s.sessionId.toLowerCase().startsWith(key));
    const exact = hits.filter((s) => s.sessionId.toLowerCase() === key);
    if (hits.length === 1 || exact.length === 1) return { ok: true, session: exact[0] || hits[0] };
    if (hits.length > 1) return { ok: false, reason: 'ambiguous', candidates: hits.map(candidateOf) };
  }
  const byTitle = list.filter((s) => s.title.trim() === want);
  if (byTitle.length === 1) return { ok: true, session: byTitle[0] };
  if (byTitle.length > 1) return { ok: false, reason: 'ambiguous', candidates: byTitle.map(candidateOf) };
  return { ok: false, reason: 'not-found' };
}
