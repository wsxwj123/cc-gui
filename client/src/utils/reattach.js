// reattach(流式中切走再切回)的渲染口径 —— 纯函数,零 React/store 依赖。
//
// 背景(调研 RESEARCH-reattach-split):切走时客户端 abort 本端 SSE、进程照跑,切回时
// ① 先拉一次 jsonl 历史,② 再 attach 到老进程、服务端把断连期间的行(earlyLines)重放。
// 于是同一段内容被两个源同时画:历史卡 + 重放出来的流式气泡 = 一条回复被劈成两块;
// 重放的首批 content_block_delta 又找不到 detach 前就被消费掉的 content_block_start,
// 整段被丢 → 流式气泡开头空着,一直挂 Connecting。
//
// 老的截断口径 { sinceTs: detachTs } 之所以拦不住,是因为 session-reader 的一条 turn =
// 一条用户 prompt 到下一条 prompt 之间的全部 assistant 记录,turn.timestamp 取该回合
// 【第一条】assistant 记录的时间 —— 流式中切走时它必然早于 detachTs,整个在跑的 turn
// (含离开期间新写的内容)照单全收。截断粒度(turn)和意图(记录)对不上,修不了。
//
// 结论:reattach 收敛到【一个源】—— 历史(jsonl)负责画,重放事件只当刷新触发器。
// 这也正是分屏不出问题的机制(那边全程只有本地流一个源在画)。

// 节流间隔:CLI 每条 assistant 记录落盘约 1-3s,取 1.5s 既跟得上又不打爆 /messages。
export const REATTACH_REFRESH_MS = 1500;

/**
 * 判断异步收尾是否仍属于当前回合。新回合在任何异步准备前同步递增 token，
 * 因此不依赖 pid 是否已经由 /api/chat 返回。
 */
export function isCurrentStreamTurn(currentToken, turnToken) {
  return currentToken === turnToken;
}

/**
 * 起流时的历史截断点。
 * @param {boolean} isReattach 本次是 reattach(接管已在跑的进程)还是正常发送
 * @param {number} now 起流时刻(正常发送用它当截断点)
 * @param {null | {sinceTs:number}} seededCutoff r68:命中直播快照时,快照里带的原始口径
 * @returns {null | { sinceTs: number, keepUser?: boolean }} null = 不截断,历史完整显示
 *
 * 正常发送:本回合所有条目(含用户消息回显)都晚于起流时刻,截掉它们、由流式气泡画。
 * reattach 无快照:不截断。在跑的那个 turn 本来就整条留在历史里(见上文 turn 粒度),显式
 * 承认这一点,并配合"reattach 不画流式气泡"收敛成单一渲染源。
 * reattach 有快照(r68 种回):沿用快照里的【原始起流时刻】—— 本回合所有磁盘记录都晚于
 * 它,历史零渲染、直播气泡独家画,与普通发送逐字同构。绝不改用 afterLastUser:⚡引导
 * 折叠会往本回合中间插 user 行,那个口径会把已产出的正文切没(App.jsx 记录过的事故)。
 */
export function resolveStreamHistCutoff(isReattach, now, seededCutoff = null) {
  if (!isReattach) return { sinceTs: now };
  return seededCutoff || null;
}

// ── r68 直播快照:切走时存,切回时"种回" ──────────────────────────────
// 修的是「流式中切走再切回,正文整段空窗几十秒(等落盘才一次性画出)」。切走时把本流
// 已经流出的内容原样存下,切回的 reattach 以它为起点、把服务端重放的后续 delta 续挂
// 上去 —— 于是切回瞬间正文完整可见且继续增长,与普通发送同构(不新增渲染分支)。
//
// 成立前提是服务端的接缝严合:detach 之后的行进 earlyLines、重连原样回放,一行不可能
// 既投递又缓冲(deliverLine 是 if/else)。实测 32 次采样 31 次严格相邻;0ms 突发流有
// 毫秒级窗口可能少 1 个 delta(几到几十字符),回合末按 jsonl 刷新自愈。
//
// 为什么存模块级 map 而不是组件 state:切会话的 effect 会把 chatMessages 整清,存那儿
// 等于没存(这正是今天 AbortError 分支明明打包过半截正文却救不回来的原因);分屏各
// 窗格是 SessionDetail 的独立实例,组件内的 state 也共用不到。
const streamSnapshots = new Map();
// 只留最近 N 个会话:快照体积≈正文字节数,长期使用不该无限涨。Map 保插入序 = 天然 LRU。
const MAX_SNAPSHOTS = 8;
// 单条上限:MB 级正文留内存不值当,超了就不存 —— 放弃种回、退回今天的行为,不出新错。
const MAX_SNAPSHOT_CHARS = 1_000_000;

