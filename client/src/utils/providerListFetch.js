// r125:GET /api/providers 的唯一客户端入口(顶栏切换浮层 / Provider 管理页 / 手机页 / 模型页共用)。
// 用户实报"反复点 provider 按钮后列表全部消失,重启才恢复"的机制(TEST-PLAN P3-4):三处列表加载
// 各自裸 fetch,只要有一次不是"200 + providers 数组"就把列表置空且不会自愈;连点又会并发堆请求,
// 请求越多任一失败的概率越大。这里一次性收口:
//  - 在途复用:同一时刻最多一个请求在飞,并发调用方拿同一个 Promise(P3-2);
//  - 最近一次成功结果缓存:组件挂载即用它渲染首帧,失败时调用方保留旧列表(P3-1);
//  - 严格校验:非 2xx / 非 JSON / providers 不是数组一律 reject,调用方据此显示错误行而不是清空;
//  - 15s 超时(AbortController):挂死的请求不能把在途复用永久卡住;
//  - cgui:provider-change 到来时作废在途复用:用户刚改完配置,下一次调用必须重拉(PLAN 失败模式 3)。
//    该监听在模块加载时注册,先于任何组件的同名监听,组件的 load() 拿到的一定是新请求。
// 服务端的 warning(某部分来源没读到,仍 200)不是加载失败:只在控制台记一行,不进错误行。
const PROVIDER_LIST_TIMEOUT_MS = 15_000;

let inflight = null;
let lastGood = null;
let lastWarning = '';

/** 最近一次成功的返回体(没有则 null);组件用它做初始状态,避免每次挂载都从空列表闪一下。 */
export function getCachedProviderList() {
  return lastGood;
}

/** 作废在途复用(下一次 fetchProviderList 一定发新请求)。cgui:provider-change 自动调用;单测也用。 */
export function invalidateProviderList() {
  inflight = null;
}

/** 只给单测:清空缓存与在途状态。 */
export function _resetProviderListForTests() {
  inflight = null;
  lastGood = null;
  lastWarning = '';
}

export function fetchProviderList() {
  if (inflight) return inflight;
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), PROVIDER_LIST_TIMEOUT_MS) : null;
  const p = fetch('/api/providers', ctrl ? { signal: ctrl.signal } : undefined)
    .then(async (r) => {
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error((d && typeof d.error === 'string' && d.error) || `HTTP ${r.status}`);
      if (!d || typeof d !== 'object' || !Array.isArray(d.providers)) throw new Error('返回体格式不对（缺 providers 数组）');
      if (typeof d.warning === 'string' && d.warning && d.warning !== lastWarning) {
        lastWarning = d.warning;
        try { console.debug('[providers] 部分来源未读到：', d.warning); } catch { /* 无 console 的环境 */ }
      }
      lastGood = d;
      return d;
    })
    .catch((e) => {
      throw new Error(e && e.name === 'AbortError' ? `请求超时（${PROVIDER_LIST_TIMEOUT_MS / 1000}s）` : (e && e.message) || String(e));
    })
    .finally(() => {
      if (timer) clearTimeout(timer);
      if (inflight === p) inflight = null;
    });
  inflight = p;
  return p;
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('cgui:provider-change', invalidateProviderList);
}
