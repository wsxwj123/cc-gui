// 子代理(子任务)的【身份 / 来源 / 历史读法】单一实现。
// 三处消费:监控面板(列表与「查看」)、Task 卡(翻历史时水合)、子代理视图(来源标注与停止按钮)。
// 身份 = parentSessionId + toolUseId(与窗格位置/模型名无关);转写读法 = agentSessionId
// + 它所属项目的 projectHash。本文件不 import React/DOM,node 直跑的单测可直接引它。
//
// 为什么不各写一份:任务卡过去把历史按 text/thinking/toolCalls 三个数组拍平再自己拼,
// 时序当场丢失(工具与正文的交错全没了);监控面板又只吃活流,跑完的子代理 0 条目。
// 同一份判据只写一遍,三处才可能长期一致。

export const TASK_TOOL_NAMES = new Set(['Task', 'Agent']);
// 终态词汇与 server 的 AGENT_TERMINAL_STATUSES 同一套(GUI 侧写 done/error/stopped)。
export const AGENT_TERMINAL_STATUSES = new Set(['done', 'error', 'stopped']);
// CLI 的 task-notification 用的是另一套拼写(completed/failed/stopped/killed)—— 两套都要认,
// 但别混用:GUI 条目状态不会写 'completed',通知里也不会写 'done'。
const NOTICE_TERMINAL_STATUSES = new Set(['completed', 'failed', 'stopped', 'killed']);
// 后台启动的子代理:工具结果说"已在后台跑",此刻它还没有终态(CLI 之后会发 task-notification)。
const ASYNC_LAUNCH_RE = /async agent launched|working in the background|已在后台启动/i;

/** 身份键:母会话 + 工具身份。列表去重、迟到响应丢弃、视图归属都用它。 */
export function agentKey(parentSessionId, toolUseId) {
  return `${parentSessionId || ''}|${toolUseId || ''}`;
}

/**
 * 母会话该落在哪个窗格:按 sessionId 身份找,已在任一窗格打开就复用那个窗格(-1 = 没打开)。
 * 刻意不看窗格位置/序号/标题 —— 那正是"查看落在错误母会话上"的来源。
 */
export function locateParentPane(paneSessions, paneCount, parentSessionId) {
  if (!parentSessionId) return -1;
  const list = (paneSessions || []).slice(0, paneCount || 0);
  return list.findIndex((p) => p?.sessionId === parentSessionId);
}

/**
 * 运行证据:某母会话的消息里,这条子代理调用现在处于什么状态。
 *   'running' = 还没回结果(前台 Task 在飞),或结果是"后台启动"且此后没有终态通知;
 *   'ended'   = 已有结果(非后台启动)或收到过终态通知;
 *   null      = 这份消息里根本没有它(不是它的母会话,或消息还没加载)—— 不知道就不猜。
 * 与 server 的 agentEvidenceInRecord 同一判据(那边读 jsonl 原始记录,这边读已解析消息)。
 */
export function taskRunEvidence(messages, toolUseId) {
  if (!toolUseId || !Array.isArray(messages)) return null;
  let call = null;
  let sawTerminal = false;
  for (const m of messages) {
    if (!m) continue;
    // task-notification 在 GUI 消息里是 task-notice(带 status/taskId/text),信封正文含
    // <tool-use-id> —— 只有指到本身份的终态才算终态。
    if (m.type === 'task-notice') {
      if (typeof m.text === 'string' && m.text.includes(toolUseId) && NOTICE_TERMINAL_STATUSES.has(m.status)) sawTerminal = true;
      continue;
    }
    if (Array.isArray(m.toolCalls)) {
      for (const tc of m.toolCalls) {
        if (tc && tc.id === toolUseId && TASK_TOOL_NAMES.has(tc.name)) call = tc;
      }
    }
  }
  if (sawTerminal) return 'ended';
  if (!call) return null;
  const result = call.result;
  if (!result) return 'running';            // 前台 Task 还没回结果 = 还在飞
  if (result.isError) return 'ended';
  const text = typeof result.content === 'string' ? result.content : JSON.stringify(result.content || '');
  return ASYNC_LAUNCH_RE.test(text) ? 'running' : 'ended';
}

/**
 * 有序展示块拆两半:prompt 走视图自己的"派发任务"气泡,其余按原序交给 CoworkBlocks
 * (与母会话共用同一渲染路径)。view.blocks 由服务端保序,前端不再自己拼。
 */
export function splitHistoryBlocks(blocks) {
  const list = Array.isArray(blocks) ? blocks : [];
  const rest = [];
  let prompt = '';
  for (const b of list) {
    if (b?.type === 'prompt') { if (!prompt && typeof b.content === 'string') prompt = b.content; continue; }
    if (b?.type === 'text' || b?.type === 'thinking' || b?.type === 'tool_use') rest.push(b);
  }
  return { prompt, blocks: rest };
}

