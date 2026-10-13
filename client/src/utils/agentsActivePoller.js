// 「正在运行的进程」(GET /api/agents/active)全应用共用的一份轮询(r148 P2)—— 纯机制,零 React / store 依赖,可单测。
//
// 病灶:每个分屏窗格、根组件、Subagent 监控面板各自 setInterval 1.5 秒拉一次这个接口,拿到的是同一份数据。
// 6 分屏约 7 个请求 / 1.5 秒(后端每次都要列目录、逐个读 json、探活),窗口隐藏也照跑。
//
// 改法:只留一份。各处 subscribe 同一份结果;没人订阅就停。
//   subscribe(cb)   订阅。订阅当下会取一份新的(等价于各处原来挂载时立刻跑的那次 poll()),之后每 intervalMs 一次。
//                   **只把"订阅之后才发出的请求"的结果交给它** —— 各窗格拿这份数据判"本会话还有没有进程在跑"
//                   来决定排空排队消息 / 出后台横幅 / 自动重连,拿一份订阅之前发出的旧结果顶替会判错。
//                   取数失败不回调(各处原来都是 catch 之后什么也不做),下一拍照常再取。返回退订函数。
//   fetchFresh()    要一份"调用之后才发出"的结果(手动刷新用)。与轮询共用请求,不另开并发。失败 reject。
// 同一时刻最多一个请求在飞:在飞期间又有人要新鲜数据,就等它回来后立刻补发一次;同一个同步任务里的
// 多次请求并成一次(6 个窗格同时挂载 = 1 个请求)。定时的那一拍撞上在飞的请求则跳过,不堆叠。
// 在飞的请求有超时(timeoutMs):到点就放弃这一拍 —— 取消请求、按"这次没取到"处理、之后晚到的结果不认,
// 下一拍照常发。没有超时的话,一次请求挂住不回,"在飞"就永远不结束,全应用的轮询跟着停。
//
// 页面不可见(document.hidden)时停掉 intervalMs 的拍子,回到可见立刻补一次并恢复。
// 不可见期间按 hiddenIntervalMs 的慢拍取(0 = 完全不取)。应用里用的慢拍见下面的常量及其说明。

export const AGENTS_ACTIVE_INTERVAL_MS = 1500;

// 在飞请求的超时(r148b A2)。这个接口正常几十毫秒就回;10 秒还没回只能是挂住了。
// 不取得更短:后端一时繁忙(列目录、逐个探活)时别把慢请求当成挂住而反复取消重发。
export const AGENTS_ACTIVE_TIMEOUT_MS = 10_000;

// 页面不可见时的慢拍。**没有设成 0(全停)的原因**:这份数据在窗口不可见时仍有三个用处 ——
//   ① Dock 角标「有代理在等你」(后台代理卡在授权 / 外部 CLI 会话停下等人):角标就是给"没在看窗口"的时候用的;
//   ② 转到后台的回合跑完后,排队消息的自动发出与最终回复上屏(窗格靠这份数据发现"进程没了");
//   ③ 自动重连。
// 全停会让这三样在窗口不可见期间一直不动,直到用户回来。15 秒一拍把不可见时的请求量压到原来的 1/10
// (6 分屏时约 1/70),这三样最多晚 15 秒。要全停:改成 0(轮询器与用例都支持)。
export const AGENTS_ACTIVE_HIDDEN_INTERVAL_MS = 15_000;

const defaultIsHidden = () => typeof document !== 'undefined' && document.hidden === true;
const defaultOnVisibilityChange = (cb) => {
  if (typeof document === 'undefined') return () => {};
  document.addEventListener('visibilitychange', cb);
  return () => document.removeEventListener('visibilitychange', cb);
};

