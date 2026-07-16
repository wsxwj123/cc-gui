// Self-check: context-overflow error normalization in both proxies.
// Guards the auto-compact fix: upstream 400 with OpenAI/relay context-overflow
// wording must surface as `prompt is too long: <original>` (the only wording the
// CLI recognizes to shrink-and-retry the compact summarization request);
// 401/429/balance errors must pass through UNCHANGED; normal streams untouched.
// Run: `node scripts/check-compact-error-normalize.mjs`.
import http from 'node:http';
import { setOpenAIUpstream, startOpenAIProxy, getProxyPort, normalizeContextOverflow } from '../server/services/openai-proxy.js';
import { setAnthropicUpstream, startAnthropicProxy, getAnthropicProxyPort } from '../server/services/anthropic-proxy.js';

function assert(c, m) { if (!c) { console.error('FAIL:', m); process.exitCode = 1; } else console.log('ok:', m); }

const OAI_WORDING = "This model's maximum context length is 65536 tokens. However, you requested 70000 tokens.";
const RELAY_WORDING = 'Request failed: too many tokens in prompt for this model';

// ── unit: normalizeContextOverflow ────────────────────────────────────────
assert(normalizeContextOverflow(OAI_WORDING).startsWith('prompt is too long: '), 'unit: OpenAI wording normalized');
assert(normalizeContextOverflow('error code context_length_exceeded').startsWith('prompt is too long: '), 'unit: context_length_exceeded normalized');
assert(normalizeContextOverflow('input is too long for requested model').startsWith('prompt is too long: '), 'unit: input...too long normalized');
assert(normalizeContextOverflow('request exceeds the context window') .startsWith('prompt is too long: '), 'unit: exceeds...context normalized');
const anthropicOriginal = 'prompt is too long: 210000 tokens > 200000 maximum';
assert(normalizeContextOverflow(anthropicOriginal) === anthropicOriginal, 'unit: anthropic original untouched (idempotent, no double prefix)');
for (const benign of ['Invalid API key', 'Rate limit exceeded, retry after 60s', 'Insufficient Balance', 'internal server error']) {
  assert(normalizeContextOverflow(benign) === benign, `unit: benign untouched: "${benign}"`);
}

// fable判官补漏的三条窄变体:正断言(命中归一化)+ 反断言(相似限流文案不误伤)。
assert(normalizeContextOverflow('input length and max_tokens exceed context limit: 250000 > 200000').startsWith('prompt is too long: '), 'unit: anthropic "exceed context limit"(无s) normalized');
assert(normalizeContextOverflow('The input token count exceeds the maximum number of tokens allowed (1048576).').startsWith('prompt is too long: '), 'unit: gemini "exceeds the maximum number of tokens allowed" normalized');
assert(normalizeContextOverflow('Your request exceeded model token limit: 262144').startsWith('prompt is too long: '), 'unit: kimi "exceeded model token limit" normalized');
for (const rateLimit of [
  'You exceeded your per-minute rate limit, please slow down',
  'Rate limit reached: tokens per min (TPM): limit 90000, used 91000',
  'exceeded your current quota, please check your plan',
]) {
  assert(normalizeContextOverflow(rateLimit) === rateLimit, `unit: rate-limit wording untouched: "${rateLimit}"`);
}

// ── openai-proxy (8788-style translation path) ────────────────────────────
let oaiMode = 'normal';
const oaiUpstream = http.createServer((req, res) => {
  if (oaiMode === 'ctx400') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: OAI_WORDING, type: 'invalid_request_error', code: 'context_length_exceeded' } }));
  } else if (oaiMode === 'ctx_instream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ error: { message: RELAY_WORDING } })}\n\n`);
    res.end();
  } else if (oaiMode === 'auth401') {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid API key', code: 401 } }));
  } else if (oaiMode === 'rate429') {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Rate limit exceeded', code: 429 } }));
  } else if (oaiMode === 'ctx_instream_429') {
    // 200 + 流内 error 体带 code:429 且文案含超限特征词 —— errMsg 429 门后不得改写
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ error: { message: 'Rate limited: too many tokens per minute, retry later', code: 429 } })}\n\n`);
    res.end();
  } else if (oaiMode === 'rate429_tokens') {
    // 某些中转的 429 限流文案含超限特征词 "too many tokens" —— 状态码收紧后不得改写
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Rate limited: too many tokens per minute, retry later', code: 429 } }));
  } else { // normal stream
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  }
});
const oaiUpPort = await new Promise((r) => oaiUpstream.listen(0, '127.0.0.1', () => r(oaiUpstream.address().port)));
setOpenAIUpstream({ baseURL: `http://127.0.0.1:${oaiUpPort}/v1`, apiKey: 'sk-test' });
await startOpenAIProxy(0);
const oaiPort = getProxyPort();