/**
 * 来源与停止按钮的唯一判据(视图与列表共用一份,免得两处各判一套)。
 *   running:有证据在跑 → true;证据说结束 → false;没证据 → 沿用条目自己的非终态。
 *   label:合同要求的两档来源,只有"实时/历史"两种说法。
 *   停止按钮 = running:证据说结束就摘掉按钮 —— 分支复制品那条正是这么收官的
 *   (复制品的母会话历史里带着源代理的终态通知 → 证据 ended → 没有运行证据 → 不给停)。
 */
export function agentSourceState({ evidence, nonTerminal }) {
  const running = evidence === 'running' ? true : (evidence === 'ended' ? false : !!nonTerminal);
  return { running, label: running ? '实时' : '历史' };
}

/**
 * 有序块 → 卡片用的三个数组(text/thinking/toolCalls)。视图走 blocks(保序),而 Task 卡
 * 的内联展开是三个平铺清单 —— 同一份历史两边都要有,不能因为改读 view.blocks 就让卡片
 * 里原来的思考/工具凭空消失。
 */
export function historyLegacyArrays(blocks) {
  const text = [], thinking = [], toolCalls = [];
  for (const b of (Array.isArray(blocks) ? blocks : [])) {
    if (b?.type === 'text' && b.content) text.push(b.content);
    else if (b?.type === 'thinking' && b.content) thinking.push(b.content);
    else if (b?.type === 'tool_use' && b.toolCall) toolCalls.push(b.toolCall);
  }
  return { text, thinking, toolCalls };
}

/**
 * 迟到历史响应能不能写进这条条目(丢弃判据)。要写的目标必须仍然是【我们水合的那条】:
 *   条目没了 / 被换成活流条目(自己会到) / 归属变成别的母会话 → 丢弃,不显示旧内容,
 *   也不把旧标题漏进新会话。
 */
export function shouldApplyHistory(current, expectedSessionId) {
  if (!current || !current.hydrated) return false;
  if (expectedSessionId && current.sessionId && current.sessionId !== expectedSessionId) return false;
  return true;
}

// 合同:代理打开 15 秒没拿到就是超时。服务端自己也有一条 15 秒超时(504
// HISTORY_READ_TIMEOUT),这里再兜一层客户端计时 —— 服务端没回话(网络半死)时同样要有终点。
export const AGENT_HISTORY_TIMEOUT_MS = 15_000;

/**
 * 读一份子代理转写(唯一四键 schema:{messages,usageTotals,owner,view})。
 * 失败按合同给五种人话文案之一 —— 调用方据此提示并保留当前视图,不在错误母会话上显示"数据不可用"。
 *   · 超时(15 秒没回来,或服务端 504)→「加载超时，可重试」
 *   · 其他读取失败 →「加载失败，可重试」
 *   · 被取消(切换目标/关面板,调用方传 signal)→ aborted:true,【不出文案】(只取消了这次读取)
 */
export async function fetchAgentHistory({ agentSessionId, projectHash, signal = null, timeoutMs = AGENT_HISTORY_TIMEOUT_MS }) {
  if (!agentSessionId || !projectHash) return { ok: false, message: '无法确定母会话', code: 'AGENT_IDENTITY_INCOMPLETE' };
  const ctl = new AbortController();
  let timedOut = false;
  const onAbort = () => ctl.abort();
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
  try {
    const r = await fetch(
      `/api/sessions/${encodeURIComponent(agentSessionId)}/messages?projectHash=${encodeURIComponent(projectHash)}`,
      { signal: ctl.signal },
    );
    const body = await r.json().catch(() => null);
    if (!r.ok) return { ok: false, status: r.status, code: body?.code || null, message: historyReadFailureText(r.status, body?.code) };
    const blocks = Array.isArray(body?.view?.blocks) ? body.view.blocks : [];
    return { ok: true, owner: body?.owner || null, blocks };
  } catch (err) {
    if (signal?.aborted) return { ok: false, aborted: true };                  // 目标已取消:静默丢弃
    if (timedOut || err?.name === 'AbortError') {
      return { ok: false, status: 0, timedOut: true, code: 'AGENT_OPEN_TIMEOUT', message: '加载超时，可重试' };
    }
    return { ok: false, status: 0, code: 'NETWORK', message: '加载失败，可重试' };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener?.('abort', onAbort);
  }
}

/**
 * 读历史失败 → 人话。各档分别可见,不合并成一句"失败"。超时与一般读取失败是两回事:
 * 前者说明对端还在读(或网络半死),后者是读挂了 —— 文案与"可重试"的含义都不同。
 */
