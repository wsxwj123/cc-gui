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
