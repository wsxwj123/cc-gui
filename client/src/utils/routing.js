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
 * r29:conversation_reset 换绑判定(CLI 2.1.x /clear = 轮换新会话语义)。
 * /clear 的流由【真会话】发起(startedAsDraft=false),isInitBindingOrigin 恒 false,
 *  subsequent init(新 sid)永远绑不上 → 窗格挂在旧会话上,新会话成了"没清成"。
 * 口径:本流见过 conversation_reset(记下的旧 sid)且当前选中仍是那个旧会话,
 * 才允许把窗格换绑到 init 带来的新 sid。用户已切走(sel 变了)不抢绑 —— 与
 * isInitBindingOrigin 同一安全失败哲学:绑不上只是列表里多一条会话,串扰才是事故。
 * @param {string|null} resetFromSid 本流 conversation_reset 事件携带的旧 session_id
 * @param {{sessionId?:string}|null} currentSel init 到达时刻的选中会话
 */
export function isResetBindingOrigin(resetFromSid, currentSel) {
  return !!(resetFromSid && currentSel && currentSel.sessionId === resetFromSid);
}

/**
 * r29:CLI 2.1.x 二进制内置的占位串 "(no content)"(/clear 等空结果回合会把它当
 * assistant 文本增量吐进流)。/clear 场景下它视同空串 —— 否则回合收尾会把占位串
 * 当正常回复画成气泡,走不到 ✅「会话已清空」分支(占位串不是用户可见内容)。
 * 只在 isClear 判定下使用:正常回合里模型真说出 "(no content)" 不该被吞。
 */