/**
 * 存一份直播快照。调用方(handleSend 的 finally)负责判"该不该存",这里只管容量。
 * @returns {boolean} 是否真的存下(超限 = false,调用方无需处理,退化即可)
 */
export function putStreamSnapshot(sessionId, snap) {
  if (!sessionId || !snap) return false;
  if ((snap.text || '').length + (snap.thinking || '').length > MAX_SNAPSHOT_CHARS) return false;
  streamSnapshots.delete(sessionId);   // 先删再插,保证插入序 = 最近使用序
  streamSnapshots.set(sessionId, snap);
  while (streamSnapshots.size > MAX_SNAPSHOTS) streamSnapshots.delete(streamSnapshots.keys().next().value);
  return true;
}

/**
 * 取出快照并【立即删除】—— 用一次即弃。
 * 这条语义是分屏同 sid 两窗格互踢时的安全阀:第二个消费者拿不到同一份陈旧快照,
 * 最坏退回今天的行为(空窗),而不是种回一段中间缺失的正文(悄悄丢字更坏)。
 */
export function takeStreamSnapshot(sessionId) {
  if (!sessionId) return null;
  const snap = streamSnapshots.get(sessionId) || null;
  if (snap) streamSnapshots.delete(sessionId);
  return snap;
}

/**
 * 作废快照。两个调用点:
 *   ① WS 'turn-complete'(服务端 result 时无条件广播,不依赖有没有 SSE 在线)——
 *      回合真结束 ⇒ 历史已全量,再种回就是双份;
 *   ② 本流被别的窗格接管(detached/takeover)—— 此后的行归对方消费,我们手里的尾巴
 *      已经落后,留着会让下一次 attach 种回一段中间缺失的正文。
 */
export function dropStreamSnapshot(sessionId) {
  if (sessionId) streamSnapshots.delete(sessionId);
}

/**
 * reattach 期间是否该刷一次历史。用 SSE 事件当心跳做节流触发,不依赖 file watcher
 * —— 打包版的 jsonl watcher 是关掉的(server/index.js "file-watcher disabled for
 * packaged Tauri backend"),靠 watcher 的话历史卡在整个 reattach 期间不会增长。
 * @param {{isReattach:boolean, now:number, lastAt:number, force?:boolean, intervalMs?:number}} o
 * @returns {boolean}
 */
export function shouldRefreshHist({ isReattach, now, lastAt, force = false, intervalMs = REATTACH_REFRESH_MS }) {
  if (!isReattach) return false;   // 正常发送由流式气泡实时画,不需要也不该刷
  if (force) return true;          // 回合结束:立刻收尾刷一次,不等下一个节流窗
  return now - lastAt >= intervalMs;
}

/**
 * 「历史真的长出新内容了吗」的 O(1) 判据 —— 取本 pane 最后一条消息的签名。
 *
 * 为什么需要它:reattach 期间每 1.5s 刷一次历史,但刷到的多半和上次一样(实测相邻 jsonl
 * 记录间隔 p75=7.6s / p90=17.4s / max=445s,长单块回合几十秒不落盘是常态)。若按「刷新
 * 发生」记时间戳,界面会恒显"0 秒前",区分不出「在跑但没落盘」和「卡死」—— 那正是这行
 * 状态要回答的问题。所以只在签名变化时才认定"更新了"。
 *
 * 为什么这么取:session-reader 的一条 turn = 一条用户 prompt 到下一条之间的全部 assistant
 * 记录,CLI 每写一条记录就往当前 turn 追一个块 → blocks 长度必变;新回合则 uuid 变。
 * 整段 JSON.stringify 也能判,但长回合是几十上百 KB,每次刷新算一遍不值当。
 * @param {object|null|undefined} m 最后一条消息
 * @returns {string} 内容未变则恒等
 */
export function histSig(m) {
  if (!m) return '';
  const text = Array.isArray(m.text) ? m.text : [];
  return [
    m.uuid || '',
    Array.isArray(m.blocks) ? m.blocks.length : 0,
    Array.isArray(m.toolCalls) ? m.toolCalls.length : 0,
    text.length,
    String(text[text.length - 1] || '').length,
  ].join('|');
}

