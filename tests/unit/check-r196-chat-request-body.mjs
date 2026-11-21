// r196 T2:窗格发送的 /api/chat 请求体抽到 client/src/utils/chatRequest.js 之后,与改前逐字相同。
//   B1 固定输入 → 固定输出(字面量):五组输入覆盖官方 / 第三方、auto 降档 / 不降、pin 失效回落历史、1M 补位、/compact 剥 [1m]、
//      强度被模型能力门控掉、新会话(draftId + agent)、cwd 回落工作区、模型解析为空、跨会话凭据字段在末尾。
//      每组同时用「改前的写法」(从 cbeb0f5ef 的 App.jsx handleSend 逐行誊写,状态库读数换成输入)算一遍,三者逐字相同。
//   B2 后台排空式输入(档位不预先门控、全局设置传状态库原值)与窗格式输入组出的请求体逐字相同,降档经 autoDowngraded 报出。
//   B3 chatCwdFor、gateThirdPartyAuto 单独核对。
//   B4 源码守卫:App.jsx 的 handleSend 经 buildChatRequestBody 组请求体、输入映射与本测试誊写的一致,跨会话凭据仍在末尾展开。
// node tests/unit/check-r196-chat-request-body.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildChatRequestBody, chatCwdFor, gateThirdPartyAuto } from '../../client/src/utils/chatRequest.js';
import { resolveHistModel, resolveSendModel } from '../../client/src/utils/routing.js';
import { isThirdPartyProvider } from '../../client/src/utils/autoAudit.js';
import { effortCapsFor, effortAllowed } from '../../client/src/utils/effortCaps.js';

let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const ok = (c, m) => { assert.ok(c, m); checks++; };

// 改前的写法:App.jsx(cbeb0f5ef)handleSend 里 `const { addDirs, globalRead } = useStore.getState();` 到 fetch 请求体为止,
// 逐行誊写;useStore.getState() 换成 w.store,getPermissionModeFor / getEffortFor / getActiveAgentFor 换成 w.store 上的取值。
function oldPaneBody(w) {
  const { addDirs, globalRead } = w.store;
  let permissionMode = w.store.permissionModeFor;
  if (permissionMode === 'auto') {
    const _stAuto = w.store;
    if (isThirdPartyProvider(_stAuto.autoAuditStatus, _stAuto.currentProvider?.providerHint) && _stAuto.autoAuditStatus?.enabled !== true) {
      permissionMode = 'default';
    }
  }
  const _stM = w.store;
  const _officialM = (_stM.currentProvider?.providerHint || 'anthropic') === 'anthropic';
  const _pin = _stM.modelBySession[w.sessionQueueKey];
  const _hist = resolveHistModel(w.localMessages, _stM.providerEpoch || 0, _officialM);
  let currentModel = resolveSendModel({
    pin: _pin, hist: _hist, globalModel: _stM.currentModel, availableModels: _stM.availableModels,
    customModels: _stM.customModels, officialAnthropic: _officialM,
  });
  const selectedSession = w.selectedSession;
  const _c1m = selectedSession?.sessionId && _stM.context1mBySession?.[selectedSession.sessionId];
  if (_c1m && currentModel && !/\[1m\]/i.test(currentModel)) currentModel = currentModel + '[1m]';
  const sentModel = currentModel;
  let effort = w.store.effortFor;
  if (effort && !effortAllowed(effortCapsFor(w.store.modelEffortMeta, currentModel), effort)) effort = '';
  const sid = selectedSession?.sessionId;
  const activeAgent = !sid ? w.store.activeAgentFor : '';
  const chatCwd = (sid && selectedSession?.projectPath)
    ? selectedSession.projectPath
    : (selectedSession?.projectPath || w.selectedProject?.path);
  const { prompt, clientTurnId, turnEpoch, isCompact, appendSystemPrompt, _suggestPref, xsFields } = w;
  const json = JSON.stringify({
    prompt,
    clientTurnId,
    serverEpoch: turnEpoch || undefined,
    sessionId: sid || undefined,
    draftId: (!sid && selectedSession?.draftId) ? selectedSession.draftId : undefined,
    cwd: chatCwd,
    model: isCompact ? String(currentModel || '').replace(/\[1m\]/i, '') : currentModel,
    effort: effort || undefined,
    appendSystemPrompt: appendSystemPrompt || undefined,
    addDirs: addDirs && addDirs.length ? addDirs : undefined,
    permissionMode: permissionMode || 'default',
    globalRead: globalRead !== false,
    agent: activeAgent || undefined,
    keepAlive: w.store.persistentChat !== false,
    maxBudgetUsd: w.store.maxBudgetUsd || undefined,
    promptSuggestions: _suggestPref,
    genui: w.store.genuiRender !== false,
    ...(xsFields || {}),
  });
  return { json, sentModel };
}

