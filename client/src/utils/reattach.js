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
 * @returns {null | { sinceTs: number }} null = 不截断,历史完整显示
 *
 * 正常发送:本回合所有条目(含用户消息回显)都晚于起流时刻,截掉它们、由流式气泡画。
 * reattach:不截断。在跑的那个 turn 本来就整条留在历史里(见上文 turn 粒度),显式
 * 承认这一点,并配合"reattach 不画流式气泡"收敛成单一渲染源。
 */
export function resolveStreamHistCutoff(isReattach, now) {
  return isReattach ? null : { sinceTs: now };
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