/**
 * attach 失败计数,**按 pid 记**。pid 变了就是另一个进程,旧账不算。
 * 修前的计数不但没按 pid 记,还指望 backgroundPid 轮询驱动重试 —— 轮询每次
 * setBackgroundPid(同一个 pid 字符串) 被 Object.is 短路,effect 根本不重跑,
 * 计数永远到不了上限,"三振出局"是死代码。现在重试由失败分支自己排定时器驱动。
 * @param {{pid:string, count:number}|null} prev 上一次的计数
 * @param {string} pid 本次 attach 的进程 id
 * @param {number} maxTries 上限,达到即 exhausted
 * @returns {{pid:string, count:number, exhausted:boolean}}
 */
export function nextAttachTry(prev, pid, maxTries = 3) {
  const count = (prev && prev.pid === pid ? prev.count : 0) + 1;
  return { pid, count, exhausted: count >= maxTries };
}

/**
 * reattach 闩锁(App.jsx 的 reattachedPidRef)的唯一决策。两个调用点共用:
 *   ① backgroundPid 轮询驱动的 auto-reattach effect —— streamEnd 传 null;
 *   ② reattach 流收尾 —— streamEnd 传 'done' | 'takeover' | 'dropped'。
 *
 * 为什么要有 ②(修「第二次复活起会话静止」):闩锁原本只有 ① 一个复位入口,而它要求
 * backgroundPid 这个 React state 发生一次「变成 null 且此刻没有本地流」的跳变。可轮询
 * 在 reattach 流还跑着的时候就已经把 state 写成 null 了(它的 !streamingRef 判据),这次
 * 跳变被「正在流,别清」那一支吃掉;等 reattach 流真结束时 state 早就是 null,再写 null
 * 被 Object.is 短路 → effect 不再运行 → 闩锁永远停在旧 pid。而 #26 会话常驻让整个会话
 * 共用同一个 pid,「一个 pid 只 reattach 一次」于是等于「一个会话只 reattach 一次」:
 * 服务端进程第二次复活时横幅挂着、没有流、也没有历史刷新,界面完全静止。补上「本次
 * reattach 已经正常收尾」这个真实复位信号即可。
 *
 * streamEnd 必须是三态,不能压成一个布尔:
 *   'done'     本回合真的结束(服务端 finalize 发的 done)→ 清闩,下一次复活能再接;
 *   'takeover' 服务端明说本连接被新 attach 接管(detached)→ 【不清】,一清就回连反踢,
 *              两个视图 1.5~3s 一轮互踢不停;
 *   'dropped'  传输被静默掐断(既无 done 也无 detached)→ 【不清】,这形态归 recoverAttach
 *              的 per-pid 三振重试管,这里插手会打穿三振保护。
 *
 * @param {{guard?: string|null, backgroundPid?: string|null, streaming?: boolean,
 *          streamEnd?: null|'done'|'takeover'|'dropped'}} o
 * @returns {{guard: string|null, reattach: boolean}} guard = 闩锁的新值(原样写回 ref)
 */
export function nextReattachGuard({ guard = null, backgroundPid = null, streaming = false, streamEnd = null } = {}) {
  if (streamEnd) return { guard: streamEnd === 'done' ? null : guard, reattach: false };
  // backgroundPid 为空【不等于】后台进程没了:本地正在流时轮询恒写 null。只有真的没有
  // 本地流,这个空值才算「进程闲下来了」的复位信号。
  if (!backgroundPid) return { guard: streaming ? guard : null, reattach: false };
  if (streaming) return { guard, reattach: false };              // 本地已有流,不必也不该再接
  if (guard === backgroundPid) return { guard, reattach: false }; // 这一次复活已经接过了
  return { guard: backgroundPid, reattach: true };
}

/**
 * 「这个会话仍在后台工作中」横幅的存在门槛。横幅的隐含前提是「你离开过」,而一次
 * 误判回合结束 + 自动 reattach 通常在 1.5s 轮询周期内就接回来了 —— 不加门槛的话用户
 * 人就在当前会话看着,横幅却闪一下,语义正好反了。真正切走再回来的场景横幅本来就要
 * 挂很久,2s 门槛对它无感。
 * 注意只门控横幅文案(backgroundWorking),不碰 isStreaming —— 后者还担着「后台跑着时
 * 禁止直发、走入队」的职责,延迟它会开出双写窗口。
 */
export const BG_BANNER_DELAY_MS = 2000;