// 改后的窗格:与 App.jsx 现在的写法相同(B4 核对 App.jsx 里的输入映射与这里一致)。
function newPaneBody(w) {
  const { addDirs, globalRead } = w.store;
  let permissionMode = w.store.permissionModeFor;
  const _stAuto = w.store;
  if (gateThirdPartyAuto(permissionMode, _stAuto.autoAuditStatus, _stAuto.currentProvider?.providerHint).downgraded) {
    permissionMode = 'default';
  }
  const _stM = w.store;
  const _officialM = (_stM.currentProvider?.providerHint || 'anthropic') === 'anthropic';
  const _pin = _stM.modelBySession[w.sessionQueueKey];
  const _hist = resolveHistModel(w.localMessages, _stM.providerEpoch || 0, _officialM);
  const selectedSession = w.selectedSession;
  const _c1m = selectedSession?.sessionId && _stM.context1mBySession?.[selectedSession.sessionId];
  const _effortRaw = w.store.effortFor;
  const _effortMeta = w.store.modelEffortMeta;
  const sid = selectedSession?.sessionId;
  const activeAgent = !sid ? w.store.activeAgentFor : '';
  const chatCwd = chatCwdFor(selectedSession, w.selectedProject);
  const { prompt, clientTurnId, turnEpoch, isCompact, appendSystemPrompt, _suggestPref, xsFields } = w;
  const _chatReq = buildChatRequestBody({
    prompt,
    clientTurnId,
    serverEpoch: turnEpoch,
    sessionId: sid,
    draftId: selectedSession?.draftId,
    cwd: chatCwd,
    isCompact,
    appendSystemPrompt,
    agent: activeAgent,
    permissionMode,
    autoAuditStatus: _stAuto.autoAuditStatus,
    providerHint: _stAuto.currentProvider?.providerHint,
    modelPin: _pin,
    histModel: _hist,
    globalModel: _stM.currentModel,
    availableModels: _stM.availableModels,
    customModels: _stM.customModels,
    officialAnthropic: _officialM,
    context1m: _c1m,
    effort: _effortRaw,
    modelEffortMeta: _effortMeta,
    addDirs,
    globalRead,
    keepAlive: w.store.persistentChat !== false,
    maxBudgetUsd: w.store.maxBudgetUsd || undefined,
    promptSuggestions: _suggestPref,
    genui: w.store.genuiRender !== false,
  });
  return { json: JSON.stringify({ ..._chatReq.body, ...(xsFields || {}) }), sentModel: _chatReq.model, autoDowngraded: _chatReq.autoDowngraded };
}

