// PA-5xx：A 项 —— 子代理花费显示在它自己的位置上（契约 §10.1 / §10.3 / §10.5）。
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import {
  clientPricing, pricingPayload, quote, useCatalog, readMessages, getRuntime, usage, roughProvider,
  EnvironmentBlocked, usd,
} from './helpers/pa-runtime.mjs';
import { ensureFixtureManifest } from './helpers/pa-fixtures.mjs';

function transcripts() {
  return ensureFixtureManifest().transcripts;
}

/** A 项的夹具（转写 + 归属键）都是本套件现场合成的，见 helpers/pa-fixtures.mjs 的「A 项夹具」一节。 */
function subagentFixtures() {
  const manifest = ensureFixtureManifest();
  if (!manifest.subagents?.dir) {
    throw new EnvironmentBlocked('夹具清单里没有 subagents 段 —— 跑 `node helpers/pa-fixtures.mjs` 重建');
  }
  return manifest.subagents;
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

/**
 * 夹具自证：本套件的数据根里必须真的有这份转写 —— 缺了就是环境不成立（不是"没验到也算过"，
 * 也不是产品结论）。三条 A 项用例都先跑这一步，再验产品行为。
 */
function requireFixtureFile(file, what) {
  if (!fs.existsSync(file)) {
    throw new EnvironmentBlocked(`夹具缺${what}：${file}（跑 \`node helpers/pa-fixtures.mjs\` 重建）`);
  }
  return file;
}

function toolUseIdsOf(records) {
  const ids = [];
  for (const record of records) {
    if (!Array.isArray(record?.message?.content)) continue;
    for (const block of record.message.content) {
      if (block?.type === 'tool_use') ids.push(block.id);
    }
  }
  return ids;
}

/** 父 jsonl 里所有「承载 tool_result 的记录」：{toolUseId, timestamp, toolUseResult, text}。 */
function toolResultsOf(records) {
  const out = [];
  for (const record of records) {
    if (!Array.isArray(record?.message?.content)) continue;
    for (const block of record.message.content) {
      if (block?.type !== 'tool_result') continue;
      out.push({
        toolUseId: block.tool_use_id,
        timestamp: record.timestamp,
        toolUseResult: record.toolUseResult ?? null,
        text: JSON.stringify(block.content ?? ''),
      });
    }
  }
  return out;
}

/** 该转写里所有带 usage 的 assistant 记录（按文件顺序）。 */
function assistantUsagesOf(records) {
  return records.filter(record => record?.type === 'assistant' && record?.message?.usage);
}

/** 按 `message.id` 去重、首次出现为准 —— 契约 §10.1 逐字复用 §3.4 的口径，测试侧独立算一遍当期望值。 */
function firstOccurrenceByMessageId(records) {
  const seen = new Map();
  for (const record of assistantUsagesOf(records)) {
    if (!seen.has(record.message.id)) seen.set(record.message.id, record);
  }
  return seen;
}

/** 响应里所有 turn 的 agents[]（展平，带它所在的那一轮）。 */
function allAgents(body) {
  const out = [];
  for (const message of body.messages || []) {
    if (message.type !== 'turn') continue;
    for (const item of message.subUsage?.agents || []) out.push({ turn: message, item });
  }
  return out;
}

function agentsNamed(body, agentSessionId) {
  return allAgents(body).filter(entry => entry.item.agentSessionId === agentSessionId);
}

function agent(overrides = {}) {
  return {
    agentSessionId: 'agent-pa0001',
    toolUseId: 'toolu_pa_0001',
    agentType: 'code-reviewer',
    model: 'claude-opus-5',
    timestamp: '2026-09-11T02:00:00.000Z',
    usage: usage({ input: 1000, output: 100 }),
    ...overrides,
  };
}

/** 跑一段代码并区分「抛了」与「返回了」。 */
async function capture(fn) {
  try { return { ok: true, value: await fn() }; } catch (error) { return { ok: false, error }; }
}

async function catalogForModels(pairs) {
  const quotes = pairs.map(([modelId, input, output]) => quote({
    quoteId: `pa-${modelId}`,
    modelId,
    prices: { input, output, cacheRead: input / 10, cacheWrite5m: null, cacheWrite1h: null },
  }));
  await useCatalog(pricingPayload({ quotes }));
}

test('PA-501 computeCostForAgents：空数组 → {totalUsd:0,count:0,agents:[],partial:false}', async () => {
  const { computeCostForAgents } = await clientPricing();
  await useCatalog(pricingPayload({}));
  const result = await computeCostForAgents([], roughProvider());
  expect(result.totalUsd).toBe(0);
  expect(result.count).toBe(0);
  expect(result.agents).toEqual([]);
  expect(result.partial).toBe(false);
});

test('PA-502 computeCostForAgents：非数组输入 → 与空数组同形，且不抛异常', async () => {
  const { computeCostForAgents } = await clientPricing();
  await useCatalog(pricingPayload({}));
  for (const bad of [undefined, null, 'agents', 42, {}]) {
    const outcome = await capture(() => computeCostForAgents(bad, roughProvider()));
    expect(outcome.ok, `computeCostForAgents(${JSON.stringify(bad)}) 不得抛：${outcome.error?.message}`).toBe(true);
    expect(outcome.value).toEqual({ totalUsd: 0, count: 0, agents: [], partial: false });
  }
});

test('PA-503 每个 agent 按自身 model 计价：opus 与 sonnet 各取自己的价，不得沿用主回合 model', async () => {
  const { computeCostForAgents } = await clientPricing();
  await catalogForModels([['claude-opus-5', 5, 25], ['claude-sonnet-4-6', 3, 15]]);
  const result = await computeCostForAgents([
    agent({ model: 'claude-opus-5', usage: usage({ input: 1000, output: 0 }) }),
    agent({ agentSessionId: 'agent-pa0002', toolUseId: 'toolu_pa_0002', model: 'claude-sonnet-4-6', usage: usage({ input: 1000, output: 0 }) }),
  ], roughProvider());
  expect(result.count).toBe(2);
  const opus = result.agents.find(item => item.model === 'claude-opus-5');
  const sonnet = result.agents.find(item => item.model === 'claude-sonnet-4-6');
  expect(opus.costUsd, 'opus agent 按 opus 价').toBeCloseTo(usd(1000, 5), 9);
  expect(sonnet.costUsd, 'sonnet agent 按 sonnet 价').toBeCloseTo(usd(1000, 3), 9);
  expect(result.totalUsd).toBeCloseTo(opus.costUsd + sonnet.costUsd, 9);
});

test('PA-504 计价失败的 agent：costUsd = null（不是 0），partial = true，且不计入 totalUsd', async () => {
  const { computeCostForAgents } = await clientPricing();
  await catalogForModels([['claude-opus-5', 5, 25]]);
  const priced = agent({ model: 'claude-opus-5', usage: usage({ input: 1000, output: 0 }) });
  const unpriced = agent({
    agentSessionId: 'agent-pa0009', toolUseId: 'toolu_pa_0009',
    model: 'pa-never-priced-model', usage: usage({ input: 1000, output: 100 }),
  });
  const result = await computeCostForAgents([priced, unpriced], roughProvider());
  const failed = result.agents.find(item => item.model === 'pa-never-priced-model');
  expect(failed.costUsd, '失败的 agent 必须是 null 而不是 0').toBeNull();
  expect(result.partial).toBe(true);
  expect(result.totalUsd, 'totalUsd 只含可计价的部分').toBeCloseTo(usd(1000, 5), 9);
});

test('PA-505 卡片金额规则：同一 toolUseId 名下多个 agent 各自保留金额，合计 = 各 costUsd 之和', async () => {
  const { computeCostForAgents } = await clientPricing();
  await catalogForModels([['claude-opus-5', 5, 25]]);
  const toolUseId = 'toolu_pa_workflow';
  const result = await computeCostForAgents([
    agent({ toolUseId, agentSessionId: 'agent-pa-w1' }),
    agent({ toolUseId, agentSessionId: 'agent-pa-w2' }),
    agent({ toolUseId, agentSessionId: 'agent-pa-w3' }),
  ], roughProvider());
  const cardAgents = result.agents.filter(item => item.toolUseId === toolUseId);
  expect(cardAgents.length).toBe(3);
  const cardSum = cardAgents.reduce((acc, item) => acc + item.costUsd, 0);
  expect(result.totalUsd).toBeCloseTo(cardSum, 9);
  expect(result.agents.every(item => typeof item.costUsd === 'number'), '每个 agent 都要有自己的金额').toBe(true);
});

test('PA-506 失败不外溢：单个 agent 的畸形输入不得让整次调用抛异常', async () => {
  const { computeCostForAgents } = await clientPricing();
  await catalogForModels([['claude-opus-5', 5, 25]]);
  const broken = [
    agent({ agentSessionId: 'agent-pa-nousage', usage: undefined }),
    agent({ agentSessionId: 'agent-pa-badusage', usage: usage({ input: -5 }) }),
    agent({ agentSessionId: 'agent-pa-nomodel', model: undefined }),
    agent({ agentSessionId: 'agent-pa-empty', model: 'claude-opus-5', usage: {} }),
  ];
  const outcome = await capture(() => computeCostForAgents(broken, roughProvider()));
  expect(outcome.ok, `畸形 agent 不得让整次调用抛异常：${outcome.error?.message}`).toBe(true);
  const result = outcome.value;
  expect(result.count).toBe(4);
  expect(result.agents.every(item => item.costUsd === null), '四个都算不出来 → 全是 null').toBe(true);
  expect(result.totalUsd).toBe(0);
  expect(result.partial).toBe(true);
});

test('PA-507 纯函数无副作用：调用后传入的 agents 数组逐字段未被改写', async () => {
  const { computeCostForAgents } = await clientPricing();
  await catalogForModels([['claude-opus-5', 5, 25]]);
  const input = [agent({ model: 'claude-opus-5' })];
  const snapshot = JSON.parse(JSON.stringify(input));
  await computeCostForAgents(input, roughProvider());
  expect(input).toEqual(snapshot);
});

test('PA-508 usageTotals 不得被本项污染：不出现 subagent 分项', async ({ request }) => {
  const { baseURL } = getRuntime();
  const fixture = transcripts();
  const { status, body } = await readMessages(request, baseURL, fixture.sessionId, fixture.projectHash);
  expect(status).toBe(200);
  expect(body.usageTotals, 'usageTotals 必须仍在').toBeTruthy();
  expect(Object.prototype.hasOwnProperty.call(body.usageTotals, 'subagent'),
    '契约 §10.1：v2 的 usageTotals.subagent 已作废').toBe(false);
});

test('PA-509 agents[] 逐字反映子代理转写（model 取真 id、timestamp/usage 取首条、toolUseId 属于本轮）', async ({ request }) => {
  const { baseURL } = getRuntime();
  const fixture = subagentFixtures();
  const fx = fixture.task;
  const dir = fixture.dir;
  const subagentsDir = path.join(dir, fx.sessionId, 'subagents');
  const parentFile = requireFixtureFile(path.join(dir, `${fx.sessionId}.jsonl`), 'Task 子代理的父会话转写');
  const agentFile = requireFixtureFile(path.join(subagentsDir, `${fx.agentId}.jsonl`), 'Task 子代理转写');
  const metaFile = requireFixtureFile(path.join(subagentsDir, `${fx.agentId}.meta.json`), 'Task 子代理的 meta');

  // ---- 夹具自证（三条都成立才有资格往下判；不成立 = 环境不成立，不是"跑过了"）----
  const parent = readJsonl(parentFile);
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  expect(typeof meta.toolUseId, `夹具自证：${metaFile} 必须带 toolUseId`).toBe('string');
  expect(toolUseIdsOf(parent), `夹具自证：父 jsonl 里找不到 tool_use ${meta.toolUseId}`).toContain(meta.toolUseId);
  const usages = assistantUsagesOf(readJsonl(agentFile));
  expect(usages.length, '夹具自证：子代理转写里必须有带 usage 的 assistant 记录').toBeGreaterThan(0);
  const first = usages[0];
  const perMessage = firstOccurrenceByMessageId(readJsonl(agentFile));

  // ---- 产品行为 ----
  const { status, body } = await readMessages(request, baseURL, fx.sessionId, fixture.projectHash);
  expect(status).toBe(200);
  const found = agentsNamed(body, fx.agentId);
  expect(found.length, '夹具里备了可归属子代理（转写 + 父 jsonl 的 tool_use 都在）→ 它必须恰好出现一次').toBe(1);
  const { turn, item } = found[0];
  expect((turn.toolCalls || []).map(call => call.id), `toolUseId ${item.toolUseId} 必须属于本轮 toolCalls`).toContain(item.toolUseId);
  expect(item.toolUseId, '归属键 = meta.json 的 toolUseId').toBe(meta.toolUseId);
  expect(item.model, `model 必须取转写首条 assistant 记录的 message.model（${first.message.model}），`
    + `不是 meta.json 的别名（${meta.model}）`).toBe(first.message.model);
  expect(Date.parse(item.timestamp), 'timestamp = 首条带 timestamp 的 assistant 记录的时间').toBe(Date.parse(first.timestamp));
  expect(Date.parse(item.timestamp), 'timestamp 可被 Date.parse 解析').toBeGreaterThan(0);

  // 用量：同一 message.id 的分片只算一项、以**首次出现**为准（契约 §10.1 复用 §3.4 口径）
  const fragment = usages.filter(record => record.message.id === first.message.id);
  expect(fragment.length, '夹具自证：首个 message.id 至少要出现两次（分片），否则"取首次"判不出来').toBeGreaterThan(1);
  expect(fragment[1].message.usage.input_tokens, '夹具自证：分片的数字必须与首条不同（取末条会给出另一个数）')
    .not.toBe(fragment[0].message.usage.input_tokens);
  const sum = key => [...perMessage.values()].reduce((acc, record) => acc + (record.message.usage[key] || 0), 0);
  expect(item.usageCalls.length, 'usageCalls 条数 = 去重后的 message.id 数（分片不得重复计）').toBe(perMessage.size);
  expect(item.usage.input_tokens, '合计 = 各次调用**首次出现**的 input_tokens 之和（分片里被改大的数字不得混进来）')
    .toBe(sum('input_tokens'));
  expect(item.usage.output_tokens).toBe(sum('output_tokens'));
  expect(item.usage.cache_read_input_tokens).toBe(sum('cache_read_input_tokens'));
  expect(item.usage.cache_creation_input_tokens).toBe(sum('cache_creation_input_tokens'));
  [...perMessage.entries()].forEach(([messageId, record], index) => {
    expect(item.usageCalls[index].at, `usageCalls[${index}] 的 at = ${messageId} 首次出现那条记录的时间`)
      .toBe(record.timestamp);
    expect(item.usageCalls[index].usage.input_tokens, `${messageId} 取首次出现的用量，不是分片那条`)
      .toBe(record.message.usage.input_tokens);
  });
});

test('PA-510 归不上的子代理不得摊派：有可归属 agent 的前提下，孤儿一个都不出现', async ({ request }) => {
  const { baseURL } = getRuntime();
  const fixture = subagentFixtures();
  const fx = fixture.task;
  const dir = fixture.dir;
  const subagentsDir = path.join(dir, fx.sessionId, 'subagents');
  const parentFile = requireFixtureFile(path.join(dir, `${fx.sessionId}.jsonl`), 'Task 子代理的父会话转写');
  const orphanMetaFile = requireFixtureFile(path.join(subagentsDir, `${fx.orphanId}.meta.json`), '孤儿子代理的 meta');

  // ---- 夹具自证：这一轮里既**有**可归属的子代理（否则"不摊派"平凡成立、判不出东西），
  //      又有一个**归不上**的（它的 tool_use 在父 jsonl 里找不到）----
  const parent = readJsonl(parentFile);
  const parentToolUseIds = toolUseIdsOf(parent);
  const orphanMeta = JSON.parse(fs.readFileSync(orphanMetaFile, 'utf8'));
  expect(typeof orphanMeta.toolUseId, `夹具自证：${orphanMetaFile} 必须带 toolUseId`).toBe('string');
  expect(parentToolUseIds, '夹具自证：孤儿 agent 的 toolUseId 本就不该出现在父 jsonl 里')
    .not.toContain(orphanMeta.toolUseId);
  expect(parentToolUseIds.length, '夹具自证：父 jsonl 里得有可归属的 tool_use').toBeGreaterThan(0);

  // ---- 产品行为 ----
  const { status, body } = await readMessages(request, baseURL, fx.sessionId, fixture.projectHash);
  expect(status).toBe(200);
  expect(allAgents(body).length, '有可归属 agent 的轮必须出现 agents[]（否则本用例判不出"不摊派"）').toBeGreaterThan(0);
  const raw = JSON.stringify(body.messages || []);
  expect(raw.includes('"unattributed"'), 'v3 已删 unattributed 桶，不得复活').toBe(false);
  expect(raw.includes('"subagentUnattributed"'), 'v3 已删顶层 subagentUnattributed').toBe(false);
  expect(raw.includes(fx.orphanId), '归不上的子代理不得出现在响应任何位置（不摊派、不猜）').toBe(false);
  expect(raw.includes(orphanMeta.toolUseId), '归不上的 tool_use id 也不得出现').toBe(false);
});

test('PA-511 workflow 归属：内层 agent 全归到 Workflow 调用的轮，且各只出现一次', async ({ request }) => {
  const { baseURL } = getRuntime();
  const fixture = subagentFixtures();
  const fx = fixture.workflow;
  const dir = fixture.dir;
  const wfDir = path.join(dir, fx.sessionId, 'subagents', 'workflows', fx.runId);
  const parentFile = requireFixtureFile(path.join(dir, `${fx.sessionId}.jsonl`), 'Workflow 父会话转写');
  if (!fs.existsSync(wfDir)) {
    throw new EnvironmentBlocked(`夹具缺 workflow 转写目录：${wfDir}（跑 \`node helpers/pa-fixtures.mjs\` 重建）`);
  }
  const agentIds = fs.readdirSync(wfDir).filter(name => /^agent-.*\.jsonl$/.test(name)).map(name => name.slice(0, -'.jsonl'.length));

  // ---- 夹具自证：转写在场 + 父 jsonl 里那条 tool_result 带得出同一个 runId ----
  expect(agentIds.length, `夹具自证：${wfDir} 里必须有 agent-*.jsonl`).toBeGreaterThan(0);
  const parent = readJsonl(parentFile);
  const carriers = toolResultsOf(parent).filter(result => result.toolUseResult?.runId === fx.runId);
  expect(carriers.length, `夹具自证：父 jsonl 里必须有带 runId=${fx.runId} 的 tool_result`).toBeGreaterThan(0);
  for (const carrier of carriers) {
    expect(toolUseIdsOf(parent), `夹具自证：runId 的承载记录要挂在某个真 tool_use 上`).toContain(carrier.toolUseId);
  }

  // ---- 产品行为 ----
  const { status, body } = await readMessages(request, baseURL, fx.sessionId, fixture.projectHash);
  expect(status).toBe(200);
  const callId = carriers[0].toolUseId;
  for (const name of agentIds) {
    const found = agentsNamed(body, name);
    expect(found.length, `${name} 必须恰好出现一次（同一 agent 不得两轮各显示一遍）`).toBe(1);
    expect(found[0].item.toolUseId, `${name} 的归属键必须是那次 Workflow 调用（runId → tool_use_id）`).toBe(callId);
    expect((found[0].turn.toolCalls || []).map(call => call.id), `${name} 所在轮必须含该 Workflow 调用`).toContain(callId);
    const meta = JSON.parse(fs.readFileSync(path.join(wfDir, `${name}.meta.json`), 'utf8'));
    expect(meta.toolUseId, '夹具自证：workflow 内层 agent 的 meta 本来就没有 toolUseId').toBeUndefined();
    expect(found[0].item.agentType, 'agentType = meta.json 的 agentType').toBe(meta.agentType);
  }
  expect(allAgents(body).length, '本轮只有这些 agent，不得多出别的东西').toBe(agentIds.length);
});

test('PA-512 resume 多命中：按「承载记录时间 ≤ agent 首条时间」就近分派，各只出现一次', async ({ request }) => {
  const { baseURL } = getRuntime();
  const fixture = subagentFixtures();
  const fx = fixture.resume;
  const dir = fixture.dir;
  const wfDir = path.join(dir, fx.sessionId, 'subagents', 'workflows', fx.runId);
  const parentFile = requireFixtureFile(path.join(dir, `${fx.sessionId}.jsonl`), 'resume 父会话转写');
  const parent = readJsonl(parentFile);

  // ---- 夹具自证：同一 runId 挂两条 tool_result（记录时间 t1 < t2），且 agent 首条记录跨过 t2 ----
  const carriers = toolResultsOf(parent).filter(result => result.toolUseResult?.runId === fx.runId);
  expect(carriers.length, `夹具自证：同一 runId（${fx.runId}）必须挂两条 tool_result`).toBe(2);
  const ordered = [...carriers].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const [t1, t2] = ordered.map(carrier => Date.parse(carrier.timestamp));
  expect(t1, '夹具自证：两条承载记录的时间必须能分开（t1 < t2）').toBeLessThan(t2);
  const firstAtOf = name => Date.parse(assistantUsagesOf(readJsonl(path.join(wfDir, `${name}.jsonl`)))[0].timestamp);
  const firstAts = Object.fromEntries(fx.agentIds.map(name => [name, firstAtOf(name)]));
  expect(Object.values(firstAts).filter(at => at < t2).length, '夹具自证：要有 agent 首条记录早于 t2').toBeGreaterThan(0);
  expect(Object.values(firstAts).filter(at => at > t2).length, '夹具自证：要有 agent 首条记录晚于 t2').toBeGreaterThan(0);

  // 期望值按契约就地算一遍（不抄产品实现）：≤ 自身时间的**最后一次**调用；早于全部调用则取**最早**一次。
  const calls = ordered.map(carrier => ({
    toolUseId: carrier.toolUseId, at: Date.parse(carrier.timestamp),
  }));
  const expectedCall = agentAt => {
    const applicable = calls.filter(call => call.at <= agentAt);
    const pool = applicable.length ? applicable : calls;
    return pool.reduce((best, call) => {
      const closer = applicable.length ? call.at >= best.at : call.at <= best.at;
      return closer ? call : best;
    }).toolUseId;
  };

  // ---- 产品行为 ----
  const { status, body } = await readMessages(request, baseURL, fx.sessionId, fixture.projectHash);
  expect(status).toBe(200);
  for (const name of fx.agentIds) {
    const found = agentsNamed(body, name);
    expect(found.length, `${name} 必须恰好出现一次（不得两轮各显示一遍）`).toBe(1);
    expect(found[0].item.toolUseId, `${name}（首条记录 ${new Date(firstAts[name]).toISOString()}）`
      + `应归到承载记录 t1=${new Date(t1).toISOString()} / t2=${new Date(t2).toISOString()} 里就近的那一次`)
      .toBe(expectedCall(firstAts[name]));
  }
  expect(allAgents(body).length, '不得多出别的东西').toBe(fx.agentIds.length);
});

test('PA-513 resume 多命中且时间戳分不开（两次调用同秒）→ 一个都不摊派', async ({ request }) => {
  const { baseURL } = getRuntime();
  const fixture = subagentFixtures();
  const fx = fixture.ambiguous;
  const dir = fixture.dir;
  const parentFile = requireFixtureFile(path.join(dir, `${fx.sessionId}.jsonl`), 'ambiguous 父会话转写');
  const parent = readJsonl(parentFile);

  // ---- 夹具自证：同一 runId 两条承载记录，时间戳逐字相同（分不开）----
  const carriers = toolResultsOf(parent).filter(result => result.toolUseResult?.runId === fx.runId);
  expect(carriers.length, `夹具自证：同一 runId（${fx.runId}）必须挂两条 tool_result`).toBe(2);
  expect(new Set(carriers.map(carrier => carrier.timestamp)).size, '夹具自证：两条承载记录的时间必须逐字相同（分不开）').toBe(1);
  const wfDir = path.join(dir, fx.sessionId, 'subagents', 'workflows', fx.runId);
  for (const name of fx.agentIds) {
    requireFixtureFile(path.join(wfDir, `${name}.jsonl`), `${name} 的 workflow 转写`);
  }

  // ---- 产品行为：契约 §10.1「多命中且时间戳分不开（两次调用同秒）」列在不可归属里 → 绝不摊派 ----
  const { status, body } = await readMessages(request, baseURL, fx.sessionId, fixture.projectHash);
  expect(status).toBe(200);
  for (const name of fx.agentIds) {
    expect(agentsNamed(body, name).length,
      `${name} 的 runId 有两条调用、记录时间分不开 → 不得归属（宁缺勿猜），一个都不该出现`).toBe(0);
  }
});
