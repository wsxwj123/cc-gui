// 任务清单栏的偏好持久化(r30 折叠 / r34 隐藏)。默认折叠成一行摘要,用户手动点开/折起的
// 选择记本设备 localStorage(cgui-todo-collapsed),刷新/重启/换会话都跟着走。
// 只有【手动切换】才写这个键 —— AI 端"任务全部完成自动折叠"是临时压制,不覆盖用户偏好。
export const TODO_COLLAPSED_KEY = 'cgui-todo-collapsed';
// 默认折叠(用户从未碰过 = 按默认折叠显示)。
const DEFAULT_COLLAPSED = true;

export function readTodoCollapsed() {
  try {
    const raw = localStorage.getItem(TODO_COLLAPSED_KEY);
    if (raw == null) return DEFAULT_COLLAPSED;
    return raw === 'true';
  } catch {
    return DEFAULT_COLLAPSED;
  }
}

export function writeTodoCollapsed(collapsed) {
  try {
    localStorage.setItem(TODO_COLLAPSED_KEY, String(!!collapsed));
  } catch {}
}

// ── 隐藏开关(r34)─────────────────────────────────────────────────────────
// 按会话键存一个布尔(cgui-todo-hidden:<owner>,owner = permKey),点隐藏后清单【任何更新
// 都不再把它弹回来】,只有用户点"显示任务清单"才恢复。r33 及以前存的是"隐藏那一刻的清单
// 签名":清单只要动一下(内容或勾选变化)签名就变 → 卡片自己弹回来,正是用户实报的 R34。
// 按会话存:A 会话隐藏不影响 B 会话(与 cgui-plan-hidden / cgui-goal-hidden 同口径);
// 值只有 '1',与清单内容无关,AI 增删改任务都改不动它。
export const TODO_HIDDEN_PREFIX = 'cgui-todo-hidden:';
// r33 的"签名隐藏"旧键(全局、value = 清单签名串)。语义已废,读到即清(见 readTodoHidden):
// 老值绝不会被当成隐藏开关用,故升级后既不会意外隐藏,也不会有解析失败。
export const TODO_HIDDEN_SIG_LEGACY_KEY = 'cgui-todo-hidden-sig';

export function todoHiddenKey(ownerKey) {
  return `${TODO_HIDDEN_PREFIX}${ownerKey || 'global'}`;
}

// 该会话是否处于"用户点了隐藏"状态。缺 localStorage(隐私模式)时按【不隐藏】回退:
// 隐藏态丢了只是个观感回退,判定成隐藏却写不进恢复键才会让入口消失。
export function readTodoHidden(ownerKey) {
  try {
    localStorage.removeItem(TODO_HIDDEN_SIG_LEGACY_KEY); // 旧签名键:不用、即刻清掉
    return localStorage.getItem(todoHiddenKey(ownerKey)) === '1';
  } catch {
    return false;
  }
}

export function writeTodoHidden(ownerKey, hidden) {
  try {
    if (hidden) localStorage.setItem(todoHiddenKey(ownerKey), '1');
    else localStorage.removeItem(todoHiddenKey(ownerKey)); // 恢复显示 = 删键,不留残值
  } catch {}
}

/**
 * "全部完成 → 自动折叠"的去重判据(与时序无关的纯函数,便于单测):同一份全完成快照
 * 只折一次 —— 用户手动展开后,AI 把某项重开再完成(签名回到同一个全完成态)不会再次
 * 强制折叠打断;只有换成内容不同的新清单完成(签名不同)才再自动折叠。
 */
export function shouldAutoCollapse(allComplete, sig, lastCollapsedSig) {
  return !!allComplete && lastCollapsedSig !== sig;
}
