// 大目录首次拍快照前的询问(r120 R7 / INTERFACE-r120 §D)的纯逻辑:文案 + "每会话只问一次"的记忆。
// 不引 React/DOM —— App.jsx 用它, tests/unit 也可直接 import 断言。
//
// 记忆只活在内存 Map(sessionId → 用户选了保存/不保存):同一会话不再问;
// 刷新页面后重问一次(可接受——选择只影响本会话体验;不落盘就不会变成"永久开关")。
const choices = new Map();   // sessionId → true=保存 / false=不保存
const asking = new Set();    // 正在弹窗中的会话(两次跳过相邻发生时,只让第一个弹)

const keyOf = (sessionId) => String(sessionId || '');

/** 认领"这次由我来问":同一会话只允许第一个调用者拿到 true。 */
export function claimLargeSnapshotAsk(sessionId) {
  const k = keyOf(sessionId);
  if (!k || choices.has(k) || asking.has(k)) return false;
  asking.add(k);
  return true;
}

/** 本会话是否已就"大目录要不要存快照"做过选择。 */
export const largeSnapshotDecided = (sessionId) => choices.has(keyOf(sessionId));

/**
 * 纯查询(不认领):本会话下次被安全阀挡住时,还会不会弹窗等用户回答。
 * 发送方据此决定"这条消息的气泡能不能现在就画"——会问的会话必须等回答之后再画
 * (D 修订:回答之前不进正文),否则与改动前一样立即画。
 * 判据保守:无 sessionId(draft 首发)、已问过、正问着的会话都返回 false(不入列推迟)。
 */
export const willAskLargeSnapshot = (sessionId) => {
  const k = keyOf(sessionId);
  return !!k && !choices.has(k) && !asking.has(k);
};

/** 用户选过"保存"→ 后续自动快照直接带 allowOversize 标记(不再问、也不再被静默跳过)。 */
export const oversizeAllowedFor = (sessionId) => choices.get(keyOf(sessionId)) === true;

/** 记住本次选择;认领标记随之释放。 */
export function rememberLargeSnapshot(sessionId, save) {
  const k = keyOf(sessionId);
  if (!k) return;
  asking.delete(k);
  choices.set(k, !!save);
}

/** 测试用:清空全部记忆。 */
export function resetLargeSnapshotState() {
  choices.clear();
  asking.clear();
}

/** 人话量级:38.2 GB / 64 KB / 7 MB。 */
export function humanBytes(n) {
  const b = Number(n);
  if (!Number.isFinite(b) || b <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = b;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  // 整数/大数不给小数点("64 KB" 好过 "64.0 KB"),其余留一位("38.2 GB")。
  const shown = Number.isInteger(v) || v >= 100 ? String(Math.round(v)) : v.toFixed(1);
  return `${shown} ${units[i]}`;
}

/**
 * 弹窗文案(D2:目录多大 + 保存会把整个目录复制一份、占磁盘)。
 * data 是 POST /api/checkpoints 的跳过响应:{ estimatedBytes, limitBytes, truncated }。
 * 客观陈述 + 条件,不劝也不吓。
 */
export function largeSnapshotQuestion(data) {
  const limit = humanBytes(data?.limitBytes);
  const bytes = Number(data?.estimatedBytes) || 0;
  // 估算 truncate(文件过多/扫描超时)时 bytes 只是下界,不能说"约";一点都没统计出来就别报数。
  const about = bytes <= 0 ? '' : (data?.truncated ? `至少 ${humanBytes(bytes)}` : `约 ${humanBytes(bytes)}`);
  const head = data?.truncated
    ? `工作目录体积${about || '无法估算'}(文件过多或扫描超时,未能统计完整),超过回滚点体积上限 ${limit},本次未创建回滚点。`
    : `工作目录${about || '体积未知'},超过回滚点体积上限 ${limit},本次未创建回滚点。`;
  return [
    head,
    `· 保存会把整个目录复制一份进回滚点,额外占用磁盘空间${about ? `(${about})` : ''}`,
    '· 本会话只询问这一次;选「不保存」后本会话不再创建回滚点,也不再询问',
    '是否为这个会话保存快照?',
  ].join('\n');
}

// ── 发送/拍快照的编排(可注入 fetch 与弹窗,便于白盒断言顺序)─────────────
// deps = { request(url, body), confirm(message, opts) } —— App.jsx 传真实的
// fetch 与 confirmDialog;单测传桩,直接断言"谁先谁后"。
async function postCheckpoint(deps, payload) {
  const r = await deps.request('/api/checkpoints', payload);
  if (!r?.ok) return { ok: false };
  return { ok: true, data: r.data || {} };
}

/** 带"用户已确认照存大目录"标记重拍一次 → 新快照 sha(失败 → null)。 */
async function createOversizeSnapshot(deps, payload) {
  try {
    const r = await postCheckpoint(deps, { ...payload, allowOversize: true });
    return r.ok ? (r.data?.sha || null) : null;
  } catch { return null; }
}

/**
 * "被体积安全阀跳过"之后的那一问(每个会话只问一次),选"保存"就照存并返回新 sha。
 * 两个调用点:①preflightLargeSnapshot —— 消息发送【之前】;②draft 首发 —— 那条消息
 * 发出去时还没有 sessionId(要等 init 才拿得到),发之前无从探测,init 补拍那张就是
 * 本会话最早的锚点,被挡住时只能在这里问。此后各回合都走 ①。
 */
export async function askSaveLargeSnapshot(payload, data, deps) {
  try {
    if (data?.skipped !== true || data?.sha) return null;
    if (!claimLargeSnapshotAsk(payload?.sessionId)) return null;      // 本会话问过一次就不再问
    // D8:两个明确可点的选项(确认=保存 / 取消=不保存),不存在"只能关掉"的形态。
    const save = await deps.confirm(largeSnapshotQuestion(data), {
      confirmText: '保存快照', cancelText: '不保存', testId: 'large-snapshot-prompt',
    });
    rememberLargeSnapshot(payload.sessionId, save);
    if (!save) return null;
    return await createOversizeSnapshot(deps, payload);
  } catch { return null; }
}

/**
 * R7(D 修订:阻塞式)拍快照 + 大目录首次询问,【在消息发出之前】调,并由发送方 await。
 * 一次 POST 兼作探测:小目录照常拍完带 sha 回来;被安全阀跳过时(每会话第一次)弹窗
 * 让用户选"保存/不保存"。
 *  - 选"保存" → 立刻带 allowOversize 再拍,返回的 sha 就是本条消息的锚点(D3 补强:
 *    快照先于消息生效,内容是 AI 动手前的状态)。
 *  - 选"不保存" → null,本会话不再拍、也不再问(R7-4/5)。
 * 返回:快照 sha / null(用户没选保存、或没超阈值但拍失败)。
 * 会等用户回答的只有"超阈值的首次"这一条分支 —— 小目录、本会话已问过的会话直接返回
 * (已确认过"保存"的会话由调用方带 allowOversize,同样不弹窗、不等)。
 */
export async function preflightLargeSnapshot(payload, deps) {
  try {
    const r = await postCheckpoint(deps, payload);
    if (!r.ok) return null;
    if (r.data?.sha) return r.data.sha;
    return await askSaveLargeSnapshot(payload, r.data, deps);
  } catch { return null; }
}