const EPOCH = Date.parse('2026-11-01T00:00:00Z');
const OFFICIAL = { currentProvider: { providerHint: 'anthropic' }, autoAuditStatus: { official: true, enabled: false } };
const CASES = [
  {
    name: '官方 + pin + 1M 补位 + 强度放行 + 额外目录 + 花费上限 + genui 关',
    w: {
      store: { ...OFFICIAL, permissionModeFor: 'acceptEdits', modelBySession: { S1: 'claude-opus-4-6' }, providerEpoch: 0,
        currentModel: 'claude-sonnet-4-6', availableModels: [], customModels: [], context1mBySession: { S1: true },
        effortFor: 'high', modelEffortMeta: {}, activeAgentFor: 'planner', addDirs: ['/extra'], globalRead: undefined,
        persistentChat: true, maxBudgetUsd: 5, genuiRender: false },
      localMessages: [], sessionQueueKey: 'S1', selectedSession: { sessionId: 'S1', projectPath: '/w/a' }, selectedProject: { path: '/w/other' },
      prompt: 'hello', clientTurnId: 'ct-1', turnEpoch: 'ep-1', isCompact: false, appendSystemPrompt: undefined, _suggestPref: 'auto', xsFields: null,
    },
    json: '{"prompt":"hello","clientTurnId":"ct-1","serverEpoch":"ep-1","sessionId":"S1","cwd":"/w/a","model":"claude-opus-4-6[1m]","effort":"high","addDirs":["/extra"],"permissionMode":"acceptEdits","globalRead":true,"keepAlive":true,"maxBudgetUsd":5,"promptSuggestions":"auto","genui":false}',
    sentModel: 'claude-opus-4-6[1m]',
  },
  {
    name: '第三方 + auto 未开 → 逐步确认;失效 pin 回落历史模型;强度被能力门控掉;常驻关、全局读关',
    w: {
      store: { currentProvider: { providerHint: 'deepseek' }, autoAuditStatus: { official: false, enabled: false },
        permissionModeFor: 'auto', modelBySession: { S2: 'mimo-v2.5-pro' }, providerEpoch: EPOCH,
        currentModel: 'deepseek-v4-flash', availableModels: [{ id: 'deepseek-v4' }, { id: 'deepseek-v4-flash' }], customModels: [],
        context1mBySession: {}, effortFor: 'max', modelEffortMeta: { 'deepseek-v4': { reasoning: false } }, activeAgentFor: '',
        addDirs: [], globalRead: false, persistentChat: false, maxBudgetUsd: 0, genuiRender: undefined },
      localMessages: [{ model: 'deepseek-v4', timestamp: '2026-11-10T00:00:00Z' }, { model: '<synthetic>', timestamp: '2026-11-11T00:00:00Z' }],
      sessionQueueKey: 'S2', selectedSession: { sessionId: 'S2', projectPath: '/w/b' }, selectedProject: null,
      prompt: 'p2', clientTurnId: 'ct-2', turnEpoch: null, isCompact: false, appendSystemPrompt: 'sys', _suggestPref: true, xsFields: null,
    },
    json: '{"prompt":"p2","clientTurnId":"ct-2","sessionId":"S2","cwd":"/w/b","model":"deepseek-v4","appendSystemPrompt":"sys","permissionMode":"default","globalRead":false,"keepAlive":false,"promptSuggestions":true,"genui":true}',
    sentModel: 'deepseek-v4',
  },
  {
    name: '/compact 剥 [1m](sentModel 不剥)+ 跨会话凭据字段在末尾',
    w: {
      store: { ...OFFICIAL, permissionModeFor: 'plan', modelBySession: { S3: 'claude-opus-4-6[1m]' }, providerEpoch: EPOCH,
        currentModel: 'claude-sonnet-4-6', availableModels: [], customModels: [], context1mBySession: { S3: true },
        effortFor: '', modelEffortMeta: {}, activeAgentFor: 'x', addDirs: undefined, globalRead: true,
        persistentChat: undefined, maxBudgetUsd: undefined, genuiRender: true },
      localMessages: [], sessionQueueKey: 'S3', selectedSession: { sessionId: 'S3', projectPath: '/w/c' }, selectedProject: { path: '/w/c2' },
      prompt: '/compact', clientTurnId: 'ct-3', turnEpoch: 'ep-3', isCompact: true, appendSystemPrompt: '', _suggestPref: undefined,
      xsFields: { xsMessageId: 'm1', xsToken: 't1' },
    },
    json: '{"prompt":"/compact","clientTurnId":"ct-3","serverEpoch":"ep-3","sessionId":"S3","cwd":"/w/c","model":"claude-opus-4-6","permissionMode":"plan","globalRead":true,"keepAlive":true,"genui":true,"xsMessageId":"m1","xsToken":"t1"}',
    sentModel: 'claude-opus-4-6[1m]',
  },
  {
    name: '新会话:带 draftId 与 agent,cwd 回落工作区,全局默认模型过白名单',
    w: {
      store: { ...OFFICIAL, permissionModeFor: undefined, modelBySession: {}, providerEpoch: 0,
        currentModel: 'claude-sonnet-4-6', availableModels: [{ id: 'claude-sonnet-4-6' }], customModels: [], context1mBySession: {},
        effortFor: undefined, modelEffortMeta: {}, activeAgentFor: 'reviewer', addDirs: [], globalRead: undefined,
        persistentChat: true, maxBudgetUsd: undefined, genuiRender: true },
      localMessages: [], sessionQueueKey: 'draft-xyz', selectedSession: { draftId: 'draft-xyz' }, selectedProject: { path: '/w/d' },
      prompt: 'p4', clientTurnId: 'ct-4', turnEpoch: 'ep-4', isCompact: false, appendSystemPrompt: undefined, _suggestPref: false, xsFields: null,
    },
    json: '{"prompt":"p4","clientTurnId":"ct-4","serverEpoch":"ep-4","draftId":"draft-xyz","cwd":"/w/d","model":"claude-sonnet-4-6","permissionMode":"default","globalRead":true,"agent":"reviewer","keepAlive":true,"promptSuggestions":false,"genui":true}',
    sentModel: 'claude-sonnet-4-6',
  },
  {
    name: '第三方 auto 已开 → 原样发 auto;白名单里一个都不对 → model 为 null;projectPath 为空串回落工作区',
    w: {
      store: { currentProvider: { providerHint: 'openrouter' }, autoAuditStatus: { official: false, enabled: true },
        permissionModeFor: 'auto', modelBySession: { S5: 'stale1' }, providerEpoch: EPOCH,
        currentModel: 'stale3', availableModels: [{ id: 'x-model' }], customModels: [], context1mBySession: { S5: true },
        effortFor: 'low', modelEffortMeta: {}, activeAgentFor: '', addDirs: undefined, globalRead: undefined,
        persistentChat: true, maxBudgetUsd: 2.5, genuiRender: true },
      localMessages: [{ model: 'old-model', timestamp: '2026-10-01T00:00:00Z' }],
      sessionQueueKey: 'S5', selectedSession: { sessionId: 'S5', projectPath: '' }, selectedProject: { path: '/w/e' },
      prompt: 'p5', clientTurnId: 'ct-5', turnEpoch: 'ep-5', isCompact: false, appendSystemPrompt: undefined, _suggestPref: 'auto', xsFields: null,
    },
    json: '{"prompt":"p5","clientTurnId":"ct-5","serverEpoch":"ep-5","sessionId":"S5","cwd":"/w/e","model":null,"effort":"low","permissionMode":"auto","globalRead":true,"keepAlive":true,"maxBudgetUsd":2.5,"promptSuggestions":"auto","genui":true}',
    sentModel: null,
  },
];

