// r191「重接尾巴」—— 纯函数(无 React / 无 store 依赖,单测直调)。
//
// 没有直播快照的重接(刷新页面 / 后台续跑后接上正在跑的回合)一律由历史单一来源画,流不画自己的气泡。
// 这一档里,本流【完整收到】的顶层正文块、思考块(见过它的 content_block_start,或来自整条快照型
// assistant 事件)在历史里还没有它的时候,画在对话列表最后,当作同一轮回复接着往下写。
//
// 交接只按「历史里已经有这条记录」判断,不按时间猜:
//   · 块写完后到达的顶层 assistant 事件的 uuid = 写进会话文件那条记录的 uuid,记到最早一个已写完、
//     还没有编号的块上(tailAssignUuid)。历史回合只带第一条记录的 uuid,所以编号命中任一回合 uuid,
//     或这一块的正文指纹(去空白)与本轮历史里同类块相同,都算「历史里已经有了」。
//   · 记不上编号的块:写完、并且此后历史刷新应用过一次(列表引用变了),就不再画。
//   · 本流收尾后:历史相对收尾时刻确实变了(末条签名不同),或回合是干净结束的并且收尾后历史应用过,
//     或收尾的重读已经结束(settled),整条尾巴退场。
// 退场在渲染期计算(visibleTailBlocks),历史换上新内容与尾巴消失在同一帧。

const fpOf = (s) => String(s || '').replace(/\s+/g, '');

function blockFp(type, content) {
  const fp = fpOf(content);
  return fp ? `${type}:${fp}` : '';
}

const isPromptEntry = (m) => m?.type === 'user' && !m.steered
  && !/^\s*\[Request interrupted/.test(Array.isArray(m.text) ? m.text.join('') : String(m.text || ''));

/** 新的尾巴状态。owner = 本流归属的会话键(闭包里的值,不读当前选中的会话)。 */
export function makeReattachTail(owner) {
  return { owner, meta: {}, ended: false, blocks: null, endSig: null, endMsgs: null, endClean: false, settled: false };
}

/** 顶层块写完(content_block_stop)。histRef = 此刻的历史列表引用。 */
export function tailMarkBlockDone(tail, orderIdx, histRef) {
  if (!tail || orderIdx == null || tail.ended) return tail;
  const prev = tail.meta[orderIdx];
  if (prev?.done) return tail;
  return { ...tail, meta: { ...tail.meta, [orderIdx]: { ...(prev || {}), done: true, doneMsgs: histRef } } };
}

/** 顶层 assistant 事件的 uuid:记到最早一个已写完、还没有编号的块上;没有这样的块则不变。 */
export function tailAssignUuid(tail, uuid) {
  if (!tail || !uuid || tail.ended) return tail;
  const idxs = Object.keys(tail.meta).map(Number).sort((a, b) => a - b);
  for (const i of idxs) {
    const m = tail.meta[i];
    if (m?.done && !m.uuid) return { ...tail, meta: { ...tail.meta, [i]: { ...m, uuid: String(uuid) } } };
  }
  return tail;
}

/** 整条快照型 assistant 事件补进来的块 [from, to):一到就是写完的,编号就是这条事件的 uuid。 */
export function tailMarkSnapshot(tail, from, to, uuid, histRef) {
  if (!tail || tail.ended || !(to > from)) return tail;
  const meta = { ...tail.meta };
  for (let i = from; i < to; i++) meta[i] = { done: true, doneMsgs: histRef, ...(uuid ? { uuid: String(uuid) } : {}) };
  return { ...tail, meta };
}

/** 历史列表末条的签名(只用于「收尾之后历史变没变」)。 */
export function histTailSig(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const m = list[list.length - 1];
  if (!m) return '';
  const blocks = Array.isArray(m.blocks) ? m.blocks : [];
  const text = Array.isArray(m.text) ? m.text.join('') : String(m.text || '');
  const blockLen = blocks.reduce((n, b) => n + (typeof b?.content === 'string' ? b.content.length : 0), 0);
  return `${list.length}|${m.type || ''}|${m.uuid || ''}|${blocks.length}|${blockLen}|${text.length}`;
}

/** 本流收尾:定格块内容(收尾会清掉直播缓冲),记下收尾时刻的历史签名与引用。 */
export function tailMarkEnded(tail, blocks, histRef, endClean) {
  if (!tail || tail.ended) return tail;
  return { ...tail, ended: true, blocks: Array.isArray(blocks) ? blocks.slice() : [], endSig: histTailSig(histRef), endMsgs: histRef, endClean: !!endClean };
}

/** 收尾的重读结束(读到了变化或到了次数上限)。 */
export function tailMarkSettled(tail) {
  if (!tail || !tail.ended || tail.settled) return tail;
  return { ...tail, settled: true };
}

/** 历史索引:全部回合的 uuid;本轮(最后一条提示词之后)各正文 / 思考块的指纹。 */
export function tailHistoryIndex(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const uuids = new Set();
  const fps = new Set();
  let roundStart = 0;
  for (let i = list.length - 1; i >= 0; i--) { if (isPromptEntry(list[i])) { roundStart = i + 1; break; } }
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (m?.type !== 'turn') continue;
    if (m.uuid) uuids.add(String(m.uuid));
    if (i < roundStart) continue;
    for (const b of (Array.isArray(m.blocks) ? m.blocks : [])) {
      if (b?.type === 'text' || b?.type === 'thinking') { const k = blockFp(b.type, b.content); if (k) fps.add(k); }
    }
  }
  return { uuids, fps };
}

/**
 * 此刻要画的尾巴块(按到达顺序)。blocks = 直播缓冲(未收尾时)或定格的内容;messages = 本窗格的历史列表。
 * 返回 [{ orderIdx, type, content }];不画时返回空数组。
 */
export function visibleTailBlocks(tail, liveBlocks, messages) {
  if (!tail) return [];
  if (tail.ended) {
    if (tail.settled) return [];
    if (histTailSig(messages) !== tail.endSig) return [];
    if (tail.endClean && messages !== tail.endMsgs) return [];
  }
  const blocks = tail.ended ? (tail.blocks || []) : (Array.isArray(liveBlocks) ? liveBlocks : []);
  const idx = tailHistoryIndex(messages);
  const out = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!b || (b.type !== 'text' && b.type !== 'thinking') || !b.content || b.errorText) continue;
    const m = tail.meta[i];
    if (m?.uuid && idx.uuids.has(m.uuid)) continue;
    const k = blockFp(b.type, b.content);
    if (k && idx.fps.has(k)) continue;
    if (m?.done && !m.uuid && messages !== m.doneMsgs) continue;
    out.push({ orderIdx: i, type: b.type, content: b.content });
  }
  return out;
}
