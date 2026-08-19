// r13-p2-19:主题弹层选项卡(Windows 属性页式)——原来所有版块纵向堆叠,
// 弹层极长要一路滚;现按关注点分页,默认「字体」(最常调)。
// 明暗三态(浅色/深色/跟随系统)不入页签:它是全局开关,常驻页签上方。
export const THEME_TABS = [
  { id: 'font', label: '字体' },
  { id: 'color', label: '配色' },
  { id: 'ui', label: '界面' },
  { id: 'skin', label: '皮肤' },
];

export const DEFAULT_THEME_TAB = 'font';
const LS_KEY = 'cgui-theme-tab';

/** 记住上次停留的页签(仅本设备);非法值回默认。 */
export function readThemeTab(storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
  try {
    const v = storage?.getItem(LS_KEY);
    return THEME_TABS.some((t) => t.id === v) ? v : DEFAULT_THEME_TAB;
  } catch { return DEFAULT_THEME_TAB; }
}

export function writeThemeTab(id, storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
  if (!THEME_TABS.some((t) => t.id === id)) return false;
  try { storage?.setItem(LS_KEY, id); return true; } catch { return false; }
}
