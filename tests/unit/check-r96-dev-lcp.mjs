// r101 自测(取代 r96 P0 的取向):CLI 元消息无论数组/字符串形态,翻译后一律 role:'user'。
// 真机 DeepSeek OpenAI 口实测:中途 role:'system' 的消息内容一变 → 整个前缀(含顶部
// system 与 tools)作废(hit=0 / miss=8516);换成 role:'user' 则 hit 恒 8448,只有它
// 之后的部分 miss。故断言:messages[] 里除 messages[0](顶部 system 字段)外 system 出现 0 次,
// 且元消息逐轮变内容时 canonical LCP 仍 ≥99%。假上游 listen(0)、零外网、用完即关。
// 跑法:node tests/unit/check-r96-dev-lcp.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { anthropicToOpenAIMessages, buildOpenAIRequest, startOpenAIProxy, setOpenAIUpstream } from '../../server/services/openai-proxy.js';

const ENV = '# Environment ' + 'e'.repeat(4000);
// 元消息逐轮变内容(真机实验的 <total_tokens>1000→1100→1200 同构)
const TOT = (n) => `<total_tokens>${n} tokens left</total_tokens>`;
const live = (t) => ({ role: 'system', content: [{ type: 'text', text: t, cache_control: { type: 'ephemeral' } }] });
const hist = (t) => ({ role: 'system', content: t });
const SYS = 'You are a test agent. ' + 's'.repeat(200);
const TOOLS = [{ name: 'Read', description: 'read', input_schema: { type: 'object', properties: { p: { type: 'string' } } } }];

const turn1 = [{ role: 'user', content: '第一问' }, live(ENV), live(TOT(1000))];
const turn2 = [{ role: 'user', content: '第一问' }, hist(ENV), hist(TOT(1000)),
  { role: 'assistant', content: '第一答' }, { role: 'user', content: '第二问' }, live(TOT(1100))];
const turn3 = [{ role: 'user', content: '第一问' }, hist(ENV), hist(TOT(1000)),
  { role: 'assistant', content: '第一答' }, { role: 'user', content: '第二问' }, hist(TOT(1100)),
  { role: 'assistant', content: '第二答' }, { role: 'user', content: '第三问' }, live(TOT(1200))];

const segments = (req) => [
  req.messages[0].role === 'system' ? req.messages[0].content : '',
  JSON.stringify(req.tools || []),
  ...req.messages.slice(1).map((m) => JSON.stringify(m)),
];
const canonical = (req) => segments(req).join(' ');
const lcpLen = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
const lcpPct = (prev, cur) => (lcpLen(prev, cur) / prev.length) * 100;
const firstDiffSeg = (a, b) => {
  const sa = segments(a), sb = segments(b);
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return i;
  return -1;
};

// ── 端到端:CLI(anthropic 体)→ 代理 → 假上游收到的 OpenAI 请求体 ────────────
const SSE = 'data: {"choices":[{"delta":{"content":"ok"},"index":0}]}\n\n'
  + 'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n'
  + 'data: [DONE]\n\n';
const recorded = [];
const upstreamSrv = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => { b += c; });
  req.on('end', () => {
    recorded.push(JSON.parse(b));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(SSE);
  });
});
await new Promise((r) => upstreamSrv.listen(0, '127.0.0.1', r));
const upPort = upstreamSrv.address().port;

const proxyPort = await startOpenAIProxy(0);
setOpenAIUpstream({ baseURL: `http://127.0.0.1:${upPort}/v1`, apiKey: 'k' });

for (const messages of [turn1, turn2, turn3]) {
  const resp = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'm', system: SYS, tools: TOOLS, messages, stream: true, max_tokens: 16000 }),
  });
  await resp.text();
}
assert.equal(recorded.length, 3, '假上游应收到 3 个请求');
const [r1, r2, r3] = recorded;

