// r182:留存副本 —— 一轮回复没见到命令行的结束信号就结束了(用户停止、静默超时被结束、进程异常退出),
// 命令行可能来不及把已经显示出来的内容写进会话文件。这份内容不再混在窗格的消息列表里(那里的每一条清理
// 路径都会把它一起清掉),单独放在这张按会话存的表里;渲染时按「本轮历史」叠加到历史段上。
//
// 只在三种情况下清:本轮历史已经把它每一块都包含了(渲染算出 covered 后由调用方删);回滚 / 编辑重发
// (dropRetained,同时记墓碑);会话被清空(dropRetained)。表在内存里,刷新页面后不在(已知局限)。
//
// 纯模块,不依赖 React。表的读取对同一组键、同一个版本返回同一个引用(空时返回同一个空数组常量),
// 叠加函数在没有改动时返回传入的原列表引用 —— 两者都是为了不打穿渲染层的记忆化。

export const EMPTY_RETAINED = Object.freeze([]);

const MAX_PER_KEY = 20;   // 每个会话最多留最近 20 条
const MAX_KEYS = 8;       // 最多 8 个会话(与 r118 的用户气泡暂存一致)
const MAX_TOMBSTONES = 32;

const table = new Map();       // key → entry[](冻结数组;变化时整体换新引用)
const tombstones = new Map();  // key → 毫秒时刻:此刻之前开始的回合,之后到的条目一律拒收
const listeners = new Set();
let version = 0;
const listCache = new Map();   // 组合键 → { version, list }

function notify() {
  version += 1;
  listCache.clear();
  for (const fn of [...listeners]) { try { fn(); } catch { /* 订阅方自己的错不影响表 */ } }
}

export function retainedVersion() { return version; }

export function subscribeRetained(fn) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// 写表。返回是否收下。墓碑:该会话在某一刻被回滚 / 清空过,起流时刻早于墓碑的条目是被那次回滚
// 打断的旧回合,迟到的写入一律拒收(编辑重发时 truncateUi 先执行,被中断那条流的 catch 后执行)。
export function addRetained(key, entry) {
  if (!key || !entry || !entry.id || !entry.turn) return false;
  const tomb = tombstones.get(key);
  if (tomb != null && !(Number(entry.roundStartTs) >= tomb)) return false;
  const prev = table.get(key) || EMPTY_RETAINED;
  const rest = prev.filter((e) => e.id !== entry.id);
  const next = Object.freeze([...rest, entry].slice(-MAX_PER_KEY));
  table.delete(key); // LRU:最近写的键排到最后
  table.set(key, next);
  while (table.size > MAX_KEYS) table.delete(table.keys().next().value);
  notify();
  return true;
}

// 只读,不取走。
export function listRetained(key) {
  if (!key) return EMPTY_RETAINED;
  return table.get(key) || EMPTY_RETAINED;
}

// 一个窗格可能同时对应两个键(会话队列键与真实会话编号),合并读取;同一组键同一个版本返回同一个引用。
export function listRetainedFor(keys) {
  const uniq = [...new Set((keys || []).filter(Boolean).map(String))];
  if (!uniq.length) return EMPTY_RETAINED;
  const ck = uniq.join('\u0001');
  const hit = listCache.get(ck);
  if (hit && hit.version === version) return hit.list;
  const seen = new Set();
  const out = [];
  for (const k of uniq) {
    for (const e of (table.get(k) || EMPTY_RETAINED)) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(e);
    }
  }
  out.sort((a, b) => (Number(a.stopTs) || 0) - (Number(b.stopTs) || 0));
  const list = out.length ? Object.freeze(out) : EMPTY_RETAINED;
  listCache.set(ck, { version, list });
  return list;
}

