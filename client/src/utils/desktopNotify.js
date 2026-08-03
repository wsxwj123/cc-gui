// L2:系统通知 —— 窗口不在前台时,把"有东西在等你"送到系统通知中心。
//
// 定位:角标(attention.js)只在你看着 GUI 时有用;人不在 GUI 前面时,唯一能触达的是
// 系统通知。两者数据源同一批(待处理的权限/表单卡 + 停下等待的后台代理),互补不重复。
//
// 平台事实(照做,别按直觉改):
//   · 不调 isPermissionGranted() —— 桌面端硬编码恒返回 granted(用户在系统设置里关掉
//     通知也一样返回 true),拿它做门控只会挡住能发的、放过发不出的,毫无信息量。
//   · 不读 window.Notification.permission —— Windows 上插件无条件把它设成 denied
//     (上游 bug #3512),读它等于在 Windows 上把通知全关掉。
//   · 不接通知点击回调 —— 桌面端只注册 notify/request_permission/is_permission_granted
//     三个命令,onAction 会报 Command not found。点通知回到 GUI 这件事不做,聚焦靠 Dock
//     角标和应用内。
//   · 发不出去就静默降级(浏览器/手机端没有 Tauri;Windows 便携版/dev 无 toast)——
//     通知是锦上添花,失败绝不能影响主流程。
// 发送链路(v2.3 起绕了一圈,别照直觉改):plugin-notification 的 sendNotification 实际是
// `new window.Notification(...)`,而 window.Notification 由插件注入的 init 脚本改写成
// invoke('plugin:notification|notify')。改写里【没有】权限判断,所以 Windows 那个被错设成
// denied 的 permission 不影响真的能不能发 —— 这正是"直接发、不做前置检查"的依据。
// 前提是 Rust 侧挂了插件(src-tauri/src/lib.rs);没挂的话 macOS WKWebView 上根本没有
// window.Notification,调用抛错,被下面的 catch 吃掉。
//
// 防轰炸三条(planNotification 里实现,纯逻辑、可单测):
//   ① 同一件事(key = sessionId + 类型)60s 内只发一次;
//   ② 60s 内最多 3 条个别通知,超出的合并成一条「N 个会话在等待处理」(合并条本身也
//      限一分钟一条);
//   ③ 窗口在前台(document.hasFocus())不发 —— 你正看着 GUI 时通知只会碍事。

export const NOTIFY_PREF_KEY = 'cgui-desktop-notify';

/** 开关。纯前端偏好(localStorage,与字体/主题同规矩:手机与桌面各自独立),默认开。 */
export function desktopNotifyEnabled() {
  try { return localStorage.getItem(NOTIFY_PREF_KEY) !== '0'; } catch { return true; }
}

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 3;

let attempts = [];              // {t, key} — 过了开关/前台门控的全部尝试,只用来数合并条的 N
let emitted = [];               // t —— 真发出去的个别通知,限流基准
const lastEmitByKey = new Map(); // key -> t,去重基准
let lastMerged = -Infinity;
let prevWaiting = new Set();

/** 仅测试用:清空限流/去重/上升沿的全部内部状态。 */
export function resetNotifyState() {
  attempts = [];
  emitted = [];
  lastEmitByKey.clear();
  lastMerged = -Infinity;
  prevWaiting = new Set();
}

/**
 * 决定这条通知发什么(或不发)。纯函数式外壳 + 模块级窗口状态,时钟由 now 注入。
 * 返回 { title, body } 表示要发,null 表示这次不发。
 *
 * 去重基准是"上次真发出去的时间"而不是"上次尝试的时间":用尝试当基准的话,每 30s 来一次
 * 的同一件事会永远落在上一次尝试的 60s 阴影里,一辈子发不出第二条。
 */
