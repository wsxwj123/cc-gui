// 会话夹具准备：
//   ① 从本套件隔离实例自己的数据根里挑会话、派生一个「同一 message.id 分片出现两次」的会话；
//   ② 现场合成 A 项（子代理花费）需要的四份会话 —— Task 归属 / Workflow 归属 / resume 就近 / 同秒分不开。
// 只动本套件 .artifacts 下的数据；不读用户 profile、不写别处。
// 用法：测试启动时自动调 ensureFixtureManifest()（幂等）；也可 `node helpers/pa-fixtures.mjs` 单独重建。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { suitePath, EnvironmentBlocked } from './pa-runtime.mjs';

const FRAGMENTED_SESSION_ID = 'a1b2c3d4-0000-4000-8000-000000000001';

export function manifestPath() {
  return suitePath('fixture-manifest.local.json');
}

export function ensureFixtureManifest({ force = false } = {}) {
  const file = manifestPath();
  if (!force && fs.existsSync(file)) {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    // 旧清单（还没有 subagents 段、或还是上一版生成的 id）或夹具文件被清掉 → 重建，
    // 别让 A 项用例报成"环境不成立"。
    if (manifest.subagents?.dir
      && manifest.subagents.task?.agentId === `agent-${AGENTS.task}`
      && manifest.subagents.background?.agentId === `agent-${AGENTS.background}`
      && fs.existsSync(path.join(manifest.subagents.dir, `${manifest.subagents.task.sessionId}.jsonl`))) {
      return manifest;
    }
  }
  const manifest = rebuild();
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function dataRoot() {
  return suitePath('.artifacts', 'runtime-data');
}

function projectsRoot() {
  return path.join(dataRoot(), 'home', '.claude', 'projects');
}

function rebuild() {
  const root = projectsRoot();
  if (!fs.existsSync(root)) {
    throw new EnvironmentBlocked(
      `没有会话夹具：${root} 不存在。按 README「Fixture preparation」把一份真实转写放进本套件的数据根`,
    );
  }
  // 子代理夹具先落盘（下面扫会话时也在场，与真实数据根的样子一致）。
  const subagents = buildSubagentFixtures();

  const sessions = [];
  for (const dir of fs.readdirSync(root)) {
    const dirPath = path.join(root, dir);
    if (!fs.statSync(dirPath).isDirectory()) continue;
    for (const name of fs.readdirSync(dirPath)) {
      if (!name.endsWith('.jsonl')) continue;
      sessions.push(scanSession(dirPath, dir, name));
    }
  }
  const usable = sessions.filter(item => item.assistantRecords > 0 && item.firstInput !== null);
  if (!usable.length) {
    throw new EnvironmentBlocked('夹具会话里没有带 usage 的 assistant 记录（无法构造次事件/计价夹具）');
  }
  const pick = predicate => usable.find(predicate) || null;

  const single = pick(item => item.assistantRecords === 1 && item.userRecords >= 1) || usable[0];
  const ttl = pick(item => item.ttlSplit > 0);
  const big = pick(item => item.bigInput > 0);

  const fragmented = buildFragmented(single);

  return {
    dataRoot: dataRoot(),
    transcripts: {
      projectHash: single.projectHash,
      sessionId: single.sessionId,
      firstInput: single.firstInput,
      ttl: ttl ? { sessionId: ttl.sessionId, ttlSplit: ttl.ttlSplit } : null,
      bigInput: big ? { sessionId: big.sessionId, bigInput: big.bigInput } : null,
      fragmented,
    },
    subagents,
  };
}

function scanSession(dirPath, projectHash, name) {
  const sessionId = name.slice(0, -'.jsonl'.length);
  const lines = fs.readFileSync(path.join(dirPath, name), 'utf8').split('\n').filter(Boolean);
  let assistantRecords = 0;
  let userRecords = 0;
  let firstInput = null;
  let ttlSplit = 0;
  let bigInput = 0;
  for (const line of lines) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record?.type === 'user') userRecords += 1;
    if (record?.type !== 'assistant') continue;
    assistantRecords += 1;
    const u = record?.message?.usage;
    if (!u) continue;
    if (firstInput === null && Number.isFinite(u.input_tokens)) firstInput = u.input_tokens;
    const cc = u.cache_creation || {};
    if ((cc.ephemeral_5m_input_tokens || 0) > 0 && (cc.ephemeral_1h_input_tokens || 0) > 0) ttlSplit += 1;
    if ((u.input_tokens || 0) > 200000) bigInput += 1;
  }
  return { projectHash, sessionId, dirPath, assistantRecords, userRecords, firstInput, ttlSplit, bigInput };
}

