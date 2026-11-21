// r196:窗格发送(App.jsx handleSend)与后台排空共用的「组 POST /api/chat 请求体」。
// 纯函数:不读状态库、不发请求、不写任何东西。调用方把各自口径取到的值作为输入传进来 —— 窗格读本窗格当前会话,
// 后台排空按队列键与入队快照取 —— 同一组输入两边组出的请求体逐字相同(单测 check-r196-chat-request-body 锁定)。
import { resolveSendModel } from './routing.js';
import { isThirdPartyProvider } from './autoAudit.js';
import { effortCapsFor, effortAllowed } from './effortCaps.js';

/**
 * 请求体的 cwd(与窗格原表达式逐字相同)。恢复已有会话时 cwd 必须是命令行当初启动时的原串:服务端从会话记录第一条
 * 系统记录里读出真实 cwd,作为 projectPath 放在会话对象上,优先用它;没有才用工作区路径。
 */
export function chatCwdFor(session, project) {
  return (session?.sessionId && session?.projectPath)
    ? session.projectPath
    : (session?.projectPath || project?.path);
}

/** 第三方 provider 下「自动」档被降为逐步确认时给的提示(窗格与后台排空共用这一份文字)。 */
export const AUTO_DOWNGRADE_NOTICE = '「自动」权限档在第三方 provider 下默认关闭，本会话已切回「逐步确认」。可在 设置 → 权限 中开启。';

/**
 * 第三方 provider 下「自动」档的门控(修正批#5 / r151a):第三方(判据读审核状态的 official,与服务端同判据)且第三方
 * auto 总开关没开 → 降为逐步确认。只判定,不写回 —— 写回档位与提示是调用方的副作用。
 * @returns {{ permissionMode: string, downgraded: boolean }}
 */
export function gateThirdPartyAuto(permissionMode, autoAuditStatus, providerHint) {
  if (permissionMode === 'auto' && isThirdPartyProvider(autoAuditStatus, providerHint) && autoAuditStatus?.enabled !== true) {
    return { permissionMode: 'default', downgraded: true };
  }
  return { permissionMode, downgraded: false };
}

/**
 * 组 /api/chat 请求体。字段与顺序和窗格改前的对象字面量逐字相同(JSON 键序 = 写入顺序;值为 undefined 的字段不进 JSON)。
 * 跨会话凭据字段(点卡片【处理】发出的那条才有)不经这里:窗格在请求体末尾展开,位置与改前相同;后台排空不发这类条目。
 *
 * 输入(都可缺省):
 *  - 回合:prompt、clientTurnId、serverEpoch、sessionId(没有 = 新会话)、draftId(只在没有 sessionId 时带)、cwd、
 *    isCompact(/compact 剥掉 [1m])、appendSystemPrompt、agent。
 *  - 权限:permissionMode(调用方按各自口径取好的档位)、autoAuditStatus、providerHint(第三方 auto 门控用)。
 *  - 模型:modelPin、histModel、globalModel、availableModels、customModels、officialAnthropic(交给 resolveSendModel)、
 *    context1m(该会话开了 1M 时补 [1m])。
 *  - 思考强度:effort(按会话取的原值)、modelEffortMeta(模型能力门控)。
 *  - 全局设置:addDirs、globalRead、keepAlive(= persistentChat)、maxBudgetUsd、promptSuggestions、genui(= genuiRender)。
 *    这几项的归一化(`!== false`、`|| undefined`)是幂等的:传状态库原值或传已归一化的值,结果相同。
 * @returns {{ body: object, autoDowngraded: boolean, model: (string|null) }}
 *   model = 本次实际发送用的模型(已补 [1m]、未按 /compact 剥 [1m]),窗格记作 sentModel;
 *   autoDowngraded = 这里把「自动」降成了逐步确认(调用方据此写回档位、给提示)。
 */
export function buildChatRequestBody(input = {}) {
  const {
    prompt, clientTurnId, serverEpoch, sessionId, draftId, cwd, isCompact = false,
    appendSystemPrompt, agent,
    permissionMode: requestedMode, autoAuditStatus, providerHint,
    modelPin, histModel, globalModel, availableModels, customModels, officialAnthropic, context1m,
    effort: requestedEffort, modelEffortMeta,
    addDirs, globalRead, keepAlive, maxBudgetUsd, promptSuggestions, genui,
  } = input || {};
  const gate = gateThirdPartyAuto(requestedMode, autoAuditStatus, providerHint);
  // 模型:pin → 历史模型 → 全局默认,过当前 provider 白名单(routing.resolveSendModel);1M 标记兜底与徽章同一规则。
  let model = resolveSendModel({
    pin: modelPin,
    hist: histModel,
    globalModel,
    availableModels,
    customModels,
    officialAnthropic,
  });
  if (context1m && model && !/\[1m\]/i.test(model)) model = model + '[1m]';
  // r10-9:模型声明不支持思考或该档不支持时不传 effort(发送侧防御 pin 残留 / 竞态)。
  let effort = requestedEffort;
  if (effort && !effortAllowed(effortCapsFor(modelEffortMeta, model), effort)) effort = '';
  const body = {
    prompt,
    clientTurnId,
    serverEpoch: serverEpoch || undefined,
    // 新会话(没有 sessionId)不带,命令行另起一个新会话
    sessionId: sessionId || undefined,
    // 新会话带 draftId(存进服务端进程槽):初始化前切走再切回时轮询按它找回本进程接流
    draftId: (!sessionId && draftId) ? draftId : undefined,
    cwd,
    // /compact 用标准上下文压缩:剥掉 [1m](Anthropic 上 1M 压缩会报 "Usage credits required for 1M context")
    model: isCompact ? String(model || '').replace(/\[1m\]/i, '') : model,
    effort: effort || undefined,
    appendSystemPrompt: appendSystemPrompt || undefined,
    addDirs: addDirs && addDirs.length ? addDirs : undefined,
    permissionMode: gate.permissionMode || 'default',
    globalRead: globalRead !== false,
    agent: agent || undefined,
    keepAlive: keepAlive !== false,
    maxBudgetUsd: maxBudgetUsd || undefined,
    promptSuggestions,
    genui: genui !== false,
  };
  return { body, autoDowngraded: gate.downgraded, model };
}
