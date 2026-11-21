#!/usr/bin/env node
// r207 自检:子代理用量按单个转写缓存(subagent-usage.js)。
//   ① 口径与旧算法逐字相同:旧算法(readline 逐行全解析 + 同一套去重汇总)照抄在本文件里当参照,
//      逐个转写比 usage / usageCalls / model / timestamp;夹具含全零调用、重复 message.id、<synthetic>、
//      TTL 分项、坏行、\r\n、末行没换行、第一个键不是 type 的用户记录;
//   ② 只解析助手记录:用户记录(行首能看出 type)一条都不 JSON.parse;
//   ③ 没变不重读;给其中一个转写追加一条 → 只重读这一个,用量随之变;meta.json 改了也认;
//   ④ 直播补齐(readSubagentUsageForToolUse)与历史挂上的条目逐字段相同。
// 临时 HOME,不起服务。node tests/unit/check-r207-subagent-usage-cache.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, realpathSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'cgui-r207-subuse-')));
const HOME = join(TMP, 'home');
process.env.HOME = HOME; process.env.USERPROFILE = HOME; process.env.CGUI_DISABLE_FILE_WATCHER = '1';
const PROJECT = '-tmp-r207-subuse';
const SID = '20720720-0000-4000-8000-0000000000a1';
const projectDir = join(HOME, '.claude', 'projects', PROJECT);
const subDir = join(projectDir, SID, 'subagents');
mkdirSync(subDir, { recursive: true });

const { streamJsonl } = await import('../../server/utils/jsonl-parser.js');
const { getSessionMessages, readSubagentUsageForToolUse } = await import('../../server/services/session-reader.js');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed += 1; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); passed += 1; };
const ts = (n) => new Date(Date.parse('2026-11-21T09:00:00.000Z') + n * 1000).toISOString();

// ── 参照:旧算法(r207 之前 session-reader.readAgentUsage 的逐字拷贝,只把 realModelName 内联)──────────
const realModelName = (m) => (typeof m === 'string' && m !== '' && !m.startsWith('<') ? m : null);
async function oldReadAgentUsage(filePath) {
  const calls = new Map();
  let model = null;
  let timestamp = null;
  try {
    await streamJsonl(filePath, (rec) => {
      if (rec?.type !== 'assistant') return;
      if (!timestamp && typeof rec.timestamp === 'string' && rec.timestamp) timestamp = rec.timestamp;
      const message = rec.message;
      if (!message || typeof message !== 'object') return;
      if (!model && message.model && !/^</.test(message.model)) model = message.model;
      const usage = message.usage;
      if (!usage || typeof usage !== 'object') return;
      const mid = message.id || rec.uuid;
      if (!mid || calls.has(mid)) return;
      const nonZero = (usage.input_tokens || 0) + (usage.output_tokens || 0)
        + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0) > 0;
      if (!nonZero) return;
      calls.set(mid, { at: rec.timestamp || null, usage, model: realModelName(message.model) });
    });
  } catch { return null; }
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
    sum5m += u.cache_creation?.ephemeral_5m_input_tokens || 0;
    sum1h += u.cache_creation?.ephemeral_1h_input_tokens || 0;
    usageCalls.push(entry.model ? { at: entry.at, usage: u, model: entry.model } : { at: entry.at, usage: u });
  }
  if (sum5m + sum1h > 0) agg.cache_creation = { ephemeral_5m_input_tokens: sum5m, ephemeral_1h_input_tokens: sum1h };
  return { model, timestamp, usage: agg, usageCalls };
}

// ── 夹具 ──────────────────────────────────────────────────────────────
const N = 6;
const mark = (i) => `r207mark${i}x`;
const userRec = (i, k) => JSON.stringify({ parentUuid: `p${k}`, isSidechain: true, promptId: `pr${i}`, type: 'user',
  message: { role: 'user', content: [{ tool_use_id: `t${i}_${k}`, type: 'tool_result', content: `${mark(i)} 结果${'内容'.repeat(200)}` }] },
  uuid: `su${i}_${k}`, timestamp: ts(k), sessionId: SID });
const asstRec = (i, k, id, usage, model = 'claude-sub-5') => JSON.stringify({ parentUuid: `su${i}_${k}`, isSidechain: true,
  message: { id, type: 'message', role: 'assistant', model, content: [{ type: 'text', text: `${mark(i)} 第${k}步` }], usage },
  type: 'assistant', uuid: `sa${i}_${k}`, timestamp: ts(k + 1), sessionId: SID });
