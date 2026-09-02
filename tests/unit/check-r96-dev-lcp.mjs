// r96 P0 自测:同一条 CLI 元消息的 role 在「数组形态(本轮活的)」与「字符串形态(变历史)」
// 之间必须一致,否则上游前缀每轮从上一轮末尾断掉。假上游 listen(0)、零外网、用完即关。
// 跑法:node tests/unit/check-r96-dev-lcp.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { anthropicToOpenAIMessages, buildOpenAIRequest, startOpenAIProxy, setOpenAIUpstream } from '../../server/services/openai-proxy.js';

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
assert.equal([...roles.get(ENV)][0], 'system', 'ENV 元消息应稳定为 system');
assert.equal([...roles.get(TOT)][0], 'system', 'total_tokens 元消息应稳定为 system');
// L6:系统段与工具段三轮逐字相同
assert.equal(segments(r1)[0], segments(r2)[0]); assert.equal(segments(r2)[0], segments(r3)[0]);
assert.equal(segments(r1)[1], segments(r2)[1]); assert.equal(segments(r2)[1], segments(r3)[1]);
// L7:请求体键集合固定,不含 user / user_id / id / 时间戳
for (const req of recorded) {
  assert.deepEqual(Object.keys(req).sort(),
    ['max_tokens', 'messages', 'model', 'stream', 'stream_options', 'tools']);
}

// ── 纯函数层:role 白名单的边界(未知 role 不放行、字符串快路零波及) ──────────
const arr = (t) => [{ type: 'text', text: t }];
assert.equal(anthropicToOpenAIMessages([{ role: 'system', content: arr('x') }])[0].role, 'system');
assert.equal(anthropicToOpenAIMessages([{ role: 'developer', content: arr('x') }])[0].role, 'user', '未知 role + 数组仍归 user');
assert.equal(anthropicToOpenAIMessages([{ role: 'developer', content: 'x' }])[0].role, 'developer', '字符串快路原样保留');
assert.equal(anthropicToOpenAIMessages([{ role: 'assistant', content: 'x' }])[0].role, 'assistant', 'assistant 字符串不得被拍成 user');
assert.equal(anthropicToOpenAIMessages([{ role: 'user', content: arr('x') }])[0].role, 'user');
// 多模态那处 push 同样要用白名单
const img = anthropicToOpenAIMessages([{ role: 'system', content: [{ type: 'text', text: 'x' },
  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA' } }] }], null, 'gpt-4o');
assert.equal(img[0].role, 'system', '多模态分支也必须走白名单');
assert.ok(Array.isArray(img[0].content));
// tool_result 仍拆成 role:'tool' 且排在 text 之前
const tr = anthropicToOpenAIMessages([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r' }, { type: 'text', text: 'after' }] }]);
assert.equal(tr[0].role, 'tool'); assert.equal(tr[1].content, 'after');
// P2:metadata 不得泄漏成 user / user_id
const req = buildOpenAIRequest({ model: 'm', messages: [{ role: 'user', content: 'hi' }], metadata: { user_id: 'BUCKET-ABC' } });
assert.ok(!('user' in req) && !('user_id' in req), 'P2 请求体不得含 user/user_id');
assert.ok(!JSON.stringify(req).includes('BUCKET-ABC'), 'P2 metadata 不得泄漏');

await new Promise((r) => upstreamSrv.close(r));   // 代理的临时口由文件末尾 process.exit(0) 释放
console.log('✅ r96-dev-lcp: role 一致性 + 三轮 canonical LCP ≥99% + 白名单边界 全部通过');
process.exit(0);
