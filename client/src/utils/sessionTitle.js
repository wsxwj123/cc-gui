// 会话标题的优先级链在 server/utils/session-title.js(前后端共用一份,服务端的跨会话目标列表也用它),
// 这里只转出;改优先级去那边改。
import { resolveSessionTitle } from '../../../server/utils/session-title.js';

export { resolveSessionTitle };

// r194:同一个会话在完成浮条、会话标题、顶栏、侧栏要显示同一个名字。
// 会话名有两个来源(会话记录里的 custom-title → 列表项的 customTitle;偏好里的 customTitles),
// 列表项上的优先。所以显示什么取决于手里拿的是哪一份会话对象:侧栏拿的是最新列表项,
// 而浮条 / 会话标题 / 顶栏手里的常常是只有编号的对象(从浮条、后台代理面板打开),
// 或打开那一刻存下的旧快照(之后改了名)。收口办法:凡是要显示会话名的地方,
// 先按会话编号到已加载的会话列表里找最新的那一项,找到就用它解析,找不到才用手里的对象。

// 按会话编号找已加载的列表项:先找它所在工作区那一组 sessionsByProject[projectHash],
// 再找旧单值槽 sessions(当前选中工作区),再找其余各组;都没有返回 null。
// 没有会话编号(草稿)返回 null。只读不写,不新建对象。
export function findLoadedSession(st, sessionId, projectHash) {
  if (!st || !sessionId) return null;
  const byProject = (st.sessionsByProject && typeof st.sessionsByProject === 'object') ? st.sessionsByProject : {};
  const findIn = (list) => (Array.isArray(list) ? (list.find((x) => x && x.sessionId === sessionId) || null) : null);
  if (projectHash) {
    const own = findIn(byProject[projectHash]);
    if (own) return own;
  }
  const fromSlot = findIn(st.sessions);
  if (fromSlot) return fromSlot;
  for (const hash of Object.keys(byProject)) {
    if (hash === projectHash) continue;
    const hit = findIn(byProject[hash]);
    if (hit) return hit;
  }
  return null;
}

// 按会话编号解析会话名(与侧栏同口径):已加载列表里最新的那一项优先,找不到用手里的对象。
// 返回字符串(基元),可以直接放进 zustand 选择器 —— 不新建对象,值没变就不触发重渲染;
// 选择器读了列表与两张标题表,列表刷新 / 改名后跟着变。
export function resolveLatestSessionTitle(st, session) {
  const sid = session?.sessionId;
  if (!sid) return resolveSessionTitle(session, undefined, undefined);
  const latest = findLoadedSession(st, sid, session.projectHash);
  return resolveSessionTitle(latest || session, st?.customTitles?.[sid], st?.autoTitles?.[sid]);
}

// r11-⑪:会话行单行化(只显状态点+标题+置顶角标)后,模型/消息数/子任务数/时间
// 收进行的原生 title tooltip。纯函数组装,缺项跳过;model 剥 [1m] 后缀(与徽章同口径)。
export function sessionRowTooltip({ model, messageCount, subagentCount, timeText } = {}) {
  const parts = [];
  const m = typeof model === 'string' ? model.replace(/\[1m\]/i, '').trim() : '';
  if (m) parts.push(m);
  if (Number.isFinite(messageCount)) parts.push(`${messageCount} 条消息`);
  if (Number.isFinite(subagentCount) && subagentCount > 0) parts.push(`${subagentCount} 个子任务`);
  if (timeText) parts.push(timeText);
  return parts.join(' · ');
}
