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
