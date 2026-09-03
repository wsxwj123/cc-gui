#!/usr/bin/env node
// r96:OpenAI 兼容通道的缓存命中修复 —— 黑盒验收测试。
//
// 只依据 .devflow/INTERFACE-r96.md 的对外契约写,不看 openai-proxy.js 的函数体。
// 三块:
//   P0 = INTERFACE 第 2 节(代理行为:role 翻转 / 三轮前缀 LCP / usage 两条路 / 不发 user)
//   P1 = INTERFACE 第 1 节(纯函数 normalizeOpenAIUsage 契约)
//   P2 = INTERFACE 第 3 节(源码锁)
//
// 段落顺序硬要求(INTERFACE 文首):P0 排在 P1 之前。openai-usage.js 用动态 import,
// 缺失时打印可读错误、把 P1 的子条目标成"跳过"并让整体 exit 1 —— 不让"模块不存在"
// 这一条淹没 P0 的红。
//
// 零费用零外网:假上游 http.createServer + listen(0,'127.0.0.1');代理 startOpenAIProxy(0)。
// 断言消息里带 INTERFACE 编号(L*/R*/M*/表行号),红了能直接对回契约表。
//
// Run: node tests/unit/check-r96-cache-openai.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const count = (s, re) => (s.match(re) || []).length;

let PASS = 0;
let FAILS = 0;
let SKIPPED = 0;
const failed = [];
const skippedNames = [];

function pass(name) { PASS++; console.log(`  ✓ ${name}`); }
function fail(name, e) {
  FAILS++;
  failed.push(name);
  const msg = String((e && e.message) || e).split('\n').slice(0, 4).join('\n      ');
  console.log(`  ✗ ${name}\n      ${msg}`);
}
function check(name, fn) { try { fn(); pass(name); } catch (e) { fail(name, e); } }
async function acheck(name, fn) { try { await fn(); pass(name); } catch (e) { fail(name, e); } }
function skip(name, why) { SKIPPED++; skippedNames.push(name); console.log(`  ~ ${name}  (跳过:${why})`); }

// ── 被测模块:两个都用动态 import,缺失/语法错时给可读错误而非 ESM 链接期整文件炸 ──
let PROXY = null; let PROXY_ERR = '';
try { PROXY = await import('../../server/services/openai-proxy.js'); }
catch (e) { PROXY_ERR = String((e && e.message) || e); }

let U = null; let U_ERR = '';
try { U = await import('../../server/utils/openai-usage.js'); }
catch (e) { U_ERR = String((e && e.message) || e); }
const normalizeOpenAIUsage = U?.normalizeOpenAIUsage;

if (!PROXY) {
  console.log(`\n✗ 致命:server/services/openai-proxy.js 导入失败 —— ${PROXY_ERR}`);
  process.exit(1);
}
const { anthropicToOpenAIMessages, buildOpenAIRequest, setOpenAIUpstream, startOpenAIProxy } = PROXY;

// ══════════════════════════════════════════════════════════════════════════
// 假上游:一台服务器吃下全部请求。选择器藏在用户消息文本里(翻译后原样透传),
// 形如 `#UF=04#FIN=stop#TRAIL=0#`。#UF=00# 表示"这一路不回 usage"。
// ══════════════════════════════════════════════════════════════════════════

// INTERFACE 1.3 换算契约表(输入侧一律带 completion_tokens:20)
const FIXTURES = {
  '01': { prompt_tokens: 1000, completion_tokens: 20, prompt_cache_hit_tokens: 896, prompt_cache_miss_tokens: 104 },
  '02': { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 896 } },
  '03': { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 0 }, prompt_cache_hit_tokens: 896 },
  '04': { prompt_tokens: 1000, completion_tokens: 20, cached_tokens: 896 },
  '05': { prompt_tokens: 1000, completion_tokens: 20, cache_read_input_tokens: 896, cache_creation_input_tokens: 50 },
  '06': { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cache_read_input_tokens: 896 } },
  '07': { prompt_tokens: 1000, completion_tokens: 20, cached_tokens: 700, cache_creation_input_tokens: 200 },
  '08': { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 700, cache_creation_input_tokens: 200 } },
  '09': { prompt_tokens: 1000, completion_tokens: 20 },
};
// out = [input_tokens, cache_read_input_tokens, cache_creation_input_tokens];output 恒 20
const EXPECT = {
  '01': [104, 896, 0], '02': [104, 896, 0], '03': [104, 896, 0],
  '04': [104, 896, 0], '05': [54, 896, 50], '06': [104, 896, 0],
  '07': [100, 700, 200], '08': [100, 700, 200], '09': [1000, 0, 0],
};
const NOTE = {
  '01': 'DeepSeek prompt_cache_hit_tokens', '02': 'OpenAI/GLM prompt_tokens_details.cached_tokens',
  '03': '显式 0 不得短路', '04': 'Kimi/Moonshot 顶层 cached_tokens',
  '05': 'anthropic 命名顶层 + creation', '06': 'anthropic 命名嵌套',
  '07': 'creation 顶层透出', '08': 'creation 嵌套透出',
  '09': '无任何缓存字段,creation 必须 0',
};
const expectUsage = (id) => ({
  input_tokens: EXPECT[id][0],
  output_tokens: 20,
  cache_read_input_tokens: EXPECT[id][1],
  cache_creation_input_tokens: EXPECT[id][2],
});

const seen = [];              // 假上游收到的全部请求体(按到达序)
const upstream = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch { body = { __unparsable: raw }; }
    seen.push({ url: req.url, body });
    const uf = /#UF=(\d\d)#/.exec(raw)?.[1] || '';
    const fin = /#FIN=([a-z_]+)#/.exec(raw)?.[1] || 'stop';
    const trail = /#TRAIL=1#/.test(raw);
    const usage = uf && uf !== '00' ? FIXTURES[uf] : null;

    if (body.stream === false) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const out = {
        id: 'chatcmpl-r96',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: fin }],
      };
      if (usage) out.usage = usage;
      res.end(JSON.stringify(out));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const lines = ['data: {"choices":[{"delta":{"role":"assistant","content":"ok"}}]}'];
    if (usage && trail) {
      // 规范 OpenAI 形态:usage 单独挂在 choices:[] 的收尾 chunk 上(include_usage 的产物)
      lines.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: fin }] })}`);
      lines.push(`data: ${JSON.stringify({ choices: [], usage })}`);
    } else if (usage) {
      lines.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: fin }], usage })}`);
    } else {
      lines.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: fin }] })}`);
    }
    lines.push('data: [DONE]', '');
    res.end(lines.join('\n'));
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const upstreamURL = `http://127.0.0.1:${upstream.address().port}/v1`;
setOpenAIUpstream({ baseURL: upstreamURL, apiKey: 'test', model: 'deepseek-chat' });
const proxyPort = await startOpenAIProxy(0);

const postMessages = (body) => fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(10000),
});

// anthropic SSE → [{event,data}](与 check-r26-g11 同手法)
const parseSSE = (text) => {
  const events = [];
  for (const chunk of text.split('\n\n')) {
    const ev = /^event: (.+)$/m.exec(chunk)?.[1];
    const dt = /^data: (.+)$/m.exec(chunk)?.[1];
    if (ev && dt) events.push({ event: ev, data: JSON.parse(dt) });
  }
  return events;
};
const marker = (uf, opt = {}) => `ping #UF=${uf}#FIN=${opt.fin || 'stop'}#TRAIL=${opt.trail ? 1 : 0}#`;

// ══════════════════════════════════════════════════════════════════════════
// P0 / INTERFACE 2.1 —— 请求翻译的 role 规则(纯函数,直调 anthropicToOpenAIMessages)
// ══════════════════════════════════════════════════════════════════════════
console.log('\n[P0-2.1] role 翻译规则 anthropicToOpenAIMessages(messages, system, model)');