async function postOai() {
  const r = await fetch(`http://127.0.0.1:${oaiPort}/v1/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'x', stream: true, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }),
  });
  return { status: r.status, text: await r.text() };
}

oaiMode = 'ctx400';
let r = await postOai();
assert(r.status === 400, `oai ctx400 → 400 (got ${r.status})`);
assert(/"message":"prompt is too long: /.test(r.text), 'oai ctx400 → message starts with normalized prefix');
assert(r.text.includes('maximum context length'), 'oai ctx400 → original wording preserved after prefix');

oaiMode = 'ctx_instream';
r = await postOai();
assert(r.status !== 200, `oai ctx_instream (prestream) → non-200 (got ${r.status})`);
assert(/prompt is too long: /.test(r.text) && r.text.includes('too many tokens'), 'oai in-stream error → normalized + original kept');

oaiMode = 'ctx_instream_429';
r = await postOai();
assert(r.status === 429, `oai 200+error{code:429} → 429 (got ${r.status})`);
assert(/too many tokens/.test(r.text) && !/prompt is too long/.test(r.text), 'oai 200+error{code:429} with overflow-like wording → NOT rewritten (errMsg 429-gated)');

oaiMode = 'auth401';
r = await postOai();
assert(r.status === 401 && /Invalid API key/.test(r.text) && !/prompt is too long/.test(r.text), 'oai 401 → untouched');

oaiMode = 'rate429';
r = await postOai();
assert(r.status === 429 && /Rate limit exceeded/.test(r.text) && !/prompt is too long/.test(r.text), 'oai 429 → untouched');

oaiMode = 'rate429_tokens';
r = await postOai();
assert(r.status === 429 && /too many tokens/.test(r.text) && !/prompt is too long/.test(r.text), 'oai 429 with "too many tokens" wording → NOT rewritten (status-gated)');

oaiMode = 'normal';
r = await postOai();
assert(r.status === 200 && /Hello/.test(r.text) && /event: message_stop/.test(r.text), 'oai normal stream → intact');

// ── anthropic-proxy (8789-style byte passthrough) ─────────────────────────
let antMode = 'normal';
const antUpstream = http.createServer((req, res) => {
  if (antMode === 'ctx400_oai') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: OAI_WORDING } }));
  } else if (antMode === 'ctx400_relay') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: RELAY_WORDING } }));
  } else if (antMode === 'ctx400_anthropic') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 210000 tokens > 200000 maximum' } }));
  } else if (antMode === 'auth401') {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
  } else if (antMode === 'rate429') {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Number of requests has exceeded your rate limit' } }));
  } else if (antMode === 'balance400') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Insufficient Balance' } }));
  } else if (antMode === 'nonjson502') {
    res.writeHead(502, { 'Content-Type': 'text/html' });
    res.end('<html>Bad Gateway</html>');
  } else if (antMode === 'rate429_tokens') {
    // 429 限流文案含 "too many tokens" —— 归一化范围收紧到 400/413 后不得改写
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited: too many tokens per minute' } }));
  } else if (antMode === 'huge400') {
    // 坏网关 MB 级 HTML 错误页(含超限特征词)—— 超 256KB 缓冲上限,不解析原样透传
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end('<html>' + 'x'.repeat(300 * 1024) + ' too many tokens </html>');
  } else { // normal anthropic SSE
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":1,"output_tokens":0}}}\n\n');
    res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    res.end();
  }
});
const antUpPort = await new Promise((r2) => antUpstream.listen(0, '127.0.0.1', () => r2(antUpstream.address().port)));
setAnthropicUpstream({ baseURL: `http://127.0.0.1:${antUpPort}`, authToken: 'sk-test' });
await startAnthropicProxy(0);
const antPort = getAnthropicProxyPort();

async function postAnt() {
  const r2 = await fetch(`http://127.0.0.1:${antPort}/v1/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'x', stream: true, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }),
  });
  return { status: r2.status, text: await r2.text() };
}

antMode = 'ctx400_oai';
r = await postAnt();
assert(r.status === 400, `ant ctx400_oai → 400 preserved (got ${r.status})`);
let j = JSON.parse(r.text);
assert(j.error.message.startsWith('prompt is too long: ') && j.error.message.includes('maximum context length'), 'ant ctx400_oai → message normalized, original kept');
assert(j.type === 'error' && j.error.type === 'invalid_request_error', 'ant ctx400_oai → error body shape/fields preserved');

antMode = 'ctx400_relay';
r = await postAnt();
j = JSON.parse(r.text);
assert(r.status === 400 && j.error.message.startsWith('prompt is too long: '), 'ant ctx400_relay → normalized');

antMode = 'ctx400_anthropic';
r = await postAnt();
j = JSON.parse(r.text);
assert(j.error.message === 'prompt is too long: 210000 tokens > 200000 maximum', 'ant anthropic-original wording → byte-identical (no double prefix)');

antMode = 'auth401';
r = await postAnt();
assert(r.status === 401 && r.text === JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), 'ant 401 → byte-identical passthrough');

antMode = 'rate429';
r = await postAnt();
assert(r.status === 429 && /exceeded your rate limit/.test(r.text) && !/prompt is too long/.test(r.text), 'ant 429 → untouched');

antMode = 'balance400';
r = await postAnt();
assert(r.status === 400 && r.text === JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Insufficient Balance' } }), 'ant balance 400 → byte-identical passthrough');

antMode = 'nonjson502';
r = await postAnt();
assert(r.status === 502 && r.text === '<html>Bad Gateway</html>', 'ant non-JSON error body → passthrough as-is');

antMode = 'rate429_tokens';
r = await postAnt();
assert(r.status === 429 && /too many tokens/.test(r.text) && !/prompt is too long/.test(r.text), 'ant 429 with "too many tokens" wording → NOT rewritten (status-gated)');

antMode = 'huge400';
r = await postAnt();
const hugeExpected = '<html>' + 'x'.repeat(300 * 1024) + ' too many tokens </html>';
assert(r.status === 400 && r.text === hugeExpected && !/prompt is too long/.test(r.text.slice(0, 100)), 'ant >256KB 400 body → passthrough byte-identical, not parsed/rewritten');

antMode = 'normal';
r = await postAnt();
assert(r.status === 200 && /event: message_start/.test(r.text) && /event: message_stop/.test(r.text), 'ant normal SSE → passthrough intact');

oaiUpstream.close();
antUpstream.close();
process.exit(process.exitCode || 0);
