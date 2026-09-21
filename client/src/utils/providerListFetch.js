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

// r126:服务端 warnings[] 里要让用户看见的两类 —— config-corrupt(某份 GUI 配置 json 损坏,首读已备份、写入已锁)
// 与 ccswitch-error(cc-switch 库读取出错 / 损坏);ccswitch-missing(未安装)不算警告,不显示(BRIEF-r126 Q3)。
const VISIBLE_WARNING_KINDS = new Set(['config-corrupt', 'ccswitch-error']);
export function visibleProviderWarnings(d) {
  const arr = Array.isArray(d?.warnings) ? d.warnings : [];
  return arr.filter((w) => w && typeof w === 'object' && VISIBLE_WARNING_KINDS.has(w.kind));
}

// 路径按 / 与 \ 两种分隔符切(Windows 路径)。
const fileNameOf = (p) => String(p || '').split(/[/\\]/).pop() || '配置文件';

/** 警告行文案(客观陈述:哪个文件、备份在哪、怎么处理;只含路径,不含文件内容)。 */
export function providerWarningText(w) {
  if (!w) return '';
  if (w.kind === 'config-corrupt') {
    const backup = w.backup
      ? `原文件未改动，备份在 ${w.backup}。`
      : '原文件未改动（自动备份失败，请先手动复制一份）。';
    return `${fileNameOf(w.file)} 不是合法 JSON（可能写到一半或被外部改坏），其中的配置暂时读不到，写入已锁定以免覆盖。${backup}修复该文件或删除它（程序会重建）后重新打开本列表即可恢复。`;
  }
  if (w.kind === 'ccswitch-error') return w.message || 'cc-switch 数据库读取出错，导入的 provider 暂时读不到。';
  return w.message || '';
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
