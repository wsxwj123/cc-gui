// 会话路由核心逻辑(纯函数,零 React/store 依赖) —— 串扰家族 bug 的聚集地,抽出可测。
// 历史回归至少 5 轮:per-pane 泄漏(v0.2.9)、I4 标题串扰、U1/U4 模型残留、
// v0.2.129 draft 串扰、v0.2.131 draftId 漏点回归。改这里必须跑 npm run test:routing。

/**
 * init 事件是否应该把 session_id 绑定到当前选中的 draft。
 * 两条泄漏路径都必须拒绝(v0.2.129/131 用户实报串扰):
 *  ① 发起于真会话(resume,startedAsDraft=false)→ 永不抢绑任何 draft;
 *  ② 发起于 draft A、init 在途时用户新建 draft B → draftId 不同,不绑。
 * draftId 用严格 ===:两边都 undefined(升级前 localStorage 残留旧 draft)相等=兼容;
 * 一边有一边无=不同 draft,拒绝 —— 任何漏加 draftId 的创建点都只会"绑不上"(安全失败,
 * 会话仍在列表可点入),不会串扰(危险失败)。
 *
 * @param {boolean} startedAsDraft 发起流时是否 draft(发起时闭包 !selectedSession?.sessionId)
 * @param {*} startDraftId 发起流的 draft 的 draftId(发起时闭包,可能 undefined)
 * @param {{sessionId?:string, draftId?:*}|null} currentSel init 到达时刻的选中会话
 */
export function isInitBindingOrigin(startedAsDraft, startDraftId, currentSel) {
  return !!(startedAsDraft && currentSel && !currentSel.sessionId
    && currentSel.draftId === startDraftId);
}

/**
 * draft 队列迁移:A 流式期间排进 messageQueue[draftKey] 的消息只可能属于 A
 * (其他 draft 没有在跑的流,消息直接发出不入队),init 拿到真 sid 后必须迁走 ——
 * 否则用户切走(不绑定)时残留队列会被下一个同项目 draft(key 相同)继承串发(fable 审计)。
 * 返回新 map;队列为空/不存在返回 null(调用方不 setState)。不迁 pin:draft key 可能
 * 已被新 draft 的 seedNewSessionDefaults 覆盖,整体迁移会偷走新 draft 的设置。
 */
export function migrateDraftQueue(messageQueue, draftKey, sid) {
  const q = messageQueue?.[draftKey];
  if (!Array.isArray(q) || q.length === 0 || !sid || draftKey === sid) return null;
  const next = { ...messageQueue };
  next[sid] = [...(next[sid] || []), ...q];
  delete next[draftKey];
  return next;
}

/**
 * 历史模型回退(U1/U4):从会话消息里找最近一条真实模型 id。
 *  - 跳过 `<synthetic>` 等伪 id(/compact 摘要、错误占位;真实 id 不以 `<` 开头)——
 *    盲目回退会把伪 id 发出 → "模型不存在"(实测 /compact 后必现);
 *  - providerEpoch 门控:只信任【最近一次 provider 切换之后】的消息,否则老会话的
 *    旧 provider 模型 id(如 mimo-v2.5-pro)会发给新 provider → "无可用渠道"。
 */
export function resolveHistModel(messages, providerEpoch = 0) {
  const ms = messages || [];
  for (let i = ms.length - 1; i >= 0; i--) {
    if (!ms[i]?.model) continue;
    if (/^</.test(ms[i].model)) continue;
    if (providerEpoch && (!ms[i].timestamp || Date.parse(ms[i].timestamp) <= providerEpoch)) return null;
    return ms[i].model;
  }
  return null;
}

const bareModel = (m) => String(m || '').replace(/\[1m\]/i, '');
const isClaudeId = (m) => /^claude-[a-z0-9.-]+(\[1m\])?$/i.test(String(m || ''));

/**
 * 发送模型解析(#8/BK-0):pin → 历史 → 全局默认,且做"属于当前 provider 才用"校验。
 *  - 白名单 = availableModels(.id) ∪ customModels(用户手填,避免误杀自定义 id);
 *    比对剥 [1m] 后缀按裸 id 匹配(不破坏 1M 逻辑);
 *  - 两个列表都空(未加载)→ 不校验,维持 pin||hist||global,绝不误杀;
 *  - 官方 Anthropic 下任何 claude-* id 一律放行(availableModels 只是 settings env
 *    +别名枚举,非完整目录;否则 pin 了 claude-sonnet-4-6 会被静默回退到全局默认,
 *    徽章与实际调用不一致 —— 用户实证"选 sonnet 实跑 haiku");
 *  - 连全局都不在白名单 → 返回 null(不传 --model,让 CLI 用 settings.json 默认)。
 */
export function resolveSendModel({ pin, hist, globalModel, availableModels, customModels, officialAnthropic }) {
  const avail = Array.isArray(availableModels) ? availableModels : [];
  const custom = Array.isArray(customModels) ? customModels : [];
  if (avail.length === 0 && custom.length === 0) {
    return pin || hist || globalModel;
  }
  const ok = new Set([
    ...avail.map((m) => bareModel(m?.id)),
    ...custom.map((m) => bareModel(m)),
  ].filter(Boolean));
  const inProvider = (m) => m && (ok.has(bareModel(m)) || (officialAnthropic && isClaudeId(m)));
  if (inProvider(pin)) return pin;
  if (inProvider(hist)) return hist;
  if (inProvider(globalModel)) return globalModel;
  return null;
}

/**
 * 串扰窗口1守卫(第226轮主诉:切会话瞬间代办/计划/费用/模型徽章短暂串显):
 * pane 的历史消息(paneMessages)是否归属当前查看的会话。切会话只换 paneSessions,
 * paneMessages 等 fetch 异步覆盖 —— 归属标记(paneMessagesSid)≠当前 sessionId 时
 * 渲染层必须把历史当空数组,不许显示上个会话的内容。
 * 归一:draft/空窗格两侧都是 null(falsy 归一为 null 再比较,undefined===null 视为同)。
 * @param {string|null|undefined} paneSid  paneMessagesSid[tabIndex](这批消息属于谁)
 * @param {string|null|undefined} sessionId 当前 pane 会话的 sessionId(draft 为 null)
 */
export function paneMessagesOwned(paneSid, sessionId) {
  return (paneSid || null) === (sessionId || null);
}
