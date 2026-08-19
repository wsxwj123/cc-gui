// r11-③:图标语义替换注册表(纯 js,零 JSX)。Icon.jsx(渲染层)与 skins.js(皮肤
// 引擎)都从这里取——引擎是 node 单测可 import 的纯模块,不能反向依赖 JSX。
let overrides = {};
let version = 0;
const subs = new Set();

export const subscribeIcons = (fn) => { subs.add(fn); return () => subs.delete(fn); };
export const getIconsVersion = () => version;

/** 皮肤层调用:map = { 语义名: 资源 URL };传空对象清除全部替换。 */
export function setIconOverrides(map) {
  overrides = (map && typeof map === 'object') ? { ...map } : {};
  version++;
  for (const fn of subs) fn();
}
export function getIconOverrides() { return overrides; }

/** lucide 组件名 → 皮肤语义名注册表(供提示词生成器/文档;渲染层 Icon.jsx 转发导出)。 */
export const ICON_SEMANTICS = {
  Send: "send",
  Square: "stop",
  MessageSquare: "new-session",
  Settings: "settings",
  Folder: "folder",
  FolderOpen: "folder-open",
  Search: "search",
  Pin: "pin",
  X: "close",
  Copy: "copy",
  RefreshCw: "refresh",
  Pencil: "edit",
  Trash2: "delete",
  Archive: "archive",
  GitBranch: "branch",
  Terminal: "terminal",
  FileText: "file",
  Image: "image",
  Globe: "globe",
  Check: "check",
  ChevronDown: "chevron-down",
  ChevronRight: "chevron-right",
  ChevronLeft: "chevron-left",
  Plus: "plus",
  Menu: "menu",
  Sparkles: "sparkles",
  Clock: "clock",
  User: "user",
  Bot: "bot",
  AlertTriangle: "warning",
  SlidersHorizontal: "sliders"
};