export function removeRetained(key, ids) {
  const cur = key ? table.get(key) : null;
  if (!cur) return false;
  const drop = new Set(Array.isArray(ids) ? ids : [ids]);
  const next = cur.filter((e) => !drop.has(e.id));
  if (next.length === cur.length) return false;
  if (next.length) table.set(key, Object.freeze(next));
  else table.delete(key);
  notify();
  return true;
}

// 草稿换成正式会话编号:条目随同改键。幂等(第二次调用时旧键下已没有条目,什么都不做)。
export function migrateRetained(from, to) {
  if (!from || !to || from === to) return false;
  const tomb = tombstones.get(from);
  if (tomb != null) {
    tombstones.set(to, Math.max(tombstones.get(to) || 0, tomb));
    tombstones.delete(from);
  }
  const cur = table.get(from);
  if (!cur || !cur.length) return false;
  table.delete(from);
  const target = table.get(to) || EMPTY_RETAINED;
  const ids = new Set(target.map((e) => e.id));
  const moved = cur.filter((e) => !ids.has(e.id)).map((e) => ({ ...e, ownerKey: to }));
  table.set(to, Object.freeze([...target, ...moved].slice(-MAX_PER_KEY)));
  notify();
  return true;
}

// 回滚 / 编辑重发 / 清空会话:整表删,并记墓碑。
export function dropRetained(key, at = Date.now()) {
  if (!key) return false;
  tombstones.delete(key);
  tombstones.set(key, Math.max(Number(at) || Date.now(), 0));
  while (tombstones.size > MAX_TOMBSTONES) tombstones.delete(tombstones.keys().next().value);
  if (!table.has(key)) return false;
  table.delete(key);
  notify();
  return true;
}

// 只给测试用:清空模块状态。
export function __resetRetainedForTest() {
  table.clear();
  tombstones.clear();
  listCache.clear();
  version += 1;
}

// ── 留存范围(唯一定义)──────────────────────────────────────────────────────
// 判据:页面有没有见到命令行给这一轮的顶层结束事件(result,不论成功还是报错)。
// 见到了 → 命令行已正常收尾、整轮已写盘 → 不留存(null),走原来的路径。
// 没见到就结束了 → 留存:用户停止 'stop'、静默超时被结束 'stall'、进程退出 / 被后端结束 'exit'。
// 「回合其实还在跑,只是本端流断了」(切走 / 转后台、传输掉线、被别的窗格接管、游标过旧、网络错、
// 让位给重接)不留存。
// 'exit' 只认从回合开头就接着的流(非重接):重接时缓冲可能溢出、看不全事件,确认不了「没有结束事件」,
// 退回原来的推送。
export function retainKindOf(flags = {}) {
  const f = flags || {};
  if (f.sawTopResult) return null;
  if (f.yielded || f.sawGap || f.sawTakeover || f.networkDrop) return null;
  if (f.aborted) return f.killed ? 'stop' : null;
  if (f.stallEnded) return 'stall';
  if ((f.sawDone || f.sawServerError) && !f.reattach) return 'exit';
  return null;
}

// 拼一条表条目。turn 是要画出来的那条回合(uuid 以 chat- 开头,压缩 / 重做 / 回滚锚点照旧拦它)。
export function makeRetainedEntry({ kind, ownerKey, turn, srcUuids, roundStartTs, stopTs, prompt }) {
  return {
    id: turn.uuid,
    kind,
    ownerKey,
    turn,
    srcUuids: Array.isArray(srcUuids) ? srcUuids.map(String) : [],
    roundStartTs: Number(roundStartTs) || 0,
    stopTs: Number(stopTs) || Date.now(),
    prompt: prompt && typeof prompt.text === 'string'
      ? { text: prompt.text, sentTs: Number(prompt.sentTs) || 0, localUuid: prompt.localUuid || null }
      : null,
  };
}

// ── 认轮次与覆盖关系(纯函数)──────────────────────────────────────────────────

