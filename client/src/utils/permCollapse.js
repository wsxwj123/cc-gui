// 待应答卡片(权限/计划/提问/越界/填表/拒答)的正文折叠偏好持久化(r92)。
// 折叠只藏可滚动正文,标题行与操作按钮行始终保留 —— 折叠态照样一键允许/拒绝。
// 默认【展开】:这类卡片是阻塞回合的闸门,默认折叠等于默认藏起一件必须做的事。
// (与 todoCollapse 的「待办默认折叠」刻意相反:待办是信息,权限是闸门。)
// 用户手动折起一次后记本设备,刷新/重启/换会话都跟着走。
export const PERM_COLLAPSED_KEY = 'cgui-perm-collapsed';
const DEFAULT_COLLAPSED = false;

export function readPermCollapsed() {
  try {
    const raw = localStorage.getItem(PERM_COLLAPSED_KEY);
    if (raw == null) return DEFAULT_COLLAPSED;
    return raw === 'true';
  } catch {
    return DEFAULT_COLLAPSED;
  }
}

export function writePermCollapsed(collapsed) {
  try {
    localStorage.setItem(PERM_COLLAPSED_KEY, String(!!collapsed));
  } catch {}
}