// ── B1 固定输入 → 固定输出;改前写法与改后写法逐字相同 ─────────────────────────────────────────
for (const c of CASES) {
  const before = oldPaneBody(c.w);
  const after = newPaneBody(c.w);
  eq(before.json, c.json, `B1 ${c.name}:改前写法 = 字面量`);
  eq(after.json, c.json, `B1 ${c.name}:改后写法 = 字面量(与改前逐字相同)`);
  eq([before.sentModel, after.sentModel], [c.sentModel, c.sentModel], `B1 ${c.name}:sentModel 相同`);
  eq(after.autoDowngraded, false, `B1 ${c.name}:窗格传进去的是门控后的档位,组请求体时不再降档`);
}

// ── B2 后台排空式输入:档位不预先门控、全局设置传状态库原值 → 请求体与窗格式输入逐字相同 ─────────────────
for (const c of CASES) {
  const w = c.w;
  const s = w.store;
  const official = (s.currentProvider?.providerHint || 'anthropic') === 'anthropic';
  const sid = w.selectedSession?.sessionId;
  const r = buildChatRequestBody({
    prompt: w.prompt, clientTurnId: w.clientTurnId, serverEpoch: w.turnEpoch, sessionId: sid, draftId: w.selectedSession?.draftId,
    cwd: chatCwdFor(w.selectedSession, w.selectedProject), isCompact: w.isCompact, appendSystemPrompt: w.appendSystemPrompt,
    agent: !sid ? s.activeAgentFor : '',
    permissionMode: s.permissionModeFor, autoAuditStatus: s.autoAuditStatus, providerHint: s.currentProvider?.providerHint,
    modelPin: s.modelBySession[w.sessionQueueKey], histModel: resolveHistModel(w.localMessages, s.providerEpoch || 0, official),
    globalModel: s.currentModel, availableModels: s.availableModels, customModels: s.customModels, officialAnthropic: official,
    context1m: sid && s.context1mBySession?.[sid], effort: s.effortFor, modelEffortMeta: s.modelEffortMeta,
    addDirs: s.addDirs, globalRead: s.globalRead, keepAlive: s.persistentChat, maxBudgetUsd: s.maxBudgetUsd,
    promptSuggestions: w._suggestPref, genui: s.genuiRender,
  });
  eq(JSON.stringify({ ...r.body, ...(w.xsFields || {}) }), c.json, `B2 ${c.name}:后台式输入组出同一份请求体`);
  const expectDowngrade = s.permissionModeFor === 'auto' && s.autoAuditStatus?.official === false && s.autoAuditStatus?.enabled !== true;
  eq(r.autoDowngraded, expectDowngrade, `B2 ${c.name}:autoDowngraded = ${expectDowngrade}`);
}
// 后台排空在返回的 body 上只多加 queuedDrain:去掉它之后与窗格逐字相同
{
  const r = buildChatRequestBody({ prompt: 'q', clientTurnId: 'ct-q', sessionId: 'S9', cwd: '/w/q', permissionMode: 'default', globalModel: 'm' });
  const withDrain = JSON.parse(JSON.stringify({ ...r.body, queuedDrain: true }));
  delete withDrain.queuedDrain;
  eq(JSON.stringify(withDrain), JSON.stringify(r.body), 'B2:去掉 queuedDrain 后逐字相同');
  eq(JSON.stringify(buildChatRequestBody().body), '{"permissionMode":"default","globalRead":true,"keepAlive":true,"genui":true}', 'B2:空输入不抛错,只剩默认值');
}