/**
 * 派生一个「同一 message.id 分片出现两次」的会话：把源会话里第一条带 usage 的 assistant 记录
 * 原样复制到文件末尾，只把 usage.input_tokens 加大、timestamp 推后 —— 这样「取末条」和
 * 「取首次」会给出可区分的数字（契约 §3.4 / §10.1 都要求首次出现为准）。
 */
function buildFragmented(source) {
  const srcFile = path.join(source.dirPath, `${source.sessionId}.jsonl`);
  const lines = fs.readFileSync(srcFile, 'utf8').split('\n').filter(Boolean);
  let index = -1;
  let record = null;
  for (let i = 0; i < lines.length; i += 1) {
    let parsed;
    try { parsed = JSON.parse(lines[i]); } catch { continue; }
    if (parsed?.type === 'assistant' && parsed?.message?.id && parsed?.message?.usage) {
      index = i; record = parsed; break;
    }
  }
  if (!record) throw new EnvironmentBlocked('源会话里找不到可复制的 assistant 记录');
  const firstUsage = { ...record.message.usage };
  const later = JSON.parse(JSON.stringify(record));
  later.message.usage = { ...later.message.usage, input_tokens: (later.message.usage.input_tokens || 0) + 111111 };
  later.uuid = `${record.uuid}-pa-fragment`;
  const base = Date.parse(record.timestamp || '2026-09-11T00:00:00.000Z');
  later.timestamp = new Date(base + 60_000).toISOString();
  const out = [...lines.slice(0, lines.length), JSON.stringify(later)];
  const outFile = path.join(source.dirPath, `${FRAGMENTED_SESSION_ID}.jsonl`);
  fs.writeFileSync(outFile, `${out.join('\n')}\n`);
  return {
    sessionId: FRAGMENTED_SESSION_ID,
    projectHash: source.projectHash,
    sourceSessionId: source.sessionId,
    firstInput: firstUsage.input_tokens,
    firstAt: record.timestamp ?? null,
    laterInput: later.message.usage.input_tokens,
    laterAt: later.timestamp,
    messageId: record.message.id,
    copiedLineIndex: index,
  };
}

// ---------------------------------------------------------------------------
// A 项（子代理花费）夹具：四份「父会话 + 子代理转写」，现场合成。
//
// 为什么合成而不是搬本机 ~/.claude/projects 的真转写：归属断言要逐字对照（哪条记录、哪个时间戳、
// 哪份用量），搬来的真转写内容不可控；而且真转写里是用户的真实对话。这里只**照抄真实记录的字段
// 形状**（键集合取自 2026-09-12 本机测试会话的快照），内容全部是本文件合成的测试提示词，零用户数据。
//
// 契约依据：§10.1 的归属两条键与顺序、§10.7 #1/#3/#4、§3.4 的去重口径（§10.1 逐字复用）。
// 四份会话：
//   task      —— 普通子代理：meta.json 带 toolUseId，且该 tool_use 就在父 jsonl 里 → 必须归属；
//                另放一个 tool_use 不在父 jsonl 里的 agent（孤儿）→ 必须不出现（PA-510 的负例）；
//   workflow  —— subagents/workflows/<runId>/agent-*.jsonl，meta 只有 agentType/spawnDepth，
//                归属只能靠父 jsonl 里那条带 runId 的 tool_result；
//   resume    —— 同一 runId 挂两条 tool_result（记录时间 t1 < t2），三个 agent 的首条记录分别
//                落在「早于全部调用」「t1 与 t2 之间」「晚于 t2」；
//   ambiguous —— 两条 tool_result 的**时间戳逐字相同**（分不开）→ 多命中且分不开 → 一个都不归属。
// ---------------------------------------------------------------------------