const T = '同一段元消息文字 X';
const IMG = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUFBQQ==' } };
const VMODEL = 'gpt-4o';                                   // 有视觉,图片块不会被剥

check('2.1-1 system + 字符串 content → role system(改动前后一致)', () => {
  const out = anthropicToOpenAIMessages([{ role: 'system', content: T }], null);
  assert.equal(out.length, 1, '不该多发消息');
  assert.equal(out[0].role, 'system');
  assert.equal(out[0].content, T);
});

check('R1/2.1-2 system + 数组 content(带 cache_control)→ role system(★唯一变化点,修前是 user)', () => {
  const out = anthropicToOpenAIMessages(
    [{ role: 'system', content: [{ type: 'text', text: T, cache_control: { type: 'ephemeral' } }] }], null);
  assert.equal(out.length, 1, '不该多发消息');
  assert.equal(out[0].role, 'system', `实得 ${out[0].role} —— 数组分支硬写 user 就是本轮 P0 根因`);
  assert.equal(out[0].content, T);
});

check('2.1-核心不变式 同一段文字的数组形态与字符串形态必须产出同一个 role', () => {
  const asArr = anthropicToOpenAIMessages([{ role: 'system', content: [{ type: 'text', text: T }] }], null)[0].role;
  const asStr = anthropicToOpenAIMessages([{ role: 'system', content: T }], null)[0].role;
  assert.equal(asArr, asStr, `数组形态得 ${asArr}、字符串形态得 ${asStr} —— 角色每轮翻一次 = 前缀每轮打穿`);
});

check('2.1-3 user + 字符串 → user(不变)', () => {
  const out = anthropicToOpenAIMessages([{ role: 'user', content: '问题' }], null);
  assert.equal(out[0].role, 'user');
  assert.equal(out[0].content, '问题');
});

check('2.1-4 user + 数组 text → user(不变)', () => {
  const out = anthropicToOpenAIMessages([{ role: 'user', content: [{ type: 'text', text: '问题' }] }], null);
  assert.equal(out[0].role, 'user');
  assert.equal(out[0].content, '问题');
});

check('2.1-5 user + [text, image] → user + 数组多模态 content(不变)', () => {
  const out = anthropicToOpenAIMessages([{ role: 'user', content: [{ type: 'text', text: '看图' }, IMG] }], null, VMODEL);
  const m = out.find((x) => Array.isArray(x.content));
  assert.ok(m, '应产出数组形态 content 的多模态消息');
  assert.equal(m.role, 'user');
  assert.ok(m.content.some((p) => p?.type === 'image_url'), '图片须以 image_url 到达');
});

check('M4/2.1-2 system + [text, image] → role 仍是 system(多模态那处 push 不得漏改)', () => {
  const out = anthropicToOpenAIMessages([{ role: 'system', content: [{ type: 'text', text: T }, IMG] }], null, VMODEL);
  const m = out.find((x) => Array.isArray(x.content));
  assert.ok(m, '应产出数组形态 content 的多模态消息');
  assert.equal(m.role, 'system', `实得 ${m.role} —— 只改文本那处 push、多模态那处仍硬写 user 就红在这里`);
});

check('M3/2.1-6 assistant + 字符串 → assistant(字符串快路不得被 role 白名单波及)', () => {
  const out = anthropicToOpenAIMessages([{ role: 'assistant', content: '答' }], null);
  assert.equal(out[0].role, 'assistant', '白名单套到字符串快路会把 assistant 拍成 user');
  assert.equal(out[0].content, '答');
});

check('2.1-7 assistant + 数组 → assistant,含 tool_calls / reasoning_content(不变)', () => {
  const out = anthropicToOpenAIMessages([{
    role: 'assistant',
    content: [{ type: 'thinking', thinking: '想' }, { type: 'tool_use', id: 'tu_1', name: 'Read', input: { p: 'x' } }],
  }], null);
  const m = out.find((x) => x.role === 'assistant');
  assert.ok(m, 'assistant 消息必须还在');
  assert.equal(m.reasoning_content, '想');
  assert.equal(m.tool_calls?.[0]?.id, 'tu_1');
});

check('M2/2.1-8 未知 role(developer)+ 数组 content → user(白名单只放行 system)', () => {
  for (const r of ['developer', 'moderator', 'tool']) {
    const out = anthropicToOpenAIMessages([{ role: r, content: [{ type: 'text', text: T }] }], null);
    assert.equal(out[0].role, 'user', `role=${r} + 数组 应落 user(原样透传 = 白名单失效)`);
  }
});

check('M3/2.1-9 developer + 字符串 → developer(快路原样保留)', () => {
  const out = anthropicToOpenAIMessages([{ role: 'developer', content: T }], null);
  assert.equal(out[0].role, 'developer');
});

check('M13/2.1-10 tool_result 拆成独立 role:tool 且排在同条消息的 text 之前', () => {
  const out = anthropicToOpenAIMessages([{
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'RES' }, { type: 'text', text: 'AFTER' }],
  }], null);
  const iTool = out.findIndex((m) => m.role === 'tool');
  assert.ok(iTool >= 0, 'tool_result 必须拆成 role:tool 消息');
  assert.equal(out[iTool].tool_call_id, 'tu_1');
  assert.equal(typeof out[iTool].content, 'string', 'OpenAI 协议 role:tool 的 content 必须是字符串');
  const iText = out.findIndex((m) => m.content === 'AFTER');
  assert.ok(iText > iTool, `tool 消息(#${iTool})必须排在同条消息产出的 text(#${iText})之前`);
});

check('2.1-11 system 参数(字符串)→ messages[0] = {role:system, content}', () => {
  const out = anthropicToOpenAIMessages([{ role: 'user', content: 'hi' }], 'SYSTEXT');
  assert.equal(out[0].role, 'system');
  assert.equal(out[0].content, 'SYSTEXT');
});

check('2.1-11 system 参数(块数组)→ messages[0] 各块文本按换行 join', () => {
  const out = anthropicToOpenAIMessages([{ role: 'user', content: 'hi' }],
    [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }]);
  assert.equal(out[0].role, 'system');
  assert.equal(out[0].content, 'A\nB');
});

