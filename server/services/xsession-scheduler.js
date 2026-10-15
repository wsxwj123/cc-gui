// r151c:跨会话自动处理的调度机关(方案 §3 xsession-scheduler.js)。只管"什么时候对哪个会话评估一次":
//   每会话一条串行链(一次只评估一次、按事件先后);目标转空闲后 idleMs(1.5 秒)仍空闲才投;有排队且目标忙时挂一次性复查
//   (30 秒,到点仍忙再挂一次;兜底"忙但不以回合结束收尾"的情形);没有常驻轮询。评估本身(去向重判、置处理中、起回合)
//   由调用方的 evaluate(sessionId) 做,本模块不读盘、不认识消息。另有全局"10 分钟 20 次"的滑动计数。
// 时长判定一律在事件到来时拿 now() 比较起算时刻(定时器只是提前叫醒一次;服务端时间被平移时照样按 now() 判)。

/**
 * deps:
 *  · evaluate(sessionId) → Promise<{ queuedLeft:boolean, busy:boolean }>:评估一次;返回后是否还有排队、目标是否仍忙。
 *  · hasQueued(sessionId) → boolean(可选):回合结束时只对可能有排队的会话排评估(省掉无谓的读盘)。
 *  · now / setTimer / clearTimer:默认 Date.now / setTimeout / clearTimeout。
 * 会话 id 按小写归一(与存储的不分大小写一致)。
 */
export function createXsScheduler({ evaluate, hasQueued = () => true, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout, idleMs = 1500, recheckMs = 30_000 } = {}) {
  if (typeof evaluate !== 'function') throw new TypeError('createXsScheduler:evaluate 必须是函数');
  const sessions = new Map(); // key → { id, chain, lastEndAt, timer, timerKind }
  const keyOf = (id) => String(id).toLowerCase();
  const stateOf = (id) => {
    const key = keyOf(id);
    let st = sessions.get(key);
    if (!st) { st = { id, chain: Promise.resolve(), lastEndAt: -Infinity, timer: null, timerKind: null }; sessions.set(key, st); }
    return st;
  };
  const disarm = (st) => { if (st.timer) clearTimer(st.timer); st.timer = null; st.timerKind = null; };
  const arm = (st, kind, ms) => {
    disarm(st);
    st.timerKind = kind;
    st.timer = setTimer(() => { st.timer = null; st.timerKind = null; kick(st.id); }, Math.max(0, ms));
    st.timer?.unref?.();
  };
  // 回合结束后还没满 idleMs:按 now() 判(不只靠定时器)
  const settleLeft = (st) => st.lastEndAt + idleMs - now();

  function kick(id) {
    if (typeof id !== 'string' || !id) return Promise.resolve();
    const st = stateOf(id);
    const run = st.chain.then(async () => {
      let out;
      try { out = await evaluate(st.id); } catch (e) {
        console.warn(`[xsession] 会话 ${st.id} 的自动处理评估出错:${e?.message || e}`);
        out = { queuedLeft: true, busy: true }; // 出错按"还在排、目标忙"处理:挂复查,不丢消息
      }
      if (!out?.queuedLeft) { disarm(st); return; }
      const left = settleLeft(st);
      if (left > 0) arm(st, 'idle', left); // 刚转空闲:满 idleMs 再评估一次
      else if (out.busy) { if (st.timerKind !== 'recheck') arm(st, 'recheck', recheckMs); }
    });
    st.chain = run.catch(() => {});
    return run;
  }

  return {
    kick,
    /** 某会话的一个回合结束:记下转空闲的时刻;可能有排队时 idleMs 后评估一次。 */
    noteTurnEnd(id) {
      if (typeof id !== 'string' || !id) return;
      const st = stateOf(id);
      st.lastEndAt = now();
      if (hasQueued(id)) arm(st, 'idle', idleMs);
    },
    /** 目标刚转空闲、还没满 idleMs(评估时按"忙"对待,只是不投)。 */
    settling(id) {
      const st = sessions.get(keyOf(id));
      return !!st && settleLeft(st) > 0;
    },
    forget(id) {
      const st = sessions.get(keyOf(id));
      if (st) { disarm(st); sessions.delete(keyOf(id)); }
    },
    /** 已挂着的定时器种类(单测观察用):'idle' | 'recheck' | null。 */
    timerOf(id) { return sessions.get(keyOf(id))?.timerKind ?? null; },
  };
}

/** 全局自动处理次数的滑动窗口(内存;服务重启清零)。note() 记一次并返回 { stamp, used, reached }。 */
export function createAutoBudget({ limit = 20, windowMs = 600_000, now = () => Date.now() } = {}) {
  let stamps = [];
  const prune = () => { const t = now(); stamps = stamps.filter((s) => t - s < windowMs); };
  return {
    limit,
    windowMs,
    used() { prune(); return stamps.length; },
    note() {
      const stamp = now();
      stamps.push(stamp);
      prune();
      return { stamp, used: stamps.length, reached: stamps.length >= limit };
    },
    /** 没真起成的那一次(内部入口回 409 退回排队)退掉。 */
    refund(stamp) { const i = stamps.lastIndexOf(stamp); if (i >= 0) stamps.splice(i, 1); },
    clear() { stamps = []; },
  };
}