// ── B3 小函数(resolveHistModel 的拆分在 check-r196-hist-model-split 里核对) ─────────────────────────────
{
  eq(chatCwdFor({ sessionId: 's', projectPath: '/p' }, { path: '/q' }), '/p', 'B3:chatCwdFor 已有会话用 projectPath');
  eq(chatCwdFor({ projectPath: '/p' }, { path: '/q' }), '/p', 'B3:chatCwdFor 草稿有 projectPath 也用它');
  eq(chatCwdFor({ sessionId: 's' }, { path: '/q' }), '/q', 'B3:chatCwdFor 没有 projectPath 回落工作区');
  eq(chatCwdFor(null, null), undefined, 'B3:chatCwdFor 都没有 → undefined');

  eq(gateThirdPartyAuto('auto', { official: false, enabled: false }, 'x'), { permissionMode: 'default', downgraded: true }, 'B3:第三方 auto 未开 → 降档');
  eq(gateThirdPartyAuto('auto', { official: false, enabled: true }, 'x'), { permissionMode: 'auto', downgraded: false }, 'B3:第三方 auto 已开 → 不降');
  eq(gateThirdPartyAuto('auto', { official: true }, 'deepseek'), { permissionMode: 'auto', downgraded: false }, 'B3:审核状态说官方 → 不降(优先于 providerHint)');
  eq(gateThirdPartyAuto('auto', null, 'deepseek'), { permissionMode: 'default', downgraded: true }, 'B3:没有审核状态时按 providerHint 判第三方');
  eq(gateThirdPartyAuto('acceptEdits', { official: false, enabled: false }, 'x'), { permissionMode: 'acceptEdits', downgraded: false }, 'B3:非 auto 档不动');
}