const tsOf = (m) => {
  const t = m?.timestamp ? Date.parse(m.timestamp) : NaN;
  return Number.isFinite(t) ? t : null;
};
const textOfUser = (m) => (Array.isArray(m?.text) ? m.text.join('') : (typeof m?.text === 'string' ? m.text : ''));
const isInterruptLine = (m) => /^\s*\[Request interrupted/.test(textOfUser(m));
// 一轮的提示词:用户条目,不是引导(回合中间插进来的)、不是打断标记。
const isPromptLike = (m) => m?.type === 'user' && !m.steered && !isInterruptLine(m);
const fp = (s) => String(s || '').replace(/\s+/g, '');

const joinParts = (v) => (Array.isArray(v) ? v.join('') : (typeof v === 'string' ? v : ''));
function partsOf(turn) {
  let text = joinParts(turn?.text);
  let thinking = joinParts(turn?.thinking);
  const blocks = Array.isArray(turn?.blocks) ? turn.blocks : [];
  if (!text) text = blocks.filter((b) => b?.type === 'text').map((b) => b.content || '').join('');
  if (!thinking) thinking = blocks.filter((b) => b?.type === 'thinking').map((b) => b.content || '').join('');
  const ids = new Set();
  for (const tc of (Array.isArray(turn?.toolCalls) ? turn.toolCalls : [])) if (tc?.id) ids.add(String(tc.id));
  for (const b of blocks) if (b?.type === 'tool_use' && b.toolCall?.id) ids.add(String(b.toolCall.id));
  return { text: fp(text), thinking: fp(thinking), ids };
}

// 本轮在历史里的范围:{ start, end, turnIdx };{ offscreen: true }(本轮不在这段列表里 —— 列表只是历史的
// 一段,只含更晚的轮次);null(历史里还认不出本轮,调用方放进本地段)。
// 上界 end:列表里第一条时间晚于停止时刻的提示词(打断标记、引导、早于停止时刻的条目都不算;停止时刻为 0
// 时不设上界)。列表可能已经含有停止之后才发生的更晚轮次,本轮只可能在 end 之前;结束边界也就是它。
// 认起点的顺序:记录编号 → 页面自己发出的提示词 → 时间。
export function locateRound(hist, entry) {
  const list = Array.isArray(hist) ? hist : EMPTY_RETAINED;
  if (!entry || !list.length) return null;
  const startTs = Number(entry.roundStartTs) || 0;
  const stopTs = Number(entry.stopTs) || 0;
  const firstLaterPrompt = (from) => {
    if (!stopTs) return list.length;
    for (let k = from; k < list.length; k++) {
      const m = list[k];
      if (!isPromptLike(m)) continue;
      const t = tsOf(m);
      if (t != null && t > stopTs) return k;
    }
    return list.length;
  };
  let end = firstLaterPrompt(0);
  let start = -1;
  // 1. 编号锚定:从末尾往前找第一个编号在本流见过的回合,再往前并入时间不早于起流时刻的条目,
  //    碰到更早的条目或本轮提示词就停。
  const src = new Set((entry.srcUuids || []).map(String));
  if (src.size) {
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (m?.type === 'turn' && m.uuid && src.has(String(m.uuid))) {
        let j = i - 1;
        while (j >= 0) {
          const t = tsOf(list[j]);
          if (t == null || t < startTs || isPromptLike(list[j])) break;
          j -= 1;
        }
        start = j + 1;
        break;
      }
    }
  }
  // 2. 提示词:全文相等且时间不早于发送时刻;碰到早于发送时刻的用户条目就停(不取上一轮)。
  //    时间晚于停止时刻的用户条目跳过(连发两条相同提示词时,不认到下一轮那条上)。
  if (start === -1 && entry.prompt && entry.prompt.text) {
    const want = entry.prompt.text.trim();
    const sentTs = Number(entry.prompt.sentTs) || 0;
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (m?.type !== 'user') continue;
      const t = tsOf(m);
      if (stopTs && t != null && t > stopTs) continue;
      if (t != null && t < sentTs) break;
      if (isPromptLike(m) && textOfUser(m).trim() === want) { start = i + 1; break; }
    }
  }
  // 3. 时间(提示词对不上全文时——例如带附件——也走这一步):只看上界之前。firstIn = 第一条时间不早于
  //    起流时刻的条目(时间为空的跳过),hasEarlier = 有没有早于起流时刻的条目。
  //    - 有 firstIn:它不晚于停止时刻,或前面有更早的历史(紧跟着的晚于停止时刻的非提示词条目是本轮被打断后
  //      才写盘的半截)→ 起点在它这里(它是提示词则在它之后);否则上界之前全是更晚的条目 → 不在这段列表里。
  //    - 没有 firstIn、有更早的历史:后面有更晚的提示词 → 本轮在这段里没有记录,位置在那条提示词之前;
  //      否则认不出(null,调用方放进本地段)。
  //    - 都没有:后面有更晚的提示词 → 不在这段列表里;否则 null。
  if (start === -1 && startTs) {
    let firstIn = -1;
    let hasEarlier = false;
    for (let i = 0; i < end; i++) {
      const t = tsOf(list[i]);
      if (t == null) continue;
      if (t < startTs) { hasEarlier = true; continue; }
      if (firstIn === -1) firstIn = i;
    }
    if (firstIn !== -1) {
      const tf = tsOf(list[firstIn]);
      if (!stopTs || tf <= stopTs || hasEarlier) start = isPromptLike(list[firstIn]) ? firstIn + 1 : firstIn;
      else return { offscreen: true };
    } else if (hasEarlier) {
      if (end < list.length) return { start: end, end, turnIdx: [] };
      return null;
    } else {
      if (end < list.length) return { offscreen: true };
      return null;
    }
  }
  if (start === -1) return null;
  // 编号锚定在时间乱序时可能越过上界:此时退回从起点往后找结束边界。
  if (start > end) end = firstLaterPrompt(start);
  const turnIdx = [];
  for (let k = start; k < end; k++) if (list[k]?.type === 'turn') turnIdx.push(k);
  return { start, end, turnIdx };
}