export function planNotification({ key, title, body, now, enabled, focused }) {
  if (!enabled || focused || !key) return null;
  attempts = attempts.filter((a) => now - a.t < WINDOW_MS);
  emitted = emitted.filter((t) => now - t < WINDOW_MS);
  attempts.push({ t: now, key });

  const last = lastEmitByKey.get(key);
  if (last != null && now - last < WINDOW_MS) return null; // ① 同一件事 60s 内只发一次

  if (emitted.length < MAX_PER_WINDOW) {                   // ② 限流内:照发
    emitted.push(now);
    lastEmitByKey.set(key, now);
    return { title, body };
  }
  // ponytail: 超额的合并成一条,一分钟一条封顶;同一分钟内更晚到的只进 N 不再触发新通知
  // (要做到"晚到的也各自成条"得挂延迟 flush 定时器,收益不抵复杂度)。
  if (now - lastMerged >= WINDOW_MS) {
    lastMerged = now;
    const n = new Set(attempts.map((a) => a.key)).size;
    return { title: '多个会话在等待处理', body: `${n} 个会话在等待处理;本分钟内的其余通知已合并为此条。` };
  }
  return null;
}

/**
 * 发一条系统通知(经过全部门控)。返回实际发出的内容,不发时返回 null —— 返回值让防轰炸
 * 决策在单测里可观测,调用方不必看。
 * 非 Tauri 环境(浏览器/手机端)没有 document 或没有插件,一律静默降级。
 */
export function maybeNotify(notice) {
  if (!notice) return null;
  const focused = typeof document !== 'undefined' && typeof document.hasFocus === 'function'
    ? document.hasFocus()
    : true; // 拿不到焦点状态就当在前台:宁可少发,不可乱发
  const plan = planNotification({
    key: notice.key,
    title: notice.title,
    body: notice.body,
    now: Date.now(),
    enabled: desktopNotifyEnabled(),
    focused,
  });
  if (!plan) return null;
  import('@tauri-apps/plugin-notification')
    .then(({ sendNotification }) => sendNotification(plan))
    .catch(() => {});
  return plan;
}

// 路径尾段。双端 dogfood:Windows 的 cwd 是反斜杠路径,只按 / 切会把整条路径当成最后一段。
function tailSegment(p) {
  return String(p || '').split(/[/\\]+/).filter(Boolean).pop() || '';
}

/**
 * 待处理卡 → 通知内容。标题按卡的类型给,正文带工具名/服务器名与所属项目(会话线索)。
 * key 用 sessionId + 类型:同一会话同一类的连续请求算同一件事,60s 内不重复打扰。
 */
export function permissionNotice(req) {
  if (!req) return null;
  const sid = req.sessionId || 'draft';
  const where = tailSegment(req.cwd);
  const suffix = where ? `(${where})` : '';
  if (req.kind === 'elicitation') {
    return {
      key: `${sid}:elicitation`,
      title: 'MCP 请求输入',
      body: `${req.serverName || 'MCP'} 请求填写信息${suffix}`,
    };
  }
  if (req.kind === 'dialog') {
    return { key: `${sid}:dialog`, title: 'Claude 需要你的选择', body: `模型拒答,等待选择重试方式${suffix}` };
  }
  if (req.toolName === 'AskUserQuestion') {
    return { key: `${sid}:ask`, title: 'Claude 需要你的选择', body: `会话中有待回答的问题${suffix}` };
  }
  if (req.toolName === 'ExitPlanMode') {
    return { key: `${sid}:plan`, title: '计划等待确认', body: `会话中有待确认的计划${suffix}` };
  }
  return { key: `${sid}:permission`, title: '等待授权', body: `${req.toolName || '工具调用'} 等待授权${suffix}` };
}

/**
 * 上升沿:这一轮新出现的等待会话。轮询每 1.5s 给一次全量集合,按水平值发通知会每 1.5s
 * 重发一遍;只有"上一轮没有、这一轮有"才是一次新的等待事件。
 * keysString 是 attention.js 的 waitingSessionKeys 那种逗号串(基元,不引入新引用)。
 */
export function newWaitingKeys(keysString) {
  const next = new Set(String(keysString || '').split(',').filter(Boolean));
  const fresh = [...next].filter((k) => !prevWaiting.has(k));
  prevWaiting = next;
  return fresh;
}

/** 后台代理新转 waiting/blocked → 各发一条(再经防轰炸)。 */
export function notifyWaiting(keysString) {
  for (const sid of newWaitingKeys(keysString)) {
    maybeNotify({
      key: `${sid}:waiting`,
      title: '后台代理在等待处理',
      body: sid === '?' ? '有后台代理停下等待,在监控面板处理。' : `会话 ${sid.slice(0, 8)} 停下等待,在监控面板处理。`,
    });
  }
}
