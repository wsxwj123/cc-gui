// r141「同一条回复被渲染两遍」的渲染期身份闸门 —— 纯函数(无 React / 无 store 依赖,单测直调)。
//
// 现场:流收尾时客户端会先推一条【本地定稿副本】(App.jsx 的 `chat-assistant-<ms>`),随后
// jsonl 对账回来,同一个回合又以历史那一条画出来 ⇒ 同一段回复在屏上出现两次(jsonl 里只有
// 一条 ⇒ 纯客户端双画)。负责清掉副本的三条路径分别被 break(切走/被新流抢走 turn token)、
// `m.type === 'turn'` 的无条件保留、以及"本会话正在流式"的守卫挡掉;最后兜底的弱去重键
// (`类型|正文前 80 字`)又因为两侧拼接方式不同(本地块间 `\n` 拼,历史逐条 push 后 `''` join)
// 结构性落空。
//
// 本合同(方案 .devflow/PLAN-r141-duprender.md §3.0)给「本地副本 vs 已渲染历史」一个三层身份:
//   ① uuid 精确对账:local.srcUuids ∩ 历史 turn 的 uuid ≠ ∅(不设时间条件;真 CLI 实测
//      流侧 assistant 事件 uuid == jsonl 记录 uuid)。
//   ② 正文指纹:blocks 里 text 块【按序直接拼接】再【去掉全部空白】,两侧相同且非空
//      —— 专治 `\n` 拼 vs `''` join 的差异,以及空白/换行规整化、正文只在 blocks 里的空 text。
//   ③ 覆盖下限(带时间窗):历史里存在 ts ∈ [roundStartTs, local.timestamp + ε] 的 turn,
//      其指纹非空且【不短于】本地那份(治上游把文本改写/改长的情形;上界防"同一会话更晚、
//      更长的一轮已落盘而本轮孪生还没落盘"时把唯一可见的副本藏掉 = 空窗)。
//
// 三层【只作用于 type === 'turn'】:user 走 App.jsx makePersistedIndex 的强口径(R37 成果,
// 全文 + 落盘时间),btw / compact / denial 等一律不碰 —— 交给本模块的一律返回 false。
//
// 消费点两处,共用同一口径与同一个索引构造器:
//   · App.jsx `renderChat`(渲染闸门,A5);
//   · App.jsx `makePersistedIndex`(既有三条清场路径的去重键,A2)。

/** 判据③ 的时间窗上界余量(ms):副本在流收尾时才推,历史记录的 ts 是消息产生时刻。 */
export const TAKEOVER_TS_EPS_MS = 2000;

/** 正文(历史口径):text 数组直接 join('')(与 App.jsx 的 msgTextOf 同口径)。 */
function flatTextOf(m) {
  if (Array.isArray(m?.text)) return m.text.join('');
  return typeof m?.text === 'string' ? m.text : '';
}

/**
 * blocks 里的正文:按序把 `type === 'text'` 的 content 直接拼接(**不插分隔符**)。
 * 正因为不插分隔符,它才与历史侧(`session-reader` 逐条 push + `msgTextOf` 的 `''` join)同形。
 * 没有可用 blocks(老数据 / 只有 thinking、tool 块)时退化到 text 数组。
 */
export function blocksText(m) {
  const blocks = m?.blocks;
  if (Array.isArray(blocks) && blocks.length) {
    let out = '';
    for (const b of blocks) {
      if (b && b.type === 'text' && typeof b.content === 'string') out += b.content;
    }
    if (out) return out;
  }
  return flatTextOf(m);
}

/** 判据② 的指纹:去掉全部空白(换行/空格/制表/全角空格差异一律抹平)。空正文返回 `''`。 */
export function turnFingerprint(m) {
  return blocksText(m).replace(/\s+/g, '');
}

/**
 * 从【已渲染历史】建身份索引。只收 `type === 'turn'`。
 * A5 传 `finalizedMessages`(已过 streamHistCutoff 截断与半成品收口;**不得**换成上游的
 * `messages`,否则流式期的半成品 turn 会被当成孪生,把唯一可见的副本藏掉 = BF-1/R37 同类空窗);
 * A2 让 makePersistedIndex 复用同一口径(那里传的是已落盘的 persisted 列表)。
 */
export function makeTurnIdentityIndex(rendered) {
  const turnUuids = new Set();
  const fingerprints = new Set();
  const turns = [];                        // 判据③ 的候选:{ ts, len }
  for (const m of rendered || []) {
    if (m?.type !== 'turn') continue;
    if (m.uuid) turnUuids.add(String(m.uuid));
    const fp = turnFingerprint(m);
    if (!fp) continue;
    fingerprints.add(fp);
    const ts = Date.parse(m?.timestamp);
    if (Number.isFinite(ts)) turns.push({ ts, len: fp.length });
  }
  return { turnUuids, fingerprints, turns };
}

/**
 * 这条本地条目是否已被【已渲染的历史】接管(= 不该再画)。三条判据命中任一即真。
 * 非 `type === 'turn'` 的条目恒 false(不动 user 强口径与 btw/compact 的既有语义)。
 */
export function localTurnTakenOver(local, idx) {
  if (!local || local.type !== 'turn' || !idx) return false;

  // ① uuid 精确对账。srcUuids 是本流收到过的 assistant 事件 uuid(可能为空数组 = 无数据)。
  const src = Array.isArray(local.srcUuids) ? local.srcUuids : null;
  if (src && src.length) {
    if (local.uuid && idx.turnUuids.has(String(local.uuid))) return true;
    for (const u of src) if (u && idx.turnUuids.has(String(u))) return true;
  }

  // ② 正文指纹(要求非空 —— 空正文不得两两相等)。
  const fp = turnFingerprint(local);
  if (!fp) return false;
  if (idx.fingerprints.has(fp)) return true;

  // ③ 覆盖下限 + 时间窗。roundStartTs 缺失(旧条目 / 非本流推出的条目)时不做这条 ——
  // 少了时间锚就没法把"更晚、更长的一轮"排除掉,那正是空窗的来源。
  const start = Number.isFinite(local.roundStartTs) ? local.roundStartTs : null;
  const localTs = Date.parse(local?.timestamp);
  if (start !== null && Number.isFinite(localTs)) {
    for (const t of idx.turns) {
      if (t.ts >= start && t.ts <= localTs + TAKEOVER_TS_EPS_MS && t.len >= fp.length) return true;
    }
  }
  return false;
}
