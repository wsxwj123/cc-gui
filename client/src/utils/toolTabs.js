// r16-5:工具面板选项卡 —— 与 themeTabs.js 同构(主题弹层那套的翻版),
// 原来 MCP / 插件 / 外部项目三块纵向堆叠要一路滚,现按块分页。
// 数据仍是挂载时一次拉全,切页签零等待(不做按页懒加载)。
export const TOOL_TABS = [
  { id: 'mcp', label: 'MCP 服务器' },
  { id: 'plugins', label: '插件' },
  { id: 'external', label: '外部项目' },
];

export const DEFAULT_TOOL_TAB = 'mcp';
const LS_KEY = 'cgui-tool-tab';

/** 记住上次停留的页签(仅本设备);非法值回默认。 */
export function readToolTab(storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
  try {
    const v = storage?.getItem(LS_KEY);
    return TOOL_TABS.some((t) => t.id === v) ? v : DEFAULT_TOOL_TAB;
  } catch { return DEFAULT_TOOL_TAB; }
}

export function writeToolTab(id, storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
  if (!TOOL_TABS.some((t) => t.id === id)) return false;
  try { storage?.setItem(LS_KEY, id); return true; } catch { return false; }
}
