// 任务清单栏的折叠/展开偏好持久化(r30)。默认折叠成一行摘要,用户手动点开/折起的选择
// 记本设备 localStorage(cgui-todo-collapsed),刷新/重启/换会话都跟着走。
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