export function createAgentsActivePoller({
  fetchActive,
  intervalMs = AGENTS_ACTIVE_INTERVAL_MS,
  hiddenIntervalMs = 0,
  timeoutMs = AGENTS_ACTIVE_TIMEOUT_MS,
  setTimer = (fn, ms) => setInterval(fn, ms),
  clearTimer = (id) => clearInterval(id),
  // 超时计时用的一次性定时器(node 下 unref:不为了等它而拖住进程退出)
  setTimeoutFn = (fn, ms) => { const t = setTimeout(fn, ms); t?.unref?.(); return t; },
  clearTimeoutFn = (id) => clearTimeout(id),
  isHidden = defaultIsHidden,
  onVisibilityChange = defaultOnVisibilityChange,
} = {}) {
  const subs = new Set();   // { cb, since }:只收序号 > since 的请求结果
  let waiters = [];         // fetchFresh 的等待者 { since, resolve, reject }
  let sentSeq = 0;          // 已发出的请求序号
  let inFlight = false;
  let flightSeq = 0;        // 在飞的那次请求的序号(0 = 没有);只认它的结果
  let flightTimeout = null; // 在飞请求的超时计时
  let wantAnother = false;  // 在飞期间又有人要新鲜数据 → 回来后立刻补发
  let kickQueued = false;   // 同一个同步任务里的多次请求并成一次
  let timer = null;
  let timerMs = 0;
  let offVisibility = null;
  let hiddenNow = false;

  const settle = (seq, data, err) => {
    if (seq !== flightSeq) return;                          // 已经超时放弃的那次:晚到的结果不认
    flightSeq = 0;
    if (flightTimeout !== null) { clearTimeoutFn(flightTimeout); flightTimeout = null; }
    inFlight = false;
    const due = waiters.filter((w) => w.since < seq);
    waiters = waiters.filter((w) => w.since >= seq);
    for (const w of due) { if (err) w.reject(err); else w.resolve(data); }
    if (!err) {
      for (const sub of [...subs]) {
        if (sub.since >= seq || !subs.has(sub)) continue;   // 订阅之前发出的 / 回调途中已退订的
        try { sub.cb(data); } catch { /* 一家出错不连累别家 */ }
      }
    }
    if (wantAnother) send();
  };
  function send() {
    if (inFlight) { wantAnother = true; return; }
    if (!subs.size && !waiters.length) return;              // 排队期间人都走了
    inFlight = true;
    wantAnother = false;
    sentSeq += 1;
    const seq = sentSeq;
    flightSeq = seq;
    const abort = typeof AbortController === 'function' ? new AbortController() : null;
    if (timeoutMs > 0) {
      flightTimeout = setTimeoutFn(() => {
        flightTimeout = null;
        try { abort?.abort(); } catch { /* 取消不了也照样放弃这一拍 */ }
        settle(seq, null, new Error('agents/active timeout'));
      }, timeoutMs);
    }
    Promise.resolve().then(() => fetchActive({ signal: abort ? abort.signal : undefined })).then(
      (data) => settle(seq, data, null),
      (err) => settle(seq, null, err || new Error('agents/active failed')),
    );
  }
  /** 要一份新鲜的:并掉同一同步任务里的重复请求。 */
  const kick = () => {
    if (kickQueued) return;
    kickQueued = true;
    queueMicrotask(() => { kickQueued = false; send(); });
  };
  const onTick = () => { if (!inFlight) send(); };          // 撞上在飞的就跳过这一拍
  const stopTimer = () => { if (timer !== null) { clearTimer(timer); timer = null; timerMs = 0; } };
  const syncTimer = () => {
    const ms = !subs.size ? 0 : (hiddenNow ? hiddenIntervalMs : intervalMs);
    if (ms === timerMs && (timer !== null || ms === 0)) return;
    stopTimer();
    if (ms > 0) { timer = setTimer(onTick, ms); timerMs = ms; }
  };
  const onVisibility = () => {
    const h = !!isHidden();
    if (h === hiddenNow) return;
    hiddenNow = h;
    syncTimer();
    if (!h && subs.size) kick();                            // 回到可见:立刻补一次
  };

  return {
    get subscriberCount() { return subs.size; },
    subscribe(cb) {
      const sub = { cb, since: sentSeq };
      if (!subs.size) {
        hiddenNow = !!isHidden();
        offVisibility = onVisibilityChange(onVisibility);
      }
      subs.add(sub);
      syncTimer();
      kick();
      return () => {
        if (!subs.delete(sub)) return;
        if (subs.size) return;
        stopTimer();
        if (offVisibility) { offVisibility(); offVisibility = null; }
      };
    },
    fetchFresh() {
      return new Promise((resolve, reject) => {
        waiters.push({ since: sentSeq, resolve, reject });
        kick();
      });
    },
  };
}

// 应用里用的那一份(模块级单例)。
const appPoller = createAgentsActivePoller({
  fetchActive: ({ signal } = {}) => fetch('/api/agents/active', { signal }).then((r) => r.json()),
  hiddenIntervalMs: AGENTS_ACTIVE_HIDDEN_INTERVAL_MS,
});
/** 订阅全应用共用的那一份「运行进程」数据。cb(data):data = 接口返回的 JSON。返回退订函数。 */
export const subscribeAgentsActive = (cb) => appPoller.subscribe(cb);
/** 取一份调用之后才发出的结果(与轮询共用请求)。 */
export const fetchAgentsActiveFresh = () => appPoller.fetchFresh();