export function historyReadFailureText(status, code) {
  if (code === 'AGENT_OWNER_UNRESOLVED') return '无法确定母会话';   // 归属不可靠 = 定位不到母会话
  if (code === 'HISTORY_READ_TIMEOUT' || code === 'AGENT_OPEN_TIMEOUT' || status === 504) return '加载超时，可重试';
  if (status === 404) return '母会话不存在';
  if (status === 403) return '无权查看此会话';
  return '加载失败，可重试';
}

/**
 * 按身份把视图装起来时,水合条目的状态该怎么落(唯一判据,面板与单测共用)。
 *   在跑 → 'working';
 *   确知有转写(索引里挂着)→ 'done'(历史转写 = 它当年跑完过);
 *   其余:看得见结果 → 'done',看不见结果 → 'stopped'(中断残骸,不冒充完成)。
 * 注意"转写未知"(null)不落 'stopped' —— 那是索引还没加载,不是"没有转写"。
 */
export function agentHydrationStatus({ running, hasTranscript, result } = {}) {
  if (running) return 'working';
  if (hasTranscript === true) return 'done';
  return result ? 'done' : 'stopped';
}

/**
 * 「查看」读失败之后该怎么办(唯一判据,面板与单测共用):
 *   'rollback' = 这个母会话根本打不开(不存在/无权限/归属不可靠)→ 回滚刚才的切换,保留用户原视图
 *   'keep'     = 临时读不到(超时/网络/5xx)→ 视图与停止目标原样留着,只提示可重试
 *   'ignore'   = 被取消(切换目标/关面板)→ 只取消了这次读取,【不出任何文案】
 * 超时属于 'keep':超时后既不得把视图说成已完成,也不得替换/摘掉停止按钮 —— 源的状态没变。
 */
export function agentOpenFailureAction(res) {
  if (!res || res.ok) return 'none';
  if (res.aborted) return 'ignore';
  if (res.status === 404 || res.status === 403 || res.code === 'AGENT_OWNER_UNRESOLVED') return 'rollback';
  return 'keep';
}

/**
 * 监控面板的子代理条目(含只存在于历史里的)。三个来源合一,按身份 (parentSessionId,toolUseId)
 * 去重,活流优先 —— 同一个代理不能因为出现在两处而列出两条:
 *   ① 已开窗格会话的消息里的 Task/Agent 工具调用(分支复制品只有这条路:fork 不复制 subagents/ 目录);
 *   ② 已加载项目的会话 subagents 索引(跑完的、本次没打开过的母会话都在这里);
 *   ③ 本页内存里的活流条目(还在跑的最新状态)。
 * running 只认证据:活流非终态,或母会话消息说它还没结束。
 */