check('2.1 回归:整条历史混合翻译时 role 集合只含 openai 合法值', () => {
  const out = anthropicToOpenAIMessages([
    { role: 'user', content: 'q' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'R', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r' }] },
    { role: 'system', content: [{ type: 'text', text: T }] },
  ], 'S');
  const legal = new Set(['system', 'user', 'assistant', 'tool']);
  for (const m of out) assert.ok(legal.has(m.role), `产出了非法 role: ${m.role}`);
});

// ══════════════════════════════════════════════════════════════════════════
// P0 / INTERFACE 2.2 —— 假上游三轮复现:canonical 前缀 LCP
// fixture 与 canonical 口径逐字抄 INTERFACE 2.2,不自己发明。
// ══════════════════════════════════════════════════════════════════════════
console.log('\n[P0-2.2] 三轮 canonical 前缀 LCP(L1–L7)');

const ENV = '# Environment ' + 'e'.repeat(4000);
const TOT = '<total_tokens>15000000 tokens left</total_tokens>';
const live = (t) => ({ role: 'system', content: [{ type: 'text', text: t, cache_control: { type: 'ephemeral' } }] });
const hist = (t) => ({ role: 'system', content: t });
const SYS = 'You are a test agent. ' + 's'.repeat(200);
const TOOLS = [{ name: 'Read', description: 'read', input_schema: { type: 'object', properties: { p: { type: 'string' } } } }];

const turn1 = [{ role: 'user', content: '第一问' }, live(ENV), live(TOT)];
const turn2 = [{ role: 'user', content: '第一问' }, hist(ENV), hist(TOT),
  { role: 'assistant', content: '第一答' }, { role: 'user', content: '第二问' }, live(TOT)];
const turn3 = [{ role: 'user', content: '第一问' }, hist(ENV), hist(TOT),
  { role: 'assistant', content: '第一答' }, { role: 'user', content: '第二问' }, hist(TOT),
  { role: 'assistant', content: '第二答' }, { role: 'user', content: '第三问' }, live(TOT)];

const segments = (req) => [
  req.messages[0].role === 'system' ? req.messages[0].content : '',
  JSON.stringify(req.tools || []),
  ...req.messages.slice(1).map((m) => JSON.stringify(m)),
];
const canonical = (req) => segments(req).join(' ');
const lcpLen = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
const lcpPct = (prev, cur) => (lcpLen(prev, cur) / prev.length) * 100;
const firstDiffSeg = (a, b) => {
  const sa = segments(a); const sb = segments(b);
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return i;
  return -1;
};

seen.length = 0;
let R1 = null; let R2 = null; let R3 = null; let lcpErr = '';
try {
  for (const messages of [turn1, turn2, turn3]) {
    const r = await postMessages({ model: 'deepseek-chat', system: SYS, tools: TOOLS, stream: true, max_tokens: 16000, messages });
    await r.text();
  }
  [R1, R2, R3] = seen.map((s) => s.body);
} catch (e) { lcpErr = String((e && e.message) || e); }

check('2.2-0 三轮请求都到达假上游(前置)', () => {
  assert.equal(lcpErr, '', `发请求出错:${lcpErr}`);
  assert.equal(seen.length, 3, `假上游应收到 3 个请求,实得 ${seen.length}`);
  for (const r of [R1, R2, R3]) assert.ok(Array.isArray(r?.messages), '每个请求体都要有 messages 数组');
});

check('L1 firstDiffSeg(req1, req2) === -1(req1 的段序列是 req2 的严格前缀)', () => {
  const idx = firstDiffSeg(R1, R2);
  const where = idx >= 0 ? segments(R1)[idx].slice(0, 60) : '';
  assert.equal(idx, -1, `第 ${idx} 段就断了,断点内容:${where}… ${idx >= 0 && segments(R1)[idx].includes('# Environment') ? '(= ENV 元消息,正是 role 翻转)' : ''}`);
});

check('L2 firstDiffSeg(req2, req3) === -1', () => {
  const idx = firstDiffSeg(R2, R3);
  const where = idx >= 0 ? segments(R2)[idx].slice(0, 80) : '';
  assert.equal(idx, -1, `第 ${idx} 段就断了,断点内容:${where}… ${idx >= 0 && segments(R2)[idx].includes('<total_tokens>') ? '(= total_tokens 元消息,正是 role 翻转)' : ''}`);
});

check('R2/L3 lcpPct(canonical(req1), canonical(req2)) === 100(修前 <90)', () => {
  const p = lcpPct(canonical(R1), canonical(R2));
  assert.ok(p >= 99, `实得 ${p.toFixed(2)}% —— 下限 99,契约要求 100`);
  assert.equal(p, 100, `实得 ${p.toFixed(2)}%`);
});

check('L4 lcpPct(canonical(req2), canonical(req3)) === 100(修前 <100)', () => {
  const p = lcpPct(canonical(R2), canonical(R3));
  assert.ok(p >= 99, `实得 ${p.toFixed(2)}% —— 下限 99,契约要求 100`);
  assert.equal(p, 100, `实得 ${p.toFixed(2)}%`);
});

check('R1/L5 角色一致性:三轮所有字符串 content 消息,同一段文字只对应一个 role', () => {
  const m = new Map();
  for (const req of [R1, R2, R3]) {
    for (const msg of req.messages) {
      if (typeof msg.content !== 'string') continue;
      if (!m.has(msg.content)) m.set(msg.content, new Set());
      m.get(msg.content).add(msg.role);
    }
  }
  const bad = [...m.entries()].filter(([, s]) => s.size !== 1)
    .map(([k, s]) => `「${k.slice(0, 40)}…」→ {${[...s].join(',')}}`);
  assert.deepEqual(bad, [], `以下文字在不同轮里换了角色(= 每轮打穿前缀):\n      ${bad.join('\n      ')}`);
});

check('L6 三轮的系统段与工具段逐字相同(不得回归)', () => {
  const sys = [R1, R2, R3].map((r) => segments(r)[0]);
  const tools = [R1, R2, R3].map((r) => segments(r)[1]);
  assert.equal(sys[0], sys[1], '系统段 轮1 vs 轮2');
  assert.equal(sys[1], sys[2], '系统段 轮2 vs 轮3');
  assert.ok(sys[0].includes('You are a test agent.'), '系统段应来自 system 参数');
  assert.equal(tools[0], tools[1], '工具段 轮1 vs 轮2');
  assert.equal(tools[1], tools[2], '工具段 轮2 vs 轮3');
  assert.ok(tools[0].includes('Read'), '工具段应含工具定义');
});

check('L7 请求体键集合恒为 [max_tokens,messages,model,stream,stream_options,tools],不含 id/时间戳/nonce/user/user_id', () => {
  const want = ['max_tokens', 'messages', 'model', 'stream', 'stream_options', 'tools'];
  for (const [i, r] of [R1, R2, R3].entries()) {
    assert.deepEqual(Object.keys(r).sort(), want, `第 ${i + 1} 轮键集合不符,实得 ${Object.keys(r).sort().join(',')}`);
  }
});

check('L7/2.4 三轮请求体都不含 user / user_id 字段(P2 反向约束)', () => {
  for (const [i, r] of [R1, R2, R3].entries()) {
    assert.ok(!('user' in r), `第 ${i + 1} 轮出现了 user 字段`);
    assert.ok(!('user_id' in r), `第 ${i + 1} 轮出现了 user_id 字段`);
  }
});

check('2.3 stream 为真时请求体含 stream_options:{include_usage:true}(不变)', () => {
  for (const r of [R1, R2, R3]) {
    assert.equal(r.stream, true);
    assert.deepEqual(r.stream_options, { include_usage: true });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// P0 / INTERFACE 2.3 —— usage 输出契约(流式 + 非流式两条路各跑 1.3 表 9 行)
// 期望值直接取 1.3 表(硬编码),不依赖 openai-usage.js 是否已存在 —— 这样修前
// R3/R4 能真跑出红,而不是"因模块缺失没跑"。
// ══════════════════════════════════════════════════════════════════════════
console.log('\n[P0-2.3] usage 换算 端到端(流式)');

const streamUsage = async (uf, opt = {}) => {
  const r = await postMessages({
    model: 'deepseek-chat', stream: true, max_tokens: 256,
    messages: [{ role: 'user', content: marker(uf, opt) }],
  });
  assert.equal(r.status, 200, `HTTP ${r.status}`);
  return parseSSE(await r.text());
};
const jsonUsage = async (uf, opt = {}) => {
  const r = await postMessages({
    model: 'deepseek-chat', stream: false, max_tokens: 256,
    messages: [{ role: 'user', content: marker(uf, opt) }],
  });
  assert.equal(r.status, 200, `HTTP ${r.status}`);
  return r.json();
};
const deltaUsage = (events) => events.find((e) => e.event === 'message_delta')?.data?.usage;

for (const id of Object.keys(FIXTURES)) {
  const star = id === '04' ? 'R3/' : '';
  await acheck(`${star}2.3-流式 1.3 表第 ${Number(id)} 行(${NOTE[id]})→ message_delta.usage`, async () => {
    const got = deltaUsage(await streamUsage(id));
    assert.deepEqual(got, expectUsage(id),
      `上游 ${JSON.stringify(FIXTURES[id])}\n      期望 ${JSON.stringify(expectUsage(id))}\n      实得 ${JSON.stringify(got)}`);
  });
}

console.log('\n[P0-2.3] usage 换算 端到端(非流式)');
for (const id of Object.keys(FIXTURES)) {
  const star = id === '07' ? 'R4/' : '';
  await acheck(`${star}2.3-非流式 1.3 表第 ${Number(id)} 行(${NOTE[id]})→ 响应 JSON 的 usage`, async () => {
    const j = await jsonUsage(id);
    assert.deepEqual(j.usage, expectUsage(id),
      `上游 ${JSON.stringify(FIXTURES[id])}\n      期望 ${JSON.stringify(expectUsage(id))}\n      实得 ${JSON.stringify(j.usage)}`);
  });
}

console.log('\n[P0-2.3] usage 其余契约行');

await acheck('R3 第 4 行(Kimi 顶层 cached_tokens)经流式得 cache_read_input_tokens === 896(修前 0)', async () => {
  assert.equal(deltaUsage(await streamUsage('04'))?.cache_read_input_tokens, 896);
});

await acheck('R4 第 7 行经非流式得 cache_creation_input_tokens === 200(修前字段不存在)', async () => {
  const j = await jsonUsage('07');
  assert.equal(j.usage?.cache_creation_input_tokens, 200);
});

await acheck('2.3 message_start.usage 恒 {input_tokens:0, output_tokens:0}(不变)', async () => {
  const events = await streamUsage('01');
  const ms = events.find((e) => e.event === 'message_start');
  assert.ok(ms, 'message_start 事件必须存在');
  assert.deepEqual(ms.data.message.usage, { input_tokens: 0, output_tokens: 0 });
});

await acheck('M14/2.3 上游 chunk 不带 usage 时 message_delta.usage === {output_tokens:0}(既有兜底不变)', async () => {
  const got = deltaUsage(await streamUsage('00'));
  assert.deepEqual(got, { output_tokens: 0 },
    '守卫 if (json.usage) 被去掉后,这里会变成 4 键归一对象或 undefined');
});

await acheck('2.3 usage 挂在 choices:[] 收尾 chunk 上(include_usage 规范形态)同样被归一', async () => {
  const got = deltaUsage(await streamUsage('04', { trail: true }));
  assert.deepEqual(got, expectUsage('04'),
    'stream_options.include_usage 的产物就是这种收尾 chunk,必须认');
});

for (const [fin, want] of [['stop', 'end_turn'], ['length', 'max_tokens'], ['tool_calls', 'tool_use']]) {
  await acheck(`2.3 流式 stop_reason 映射 ${fin} → ${want}(不变)`, async () => {
    const events = await streamUsage('01', { fin });
    const md = events.find((e) => e.event === 'message_delta');
    assert.equal(md?.data?.delta?.stop_reason, want);
  });
  await acheck(`2.3 非流式 stop_reason 映射 ${fin} → ${want}(不变)`, async () => {
    const j = await jsonUsage('01', { fin });
    assert.equal(j.stop_reason, want);
  });
}

await acheck('2.3 非流式请求体不带 stream_options(只有 stream 为真才带)', async () => {
  seen.length = 0;
  await jsonUsage('01');
  const r = seen[0]?.body;
  assert.equal(r?.stream, false, '非流式请求 stream 必须显式为 false');
  assert.ok(!('stream_options' in r), 'stream 为假时不该带 stream_options');
});

// ══════════════════════════════════════════════════════════════════════════
// P0 / INTERFACE 2.4 —— 反向约束:不给 OpenAI 通道补发 user / user_id
// ══════════════════════════════════════════════════════════════════════════
console.log('\n[P0-2.4] 反向约束:不发 user / user_id');

check('M12/2.4 buildOpenAIRequest 产出不含 user 字段', () => {
  assert.equal(typeof buildOpenAIRequest, 'function', 'buildOpenAIRequest 必须仍是导出函数');
  const req = buildOpenAIRequest({ model: 'm', messages: [{ role: 'user', content: 'hi' }], metadata: { user_id: 'BUCKET-ABC' } });
  assert.ok(!('user' in req), `发现 user 字段:${JSON.stringify(req.user)}`);
});

check('M12/2.4 buildOpenAIRequest 产出不含 user_id 字段', () => {
  const req = buildOpenAIRequest({ model: 'm', messages: [{ role: 'user', content: 'hi' }], metadata: { user_id: 'BUCKET-ABC' } });
  assert.ok(!('user_id' in req), `发现 user_id 字段:${JSON.stringify(req.user_id)}`);
});

check('M12/2.4 metadata 的值不得泄漏到任何字段(整串序列化不含 BUCKET-ABC)', () => {
  const req = buildOpenAIRequest({ model: 'm', messages: [{ role: 'user', content: 'hi' }], metadata: { user_id: 'BUCKET-ABC' } });
  assert.equal(JSON.stringify(req).includes('BUCKET-ABC'), false, `泄漏进:${JSON.stringify(req)}`);
});

// 端到端反向断言:L7 只看"上游收到的 body",而 { user: undefined } 会被 JSON.stringify 抹掉、
// L7 抓不到 —— 所以必须真发一条带 metadata.user_id 的请求,盯上游收到的**原始字节**。
await acheck('M12/2.4 端到端:带 metadata.user_id 的请求,上游收到的原始 body 不含 user/user_id/该值', async () => {
  seen.length = 0;
  const r = await postMessages({
    model: 'deepseek-chat', stream: false, max_tokens: 64,
    messages: [{ role: 'user', content: marker('01') }],
    metadata: { user_id: 'BUCKET-XYZ' },
  });
  await r.json();
  const body = seen[0]?.body;
  assert.ok(body, '假上游应收到请求');
  const raw = JSON.stringify(body);
  assert.equal(raw.includes('BUCKET-XYZ'), false, `user_id 值泄漏到上游:${raw.slice(0, 200)}`);
  assert.equal(raw.includes('user_id'), false, 'user_id 字段名出现在发给上游的请求里');
  assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'stream'],
    `非流式请求键集合应只有 4 个,实得 ${Object.keys(body).sort().join(',')}`);
});

// ══════════════════════════════════════════════════════════════════════════
// P1 / INTERFACE 第 1 节 —— 纯函数 normalizeOpenAIUsage 契约
// ══════════════════════════════════════════════════════════════════════════
console.log('\n[P1] 纯函数契约 server/utils/openai-usage.js');

const HAVE_U = typeof normalizeOpenAIUsage === 'function';
check('P1-0 openai-usage.js 可被 node 直接 import 且导出 normalizeOpenAIUsage', () => {
  assert.ok(U, `import 失败:${U_ERR}`);
  assert.equal(typeof normalizeOpenAIUsage, 'function',
    `模块已加载但未导出 normalizeOpenAIUsage;现有导出:${Object.keys(U || {}).join(', ') || '(空)'}`);
});
if (!HAVE_U) {
  console.log(`\n  !! server/utils/openai-usage.js 不可用 —— ${U_ERR || '模块加载了但没有 normalizeOpenAIUsage 导出'}`);
  console.log('     P1 的子条目按"跳过"计(P0 的红已在上方打完),整体退出码仍为 1。\n');
}
const p1 = (name, fn) => (HAVE_U ? check(name, fn) : skip(name, 'normalizeOpenAIUsage 不可用,见 P1-0'));

const KEYS = ['cache_creation_input_tokens', 'cache_read_input_tokens', 'input_tokens', 'output_tokens'];
const WEIRD = [null, undefined, 'x', 0, [], {}, NaN, Infinity, -1, true, () => {}, Symbol.iterator,
  { prompt_tokens: Infinity }, { prompt_tokens: -5 }, { prompt_tokens: NaN },
  { prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: {} } },
  { prompt_tokens: 1000, prompt_tokens_details: [] },
  { prompt_tokens: 1000, cached_tokens: null }];

// ── 1.1 签名与不变式 ──────────────────────────────────────────────────
p1('1.1 返回对象恒含且仅含 4 个键(对 1.3 表 + 全部畸形输入)', () => {
  const bag = [...Object.values(FIXTURES), ...WEIRD];
  for (const u of bag) {
    const got = normalizeOpenAIUsage(u);
    assert.deepEqual(Object.keys(got).sort(), KEYS, `入参 ${String(JSON.stringify(u) ?? u)} 的键集合不符`);
  }
});

p1('1.1 4 个值恒为有限非负数(无 undefined/null/NaN/负数/字符串)', () => {
  const bag = [...Object.values(FIXTURES), ...WEIRD];
  for (const u of bag) {
    const got = normalizeOpenAIUsage(u);
    for (const k of KEYS) {
      assert.equal(typeof got[k], 'number', `入参 ${String(JSON.stringify(u) ?? u)} 的 ${k} 不是 number(实得 ${String(got[k])})`);
      assert.ok(Number.isFinite(got[k]), `${k} 非有限数:${String(got[k])}`);
      assert.ok(got[k] >= 0, `${k} 为负:${got[k]}`);
    }
  }
});

p1('1.1 纯函数:不改入参(调用前后 JSON 序列化一致)', () => {
  for (const u of Object.values(FIXTURES)) {
    const before = JSON.stringify(u);
    normalizeOpenAIUsage(u);
    assert.equal(JSON.stringify(u), before, '入参被就地改写了');
  }
});

p1('1.1 纯函数:同一入参多次调用 deepEqual', () => {
  for (const u of [...Object.values(FIXTURES), ...WEIRD]) {
    assert.deepEqual(normalizeOpenAIUsage(u), normalizeOpenAIUsage(u), `入参 ${String(JSON.stringify(u) ?? u)} 两次调用结果不一致`);
  }
});

// ── 1.3 换算契约表 9 行 ───────────────────────────────────────────────
for (const id of Object.keys(FIXTURES)) {
  p1(`1.3 第 ${Number(id)} 行(${NOTE[id]})→ [${EXPECT[id].join(', ')}]`, () => {
    const got = normalizeOpenAIUsage(FIXTURES[id]);
    assert.deepEqual(
      [got.input_tokens, got.cache_read_input_tokens, got.cache_creation_input_tokens],
      EXPECT[id],
      `上游 ${JSON.stringify(FIXTURES[id])} → 实得 ${JSON.stringify(got)}`);
    assert.equal(got.output_tokens, 20, 'completion_tokens:20 → output_tokens:20');
  });
}

p1('1.3 恒等式:每一行(含第 9 行)input + read + creation === prompt_tokens', () => {
  for (const id of Object.keys(FIXTURES)) {
    const g = normalizeOpenAIUsage(FIXTURES[id]);
    assert.equal(g.input_tokens + g.cache_read_input_tokens + g.cache_creation_input_tokens,
      FIXTURES[id].prompt_tokens, `第 ${Number(id)} 行不满足恒等式:${JSON.stringify(g)}`);
  }
});

// ── 1.2 候选优先级 ────────────────────────────────────────────────────
p1('1.2 候选优先级:details.cached_tokens 先于顶层 prompt_cache_hit_tokens', () => {
  const g = normalizeOpenAIUsage({ prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 100 }, prompt_cache_hit_tokens: 896 });
  assert.equal(g.cache_read_input_tokens, 100, '按 1.2 顺序先到先得');
});