// ── B4 源码守卫:App.jsx 的发送块调用 buildChatRequestBody,输入映射与上面的 newPaneBody 一致 ─────────────────────
{
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const app = readFileSync(join(ROOT, 'client', 'src', 'App.jsx'), 'utf8');
  const hsHead = 'const handleSend = useCallback(async (prompt, opts = {}) => {';
  const hs = app.indexOf(hsHead);
  ok(hs > 0, 'B4:找到 handleSend');
  const he = app.indexOf('= useCallback(', hs + hsHead.length);
  const body = app.slice(hs, he > 0 ? he : undefined);
  const callAt = body.indexOf('const _chatReq = buildChatRequestBody({');
  ok(callAt > 0, 'B4:handleSend 经 buildChatRequestBody 组请求体');
  const call = body.slice(callAt, body.indexOf('});', callAt));
  const code = call.split('\n').filter((l) => !/^\s*\/\//.test(l)).map((l) => l.trim()).filter(Boolean);
  eq(code, [
    'const _chatReq = buildChatRequestBody({',
    'prompt,', 'clientTurnId,', 'serverEpoch: turnEpoch,', 'sessionId: sid,', 'draftId: selectedSession?.draftId,', 'cwd: chatCwd,',
    'isCompact,', 'appendSystemPrompt,', 'agent: activeAgent,', 'permissionMode,',
    'autoAuditStatus: _stAuto.autoAuditStatus,', 'providerHint: _stAuto.currentProvider?.providerHint,',
    'modelPin: _pin,', 'histModel: _hist,', 'globalModel: _stM.currentModel,', 'availableModels: _stM.availableModels,',
    'customModels: _stM.customModels,', 'officialAnthropic: _officialM,', 'context1m: _c1m,', 'effort: _effortRaw,',
    'modelEffortMeta: _effortMeta,', 'addDirs,', 'globalRead,',
    'keepAlive: useStore.getState().persistentChat !== false,', 'maxBudgetUsd: useStore.getState().maxBudgetUsd || undefined,',
    'promptSuggestions: _suggestPref,', 'genui: useStore.getState().genuiRender !== false,',
  ], 'B4:输入映射逐行与本测试誊写的窗格写法一致');
  for (const line of [
    'let permissionMode = useStore.getState().getPermissionModeFor(sessionQueueKey);',
    'if (gateThirdPartyAuto(permissionMode, _stAuto.autoAuditStatus, _stAuto.currentProvider?.providerHint).downgraded) {',
    'const _pin = _stM.modelBySession[sessionQueueKey];',
    'const _hist = resolveHistModel(getLocalMessages(), _stM.providerEpoch || 0, _officialM);',
    'const _c1m = selectedSession?.sessionId && _stM.context1mBySession?.[selectedSession.sessionId];',
    'const _effortRaw = useStore.getState().getEffortFor(sessionQueueKey);',
    'const _effortMeta = useStore.getState().modelEffortMeta;',
    'const chatCwd = chatCwdFor(selectedSession, selectedProject);',
    'sentModel = _chatReq.model; // r146 R6:见声明处',
  ]) ok(body.includes(line), `B4:handleSend 里有「${line}」`);
  const post = body.slice(body.indexOf("const res = await fetch('/api/chat', {"));
  ok(/body: JSON\.stringify\(\{\s*\.\.\._chatReq\.body,[\s\S]*?\.\.\.\(xsFields \|\| \{\}\),\s*\}\),/.test(post.slice(0, 800)), 'B4:请求体 = 共用函数的结果 + 末尾展开跨会话凭据');
  ok(!/model: isCompact \? String\(currentModel/.test(body), 'B4:handleSend 里不再有自己拼的 model 字段');
}

console.log(`✓ check-r196-chat-request-body:${checks} 项断言全部通过`);