export function buildAgentRows({ sessionsByProject, panes, liveAgents, openSessionIds, limit = 30 } = {}) {
  const rows = new Map();
  const put = (key, patch) => { rows.set(key, { ...(rows.get(key) || {}), ...patch }); };
  const ts = (v) => (typeof v === 'string' ? Date.parse(v) : 0) || 0;
  // 哪些母会话已经在索引里。判定"复制品没有自己的转写"需要这个前提:会话都不在索引里时
  // 我们并不知道它有没有转写(刚建的会话、索引还没加载完)—— 那种情况算【不知道】,
  // 不能当成"没有转写",否则新建会话里的子代理会被误标成已停止、还会丢掉停止按钮。
  const indexedSessions = new Set();

  // ② 会话索引:每个母会话的 subagents[]。workflow 内层助手另有专区分组,这里不重复列。
  for (const [hash, list] of Object.entries(sessionsByProject || {})) {
    for (const sess of (list || [])) {
      if (sess?.sessionId) indexedSessions.add(sess.sessionId);
      for (const sub of (sess?.subagents || [])) {
        if (sub?.workflowId) continue;
        const key = agentKey(sess.sessionId, sub.toolUseId || sub.sessionId);
        put(key, {
          key,
          parentSessionId: sess.sessionId,
          parentProjectHash: sess.projectHash || hash,
          parentTitle: sess.customTitle || sess.aiTitle || sess.firstPrompt || '',
          toolUseId: sub.toolUseId || null,
          agentSessionId: sub.sessionId || null,
          agentProjectHash: sess.projectHash || hash,
          agentType: sub.agentType || null,
          model: sub.model || null,
          prompt: sub.firstPrompt || '',
          lastActivity: sub.lastActivity || sess.lastActivity || null,
          hasTranscript: true,
          running: false,
          live: false,
        });
      }
    }
  }

  // ③ 活流条目:本页内存里还在跑/刚跑完的。sessionId 就是它的母会话(没有母会话的
  // draft 期条目定位不了,不进这份列表)。
  for (const agent of Object.values(liveAgents || {})) {
    if (!agent || agent.hydrated || !agent.id || !agent.sessionId) continue;
    const key = agentKey(agent.sessionId, agent.id);
    const running = !AGENT_TERMINAL_STATUSES.has(agent.status || 'working');
    put(key, {
      key,
      parentSessionId: agent.sessionId,
      toolUseId: agent.id,
      agentType: rows.get(key)?.agentType || agent.teammateName || agent.name || null,
      model: agent.model || rows.get(key)?.model || null,
      description: agent.description || rows.get(key)?.description || '',
      running,
      live: true,
      lastActivity: agent.finishedAt || agent.startedAt || rows.get(key)?.lastActivity || null,
    });
  }

  // ① 已开窗格会话的消息:补 running 证据,并把 fork 复制品(没有 subagents/ 目录、
  // 也没有活流条目的 Task 工具调用)补成条目。
  for (const pane of (panes || [])) {
    const sess = pane?.session;
    if (!sess?.sessionId || !Array.isArray(pane.messages)) continue;
    for (const m of pane.messages) {
      if (!Array.isArray(m?.toolCalls)) continue;
      for (const tc of m.toolCalls) {
        if (!tc || !TASK_TOOL_NAMES.has(tc.name) || !tc.id) continue;
        const key = agentKey(sess.sessionId, tc.id);
        const known = rows.get(key);
        const evidence = taskRunEvidence(pane.messages, tc.id);
        // 转写存在性三态:索引行 != null → 有;会话在索引里却没这条 → 没有(复制品);会话不在索引 → 不知道。
        const rowHasTranscript = known?.hasTranscript === true ? true
          : (known?.live === true ? known.hasTranscript
            : (indexedSessions.has(sess.sessionId) ? false : null));
        put(key, {
          key,
          parentSessionId: sess.sessionId,
          parentProjectHash: sess.projectHash || pane.projectHash || null,
          parentTitle: rows.get(key)?.parentTitle || sess.customTitle || sess.firstPrompt || '',
          toolUseId: tc.id,
          agentSessionId: known?.agentSessionId || null,
          agentProjectHash: known?.agentProjectHash || sess.projectHash || pane.projectHash || null,
          agentType: known?.agentType || tc.input?.subagent_type || tc.input?.name || null,
          description: tc.input?.description || known?.description || '',
          prompt: tc.input?.prompt || known?.prompt || '',
          result: typeof tc.result?.content === 'string' ? tc.result.content : (known?.result || null),
          // true=索引里有它的转写(或活流条目);false=母会话在索引里、却没有这个 toolUseId
          // 的转写(分支复制品);null=该母会话还没进索引 → 不知道,不许当成"没有转写"。
          hasTranscript: rowHasTranscript,
          // 在不在跑只看证据:活流非终态,或母会话消息说这条 Task 还没结束(没回结果 /
          // 后台启动且此后无终态通知)。转写存在性(hasTranscript)只用来标状态与来源,
          // 不用来否定证据 —— 索引可能是"子代理转写落盘前"抓的(新建会话),拿它当"没有
          // 转写"会把正在跑的子代理误标成已停止。(分支复制品那条路本来就靠证据收官:
          // 复制品的历史里有源代理的终态通知 → evidence = ended。)
          running: known?.live === true ? known.running === true : evidence === 'running',
          live: known?.live === true,
          lastActivity: known?.lastActivity || m.timestamp || null,
        });
      }
    }
  }

  // 同一个 toolUseId 出现在多个母会话(分支复制品撞源会话)时只留一条,否则面板里会出现
  // 两行一模一样的 id,点哪一行都一样地"可能点错母会话"—— 这正是要修的那类错位。
  // 取舍:活流 > 现在开着的母会话(用户眼前那一条) > 有独立转写的(源会话) > 其余。
  const open = new Set(openSessionIds || []);
  const rank = (r) => (r.live ? 8 : 0) + (open.has(r.parentSessionId) ? 4 : 0) + (r.hasTranscript ? 2 : 0) + (r.running ? 1 : 0);
  const byTool = new Map();
  for (const row of rows.values()) {
    const id = row.toolUseId || row.agentSessionId;
    if (!id) continue;                        // 连身份都没有的条目列了也点不动
    const cur = byTool.get(id);
    if (!cur || rank(row) > rank(cur)) byTool.set(id, row);
  }
  // 先跑中的,再按最近活动倒序;条数封顶,免得把"本机所有历史"铺一屏。
  return [...byTool.values()]
    .sort((a, b) => (Number(b.running) - Number(a.running)) || (ts(b.lastActivity) - ts(a.lastActivity)))
    .slice(0, limit);
}