// L0(r101 核心):messages[] 里只有 messages[0](顶部 system 字段)可以是 system,
// 中途一条都不许 —— 中途 system 一变内容,上游把整个前缀连同 tools 一起作废。
for (const req of recorded) {
  assert.equal(req.messages[0].role, 'system', '顶部 system 字段仍应是 messages[0]');
  const mid = req.messages.slice(1).filter((m) => m.role === 'system');
  assert.equal(mid.length, 0, `L0 messages[] 中途出现 ${mid.length} 条 role:'system'`);
}
// L1/L2:前一轮的段序列必须是后一轮的严格前缀
assert.equal(firstDiffSeg(r1, r2), -1, 'L1 第1→2轮出现前缀断点(ENV 角色翻转?)');
assert.equal(firstDiffSeg(r2, r3), -1, 'L2 第2→3轮出现前缀断点(total_tokens 角色翻转?)');
// L3/L4:canonical LCP ≥99%
const p12 = lcpPct(canonical(r1), canonical(r2));
const p23 = lcpPct(canonical(r2), canonical(r3));
assert.ok(p12 >= 99, `L3 LCP(1→2)=${p12.toFixed(2)}% < 99%`);
assert.ok(p23 >= 99, `L4 LCP(2→3)=${p23.toFixed(2)}% < 99%`);
// L5:角色一致性 —— 同一段文字只能有一个 role
const roles = new Map();
for (const req of recorded) {
  for (const m of req.messages) {
    if (typeof m.content !== 'string') continue;
    if (!roles.has(m.content)) roles.set(m.content, new Set());
    roles.get(m.content).add(m.role);
  }
}
for (const [txt, set] of roles) {
  assert.equal(set.size, 1, `L5 同一段文字出现多种 role: ${[...set]} @ ${txt.slice(0, 40)}`);
}
assert.equal([...roles.get(ENV)][0], 'user', 'ENV 元消息必须稳定为 user');
for (const n of [1000, 1100, 1200]) {
  const set = roles.get(TOT(n));
  if (set) assert.equal([...set][0], 'user', `total_tokens(${n}) 元消息必须稳定为 user`);
}
// L6:系统段与工具段三轮逐字相同
assert.equal(segments(r1)[0], segments(r2)[0]); assert.equal(segments(r2)[0], segments(r3)[0]);
assert.equal(segments(r1)[1], segments(r2)[1]); assert.equal(segments(r2)[1], segments(r3)[1]);
// L7:请求体键集合固定,不含 user / user_id / id / 时间戳
for (const req of recorded) {
  assert.deepEqual(Object.keys(req).sort(),
    ['max_tokens', 'messages', 'model', 'stream', 'stream_options', 'tools']);
}

// ── 纯函数层:两条路径同口径(非 assistant 一律 user) ────────────────────────
const arr = (t) => [{ type: 'text', text: t }];
assert.equal(anthropicToOpenAIMessages([{ role: 'system', content: arr('x') }])[0].role, 'user', '数组形态的中途 system → user');
assert.equal(anthropicToOpenAIMessages([{ role: 'system', content: 'x' }])[0].role, 'user', '字符串形态的中途 system → user(与数组同口径)');
assert.equal(anthropicToOpenAIMessages([{ role: 'developer', content: arr('x') }])[0].role, 'user', '未知 role + 数组 → user');
assert.equal(anthropicToOpenAIMessages([{ role: 'developer', content: 'x' }])[0].role, 'user', '未知 role 字符串 → user');
assert.equal(anthropicToOpenAIMessages([{ role: 'assistant', content: 'x' }])[0].role, 'assistant', 'assistant 字符串不变');
assert.equal(anthropicToOpenAIMessages([{ role: 'assistant', content: arr('x') }])[0].role, 'assistant', 'assistant 数组不变');
assert.equal(anthropicToOpenAIMessages([{ role: 'user', content: arr('x') }])[0].role, 'user');
// 顶部 system 字段仍产出唯一一条 role:'system'
const withSys = anthropicToOpenAIMessages([{ role: 'system', content: 'mid' }, { role: 'user', content: 'q' }], SYS);
assert.equal(withSys[0].role, 'system'); assert.equal(withSys[0].content, SYS);
assert.equal(withSys.filter((m) => m.role === 'system').length, 1, '中途 system 不得再产出第二条 system');
// 多模态那处 push 同口径
const img = anthropicToOpenAIMessages([{ role: 'system', content: [{ type: 'text', text: 'x' },
  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA' } }] }], null, 'gpt-4o');
assert.equal(img[0].role, 'user', '多模态分支同口径 → user');
assert.ok(Array.isArray(img[0].content));
// tool_result 仍拆成 role:'tool' 且排在 text 之前
const tr = anthropicToOpenAIMessages([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r' }, { type: 'text', text: 'after' }] }]);
assert.equal(tr[0].role, 'tool'); assert.equal(tr[1].content, 'after');
// P2:metadata 不得泄漏成 user / user_id
const req = buildOpenAIRequest({ model: 'm', messages: [{ role: 'user', content: 'hi' }], metadata: { user_id: 'BUCKET-ABC' } });
assert.ok(!('user' in req) && !('user_id' in req), 'P2 请求体不得含 user/user_id');
assert.ok(!JSON.stringify(req).includes('BUCKET-ABC'), 'P2 metadata 不得泄漏');

await new Promise((r) => upstreamSrv.close(r));   // 代理的临时口由文件末尾 process.exit(0) 释放
console.log('✅ r101 dev-lcp: 中途 system 归零 + 元消息逐轮变内容仍 LCP ≥99% + 两条路径同口径 全部通过');
process.exit(0);