// 副本与本轮历史的关系:
//   covered —— 副本每一块都被本轮历史包含(不画,调用方删条目);
//   replace —— 本轮历史每一块都被副本包含(隐藏本轮历史回合,在第一个的位置整块画副本);
//   append  —— 本轮在历史里还没有回合(副本插在结束边界处);
//   split   —— 都不是(历史照画,副本只画没被包含的块,放在结束边界处);
//   unplaced —— 历史里还认不出本轮(由调用方放进本地段,紧跟页面自己的那条提示词气泡);
//   offscreen —— 本轮不在这段列表里(列表只含更晚的轮次):这次不画,条目留在表里等列表重新包含本轮。
// 不用长度容差:差一个字也不算包含。
export function relate(hist, entry) {
  const loc = locateRound(hist, entry);
  if (!loc) return { mode: 'unplaced' };
  if (loc.offscreen) return { mode: 'offscreen' };
  if (!loc.turnIdx.length) return { mode: 'append', ...loc, insertAt: loc.end };
  const h = { text: '', thinking: '', ids: new Set() };
  for (const i of loc.turnIdx) {
    const p = partsOf(hist[i]);
    h.text += p.text; h.thinking += p.thinking;
    for (const id of p.ids) h.ids.add(id);
  }
  const e = partsOf(entry.turn);
  const entryInHist = h.text.includes(e.text) && h.thinking.includes(e.thinking) && [...e.ids].every((id) => h.ids.has(id));
  if (entryInHist) return { mode: 'covered', ...loc };
  const histInEntry = e.text.includes(h.text) && e.thinking.includes(h.thinking) && [...h.ids].every((id) => e.ids.has(id));
  if (histInEntry) return { mode: 'replace', ...loc, insertAt: loc.turnIdx[0] };
  return { mode: 'split', ...loc, insertAt: loc.end, rest: restOf(entry.turn, h) };
}