const transcriptOf = (i) => {
  const lines = [];
  for (let k = 0; k < 8; k++) {
    lines.push(userRec(i, k));
    lines.push(asstRec(i, k, `msg_${i}_${k}`, { input_tokens: 10 + i, output_tokens: 5, cache_read_input_tokens: k, cache_creation_input_tokens: 2,
      cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 1 } }));
  }
  lines.push(asstRec(i, 20, `msg_${i}_3`, { input_tokens: 999, output_tokens: 999 }));      // 重复 message.id:不计
  lines.push(asstRec(i, 21, `msg_${i}_zero`, { input_tokens: 0, output_tokens: 0 }));        // 全零:不计
  lines.push(asstRec(i, 22, `msg_${i}_syn`, { input_tokens: 3, output_tokens: 1 }, '<synthetic>'));
  lines.push('{坏行');
  return `${lines.join(i % 2 ? '\r\n' : '\n')}${i === 3 ? '' : '\n'}`;   // 第 3 个末行没换行
};
const files = [];
for (let i = 0; i < N; i++) {
  const f = join(subDir, `agent-a${i}.jsonl`);
  writeFileSync(f, transcriptOf(i));
  writeFileSync(join(subDir, `agent-a${i}.meta.json`), JSON.stringify({ agentType: 'general-purpose', toolUseId: `toolu_${i}` }));
  files.push(f);
}
const parent = [];
for (let t = 0; t < N / 2; t++) {
  parent.push({ parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: `问${t}` }, uuid: `u${t}`, timestamp: ts(100 + t * 10), sessionId: SID });
  parent.push({ parentUuid: `u${t}`, isSidechain: false, message: { id: `pm${t}`, type: 'message', role: 'assistant', model: 'claude-main-5',
    content: [0, 1].map((j) => ({ type: 'tool_use', id: `toolu_${t * 2 + j}`, name: 'Agent', input: { prompt: 'p' } })),
    stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } }, type: 'assistant', uuid: `a${t}`, timestamp: ts(101 + t * 10), sessionId: SID });
  for (const j of [0, 1]) {
    parent.push({ parentUuid: `a${t}`, isSidechain: false, type: 'user', message: { role: 'user', content: [{ tool_use_id: `toolu_${t * 2 + j}`, type: 'tool_result', content: '完成' }] },
      uuid: `r${t}_${j}`, timestamp: ts(102 + t * 10 + j), sessionId: SID });
  }
}
writeFileSync(join(projectDir, `${SID}.jsonl`), `${parent.map((r) => JSON.stringify(r)).join('\n')}\n`);

const agentsOf = (res) => (res.messages || []).flatMap((m) => (m.type === 'turn' ? (m.subUsage?.agents || []) : []));
const realParse = JSON.parse;
let parsed = [];
const readCounting = async () => {
  parsed = [];
  JSON.parse = function patched(text, ...rest) { if (typeof text === 'string' && text.includes('r207mark')) parsed.push(text); return realParse.call(this, text, ...rest); };
  try { return await getSessionMessages(SID, PROJECT); } finally { JSON.parse = realParse; }
};
const parsedOf = (i) => parsed.filter((t) => t.includes(mark(i)));

try {
  // ① + ② 第一次读
  const first = await readCounting();
  const agents = agentsOf(first);
  eq(agents.map((a) => a.toolUseId), files.map((_, i) => `toolu_${i}`), '六个子代理都挂上,顺序同前');
  for (let i = 0; i < N; i++) {
    const want = await oldReadAgentUsage(files[i]);
    const got = agents[i];
    eq({ model: got.model, timestamp: got.timestamp, usage: got.usage, usageCalls: got.usageCalls }, want, `转写 ${i}:用量与旧算法逐字相同`);
    ok(parsedOf(i).length > 0 && parsedOf(i).every((t) => t.includes('"type":"assistant"')), `转写 ${i}:只解析了助手记录`);
  }
  ok(!parsed.some((t) => t.startsWith('{"parentUuid":"p')), '用户记录(行首看得出 type)一条都没解析');

  // ③ 没变不重读
  const second = await readCounting();
  eq(parsed.length, 0, '转写都没变 → 一条都不重读');
  eq(agentsOf(second), agents, '第二次结果相同');

  // ③ 只改第 4 个:追加一条新调用
  appendFileSync(files[4], `${asstRec(4, 30, 'msg_4_new', { input_tokens: 1000, output_tokens: 500 })}\n`);
  const third = await readCounting();
  ok(parsedOf(4).length > 0, '变了的那个重读');
  ok([0, 1, 2, 3, 5].every((i) => parsedOf(i).length === 0), '其余五个不重读');
  const a4 = agentsOf(third)[4];
  eq(a4.usage.input_tokens, agents[4].usage.input_tokens + 1000, '新调用的 input 计入');
  eq(a4.usage.output_tokens, agents[4].usage.output_tokens + 500, '新调用的 output 计入');
  eq({ model: a4.model, timestamp: a4.timestamp, usage: a4.usage, usageCalls: a4.usageCalls }, await oldReadAgentUsage(files[4]), '追加后仍与旧算法逐字相同');
  eq(agentsOf(third).filter((_, i) => i !== 4), agents.filter((_, i) => i !== 4), '其余五个结果不变');

  // ③ meta.json 改了也认(大小与修改时间都变)
  const metaPath = join(subDir, 'agent-a1.meta.json');
  writeFileSync(metaPath, JSON.stringify({ agentType: 'explorer-r207', toolUseId: 'toolu_1' }));
  const later = new Date(Date.now() + 5000);
  utimesSync(metaPath, later, later);
  const fourth = await readCounting();
  eq(agentsOf(fourth)[1].agentType, 'explorer-r207', 'meta.json 变了 → 用新的 agentType');
  eq(parsed.length, 0, '只改 meta 不重读转写');

  // ④ 直播补齐与历史条目逐字段相同
  const live = await readSubagentUsageForToolUse(PROJECT, SID, { toolUseId: 'toolu_4', taskId: 'a4' });
  eq(live, agentsOf(fourth)[4], '直播补齐(按 taskId 直连)与历史挂上的条目相同');
  const liveByMeta = await readSubagentUsageForToolUse(PROJECT, SID, { toolUseId: 'toolu_2', taskId: 'nope' });
  eq(liveByMeta, agentsOf(fourth)[2], '直播补齐(扫 meta 找)与历史条目相同');
} finally {
  JSON.parse = realParse;
}

console.log(`check-r207-subagent-usage-cache: OK (${passed} assertions)`);
