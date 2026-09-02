// `@` 上下文引用的共享纯函数(会话内 ChatInput 与首页 HomeState 同一份实现)。
// 零 React / 零 store / 零定时器(防抖属于 hooks/useAtRef.js):node 可直接 import 做单测。

/**
 * 光标前是否处于 `@词`(`@` 必须在行首或空白/换行之后,词内不含空白与 `@`)。
 * 斜杠命令优先:文本以 `/` 开头时一律不检测。
 */
export function detectAtQuery(value, caret) {
  const v = String(value ?? '');
  const c = Number.isInteger(caret) ? caret : v.length;
  if (v.startsWith('/')) return null;
  const m = v.slice(0, c).match(/(^|[\s\n])@([^\s@]*)$/);
  return m ? { query: m[2], start: c - m[2].length - 1 } : null;
}

/** 把 `@query` 区间替换成 `@insert `(保留前后文;插入自带一个尾空格)。 */
export function applyAtInsert(text, at, insert) {
  const cur = String(text ?? '');
  if (!at || !Number.isInteger(at.start)) return cur;
  const beforeAt = cur.slice(0, at.start);
  const afterQuery = cur.slice(at.start + 1 + String(at.query || '').length);
  return `${beforeAt}@${insert} ${afterQuery}`;
}

/** 层级浏览的上一级相对目录('a/b/c' → 'a/b';根目录 → '')。 */
export function parentDir(dir) {
  return String(dir || '').split('/').slice(0, -1).join('/');
}

/** 目录条目 → 面板条目;子目录里首行补「返回上级」。 */
export function mapDirEntries(entries, dir) {
  const items = (Array.isArray(entries) ? entries : []).map((e) => ({
    kind: e.isDir ? 'dir' : 'file',
    name: e.name,
    rel: dir ? `${dir}/${e.name}` : e.name,
  }));
  return dir ? [{ kind: 'up', name: '..', rel: '' }, ...items] : items;
}

/** 全局模糊搜索结果 → 面板条目(条目显示相对路径)。 */
export function mapSearchFiles(files) {
  return (Array.isArray(files) ? files : []).map((f) => ({ kind: 'file', name: f, rel: f }));
}

/**
 * 会话 tab 候选:排除归档与"当前会话",按首条提示词子串 / 会话 id 前缀过滤,最多 20 条。
 * query 整体小写化后再比,sessionId 不做变换(真实会话 id 是小写 uuid)。
 */
export function filterAtSessions(sessions, query, excludeSessionId) {
  const q = String(query || '').toLowerCase();
  return (Array.isArray(sessions) ? sessions : [])
    .filter((s) => s && s.sessionId !== excludeSessionId && !s.archived)
    .filter((s) => !q || (s.firstPrompt || '').toLowerCase().includes(q) || String(s.sessionId).startsWith(q))
    .slice(0, 20);
}

// 下面两个 GET 故意不检查 HTTP 状态码:服务端异常时按字段兜底成空数组,与改动前逐字
// 同行为(列表"空"而不是"永远不弹")。

/** 列当前层的目录条目(层级浏览)。 */
export async function fetchDirEntries(cwd, dir, { fetchImpl = fetch } = {}) {
  const dirAbs = dir ? `${cwd}/${dir}` : cwd;
  const r = await fetchImpl(`/api/files/list?path=${encodeURIComponent(dirAbs)}`);
  const d = await r.json();
  return mapDirEntries(d.entries, dir);
}

/** 项目内全局模糊搜索(后端 git ls-files / 递归 + 缓存)。 */
export async function searchProjectFiles(cwd, q, { fetchImpl = fetch } = {}) {
  const r = await fetchImpl(`/api/files/search?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(q)}`);
  const d = await r.json();
  return mapSearchFiles(d.files);
}

/** 把一个会话导出成精简 md,返回可直接 `@` 引用的绝对路径。失败抛错由调用方提示。 */
export async function createSessionRef(sessionId, projectHash, { fetchImpl = fetch } = {}) {
  const r = await fetchImpl('/api/session-ref', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, projectHash }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || '生成会话引用失败');
  return d.path;
}