// split 时副本只画没被本轮历史包含的块。
function restOf(turn, h) {
  const blocks = (Array.isArray(turn?.blocks) ? turn.blocks : []).filter((b) => {
    if (b?.type === 'text') return !h.text.includes(fp(b.content));
    if (b?.type === 'thinking') return !h.thinking.includes(fp(b.content));
    if (b?.type === 'tool_use') return !(b.toolCall?.id && h.ids.has(String(b.toolCall.id)));
    return true;
  });
  const text = joinParts(turn?.text);
  const thinking = joinParts(turn?.thinking);
  return {
    ...turn,
    uuid: turn.uuid + '-rest',
    blocks,
    text: text && !h.text.includes(fp(text)) ? [text] : [],
    thinking: thinking && !h.thinking.includes(fp(thinking)) ? [thinking] : [],
    toolCalls: (Array.isArray(turn?.toolCalls) ? turn.toolCalls : []).filter((tc) => !(tc?.id && h.ids.has(String(tc.id)))),
  };
}

// 本地段里找页面自己发出的那条提示词气泡(先按本地编号,再按全文)。
function findLocalPrompt(local, entry) {
  if (!entry?.prompt || !Array.isArray(local)) return -1;
  if (entry.prompt.localUuid) {
    const i = local.findIndex((m) => m?.uuid === entry.prompt.localUuid);
    if (i !== -1) return i;
  }
  const want = String(entry.prompt.text || '').trim();
  if (!want) return -1;
  for (let i = local.length - 1; i >= 0; i--) {
    const m = local[i];
    if (m?.type === 'user' && textOfUser(m).trim() === want) return i;
  }
  return -1;
}

function spliceInserts(list, inserts, hidden) {
  const out = [];
  for (let i = 0; i <= list.length; i++) {
    const add = inserts.get(i);
    if (add) out.push(...add);
    if (i < list.length && !hidden.has(i)) out.push(list[i]);
  }
  return out;
}

// 把表里的条目叠加到历史段(histList)与本地段(localList)上。
// 返回 { list, local, coveredIds };没有改动的一段返回传入的原引用。
// offscreen 的条目跳过:不画、不进 coveredIds、不放本地段。
export function applyRetained(histList, entries, localList) {
  if (!entries || !entries.length) return { list: histList, local: localList, coveredIds: EMPTY_RETAINED };
  const hist = Array.isArray(histList) ? histList : EMPTY_RETAINED;
  const local = Array.isArray(localList) ? localList : EMPTY_RETAINED;
  const histInserts = new Map();
  const localInserts = new Map();
  const hidden = new Set();
  const coveredIds = [];
  const put = (map, at, item) => { const arr = map.get(at); if (arr) arr.push(item); else map.set(at, [item]); };
  for (const entry of entries) {
    if (!entry?.turn) continue;
    const rel = relate(hist, entry);
    if (rel.mode === 'offscreen') continue;
    if (rel.mode === 'covered'){ coveredIds.push(entry.id); continue; }
    if (rel.mode === 'unplaced') {
      const li = findLocalPrompt(local, entry);
      if (li !== -1) put(localInserts, li + 1, entry.turn);
      else put(histInserts, hist.length, entry.turn);
      continue;
    }
    if (rel.mode === 'replace') for (const i of rel.turnIdx) hidden.add(i);
    put(histInserts, rel.insertAt, rel.mode === 'split' ? rel.rest : entry.turn);
  }
  const list = (histInserts.size || hidden.size) ? spliceInserts(hist, histInserts, hidden) : histList;
  const nextLocal = localInserts.size ? spliceInserts(local, localInserts, new Set()) : localList;
  return { list, local: nextLocal, coveredIds: coveredIds.length ? coveredIds : EMPTY_RETAINED };
}