p1('1.2 候选优先级:prompt_cache_hit_tokens 先于顶层 cached_tokens', () => {
  const g = normalizeOpenAIUsage({ prompt_tokens: 1000, prompt_cache_hit_tokens: 300, cached_tokens: 700 });
  assert.equal(g.cache_read_input_tokens, 300);
});

p1('1.2 候选优先级:顶层 cached_tokens 先于顶层 cache_read_input_tokens', () => {
  const g = normalizeOpenAIUsage({ prompt_tokens: 1000, cached_tokens: 300, cache_read_input_tokens: 700 });
  assert.equal(g.cache_read_input_tokens, 300);
});

p1('1.2 creation 候选:顶层 cache_creation_input_tokens 先于嵌套', () => {
  const g = normalizeOpenAIUsage({ prompt_tokens: 1000, cache_creation_input_tokens: 30,
    prompt_tokens_details: { cache_creation_input_tokens: 70 } });
  assert.equal(g.cache_creation_input_tokens, 30);
});

p1('M8 creation 永不由其它字段推算:只给 prompt_tokens + read 时 creation === 0', () => {
  const g = normalizeOpenAIUsage({ prompt_tokens: 1000, prompt_cache_hit_tokens: 600 });
  assert.equal(g.cache_creation_input_tokens, 0, 'creation 用 prompt-read 推算就红在这里');
});

