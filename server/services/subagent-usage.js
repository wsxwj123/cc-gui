// r207:子代理用量(从 session-reader.js 搬出,session-reader 原名转出,已有调用方不改 import)。
// 契约:`.devflow/INTERFACE-20260911-pricing.md` §10.1。子代理的【真】model 与 usage 只在
// 自己的转写里(meta.json 的 model 是别名如 "opus",不可用于计价),故逐转写只取
// message.model / message.usage / timestamp 三样,不把整条消息留在内存。
// 结果只读、不改任何既有字段;读不到就少一条,绝不摊派、绝不猜。
//
// r207 缓存:逐转写按「路径 + dev/ino + 大小 + 修改时间」缓存用量摘要,meta.json 同样按文件身份缓存 ——
// 转写没变不重读,变了只重读变了的那一个(原来按整个 subagents 目录一个签名,改一个就全部重读)。
// 读转写只解析助手记录:行首能确定顶层类型且不是 assistant 的行直接跳过,看不出就照常解析。
import { readdir, stat, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { scanJsonlRange } from '../utils/jsonl-parser.js';

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');

// 上限保护:历史会话 + 面板轮询都会往里放,只留最近用到的这么多份(按最近使用淘汰;被淘汰的下次用时重读)。
const AGENT_CACHE_MAX = 2048;
const agentUsageCache = new Map();   // 转写路径 → { sig, usage }
const agentMetaCache = new Map();    // meta.json 路径 → { sig, meta }
const NULL_META = Object.freeze({ toolUseId: null, agentType: null });

// 文件身份:先 stat 再读、记读之前的身份 —— 读的过程中文件被追加,下次身份对不上就会重读,不会把旧结果当新的。
function statSig(st) {
  return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs ?? st.mtimeMs}`;
}
function remember(cache, key, value) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > AGENT_CACHE_MAX) cache.delete(cache.keys().next().value);
}

// r200:尖括号开头的伪模型名(<synthetic> 等,报错占位 / 压缩摘要)不算一个模型。
export function realModelName(model) {
  return typeof model === 'string' && model !== '' && !model.startsWith('<') ? model : null;
}

/** 读子代理 meta.json 的两个字段(读不到/类型不对一律 null,不抛)。按文件身份缓存;读失败不记缓存。 */
export async function readAgentMeta(metaPath) {
  let st;
  try { st = await stat(metaPath, { bigint: true }); } catch { return NULL_META; }
  const sig = statSig(st);
  const hit = agentMetaCache.get(metaPath);
  if (hit && hit.sig === sig) { remember(agentMetaCache, metaPath, hit); return hit.meta; }
  let text;
  try { text = await readFile(metaPath, 'utf-8'); } catch { return NULL_META; }
  let meta = NULL_META;
  try {
    const raw = JSON.parse(text);
    meta = Object.freeze({
      toolUseId: typeof raw?.toolUseId === 'string' && raw.toolUseId ? raw.toolUseId : null,
      agentType: typeof raw?.agentType === 'string' && raw.agentType ? raw.agentType : null,
    });
  } catch { /* 坏 JSON:两个字段都 null(内容不变就一直是这个结果,可以缓存) */ }
  remember(agentMetaCache, metaPath, { sig, meta });
  return meta;
}

/**
 * R12:子代理转写里 toolUseId 的来源 —— 与转写同目录的 `<agentSessionId>.meta.json`
 * (CLI 起子代理时写,带 toolUseId = 母会话里那次 Task/Agent 调用的 id)。
 * 读不到/没有该键都返回 null(workflow 起的 agent 的 meta 就没有 toolUseId)。
 */
export async function readAgentToolUseId(metaPath) {
  return (await readAgentMeta(metaPath)).toolUseId;
}

/** 列出 `subagents/`(含 workflows/wf_*)下的子代理转写,带各自的 stat(bigint,给逐文件缓存认身份)。 */
async function listSubagentTranscripts(dir) {
  const files = [];      // { filePath, metaPath, runId, st }
  const pushDir = async (d, runId) => {
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries.slice().sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!e.isFile() || !e.name.startsWith('agent-') || !e.name.endsWith('.jsonl')) continue;
      const filePath = join(d, e.name);
      let st;
      try { st = await stat(filePath, { bigint: true }); } catch { continue; }
      files.push({ filePath, metaPath: join(d, `${e.name.slice(0, -'.jsonl'.length)}.meta.json`), runId, st });
    }
  };
  await pushDir(dir, null);
  let wfEntries;
  try { wfEntries = await readdir(join(dir, 'workflows'), { withFileTypes: true }); } catch { wfEntries = []; }
  for (const wf of wfEntries.slice().sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!wf.isDirectory() || !wf.name.startsWith('wf_')) continue;
    await pushDir(join(dir, 'workflows', wf.name), wf.name);
  }
  return files;
}

/**
 * 读一条子代理转写里计价需要的三样东西(读失败抛,由 readAgentUsage 接住、不记缓存)。
 * usage 的去重口径与回合 usageCalls **逐字相同**(§3.4):按 message.id 去重、首次出现为准、
 * 全零 usage 不计;两档 TTL 分项按同一口径各自汇总,顶层量与分项互不相加。
 * 返回 null = model 与 usage 都读不到(不值得进 agents[])。
 */
async function scanAgentUsage(filePath) {
  const calls = new Map();     // message.id → { at, usage }
  let model = null;
  let timestamp = null;
  await scanJsonlRange(filePath, {
    requireNewline: false,      // 与原来的 readline 同:末行没换行也算
    skipTypes: (type) => type !== 'assistant',
    onRecord: (rec) => {
      // 与原来 streamJsonl 的回调同口径:单条出异常只跳过这一条
      try {
        if (rec?.type !== 'assistant') return;
        if (!timestamp && typeof rec.timestamp === 'string' && rec.timestamp) timestamp = rec.timestamp;
        const message = rec.message;
        if (!message || typeof message !== 'object') return;
        // 真 model:跳过 `<synthetic>` 伪模型(compact 摘要/错误占位,同 turn.model 的过滤口径)。
        if (!model && message.model && !/^</.test(message.model)) model = message.model;
        const usage = message.usage;
        if (!usage || typeof usage !== 'object') return;
        const mid = message.id || rec.uuid;
        if (!mid || calls.has(mid)) return;
        const nonZero = (usage.input_tokens || 0) + (usage.output_tokens || 0)
          + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0) > 0;
        if (!nonZero) return;
        calls.set(mid, { at: rec.timestamp || null, usage, model: realModelName(message.model) }); // r200:每次调用记下自己的模型
      } catch { /* 跳过这一条 */ }
    },
  });
  if (!model && calls.size === 0) return null;
  const agg = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const usageCalls = [];
  let sum5m = 0;
  let sum1h = 0;
  for (const entry of calls.values()) {
    const u = entry.usage;
    agg.input_tokens += u.input_tokens || 0;
    agg.output_tokens += u.output_tokens || 0;
    agg.cache_read_input_tokens += u.cache_read_input_tokens || 0;
    agg.cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
    const w5 = u.cache_creation?.ephemeral_5m_input_tokens || 0;
    const w1 = u.cache_creation?.ephemeral_1h_input_tokens || 0;
    sum5m += w5;
    sum1h += w1;
    usageCalls.push(entry.model ? { at: entry.at, usage: u, model: entry.model } : { at: entry.at, usage: u }); // r200:前端按实际模型分段计价
  }
  if (sum5m + sum1h > 0) agg.cache_creation = { ephemeral_5m_input_tokens: sum5m, ephemeral_1h_input_tokens: sum1h };
  return { model, timestamp, usage: agg, usageCalls };
}

/**
 * 一条转写的用量(按文件身份缓存)。返回 { usage, bytes }:usage = null 表示读不出来(调用方跳过);
 * bytes = 这次实际重读的字节数(命中缓存为 0,给历史读取回报进展用)。
 */
async function readAgentUsage(filePath, knownStat = null) {
  let st = knownStat;
  if (!st) {
    try { st = await stat(filePath, { bigint: true }); } catch { return { usage: null, bytes: 0 }; }
  }
  const sig = statSig(st);
  const hit = agentUsageCache.get(filePath);
  if (hit && hit.sig === sig) { remember(agentUsageCache, filePath, hit); return { usage: hit.usage, bytes: 0 }; }
  let usage;
  try { usage = await scanAgentUsage(filePath); } catch { return { usage: null, bytes: 0 }; }   // 读失败不记缓存,下次再试
  remember(agentUsageCache, filePath, { sig, usage });
  return { usage, bytes: Number(st.size) };
}

/**
 * 读某个会话的全部子代理用量(逐条:身份 + 真 model + 聚合 usage + 逐调用 usageCalls)。
 * 只是"读到什么",不做归属 —— 归属要配对母 jsonl 的 tool_use.id,在 getSessionMessages
 * 内做(见 attachSubagentUsage)。逐转写按文件身份缓存(见文件头),不写磁盘。
 * opts.onProgress(累计重读的字节数):每重读完一个转写回报一次(命中缓存的不报)。
 *
 * ⚠️ 安全边界(2026-09-12 后台扫描告警核查为误报,此处显式写明依赖):
 * 本函数**直接拼接** projectHash / sid 进文件路径、**自身不做任何校验** —— 安全性依赖
 * 调用链上游的 safeId(拒含 `/`、`\`、`..`、`\0` 的串,见 routes/sessions.js)。
 * 当前唯一调用点就是 session-reader.js 的 getSessionMessages,而它的 HTTP 入口
 * 都在进入前校验过 projectHash 与 sessionId。
 * **若将来新增调用点,必须自行先过 safeId**,否则会打开任意文件读取。
 */
export async function readSessionSubagentUsage(projectHash, sid, { onProgress } = {}) {
  const dir = join(PROJECTS_DIR, projectHash, sid, 'subagents');
  const files = await listSubagentTranscripts(dir);
  if (!files.length) return [];
  const agents = [];
  let bytes = 0;
  for (const file of files) {
    try {
      const read = await readAgentUsage(file.filePath, file.st);
      if (read.bytes) { bytes += read.bytes; onProgress?.(bytes); }
      if (!read.usage) continue;
      const meta = await readAgentMeta(file.metaPath);
      agents.push({
        agentSessionId: basename(file.filePath).replace('.jsonl', ''),
        agentType: meta.agentType,
        toolUseId: meta.toolUseId,
        runId: file.runId,
        ...read.usage,
      });
    } catch { /* 单条读失败只跳过它(契约:无错误码、其余照常) */ }
  }
  return agents;
}

/** 路径段安全(与 routes/sessions.js 的 safeId 同款判据;那份在 routes 层,本模块不能反向 import)。 */
function pathSegSafe(s) {
  return typeof s === 'string' && !!s
    && !s.includes('/') && !s.includes('\\') && !s.includes('..') && !s.includes('\0');
}

/**
 * 一条转写 → agents[] 同形状条目(读不到用量就 null)。
 * 比历史路径多一道闸:连一条非零 usage 都没有(文件刚建/正在 flush)也不发 —— 历史那边
 * 是"回合已结束、账就该齐了",这里发早了在卡片上画一个 $0.00 比不画更坏(宁缺勿假)。
 */
async function agentEntryFromTranscript(filePath, metaPath, fallbackToolUseId) {
  const { usage } = await readAgentUsage(filePath);
  if (!usage || !usage.usageCalls?.length) return null;
  const meta = await readAgentMeta(metaPath);
  return {
    agentSessionId: basename(filePath).replace('.jsonl', ''),
    agentType: meta.agentType,
    // 归属键取调用方给的(它才是卡片键);meta 只是兜底。
    toolUseId: fallbackToolUseId || meta.toolUseId,
    ...usage,
  };
}

/**
 * 直播补齐(2026-09-13):子代理【完成那一刻】只读它那一条转写,给完成事件附金额用。
 * 与 readSessionSubagentUsage 的区别是**不扫全盘**:先按 taskId 直连 `agent-<task-id>.jsonl`
 * (CLI 的 task_id 与转写文件名同名,实测同名率 ~100%),命不中才扫 subagents/*.meta.json
 * (+ workflows/wf_*)按 toolUseId 找。返回形状与 attachSubagentUsage 产出的 agents[] 逐字段相同
 * —— 同一形状 = 同一计价口径。读不到 usage(文件刚建/正在 flush)→ null,调用方据此不下发(宁缺勿假)。
 *
 * ⚠️ 安全边界:与 readSessionSubagentUsage 同款,自行过 pathSegSafe —— 调用方是
 * routes/chat.js 的消息泵(入参来自 slot.cwd 派生 + CLI 事件),不是 HTTP 查询串。
 */
export async function readSubagentUsageForToolUse(projectHash, sid, { toolUseId, taskId } = {}) {
  if (!pathSegSafe(projectHash) || !pathSegSafe(sid)) return null;
  if (!toolUseId && !taskId) return null;
  const dir = join(PROJECTS_DIR, projectHash, sid, 'subagents');
  if (typeof taskId === 'string' && /^[A-Za-z0-9_-]+$/.test(taskId)) {
    const filePath = join(dir, `agent-${taskId}.jsonl`);
    if (existsSync(filePath)) {
      return await agentEntryFromTranscript(filePath, join(dir, `agent-${taskId}.meta.json`), toolUseId);
    }
  }
  const files = await listSubagentTranscripts(dir);
  for (const file of files) {
    const meta = await readAgentMeta(file.metaPath);
    if (meta.toolUseId && meta.toolUseId === toolUseId) {
      return await agentEntryFromTranscript(file.filePath, file.metaPath, toolUseId);
    }
  }
  return null;
}

function parseStamp(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const t = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/**
 * workflow 子代理的归属:runId → 母 jsonl 里那次 Workflow 调用的 tool_use.id。
 * 同一 runId 可能出现在多条 tool_result 上(resume/续跑)—— 唯一命中直接归属;多命中按
 * 时间戳就近:取「承载记录时刻 ≤ 该 agent 首条记录时刻」的最后一次调用,agent 早于全部
 * 调用则取最早一次。分不开(agent 无时间戳 / 承载记录无时间戳 / 选中的那次与别的调用
 * **时间戳相同**,契约 §10.1「多命中且时间戳分不开」)→ null,宁缺勿猜。
 */
function pickWorkflowCall(calls, agentTimestamp) {
  if (!calls || !calls.length) return null;
  if (calls.length === 1) return calls[0];
  const at = parseStamp(agentTimestamp);
  if (at == null) return null;
  let chosen = null;
  for (const call of calls) {
    const callAt = parseStamp(call.at);
    if (callAt == null) return null;
    if (callAt <= at) chosen = call;
  }
  const pick = chosen || calls[0];
  // 选中的那次时刻与别的调用完全相同 → 先后无从区分(再往下比只是文件记录顺序的产物,
  // 不是时间证据)→ 不可归属。金额宁可空着,也不能挂到猜出来的那一次上。
  const pickAt = parseStamp(pick.at);
  if (calls.filter((call) => parseStamp(call.at) === pickAt).length > 1) return null;
  return pick;
}

/**
 * 把子代理用量挂到各自回合的 `subUsage.agents[]` 上(契约 §10.1)。
 * 归属键两条:普通子代理 = meta.json 的 toolUseId;workflow 子代理 = runId → 那次
 * Workflow 调用的 tool_use.id。都归不到 → 不进任何 agents[](不摊派、不猜)。
 * 顺序 = 该轮内 toolUseId 首次出现顺序;同一 toolUseId 多个 agent 按转写文件名升序
 * (扫描顺序已保证)。本轮一条都没有 → subUsage 键不出现。
 */
export function attachSubagentUsage(messages, agents, workflowCalls) {
  if (!agents.length) return;
  const turnOf = new Map();      // toolUseId → 该 tool_use 所属的 turn
  for (const m of messages) {
    if (m.type !== 'turn' || !Array.isArray(m.toolCalls)) continue;
    for (const tc of m.toolCalls) if (tc?.id && !turnOf.has(tc.id)) turnOf.set(tc.id, m);
  }
  const byTurn = new Map();      // turn → Map(toolUseId → agent[])
  for (const agent of agents) {
    const call = agent.runId
      ? pickWorkflowCall(workflowCalls.get(agent.runId), agent.timestamp)
      : (agent.toolUseId ? { toolUseId: agent.toolUseId } : null);
    if (!call) continue;
    const turn = turnOf.get(call.toolUseId);
    if (!turn) continue;
    let grouped = byTurn.get(turn);
    if (!grouped) { grouped = new Map(); byTurn.set(turn, grouped); }
    if (!grouped.has(call.toolUseId)) grouped.set(call.toolUseId, []);
    grouped.get(call.toolUseId).push(agent);
  }
  for (const [turn, grouped] of byTurn) {
    const order = new Map();
    (turn.toolCalls || []).forEach((tc, i) => { if (tc?.id && !order.has(tc.id)) order.set(tc.id, i); });
    const ids = [...grouped.keys()].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    const list = [];
    for (const id of ids) {
      for (const agent of grouped.get(id)) {
        list.push({
          agentSessionId: agent.agentSessionId,
          toolUseId: id,
          agentType: agent.agentType,
          model: agent.model,
          timestamp: agent.timestamp,
          usage: agent.usage,
          usageCalls: agent.usageCalls,
        });
      }
    }
    if (list.length) turn.subUsage = { agents: list };
  }
}
