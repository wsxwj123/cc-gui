// r11-p2-3b:会话行状态点的数据层(纯 js,node 可测)。视觉语义(dsh 逆向定稿):
// 一行一点,优先级 等待用户(琥珀) > 运行中(accent 点阵) > 完成未读(绿) > 空闲(无点)。
// "完成未读"是边沿触发语义:running 真→假 且该会话非当前选中 → 置位;
// 首次观测(加载时已空闲)永不置位;清除 = 选中该会话 / 它再次运行 / forget(删除);
// 纯内存 per-device,不落盘。

/** 一行一点仲裁:→ 'waiting' | 'running' | 'done' | null。 */
export function resolveSessionDot({ waiting, running, completedUnread } = {}) {
  if (waiting) return 'waiting';
  if (running) return 'running';
  if (completedUnread) return 'done';
  return null;
}

/**
 * 完成未读边沿追踪器(工厂供单测,app 用下方单例)。
 * observe(sessionId, running, isSelected) 每次渲染态变化调用:
 *  - prev === true && running === false && !isSelected → 置位(真边沿);
 *  - 首次观测(prev === undefined)只记账不置位;
 *  - running 或 isSelected → 清位(再跑/选中即视为已读)。
 */
export function createCompletionTracker(onChange) {
  const prevRunning = new Map();
  const unread = new Set();
  const emit = () => { try { onChange?.(); } catch {} };
  return {
    observe(sessionId, running, isSelected) {
      if (!sessionId) return;
      const prev = prevRunning.get(sessionId);
      prevRunning.set(sessionId, !!running);
      if (running || isSelected) {
        if (unread.delete(sessionId)) emit();
        return;
      }
      // 边沿条件:上一观测确为运行中(首次观测 prev=undefined 不算)
      if (prev === true && !isSelected && !unread.has(sessionId)) {
        unread.add(sessionId);
        emit();
      }
    },
    has: (sessionId) => unread.has(sessionId),
    /** 会话从库中移除(删除/清理)时的清理钩。 */
    forget(sessionId) {
      const had = unread.delete(sessionId);
      prevRunning.delete(sessionId);
      if (had) emit();
    },
    _size: () => unread.size,
  };
}

// ── app 单例 + 订阅(useSyncExternalStore 挂点,与 iconOverrides 同款) ──
let version = 0;
const subs = new Set();
export const subscribeDots = (fn) => { subs.add(fn); return () => subs.delete(fn); };
export const getDotsVersion = () => version;
export const completionTracker = createCompletionTracker(() => {
  version++;
  for (const fn of subs) fn();
});

/** 运行中点阵的 8 格坐标(dsh 逆向:3×3 网格顺时针,2×2 格,viewBox 0 0 10 10)。 */
export const RUN_MATRIX_CELLS = [[0, 0], [4, 0], [8, 0], [8, 4], [8, 8], [4, 8], [0, 8], [0, 4]];
/** 每格负延迟预置相位:(i-8)*125ms。 */
export const runCellDelayMs = (i) => (i - 8) * 125;