const SUBAGENT_PROJECT_HASH = '-pa-subagent-fixtures';
const SESSIONS = {
  task: 'a1000001-0000-4000-8000-000000000001',
  workflow: 'a1000002-0000-4000-8000-000000000002',
  resume: 'a1000003-0000-4000-8000-000000000003',
  ambiguous: 'a1000004-0000-4000-8000-000000000004',
  background: 'a1000005-0000-4000-8000-000000000005',
};
// agent id 与 runId 都照真实形态写：转写文件名是 `agent-<16 位小写十六进制>`（本机 1513 份实测如此），
// runId 是 `wf_<8 位十六进制>-<3 位>` —— 带别的字符的产品侧一律扫不到（本夹具首版用 `pa…` 就全军覆没）。
const AGENTS = {
  task: '0a1b2c3d4e5f6001',
  taskOrphan: '0a1b2c3d4e5f6002',
  background: '0a1b2c3d4e5f6041',
  workflow: ['0a1b2c3d4e5f6011', '0a1b2c3d4e5f6012'],
  resume: ['0a1b2c3d4e5f6021', '0a1b2c3d4e5f6022', '0a1b2c3d4e5f6023'],
  ambiguous: ['0a1b2c3d4e5f6031'],
};
const RUN_IDS = { workflow: 'wf_0a1b2c3d-001', resume: 'wf_0a1b2c3d-002', ambiguous: 'wf_0a1b2c3d-003' };
const CALL_IDS = {
  task: 'toolu_01PaTaskCall00000001',
  background: 'toolu_01PaBgCall000000001',
  workflow: 'toolu_01PaWorkflowCall0001',
  resume: ['toolu_01PaResumeCall00001', 'toolu_01PaResumeCall00002'],
  ambiguous: ['toolu_01PaAmbigCall000001', 'toolu_01PaAmbigCall000002'],
};
const T0 = Date.parse('2026-09-11T03:00:00.000Z');
const at = seconds => new Date(T0 + seconds * 1000).toISOString();
const uuid = n => `pa000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let uuidSeq = 0;
const nextUuid = () => uuid((uuidSeq += 1));

function fixtureWorkspace() {
  return path.join(dataRoot(), 'fixture-workspace');
}

/** 采集口径的 usage 形状（与真实转写逐键一致；iterations 里同一份数字）。 */
function usageRecord({ input = 0, output = 0, cacheRead = 0, fiveMin = 0, oneHour = 0 } = {}) {
  const cacheWrite = fiveMin + oneHour;
  return {
    input_tokens: input,
    cache_creation_input_tokens: cacheWrite,
    cache_read_input_tokens: cacheRead,
    output_tokens: output,
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: 'standard',
    cache_creation: { ephemeral_1h_input_tokens: oneHour, ephemeral_5m_input_tokens: fiveMin },
    inference_geo: 'not_available',
    iterations: [{
      input_tokens: input,
      output_tokens: output,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheWrite,
      cache_creation: { ephemeral_5m_input_tokens: fiveMin, ephemeral_1h_input_tokens: oneHour },
      type: 'message',
    }],
    speed: 'standard',
  };
}

function commonFields(sessionId, timestamp, extra = {}) {
  return {
    parentUuid: null,
    isSidechain: false,
    ...extra,
    uuid: nextUuid(),
    timestamp,
    userType: 'external',
    entrypoint: 'cli',
    cwd: fixtureWorkspace(),
    sessionId,
    version: '2.1.267',
    gitBranch: 'HEAD',
  };
}

function userText({ sessionId, timestamp, text }) {
  return {
    parentUuid: null, isSidechain: false, type: 'user',
    message: { role: 'user', content: text },
    ...commonFields(sessionId, timestamp, {}),
    promptId: nextUuid(), promptSource: 'sdk', permissionMode: 'default',
  };
}

function assistant({ sessionId, timestamp, model, messageId, content, stopReason, usage, subagentId = null }) {
  return {
    parentUuid: null, isSidechain: false,
    ...(subagentId ? { agentId: subagentId } : {}),
    message: {
      model, id: messageId, type: 'message', role: 'assistant', content,
      stop_reason: stopReason, stop_sequence: null, stop_details: null, usage, diagnostics: null,
    },
    requestId: `req_pa_${messageId}`,
    type: 'assistant',
    ...commonFields(sessionId, timestamp, subagentId ? { isSidechain: true } : {}),
    effort: 'high',
  };
}

function assistantToolUse({ sessionId, timestamp, model, messageId, name, toolUseId, input }) {
  return assistant({
    sessionId, timestamp, model, messageId, stopReason: 'tool_use',
    content: [{ type: 'tool_use', id: toolUseId, name, input, caller: { type: 'direct' } }],
    usage: usageRecord({ input: 3, output: 208, cacheRead: 18311, oneHour: 11470 }),
  });
}

function assistantText({ sessionId, timestamp, model, messageId, text }) {
  return assistant({
    sessionId, timestamp, model, messageId, stopReason: 'end_turn',
    content: [{ type: 'text', text }],
    usage: usageRecord({ input: 1, output: 7, cacheRead: 29781, oneHour: 303 }),
  });
}

function userToolResult({ sessionId, timestamp, toolUseId, text, toolUseResult }) {
  return {
    parentUuid: null, isSidechain: false, type: 'user',
    message: {
      role: 'user',
      content: [{ tool_use_id: toolUseId, type: 'tool_result', content: [{ type: 'text', text }] }],
    },
    ...commonFields(sessionId, timestamp, {}),
    promptId: nextUuid(), sourceToolAssistantUUID: null, toolUseResult,
  };
}

function subagentUser({ sessionId, subagentId, timestamp, text }) {
  return {
    parentUuid: null, isSidechain: true, promptId: nextUuid(), agentId: subagentId, type: 'user',
    message: { role: 'user', content: text },
    ...commonFields(sessionId, timestamp, { isSidechain: true }),
  };
}

function subagentAssistant({ sessionId, subagentId, timestamp, model, messageId, text, usage }) {
  return assistant({
    sessionId, timestamp, model, messageId, stopReason: 'end_turn',
    content: [{ type: 'text', text }], usage, subagentId,
  });
}

function buildSubagentFixtures() {
  const dir = path.join(projectsRoot(), SUBAGENT_PROJECT_HASH);
  const write = (relPath, records) => {
    const file = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
  };
  const writeJson = (relPath, body) => {
    const file = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(body)}\n`);
  };
  // 转写的落点是 `<项目>/<会话 id>/subagents/…`（下一级目录名就是会话 id）。
  const subagentDir = sessionId => path.join(sessionId, 'subagents');
  const meta = (sessionId, subagentId, body) => writeJson(path.join(subagentDir(sessionId), `agent-${subagentId}.meta.json`), body);
  const workflowMeta = (sessionId, runId, subagentId, body) => writeJson(
    path.join(subagentDir(sessionId), 'workflows', runId, `agent-${subagentId}.meta.json`), body);
  const writeWorkflow = (sessionId, runId, relPath, records) => write(
    path.join(subagentDir(sessionId), 'workflows', runId, relPath), records);

  // ---- ① task：普通子代理（可归属）+ 孤儿（tool_use 不在父 jsonl 里） -------------------
  write(`${SESSIONS.task}.jsonl`, [
    userText({
      sessionId: SESSIONS.task, timestamp: at(0),
      text: 'Use the Task tool (subagent_type: general-purpose) with prompt: "Reply with exactly PA-TASK-HELLO and nothing else." After it returns, reply with exactly PA-TASK-DONE.',
    }),
    assistantToolUse({
      sessionId: SESSIONS.task, timestamp: at(5), model: 'claude-opus-5', messageId: 'msg_pa_task_main_1',
      name: 'Agent', toolUseId: CALL_IDS.task,
      input: {
        description: 'PA fixture task agent', subagent_type: 'general-purpose',
        prompt: 'Reply with exactly PA-TASK-HELLO and nothing else.', run_in_background: false,
      },
    }),
    userToolResult({
      sessionId: SESSIONS.task, timestamp: at(20), toolUseId: CALL_IDS.task, text: 'PA-TASK-HELLO',
      toolUseResult: {
        status: 'completed', agentId: AGENTS.task, agentType: 'general-purpose',
        content: [{ type: 'text', text: 'PA-TASK-HELLO' }], resolvedModel: 'claude-opus-5',
      },
    }),
    assistantText({
      sessionId: SESSIONS.task, timestamp: at(21), model: 'claude-opus-5',
      messageId: 'msg_pa_task_main_2', text: 'PA-TASK-DONE',
    }),
  ]);
  write(path.join(subagentDir(SESSIONS.task), `agent-${AGENTS.task}.jsonl`), [
    subagentUser({
      sessionId: SESSIONS.task, subagentId: AGENTS.task, timestamp: at(5.5),
      text: 'Reply with exactly PA-TASK-HELLO and nothing else.',
    }),
    subagentAssistant({
      sessionId: SESSIONS.task, subagentId: AGENTS.task, timestamp: at(8), model: 'claude-opus-5',
      messageId: 'msg_pa_task_agent_1', text: 'PA-TASK-HELLO',
      usage: usageRecord({ input: 1000, output: 100, cacheRead: 500 }),
    }),
    // 同一 message.id 的分片（真实转写里流式增量会这么落）：它必须被当成"同一项"且以**首条**为准。
    subagentAssistant({
      sessionId: SESSIONS.task, subagentId: AGENTS.task, timestamp: at(9), model: 'claude-opus-5',
      messageId: 'msg_pa_task_agent_1', text: 'PA-TASK-HELLO',
      usage: usageRecord({ input: 999999, output: 100, cacheRead: 500 }),
    }),
    subagentAssistant({
      sessionId: SESSIONS.task, subagentId: AGENTS.task, timestamp: at(10), model: 'claude-opus-5',
      messageId: 'msg_pa_task_agent_2', text: 'PA-TASK-DONE',
      usage: usageRecord({ input: 2000, output: 200, cacheRead: 100 }),
    }),
  ]);
  // meta 的 model 是别名（契约 §10.1：金额与 model 必须取转写里的真 id，不得用 meta 的别名）。
  meta(SESSIONS.task, AGENTS.task, {
    agentType: 'general-purpose', description: 'PA fixture task agent',
    toolUseId: CALL_IDS.task, model: 'opus', spawnDepth: 1,
  });
  write(path.join(subagentDir(SESSIONS.task), `agent-${AGENTS.taskOrphan}.jsonl`), [
    subagentUser({
      sessionId: SESSIONS.task, subagentId: AGENTS.taskOrphan, timestamp: at(30),
      text: 'Reply with exactly PA-ORPHAN-HELLO and nothing else.',
    }),
    subagentAssistant({
      sessionId: SESSIONS.task, subagentId: AGENTS.taskOrphan, timestamp: at(32), model: 'claude-opus-5',
      messageId: 'msg_pa_task_orphan_1', text: 'PA-ORPHAN-HELLO',
      usage: usageRecord({ input: 500, output: 50 }),
    }),
  ]);
  meta(SESSIONS.task, AGENTS.taskOrphan, {
    agentType: 'general-purpose', description: 'PA fixture orphan agent',
    toolUseId: 'toolu_01PaAbsentFromParent001', model: 'opus', spawnDepth: 1,
  });

  // ---- ①b background：普通子代理但 `run_in_background: true`（tool_result = async_launched）----
  // 记录形状照抄真实转写（2026-09-12 本机实测 toolUseResult 键集合：
  // agentId / canReadOutputFile / description / isAsync / outputFile / prompt / resolvedModel / status）。
  write(`${SESSIONS.background}.jsonl`, [
    userText({
      sessionId: SESSIONS.background, timestamp: at(0),
      text: 'Launch one background subagent with the Task tool (subagent_type: general-purpose, run_in_background: true) with prompt: "Reply with exactly PA-BG-HELLO and nothing else." Then reply with exactly PA-BG-STARTED.',
    }),
    assistantToolUse({
      sessionId: SESSIONS.background, timestamp: at(5), model: 'claude-opus-5', messageId: 'msg_pa_bg_main_1',
      name: 'Agent', toolUseId: CALL_IDS.background,
      input: {
        description: 'PA fixture background agent', subagent_type: 'general-purpose',
        prompt: 'Reply with exactly PA-BG-HELLO and nothing else.', run_in_background: true,
      },
    }),
    userToolResult({
      sessionId: SESSIONS.background, timestamp: at(6), toolUseId: CALL_IDS.background,
      text: 'Async agent launched successfully.', toolUseResult: {
        isAsync: true, status: 'async_launched', agentId: AGENTS.background,
        description: 'PA fixture background agent', resolvedModel: 'claude-opus-5',
        prompt: 'Reply with exactly PA-BG-HELLO and nothing else.',
        outputFile: path.join(dir, SESSIONS.background, 'background', 'pa-bg.output'),
        canReadOutputFile: true,
      },
    }),
    assistantText({
      sessionId: SESSIONS.background, timestamp: at(7), model: 'claude-opus-5',
      messageId: 'msg_pa_bg_main_2', text: 'PA-BG-STARTED',
    }),
  ]);
  write(path.join(subagentDir(SESSIONS.background), `agent-${AGENTS.background}.jsonl`), [
    subagentUser({
      sessionId: SESSIONS.background, subagentId: AGENTS.background, timestamp: at(5.5),
      text: 'Reply with exactly PA-BG-HELLO and nothing else.',
    }),
    subagentAssistant({
      sessionId: SESSIONS.background, subagentId: AGENTS.background, timestamp: at(9), model: 'claude-opus-5',
      messageId: 'msg_pa_bg_agent_1', text: 'PA-BG-HELLO',
      usage: usageRecord({ input: 1000, output: 100 }),
    }),
  ]);
  meta(SESSIONS.background, AGENTS.background, {
    agentType: 'general-purpose', description: 'PA fixture background agent',
    toolUseId: CALL_IDS.background, model: 'opus', spawnDepth: 1,
  });

  // ---- ② workflow：runId 只能靠父 jsonl 里那条 tool_result 才认得出 -------------------
  write(`${SESSIONS.workflow}.jsonl`, [
    userText({
      sessionId: SESSIONS.workflow, timestamp: at(0),
      text: "Call the Workflow tool exactly once. Pass this script verbatim as the `script` argument, then reply with the single word PA-WF-STARTED.",
    }),
    assistantToolUse({
      sessionId: SESSIONS.workflow, timestamp: at(5), model: 'claude-sonnet-4-6', messageId: 'msg_pa_wf_main_1',
      name: 'Workflow', toolUseId: CALL_IDS.workflow,
      input: { script: "export const meta = { name: 'pa-fixture-wf' }\nawait agent('Reply with exactly PA-WF-HELLO')" },
    }),
    userToolResult({
      sessionId: SESSIONS.workflow, timestamp: at(6), toolUseId: CALL_IDS.workflow,
      text: 'Workflow launched in background.', toolUseResult: {
        status: 'async_launched', taskId: 't0a1b2c3d', taskType: 'local_workflow',
        workflowName: 'pa-fixture-wf', runId: RUN_IDS.workflow, summary: 'PA fixture workflow',
        transcriptDir: path.join(dir, SESSIONS.workflow, 'subagents', 'workflows', RUN_IDS.workflow),
      },
    }),
    assistantText({
      sessionId: SESSIONS.workflow, timestamp: at(12), model: 'claude-sonnet-4-6',
      messageId: 'msg_pa_wf_main_2', text: 'PA-WF-STARTED',
    }),
  ]);
  for (const [index, subagentId] of AGENTS.workflow.entries()) {
    writeWorkflow(SESSIONS.workflow, RUN_IDS.workflow, `agent-${subagentId}.jsonl`, [
      subagentUser({
        sessionId: SESSIONS.workflow, subagentId, timestamp: at(6.5 + index / 10),
        text: 'Reply with exactly PA-WF-HELLO and nothing else.',
      }),
      subagentAssistant({
        sessionId: SESSIONS.workflow, subagentId, timestamp: at(7 + index), model: 'claude-sonnet-4-6',
        messageId: `msg_pa_wf_agent_${index + 1}`, text: 'PA-WF-HELLO',
        usage: usageRecord({ input: 1000 * (index + 1), output: 100 * (index + 1) }),
      }),
    ]);
    // workflow 内层 agent 的 meta 只有 agentType/spawnDepth（契约 §10.7 #3）—— 没有 toolUseId。
    workflowMeta(SESSIONS.workflow, RUN_IDS.workflow, subagentId, { agentType: 'workflow-subagent', spawnDepth: 1 });
  }

  // ---- ③ resume：同一 runId 两条 tool_result（t1 < t2），三个 agent 跨 t2 -----------------
  const resumeCalls = [
    { toolUseId: CALL_IDS.resume[0], assistantAt: at(5), resultAt: at(6), messageId: 'msg_pa_resume_main_1' },
    { toolUseId: CALL_IDS.resume[1], assistantAt: at(45), resultAt: at(46), messageId: 'msg_pa_resume_main_2' },
  ];
  write(`${SESSIONS.resume}.jsonl`, [
    userText({
      sessionId: SESSIONS.resume, timestamp: at(0),
      text: 'Call the Workflow tool exactly once with the provided script, then reply PA-RESUME-1.',
    }),
    ...resumeCalls.flatMap(call => ([
      assistantToolUse({
        sessionId: SESSIONS.resume, timestamp: call.assistantAt, model: 'claude-sonnet-4-6',
        messageId: call.messageId, name: 'Workflow', toolUseId: call.toolUseId,
        input: { script: "export const meta = { name: 'pa-fixture-resume' }" },
      }),
      userToolResult({
        sessionId: SESSIONS.resume, timestamp: call.resultAt, toolUseId: call.toolUseId,
        text: 'Workflow launched in background.', toolUseResult: {
          status: 'async_launched', taskId: `t0a1b2c3d${call.toolUseId.slice(-1)}`,
          taskType: 'local_workflow', workflowName: 'pa-fixture-resume',
          runId: RUN_IDS.resume, summary: 'PA fixture resume', resumed: call.toolUseId === CALL_IDS.resume[1],
          transcriptDir: path.join(dir, SESSIONS.resume, 'subagents', 'workflows', RUN_IDS.resume),
        },
      }),
    ])),
    assistantText({
      sessionId: SESSIONS.resume, timestamp: at(60), model: 'claude-sonnet-4-6',
      messageId: 'msg_pa_resume_main_3', text: 'PA-RESUME-DONE',
    }),
  ]);
  // 首条 assistant 记录的时间（t1 = 6s、t2 = 46s）：
  //   21 → 20s（落在 t1 与 t2 之间 → 就近取 t1 那次调用）；22 → 1s（早于全部调用 → 取最早一次 = t1 那次）；
  //   23 → 50s（晚于 t2 → 取 t2 那次调用）。
  const resumeAgentFirstAt = { [AGENTS.resume[0]]: at(20), [AGENTS.resume[1]]: at(1), [AGENTS.resume[2]]: at(50) };
  for (const subagentId of AGENTS.resume) {
    writeWorkflow(SESSIONS.resume, RUN_IDS.resume, `agent-${subagentId}.jsonl`, [
      subagentUser({
        sessionId: SESSIONS.resume, subagentId, timestamp: new Date(Date.parse(resumeAgentFirstAt[subagentId]) - 500).toISOString(),
        text: 'Reply with exactly PA-RESUME-HELLO and nothing else.',
      }),
      subagentAssistant({
        sessionId: SESSIONS.resume, subagentId, timestamp: resumeAgentFirstAt[subagentId],
        model: 'claude-sonnet-4-6', messageId: `msg_pa_resume_agent_${subagentId.slice(-2)}`,
        text: 'PA-RESUME-HELLO', usage: usageRecord({ input: 1000, output: 100 }),
      }),
    ]);
    workflowMeta(SESSIONS.resume, RUN_IDS.resume, subagentId, { agentType: 'workflow-subagent', spawnDepth: 1 });
  }

  // ---- ④ ambiguous：两条 tool_result 的时间戳逐字相同（分不开）→ 一个都不归属 -------------
  write(`${SESSIONS.ambiguous}.jsonl`, [
    userText({
      sessionId: SESSIONS.ambiguous, timestamp: at(10),
      text: 'Call the Workflow tool with the provided script, then reply PA-AMBIG-1.',
    }),
    ...CALL_IDS.ambiguous.flatMap((toolUseId, index) => ([
      ...(index === 0 ? [] : [userText({
        sessionId: SESSIONS.ambiguous, timestamp: at(10),
        text: 'Resume that workflow run with the same runId, then reply PA-AMBIG-2.',
      })]),
      assistantToolUse({
        sessionId: SESSIONS.ambiguous, timestamp: at(10), model: 'claude-sonnet-4-6',
        messageId: `msg_pa_ambig_main_${toolUseId.slice(-1)}`, name: 'Workflow', toolUseId,
        input: { script: "export const meta = { name: 'pa-fixture-ambiguous' }" },
      }),
      userToolResult({
        sessionId: SESSIONS.ambiguous, timestamp: at(10), toolUseId,
        text: 'Workflow launched in background.', toolUseResult: {
          status: 'async_launched', taskId: `t0a1b2c3e${toolUseId.slice(-1)}`,
          taskType: 'local_workflow', workflowName: 'pa-fixture-ambiguous',
          runId: RUN_IDS.ambiguous, summary: 'PA fixture ambiguous',
          transcriptDir: path.join(dir, SESSIONS.ambiguous, 'subagents', 'workflows', RUN_IDS.ambiguous),
        },
      }),
    ])),
    assistantText({
      sessionId: SESSIONS.ambiguous, timestamp: at(30), model: 'claude-sonnet-4-6',
      messageId: 'msg_pa_ambig_main_3', text: 'PA-AMBIG-DONE',
    }),
  ]);
  for (const subagentId of AGENTS.ambiguous) {
    writeWorkflow(SESSIONS.ambiguous, RUN_IDS.ambiguous, `agent-${subagentId}.jsonl`, [
      subagentUser({
        sessionId: SESSIONS.ambiguous, subagentId, timestamp: at(24.5),
        text: 'Reply with exactly PA-AMBIG-HELLO and nothing else.',
      }),
      subagentAssistant({
        sessionId: SESSIONS.ambiguous, subagentId, timestamp: at(25), model: 'claude-sonnet-4-6',
        messageId: `msg_pa_ambig_agent_${subagentId.slice(-2)}`, text: 'PA-AMBIG-HELLO',
        usage: usageRecord({ input: 1000, output: 100 }),
      }),
    ]);
    workflowMeta(SESSIONS.ambiguous, RUN_IDS.ambiguous, subagentId, { agentType: 'workflow-subagent', spawnDepth: 1 });
  }

  return {
    projectHash: SUBAGENT_PROJECT_HASH,
    dir,
    // agentId 一律带 `agent-` 前缀（= 转写文件名去扩展名，与响应里的 agentSessionId 同口径）
    task: { sessionId: SESSIONS.task, agentId: `agent-${AGENTS.task}`, orphanId: `agent-${AGENTS.taskOrphan}`, callId: CALL_IDS.task },
    background: { sessionId: SESSIONS.background, agentId: `agent-${AGENTS.background}`, callId: CALL_IDS.background },
    workflow: {
      sessionId: SESSIONS.workflow, runId: RUN_IDS.workflow,
      agentIds: AGENTS.workflow.map(id => `agent-${id}`), callId: CALL_IDS.workflow,
    },
    resume: {
      sessionId: SESSIONS.resume, runId: RUN_IDS.resume, agentIds: AGENTS.resume.map(id => `agent-${id}`),
      callIds: CALL_IDS.resume, callAt: resumeCalls.map(call => ({ toolUseId: call.toolUseId, assistantAt: call.assistantAt, resultAt: call.resultAt })),
    },
    ambiguous: {
      sessionId: SESSIONS.ambiguous, runId: RUN_IDS.ambiguous,
      agentIds: AGENTS.ambiguous.map(id => `agent-${id}`), callIds: CALL_IDS.ambiguous,
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = ensureFixtureManifest({ force: true });
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}
