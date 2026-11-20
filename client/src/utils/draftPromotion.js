// r196:新会话(草稿)拿到正式编号时,把挂在草稿键下、属于这个会话的三样东西转到正式编号:排队消息、留给它的留言、输入历史。
// 窗格在流的 init 处调它(用户已切走、窗格不再显示这个草稿时也照做);后台排空在没有窗格负责这个草稿时调同一个函数。
// pin 不迁(见 routing.migrateDraftQueue 的注释);窗格级的提示条、标题生成、会话列表刷新留在窗格。
// 三步的顺序与抽出前窗格里的写法相同(先排队、再留言、最后输入历史),每一步对「草稿键下已经没有东西」都是 no-op。
import { useStore } from '../stores/sessionStore.js';
import { migrateDraftQueue } from './routing.js';
import { migrateSessionNotice } from './sessionNotice.js';

export function promoteDraftArtifacts(draftKey, sid) {
  // 排队(fable 审计,逻辑在 routing.migrateDraftQueue):窗格已切走(不绑定)时 migrateSessionKey 不执行,残留队列会被
  // 下一个同项目草稿继承串发;窗格绑定时已随 migrateSessionKey 迁空,这里 no-op。
  try {
    const next = migrateDraftQueue(useStore.getState().messageQueue, draftKey, sid);
    if (next) useStore.setState({ messageQueue: next });
  } catch {}
  // 留言(r193 F1):留给草稿键的(leaveSessionNotice)改挂到正式编号,切回这个会话时取得到。
  migrateSessionNotice(draftKey, sid);
  // 输入历史:草稿期写在草稿键下,不迁则首条历史滞留旧键、且污染该工作区下一个草稿的历史列表。旧键已删 / 为空 → no-op。
  try {
    const hv = localStorage.getItem(`cgui-input-history:${draftKey}`);
    if (hv && hv !== '[]') {
      localStorage.setItem(`cgui-input-history:${sid}`, hv);
      localStorage.removeItem(`cgui-input-history:${draftKey}`);
    }
  } catch {}
}