// ── 1.4 边界与不变式 ──────────────────────────────────────────────────
p1('1.4 null / undefined / \'x\' / 0 / [] / {} → 4 个键全 0', () => {
  for (const v of [null, undefined, 'x', 0, [], {}]) {
    assert.deepEqual(normalizeOpenAIUsage(v),
      { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      `入参 ${String(JSON.stringify(v) ?? v)}`);
  }
});

p1('1.4 prompt_tokens_details 为 null / \'x\' → 不抛错,按无 details 处理', () => {
  const zero = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  assert.deepEqual(normalizeOpenAIUsage({ prompt_tokens_details: null }), zero);
  assert.deepEqual(normalizeOpenAIUsage({ prompt_tokens_details: 'x' }), zero);
  // 派生:带 prompt_tokens 时等价于第 9 行
  assert.deepEqual(normalizeOpenAIUsage({ prompt_tokens: 1000, prompt_tokens_details: null }),
    normalizeOpenAIUsage({ prompt_tokens: 1000 }), '按无 details 处理 = 与第 9 行同结果');
});

p1('M10/1.4 无 prompt_tokens 时用 input_tokens 且不再减 read', () => {
  const g = normalizeOpenAIUsage({ input_tokens: 300, cache_read_input_tokens: 700, output_tokens: 9 });
  assert.equal(g.input_tokens, 300, 'prompt_tokens 缺席时仍减 read 就红在这里');
  assert.equal(g.cache_read_input_tokens, 700);
  assert.equal(g.output_tokens, 9);
});

p1('1.4 上游自相矛盾(read > prompt)→ input 钳位为 0,不得为负', () => {
  const g = normalizeOpenAIUsage({ prompt_tokens: 100, prompt_cache_hit_tokens: 900 });
  assert.equal(g.input_tokens, 0);
});

p1('1.4 字符串数字 {prompt_tokens:\'1000\', cached_tokens:\'896\'} → 4 个键全 0(只认有限数字类型)', () => {
  assert.deepEqual(normalizeOpenAIUsage({ prompt_tokens: '1000', cached_tokens: '896' }),
    { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
});

p1('1.4 负数不算候选:cached_tokens:-5 + prompt_cache_hit_tokens:896 → read 896', () => {
  assert.equal(normalizeOpenAIUsage({ prompt_tokens: 1000, cached_tokens: -5, prompt_cache_hit_tokens: 896 }).cache_read_input_tokens, 896);
});

p1('1.4 NaN 不算候选:cached_tokens:NaN + prompt_cache_hit_tokens:896 → read 896', () => {
  assert.equal(normalizeOpenAIUsage({ prompt_tokens: 1000, cached_tokens: NaN, prompt_cache_hit_tokens: 896 }).cache_read_input_tokens, 896);
});

p1('1.4 {completion_tokens:0, output_tokens:7} → output 7', () => {
  assert.equal(normalizeOpenAIUsage({ completion_tokens: 0, output_tokens: 7 }).output_tokens, 7);
});

p1('1.4 {completion_tokens:5, output_tokens:99} → output 5(completion 优先)', () => {
  assert.equal(normalizeOpenAIUsage({ completion_tokens: 5, output_tokens: 99 }).output_tokens, 5);
});

// ── 2.3 的"与 normalizeOpenAIUsage(上游 usage) deepEqual"这一句:两层必须同源 ──
console.log('\n[P1×P0] 代理输出 与 normalizeOpenAIUsage 同源');
for (const id of ['01', '04', '07']) {
  if (!HAVE_U) { skip(`2.3 代理输出 === normalizeOpenAIUsage(上游 usage)(第 ${Number(id)} 行)`, '模块不可用'); continue; }
  await acheck(`2.3 代理输出 === normalizeOpenAIUsage(上游 usage)(第 ${Number(id)} 行,流式+非流式)`, async () => {
    const want = normalizeOpenAIUsage(FIXTURES[id]);
    assert.deepEqual(deltaUsage(await streamUsage(id)), want, '流式');
    assert.deepEqual((await jsonUsage(id)).usage, want, '非流式');
  });
}

// ══════════════════════════════════════════════════════════════════════════
// P2 / INTERFACE 第 3 节 —— 源码锁
// ══════════════════════════════════════════════════════════════════════════
console.log('\n[P2-3.1] 源码锁 server/services/openai-proxy.js');
let OP = '';
try { OP = read('server/services/openai-proxy.js'); } catch { OP = ''; }
check('3.1-0 openai-proxy.js 可读', () => assert.ok(OP.length > 0, '文件读不到或为空'));

const mustOP = [
  [/import \{ normalizeOpenAIUsage \} from '\.\.\/utils\/openai-usage\.js'/, '必须 import 共用归一函数'],
  [/=== 'system' \? 'system' : 'user'/, "role 白名单判据(只放行 system)"],
  [/if \(json\.usage\)/, '流式 usage 仍带守卫'],
  [/usage: \{ input_tokens: 0, output_tokens: 0 \}/, 'message_start 恒 0 不变'],
  [/usage: usage \|\| \{ output_tokens: 0 \}/, 'message_delta 兜底不变'],
  [/for \(const tr of toolResults\) out\.push\(tr\);/, 'tool_result 先行不变'],
];
for (const [re, why] of mustOP) {
  check(`3.1 必须出现 ${re}  —— ${why}`, () => assert.match(OP, re));
}
check('3.1 normalizeOpenAIUsage( 至少 2 次(流式 + 非流式两个调用点都换了)', () => {
  const n = count(OP, /normalizeOpenAIUsage\(/g);
  assert.ok(n >= 2, `实得 ${n} 处 —— M11「只换流式、非流式留旧代码」就红在这里`);
});
check('3.1 P2 注释存在(/故意不发/ 或 /不发 user/ 任一)', () => {
  assert.ok(/故意不发/.test(OP) || /不发 user/.test(OP), '缺"不发 user"的意图注释,后人会当成漏项补上');
});

const banOP = [
  [/prompt_tokens_details/g, '候选表必须整体搬进 util,留在这里说明只搬了一半'],
  [/prompt_cache_hit_tokens/g, '同上'],
  [/cached_tokens/g, '同上'],
  [/out\.push\(\{ role: 'user', content: \[/g, '硬写 user 的多模态那处必须消失'],
  [/out\.push\(\{ role: 'user', content: txt \}\)/g, '硬写 user 的文本那处必须消失'],
  [/body\.metadata/g, 'P2 反向约束:不读 metadata'],
  [/req\.user\s*=/g, 'P2 反向约束:不写 user'],
  [/user-id-normalize/g, 'P2 反向约束:不引 user_id 归一'],
  [/normalizeUserIdInBody/g, 'P2 反向约束:不引 user_id 归一'],
];
for (const [re, why] of banOP) {
  check(`3.1 不许出现 ${re.source}(0 次)—— ${why}`, () => {
    const n = count(OP, re);
    assert.strictEqual(n, 0, `实得 ${n} 次`);
  });
}

console.log('\n[P2-3.2] 源码锁 server/utils/openai-usage.js');
let UF = '';
let UF_ERR = '';
try { UF = read('server/utils/openai-usage.js'); } catch (e) { UF = ''; UF_ERR = String((e && e.message) || e); }
check('3.2-0 openai-usage.js 存在且可读', () => assert.ok(UF.length > 0, UF_ERR || '文件读不到或为空'));

if (!UF) {
  for (const n of ['3.2 必须出现 export function normalizeOpenAIUsage',
    '3.2 五个候选路径字面各至少 1 次',
    '3.2 零依赖:不出现 import / require( / process. / fetch(']) skip(n, '文件不存在,见 3.2-0');
} else {
  check('3.2 必须出现 export function normalizeOpenAIUsage', () => {
    assert.match(UF, /export function normalizeOpenAIUsage/);
  });
  check('3.2 五个候选路径字面各至少 1 次', () => {
    for (const lit of ['cached_tokens', 'prompt_cache_hit_tokens', 'cache_read_input_tokens',
      'prompt_tokens_details', 'cache_creation_input_tokens']) {
      assert.ok(UF.includes(lit), `缺候选字面 ${lit}`);
    }
  });
  check('3.2 零依赖:不出现 import / require( / process. / fetch(', () => {
    for (const re of [/^import /m, /require\(/, /process\./, /fetch\(/]) {
      assert.ok(!re.test(UF), `发现 ${re.source} —— 纯函数模块必须零依赖`);
    }
  });
}

// INTERFACE 3.3 写的是"这些文件本轮零 diff"。**这里不做 git diff 分支范围锁** ——
// 那锁的是"本轮的开发边界",不是产品不变量:一旦进了共享单测,此后任何动这些文件的
// 分支都会被它判红,与该分支自身对错无关(r92 就栽过,本轮刚把那颗地雷拆掉)。
// 改成锁 INTERFACE 真正在意的结构:usage 归一只许落在 openai 通道,不许扩散。
console.log('\n[P2-3.3] 改动不得越界(内容锁,不锁"文件零改动")');
// 注:INTERFACE 3.3 写的 `server/services/chat.js` **不存在**(真身是 server/routes/chat.js);
// 旧的 git diff 锁对不存在的路径恒返回空字符串 → 那一项一直是假绿。这里换成真实路径。
// routes/chat.js 本轮确实要改(#8),所以锁的不是"没改",而是"没把 usage 归一扩散过来"。
for (const f of ['server/services/anthropic-proxy.js', 'server/routes/chat.js']) {
  check(`3.3 ${f.split('/').pop()} 不碰 openai usage 归一(该通道是字节透传/与 usage 换算无关)`, () => {
    const src = read(f);
    assert.ok(!/openai-usage/.test(src), '不该 import openai-usage.js');
    assert.ok(!/normalizeOpenAIUsage/.test(src), '不该调用 normalizeOpenAIUsage');
    assert.ok(!/prompt_cache_hit_tokens|prompt_tokens_details/.test(src), '候选表字面不该出现在这里');
  });
}
check('3.3 cacheStats.js 的 readCacheUsage 仍在(前端徽章口径本轮不动,check-r89 A4 依赖)', () => {
  assert.match(read('client/src/utils/cacheStats.js'), /export function readCacheUsage/);
});
// 其余三项(user-id-normalize.js / App.jsx / tests/acceptance)不设锁:
//  - user-id-normalize:已由 3.1 的"openai-proxy 不许出现 user-id-normalize"从消费侧钉死;
//  - App.jsx / tests/acceptance:本轮契约里没有可锁的具体字面或结构,只能靠 code review。

// ══════════════════════════════════════════════════════════════════════════
// #8 / INTERFACE 第 6 节 —— GUI 自写权限规则不触发 chatCompatKey 冷启
//
// 隔离:mkdtemp 临时 HOME(同时设 HOME 与 USERPROFILE),再 await import chat.js
//      —— 真实 ~/.claude 一个字节不碰。workingDir 也指到临时目录里(比 INTERFACE 写的
//      /tmp/proj 更干净:C2 要往 workingDir/.claude 里写文件)。
// mtime:每次写 settings.json 后 utimesSync 显式推到一个新的、递增的值(同毫秒连写
//      会被既有 mtime 快路吃掉)。
// ══════════════════════════════════════════════════════════════════════════
console.log('\n[#8] chatCompatKey 权限自写豁免(K0–K7 / C1–C4)');

const REAL_HOME = process.env.HOME;
const REAL_PROFILE = process.env.USERPROFILE;
const home = mkdtempSync(join(tmpdir(), 'cgui-r96-perm-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
mkdirSync(join(home, '.claude'), { recursive: true });
mkdirSync(join(home, '.claude-gui'), { recursive: true });
const projDir = join(home, 'proj');
mkdirSync(join(projDir, '.claude'), { recursive: true });

let CH_MOD = null; let CH_ERR = '';
try { CH_MOD = await import('../../server/routes/chat.js'); }
catch (e) { CH_ERR = String((e && e.message) || e); }
const chatCompatKey = CH_MOD?.chatCompatKey;
const noteSelfPermissionWrite = CH_MOD?.noteSelfPermissionWrite;
const note = () => { if (typeof noteSelfPermissionWrite === 'function') noteSelfPermissionWrite(); };

check('#8-0 chat.js 可 import 且导出 chatCompatKey', () => {
  assert.ok(CH_MOD, `import 失败:${CH_ERR}`);
  assert.equal(typeof chatCompatKey, 'function', 'chatCompatKey 必须仍是导出函数(调用方参数列表不得变)');
});

// 只做 typeof 判断(照 INTERFACE R5 的字面)。**不许在这里试调它** —— 标记是模块级
// 状态,提前置位会被下面时间线的第一次观测吞掉,K2 会假红(本文件踩过一次)。
check('R5 chat.js 新增导出 noteSelfPermissionWrite', () => {
  assert.equal(typeof noteSelfPermissionWrite, 'function',
    `该导出不存在;现有导出:${Object.keys(CH_MOD || {}).slice(0, 20).join(', ') || '(无)'}`);
});

const HAVE_CK = typeof chatCompatKey === 'function';
const c8 = (name, fn) => (HAVE_CK ? check(name, fn) : skip(name, 'chatCompatKey 不可用,见 #8-0'));

const settingsPath = join(home, '.claude', 'settings.json');
const base = {
  workingDir: projDir, effort: 'high', appendSystemPrompt: '', promptSuggestions: false,
  excludeDynamicSystemPrompt: 'auto', globalRead: true, dirs: ['/'], maxBudgetUsd: null,
};
let tick = Math.floor(Date.now() / 1000) - 100000;
const bump = (p) => { tick += 7; utimesSync(p, tick, tick); };
const writeSettings = (obj) => {
  writeFileSync(settingsPath, typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8');
  bump(settingsPath);
};
const K = () => chatCompatKey(base);

// 时间线一次跑完(模块级状态跨调用累积,不可乱序);每步的结果单独断言,便于定位。
const S = {}; let TL_ERR = '';
if (HAVE_CK) {
  try {
    const allow = ['Bash(ls)'];
    // 预热:让实现把"上一次看到的 permissions"基线建起来。进程启动后的第一次观测
    // 无从比较,不能当作时间线的 K0。
    writeSettings({ env: { ANTHROPIC_BASE_URL: 'https://a/v1' }, permissions: { allow: ['Bash(warmup)'] } });
    K();
    writeSettings({ env: { ANTHROPIC_BASE_URL: 'https://a/v1' }, permissions: { allow: [...allow] } });
    S.k0 = K();
    S.k1 = K();
    allow.push('Bash(pwd)');
    writeSettings({ env: { ANTHROPIC_BASE_URL: 'https://a/v1' }, permissions: { allow: [...allow] } });
    S.k2 = K();
    note();
    allow.push('Bash(cat)');
    writeSettings({ env: { ANTHROPIC_BASE_URL: 'https://a/v1' }, permissions: { allow: [...allow] } });
    S.k3 = K();
    allow.push('Bash(echo)');
    writeSettings({ env: { ANTHROPIC_BASE_URL: 'https://a/v1' }, permissions: { allow: [...allow] } });
    S.k4 = K();
    note();
    allow.push('Bash(id)');
    const k5obj = { env: { ANTHROPIC_BASE_URL: 'https://b/v1' }, permissions: { allow: [...allow] } };
    writeSettings(k5obj);
    S.k5 = K();
    writeSettings(k5obj);          // 字节完全相同,只有 mtime 变
    S.k6 = K();
    rmSync(settingsPath, { force: true });
    S.k7 = K();
  } catch (e) { TL_ERR = String((e && e.message) || e); }
}

c8('#8 K0–K7 时间线跑完不抛错', () => {
  assert.equal(TL_ERR, '', `时间线中途抛错:${TL_ERR}`);
});
c8('K1 不动文件重复调用 → 键恒等(纯函数性)', () => {
  assert.equal(S.k1, S.k0, '同一状态两次调用必须同键');
});
c8('K2 外部改 permissions(未打自写标记)→ 换键(冷启)', () => {
  assert.notEqual(S.k2, S.k0, '外部权限改动必须换键');
});
c8('R6/K3 ★核心:noteSelfPermissionWrite() 后只改 permissions → K3 === K2(不冷启)', () => {
  assert.equal(S.k3, S.k2, 'GUI 自写权限规则不得换键,否则每点一次"始终允许"就冷启重建进程');
});
c8('K4 标记已被消费:紧接着的外部权限改动仍换键(一次标记只吞一次)', () => {
  assert.notEqual(S.k4, S.k3, '标记不清零 = 此后所有外部权限改动都被误吞');
});
c8('K5 打了标记但同时改了 env → 仍必须换键(provider 切换护栏)', () => {
  assert.notEqual(S.k5, S.k4, '非权限字段变化无论标记如何都必须冷启');
});
c8('R7/K6 原样重写(仅 mtime 变、字节不变)→ 键不变(内容指纹口径)', () => {
  assert.equal(S.k6, S.k5, '键里还挂着原始 mtime 就红在这里');
});
c8('K7 删掉 settings.json → 不抛错且换键', () => {
  assert.notEqual(S.k7, S.k6, '文件消失必须换键');
});

// ── C1–C4 补充契约 ────────────────────────────────────────────────────
c8('C1 其余字段照旧进键:effort / workingDir / maxBudgetUsd / genui 各自换键', () => {
  writeSettings({ env: { ANTHROPIC_BASE_URL: 'https://c/v1' }, permissions: { allow: ['Bash(ls)'] } });
  const k = K();
  assert.notEqual(chatCompatKey({ ...base, effort: 'low' }), k, 'effort');
  assert.notEqual(chatCompatKey({ ...base, workingDir: join(home, 'other') }), k, 'workingDir');
  assert.notEqual(chatCompatKey({ ...base, maxBudgetUsd: 5 }), k, 'maxBudgetUsd');
  assert.notEqual(chatCompatKey({ ...base, genui: false }), k, 'genui');
});

c8('C2 项目级 settings 仍进键(workingDir/.claude/settings.json)', () => {
  const before = K();
  const projSettings = join(projDir, '.claude', 'settings.json');
  writeFileSync(projSettings, JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }), 'utf8');
  bump(projSettings);
  assert.notEqual(K(), before, '项目级 settings 变化必须换键(r89 焊死项)');
});

c8('C3 坏 JSON 的 settings.json → 不抛错且换键(保守冷启)', () => {
  const before = K();
  let after; let err = '';
  try { writeSettings('{oops'); after = K(); } catch (e) { err = String((e && e.message) || e); }
  assert.equal(err, '', `读到坏 JSON 不该抛错:${err}`);
  assert.notEqual(after, before, '解析不了就应保守换键,不能沉默复用');
});

c8('C4 noteSelfPermissionWrite() 连调 3 次不累积成计数(只吞一次权限改动)', () => {
  writeSettings({ env: { ANTHROPIC_BASE_URL: 'https://d/v1' }, permissions: { allow: ['Bash(ls)'] } });
  const k0 = K();
  note(); note(); note();
  writeSettings({ env: { ANTHROPIC_BASE_URL: 'https://d/v1' }, permissions: { allow: ['Bash(ls)', 'Bash(pwd)'] } });
  assert.equal(K(), k0, '第一次权限改动应被吞');
  writeSettings({ env: { ANTHROPIC_BASE_URL: 'https://d/v1' }, permissions: { allow: ['Bash(ls)', 'Bash(pwd)', 'Bash(cat)'] } });
  assert.notEqual(K(), k0, '标记若累积成计数,第二、三次外部改动也会被误吞');
});

c8('M20 标记是模块级不是 per-session:不同 workingDir 的调用共享同一次自写吞并', () => {
  const dirB = join(home, 'projB');
  mkdirSync(join(dirB, '.claude'), { recursive: true });
  writeSettings({ env: { ANTHROPIC_BASE_URL: 'https://e/v1' }, permissions: { allow: ['Bash(ls)'] } });
  const kA = chatCompatKey(base);
  const kB = chatCompatKey({ ...base, workingDir: dirB });
  note();
  writeSettings({ env: { ANTHROPIC_BASE_URL: 'https://e/v1' }, permissions: { allow: ['Bash(ls)', 'Bash(pwd)'] } });
  assert.equal(chatCompatKey(base), kA, 'workingDir A 侧应被吞');
  assert.equal(chatCompatKey({ ...base, workingDir: dirB }), kB,
    'workingDir B 侧也应被吞 —— 标记做成 per-session/per-slot 就红在这里');
});

// ── 6.3 源码锁 ────────────────────────────────────────────────────────
console.log('\n[#8-6.3] 源码锁 server/routes/chat.js');
let CH = '';
try { CH = read('server/routes/chat.js'); } catch { CH = ''; }
const KEYFN = CH ? CH.slice(CH.indexOf('export function chatCompatKey'), CH.indexOf('export function closePersistentForSession')) : '';
const KEYSER = KEYFN ? KEYFN.slice(KEYFN.indexOf('return JSON.stringify')) : '';

check('6.3-0 chat.js 可读且能切出 chatCompatKey 函数体与序列化体', () => {
  assert.ok(CH.length > 0, '文件读不到');
  assert.ok(KEYFN.length > 0, '切不出 chatCompatKey 函数体(签名被改了?)');
  assert.ok(KEYSER.length > 0, '函数体里找不到 return JSON.stringify');
});

check('6.3 必须出现 export function noteSelfPermissionWrite', () => {
  assert.match(CH, /export function noteSelfPermissionWrite/);
});
check('6.3 序列化体同时含 settingsFp 与 permEpoch', () => {
  assert.ok(/settingsFp/.test(KEYSER), '缺 settingsFp(用户级 settings 的内容指纹)');
  assert.ok(/permEpoch/.test(KEYSER), '缺 permEpoch(外部权限改动代数)');
});
check('6.3 序列化体仍含 projSettingsMtime / disToolsMtime / mcpStampMtime(r89 焊死项)', () => {
  for (const f of ['projSettingsMtime', 'disToolsMtime', 'mcpStampMtime']) {
    assert.ok(new RegExp(f).test(KEYSER), `${f} 被连带摘掉了(r89 已裁定保留)`);
  }
});
check('6.3 序列化体仍不含 model(check-compat-key-model 的既有锁)', () => {
  assert.ok(!/\bmodel\b/.test(KEYSER), 'key 里不得再出现 model');
});
check('6.3 序列化体不得再含 settingsMtime(用户级 mtime 必须已换成内容指纹)', () => {
  assert.ok(!/\bsettingsMtime\b/.test(KEYSER), 'settingsMtime 还在 = 原样重写也会换键(K6 红)');
});
check('6.3 存在"把 permissions 从指纹里排除"的写法(delete <x>.permissions)', () => {
  assert.match(CH, /delete\s+\w+\.permissions/, '指纹不排除 permissions,自写豁免无从谈起');
});
check('6.3 makeCanUseTool 内 destination === \'userSettings\' 后 80 字符内调 noteSelfPermissionWrite()', () => {
  assert.match(CH, /destination === 'userSettings'[\s\S]{0,80}noteSelfPermissionWrite\(\)/,
    '标记必须挂在"确实写了 userSettings"这一支上,无条件置位会把 session 级改动也吞掉');
});
check('6.3 天花板注释在位(ponytail: 同段含 始终允许 与 deny)', () => {
  const seg = CH.split('\n').map((l, i, a) => a.slice(i, i + 12).join('\n')).find((blk) => /ponytail:/.test(blk));
  assert.ok(seg, '找不到 ponytail: 注释');
  assert.ok(/始终允许/.test(seg) && /deny/.test(seg), 'ponytail 注释未写清天花板(始终允许 / deny)');
});
check('6.3 chatCompatKey 函数体内不得出现 Date.now()(不许用时间窗)', () => {
  assert.ok(!/Date\.now\(\)/.test(KEYFN), '时间窗一过收益归零,且会让键不稳定');
});
check('6.3 chatCompatKey 函数体内不得出现 pendingSelfPermWrite = true(只允许 note 置位)', () => {
  assert.ok(!/pendingSelfPermWrite\s*=\s*true/.test(KEYFN), '只有 noteSelfPermissionWrite 可以置位');
});
// 同上:不做 git 分支范围锁。permission-rules.js 对 #8 唯一承重的事实是"「始终允许」
// 落 userSettings" —— 它若改成写别的 destination,上面那条 makeCanUseTool 源码锁虽然
// 还绿,标记却永远不会被触发。锁这条事实,不锁"文件没改"。
check('6.3 permission-rules.js 仍把「始终允许」写向 userSettings(#8 标记的触发前提)', () => {
  assert.match(read('server/utils/permission-rules.js'), /destination: 'userSettings'/,
    'buildAlwaysAllowUpdates 不再写 userSettings 的话,noteSelfPermissionWrite 永不触发(check-r89 A3-2 同源)');
});

// 收尾:还原 HOME,清临时目录
process.env.HOME = REAL_HOME;
if (REAL_PROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = REAL_PROFILE;
try { rmSync(home, { recursive: true, force: true }); } catch {}

// ══════════════════════════════════════════════════════════════════════════
upstream.close();
console.log(`\n—— check-r96-cache-openai: ${PASS} 绿 / ${FAILS} 红 / ${SKIPPED} 跳过(共 ${PASS + FAILS + SKIPPED} 条)——`);
if (FAILS) {
  console.log('红的条目:');
  for (const n of failed) console.log(`  ✗ ${n}`);
}
if (SKIPPED) {
  console.log('跳过的条目(前置缺失,不算通过):');
  for (const n of skippedNames) console.log(`  ~ ${n}`);
}
if (FAILS || SKIPPED) process.exit(1);
console.log('✓ check-r96-cache-openai: role 一致性 + 三轮前缀 LCP + usage 九形态两条路 + 不发 user + 源码锁 全绿');
process.exit(0);
