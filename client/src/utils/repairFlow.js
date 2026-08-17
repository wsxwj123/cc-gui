// r11-⑤:官方兼容体检与清理的纯函数层(三态判定 + repairHint 持久化 LRU)。
// UI(App.jsx 的 RepairCompatModal / 错误行动卡)只消费这里的输出;
// 单测 tests/unit/check-repair-flow.mjs 钉住三态分支与 LRU 行为。

export const REPAIR_HINT_LS_KEY = 'cgui-repair-hints';
export const REPAIR_HINT_CAP = 20;

/**
 * 清理(POST)响应 → 显式三态。绝不静默:每个分支都有用户可读文案。
 *  - 409 会话运行中 → kind 'running'(明确提示"先停止再清理",此前该分支被吞是⑤主诉);
 *  - 200 changed    → kind 'cleaned'(报告数字 + 提示重发);
 *  - 200 !changed   → kind 'clean'(历史已干净,原文件未改动);
 *  - 其余           → kind 'error'。
 */
export function classifyRepairOutcome(status, body) {
  if (status === 409) {
    return { kind: 'running', text: '会话正在运行，请先停止当前回合再清理。' };
  }
  if (status === 200 && body && typeof body === 'object') {
    if (body.changed) {
      const r = body.report || {};
      return {
        kind: 'cleaned',
        report: r,
        text: `已清理并备份原文件（空 text ${r.emptyText || 0} 处 / 空 thinking ${r.emptyThinking || 0} 处 / 删除空行 ${r.droppedLines || 0} 行）。请重发一次消息继续。`,
      };
    }
    return { kind: 'clean', text: '历史已干净，未发现需要清理的空内容块，原文件未改动。' };
  }
  return { kind: 'error', text: `清理失败：${body?.error || `HTTP ${status}`}` };
}

/** 体检(GET dry-run)响应 → 'found'(有待清理项) | 'clean' | 'error'。 */
export function classifyCheckOutcome(status, body) {
  if (status === 200 && body && typeof body === 'object' && body.report) {
    return body.wouldChange
      ? { kind: 'found', report: body.report }
      : { kind: 'clean', report: body.report };
  }
  return { kind: 'error', text: `体检失败：${body?.error || `HTTP ${status}`}` };
}

/**
 * repairHint LRU reducer(纯函数)。map 形态 { [sessionId]: { report, at } }。
 * 超出 cap 时按 at 最旧淘汰;同 id 更新即触新(at 刷新)。
 */
export function upsertRepairHint(map, sessionId, report, cap = REPAIR_HINT_CAP) {
  if (!sessionId || !report) return map || {};
  const next = { ...(map || {}), [sessionId]: { report, at: Date.now() } };
  const ids = Object.keys(next);
  if (ids.length > cap) {
    ids.sort((a, b) => (next[a]?.at || 0) - (next[b]?.at || 0));
    for (const id of ids.slice(0, ids.length - cap)) delete next[id];
  }
  return next;
}

export function removeRepairHint(map, sessionId) {
  if (!map || !(sessionId in map)) return map || {};
  const next = { ...map };
  delete next[sessionId];
  return next;
}

/** localStorage 读写(刷新后错误行仍可唤出统计;⑤主诉"提示不落盘刷新即丢")。 */
export function loadRepairHints() {
  if (typeof localStorage === 'undefined') return {};
  try {
    const v = JSON.parse(localStorage.getItem(REPAIR_HINT_LS_KEY) || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

export function persistRepairHints(map) {
  try { localStorage.setItem(REPAIR_HINT_LS_KEY, JSON.stringify(map || {})); } catch {}
}
