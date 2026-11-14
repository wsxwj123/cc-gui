// r186:页面重新接上一条正在跑的回合、内容由「历史回合」画的那种状态(App 的 reattachStream 为真)时,
// 找出「正在跑的那一轮」在历史里的那个回合,让它最后一个工作组的头行承载实时状态行
// (与正常对话里流式气泡的承载同款,判定仍走 isLiveLineHostedByGroup)。
// 认不准时一律返回 null(退回现状:页面最下面一行独立状态行),绝不把实时状态挂到更早的回合上。
// 归属核对分两种:流里已经见过工具调用 id → 回合至少要含其中一个;流里还没见过 → 回合里必须还有
// 没返回的工具调用(已经正常结束的回合不会留下没返回的工具调用;例如后台任务完成后自动接上续跑、
// 历史还没刷新时,列表末尾是已结束的上一轮,不能认成正在跑的那一轮)。
import { isLiveLineHostedByGroup } from './liveStatus.js';

// 一轮的起点:用户消息、后台任务通知、跨会话消息;压缩分隔线之后也不可能还是上一轮的助手内容。
const ROUND_START_TYPES = new Set(['user', 'task-notice', 'peer-message', 'compact']);

function turnToolIds(turn) {
  const ids = new Set();
  for (const b of Array.isArray(turn?.blocks) ? turn.blocks : []) {
    if (b?.type === 'tool_use' && b.toolCall?.id) ids.add(b.toolCall.id);
  }
  for (const tc of Array.isArray(turn?.toolCalls) ? turn.toolCalls : []) {
    if (tc?.id) ids.add(tc.id);
  }
  return ids;
}

// 回合 blocks 里还有没返回的工具调用(口径同 liveStatus.js 的 liveLabelFromBlocks:toolCall 没有 result)
function hasPendingToolCall(turn) {
  for (const b of Array.isArray(turn?.blocks) ? turn.blocks : []) {
    if (b?.type === 'tool_use' && b.toolCall && !b.toolCall.result) return true;
  }
  return false;
}

/**
 * @param {Array<object>} entries 页面上按显示顺序排好的条目(历史 + 本地),每条有 type / uuid
 * @param {{streamToolIds?: string[], stopping?: boolean, compacting?: boolean, chatMode?: boolean}} o
 *   streamToolIds:重新接上的流里已经见过的工具调用 id。
 *     有:回合至少要含其中一个才算这条流的那一轮;
 *     没有:回合里必须还有没返回的工具调用才算(已正常结束的回合不会留下没返回的工具调用),否则 null
 * @returns {string|null} 承载实时状态行的历史回合 uuid;null = 不承载
 */
export function pickReattachHostTurn(entries, { streamToolIds = [], stopping = false, compacting = false, chatMode = false } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  // ① 最后一个助手回合;它之后若出现了一轮的起点 = 这一轮还没有助手内容写进会话文件
  let at = -1;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const type = list[i]?.type;
    if (type === 'turn') { at = i; break; }
    if (ROUND_START_TYPES.has(type)) return null;
  }
  if (at < 0) return null;
  const turn = list[at];
  if (!turn?.uuid || turn.interrupted) return null;
  // ② 它前面必须看得见这一轮的起点(历史被裁到只剩助手内容时认不出归属)
  let hasStart = false;
  for (let i = at - 1; i >= 0; i -= 1) {
    if (ROUND_START_TYPES.has(list[i]?.type)) { hasStart = true; break; }
  }
  if (!hasStart) return null;
  // ③ 归属核对。流里见过工具调用时,这个回合至少要含其中一个(否则它不是这条流的那一轮,或者还没写到)。
  //   流里还没见过时,这个回合必须还有没返回的工具调用:已经正常结束的回合不会留下没返回的工具调用,
  //   正在跑的回合(例如刷新页面后重开、某个工具还挂着)才会有。后台任务完成后自动接上续跑时,
  //   历史还没刷新、列表末尾是已结束的上一轮,靠这一条才不会把实时状态挂到上一轮去。
  const ids = (Array.isArray(streamToolIds) ? streamToolIds : []).filter(Boolean);
  if (ids.length > 0) {
    const own = turnToolIds(turn);
    if (!ids.some((id) => own.has(id))) return null;
  } else if (!hasPendingToolCall(turn)) {
    return null;
  }
  // ④ 最后一段是工具组、阶段是工具或思考:与正常对话同一个判定
  if (!isLiveLineHostedByGroup({ blocks: turn.blocks || [], stopping, compacting, chatMode })) return null;
  return turn.uuid;
}
