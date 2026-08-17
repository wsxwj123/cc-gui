export function contextCanonicalKey(sessionId, projectHash, cwd, model) {
  return JSON.stringify([sessionId || '', projectHash || '', cwd || '', model || '']);
}

const finiteNonNegative = (value) => Number.isFinite(value) && value >= 0;
const validLabel = (value) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 200;

export function isValidContextResponse(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || 'raw' in data) return false;
  if (data.source !== 'sdk' && data.source !== 'cli') return false;
  if (typeof data.sampledAt !== 'string' || !Number.isFinite(Date.parse(data.sampledAt))) return false;
  if (data.model !== null && (typeof data.model !== 'string' || !data.model.trim() || data.model.length > 256)) return false;
  if (!Number.isInteger(data.totalTokens) || data.totalTokens < 0) return false;
  if (!Number.isInteger(data.windowTokens) || data.windowTokens <= 0) return false;
  if (!finiteNonNegative(data.pct)) return false;
  if (!Array.isArray(data.categories) || !Array.isArray(data.mcpServers)) return false;
  if (!data.categories.every((item) => item && validLabel(item.name)
    && Number.isInteger(item.tokens) && item.tokens >= 0 && finiteNonNegative(item.pct))) return false;
  return data.mcpServers.every((item) => item && validLabel(item.server)
    && Number.isInteger(item.tokens) && item.tokens >= 0);
}

export function shouldReplaceContextCache(previous, next, requestEpoch) {
  if (!previous) return true;
  const previousTime = Date.parse(previous.sampledAt);
  const nextTime = Date.parse(next.sampledAt);
  if (nextTime !== previousTime) return nextTime > previousTime;
  return requestEpoch > (previous.requestEpoch || 0);
}

// ── r11-⑨:徽章弹层三级数据源 + 静默降级(产品原则:点开立刻显示组成,任何情况不弹报错)──

/** 三级即时回退:上次精确结果缓存 > 本地估算组成 > 全新会话骨架。 */
export function pickBreakdownTier({ cached, localTokens } = {}) {
  if (cached) return 'cached';
  return (localTokens || 0) > 0 ? 'local' : 'skeleton';
}

/**
 * 精确计算结果落地(静默降级核心):成功 → 无感原位替换;失败/超时 → **保持已显示
 * 的组成不动**,只标 exactUnavailable(弹层底部一行小字,不弹错误、不清数据、无红字)。
 */
export function applyExactResult(prevData, outcome) {
  if (outcome?.ok && outcome.data) return { data: outcome.data, exactUnavailable: false };
  return { data: prevData, exactUnavailable: true };
}

/** 「X 分钟前」标注(缓存精确结果的新鲜度)。非法时间返回空串。 */
export function relativeAgeLabel(sampledAt, now = Date.now()) {
  const t = Date.parse(sampledAt || '');
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

export function contextErrorMessage(code) {
  const messages = {
    'invalid-context-request': '上下文请求参数无效',
    'context-session-mismatch': '上下文请求与会话不匹配',
    'context-session-not-found': '找不到对应会话',
    'context-cwd-invalid': '会话工作目录无效',
    'context-cli-unavailable': '无法启动上下文计算',
    'context-output-invalid': '未获得有效的上下文统计',
    'context-sdk-timeout': '精确上下文计算超时，请稍后重试',
    'context-cli-timeout': '精确上下文计算超时，请稍后重试',
  };
  return messages[code] || '上下文计算失败';
}