export function isCliNoContentPlaceholder(text) {
  return String(text || '').trim() === '(no content)';
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
  // 合并必须按 queuedAt 升序,不能简单拼接:draft 期间入队的消息(早)若排在 real sid
  // 已有队列(晚)之后,出队顺序颠倒 —— 先发的 A(draft 期)反而在后发的 B 之后发出。
  // 无 queuedAt 的历史数据按 0 兜底(stable sort 保持原相对顺序)。
  next[sid] = [...(next[sid] || []), ...q].sort((a, b) => (a?.queuedAt || 0) - (b?.queuedAt || 0));
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

/**
 * r16-1:「这个模型属不属于当前 provider」的白名单判据 —— 发送路径与显示路径共用。
 * 此前只有发送路径(resolveSendModel)有,显示路径(resolveSelectorModel)没有,于是
 * store 里任何来源的陈旧值(切 provider 竞速、fetchModel 的 `if (data.model)` 守卫
 * 让服务端空响应保留旧值、跨设备同步、ws 重连水合)都会被原样显示,而下拉列表来自
 * 新 provider 的 available → 症状即"顶栏显示 deepseek-v4-flash,点开列表里却没有"。
 * 发送不受影响(它一直有校验),所以只错在显示。
 *
 * 语义与原实现逐字一致:
 *  - 两个列表都空(未加载)→ 一律放行,绝不误杀(否则启动瞬间徽章空白);
 *  - 比对剥 [1m] 后的裸 id(不破坏 1M 逻辑);
 *  - 官方 Anthropic 下任何 claude-* 放行(availableModels 只是 settings env + 别名
 *    枚举,不是完整目录;否则 pin 了 claude-sonnet-4-6 会被误杀)。
 */
export function makeProviderModelGuard({ availableModels, customModels, officialAnthropic }) {
  const avail = Array.isArray(availableModels) ? availableModels : [];
  const custom = Array.isArray(customModels) ? customModels : [];
  if (avail.length === 0 && custom.length === 0) return () => true;
  const ok = new Set([
    ...avail.map((m) => bareModel(m?.id)),
    ...custom.map((m) => bareModel(m)),
  ].filter(Boolean));
  return (m) => !!m && (ok.has(bareModel(m)) || (officialAnthropic && isClaudeId(m)));
}

/**
 * 选择器侧「当前模型」解析:模型下拉与 1M 开关显示/操作的那个模型。
 * 必须与徽章(App.jsx pin → 历史 → 全局 + context1m 兜底)和发送(resolveSendModel)同口径。
 * 旧实现只有 `pin || global`,两处后果:
 *  ① 无 pin 的老会话下拉显示的是全局默认模型,点 1M 开关会把会话静默 pin 成【另一个模型】[1m]
 *    —— 用户只想开 1M,模型被换了且没有提示;
 *  ② 手机页(MobileModelPage)连 context1m 标记都没叠,重装丢 pin 后开关显示"关",
 *    与徽章/发送反向,用户想关反而点成开。
 * 历史这一环用会话元数据 model —— 徽章在 messages 未加载时用的同一来源(选择器拿不到
 * messages),并沿用同样的 providerEpoch 门控:切过 provider 后不信任无时间戳的元数据,
 * 否则会把旧 provider 的模型 id 显示/pin 给新 provider(U1/U4 同一族)。
 * @param {object} s store 状态(读 modelBySession/paneSessions/selectedSession/currentModel/providerEpoch/context1mBySession)
 * @param {string|null} permKey 会话 key(真会话 = sessionId,草稿 = `draft-<hash>`)
 * @returns {string} 模型 id(可能带 [1m]);无从解析时返回全局默认(可能为空串)
 */
export function resolveSelectorModel(s, permKey) {
  if (!s) return '';
  // r16-1:pin 与历史都要过"属于当前 provider"这关(与发送路径同一判据);
  // s.currentModel 是服务端按 settings.json 解析的结果,天然属于当前 provider,无条件信任
  // —— 它兜底,所以校验失败时不会落空。
  // 门槛比发送侧更宽一档:只要 availableModels 还没加载就整段跳过校验。
  // (guard 自己的"未加载"判据是【两个列表都空】,而 customModels 从 localStorage 同步
  //  读出、开机即非空 —— 只要用户加过一个自定义模型,开机那一小段白名单里就只有那一个
  //  id,第三方用户的徽章会闪一下全局默认再跳回 pin。发送侧不能这么放宽:它宁可回落也
  //  不能把不存在的模型发上去。)
  const inProvider = (Array.isArray(s.availableModels) && s.availableModels.length)
    ? makeProviderModelGuard({
      availableModels: s.availableModels,
      customModels: s.customModels,
      officialAnthropic: (s.currentProvider?.providerHint || 'anthropic') === 'anthropic',
    })
    : () => true;
  const rawPin = permKey ? s.modelBySession?.[permKey] : null;
  const pin = inProvider(rawPin) ? rawPin : null;
  const rawMeta = (permKey && !s.providerEpoch)
    ? [...(s.paneSessions || []), s.selectedSession].find((x) => x?.sessionId === permKey)?.model
    : null;
  const meta = inProvider(rawMeta) ? rawMeta : null;
  const base = pin || meta || s.currentModel;
  const ctx1m = permKey ? !!s.context1mBySession?.[permKey] : false;
  return (base && ctx1m && !/\[1m\]/i.test(base)) ? `${base}[1m]` : base;
}

const bareModel = (m) => String(m || '').replace(/\[1m\]/i, '');
// 官方 Anthropic 下的兜底豁免判据。**故意比服务端 model-resolver.js 的 isClaudeModel
// 更严**:那个是 /claude/i 子串匹配(用于"这个 id 是不是外来残留"的宽松体检),这个是前缀
// 锚定(用于"要不要跳过白名单直接放行"的授权判定)。宽松判据用在授权位会把
// `anthropic.claude-v2` 这类也放行。两者门控条件也不同(那个按 provider==='Anthropic',
// 这个按 currentProvider.providerHint),改任一处前先确认另一处的用途。
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
  const inProvider = makeProviderModelGuard({ availableModels: avail, customModels: custom, officialAnthropic });
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
