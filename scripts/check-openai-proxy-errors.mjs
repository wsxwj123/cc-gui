// Self-check: fake OpenAI upstream × real openai-proxy, error forms + normal stream.
// Guards the "swallow upstream error" fix: 200+stream-error / 200+JSON-error must
// surface as non-200 anthropic error bodies; normal SSE must still convert (lazy
// message_start intact). Run: `node scripts/check-openai-proxy-errors.mjs`.
import http from 'node:http';
import { setOpenAIUpstream, startOpenAIProxy, getProxyPort } from '../server/services/openai-proxy.js';

let mode = 'normal';
const upstream = http.createServer((req, res) => {
  let reqBody = '';
  req.on('data', (c) => { reqBody += c; });
  req.on('end', () => handleUpstream(reqBody, res));
});
function handleUpstream(reqBody, res) {
  if (mode === 'prestream') {
    res.writeHead(402, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Insufficient Balance', type: 'insufficient_quota', code: 'insufficient_quota' } }));
  } else if (mode === 'json200') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Insufficient Balance json200' } }));
  } else if (mode === 'instream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"error":{"message":"Insufficient Balance mid-stream"}}\n\n');
    res.end();
  } else if (mode === 'instream_after_text') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"partial "}}]}\n\n');
    res.write('data: {"error":{"message":"boom after text"}}\n\n');
    res.end();
  } else if (mode === 'sse_wrong_ct') {
    // 判官项3:劣质中转 CT 错标 text/plain 但 body 实为 SSE → 必须回退流解析,不能 200 空消息
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":" world"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  } else if (mode === 'retry_effort' && /"reasoning_effort"/.test(reqBody)) {
    // 首发带 reasoning_effort → 400,触发 proxy 删参重试;重试落到下面 normal 分支经 respondOk
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'unsupported parameter: reasoning_effort' } }));
  } else { // normal(retry_effort 重试后也走这里)
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":" world"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

async function post(port, extra = {}) {
  const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'x', stream: true, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }], ...extra }),
  });
  return { status: r.status, text: await r.text() };
}

function assert(c, m) { if (!c) { console.error('FAIL:', m); process.exitCode = 1; } else console.log('ok:', m); }

const upPort = await new Promise((res) => upstream.listen(0, '127.0.0.1', () => res(upstream.address().port)));
setOpenAIUpstream({ baseURL: `http://127.0.0.1:${upPort}/v1`, apiKey: 'sk-test' });
await startOpenAIProxy(0);
const port = getProxyPort();

mode = 'prestream';
let r = await post(port);
assert(r.status === 402, `prestream → 402 (got ${r.status})`);
assert(/Insufficient Balance/.test(r.text) && !/\bupstream 402:/.test(r.text), 'prestream → clean message (C), no double-402 JSON');

mode = 'json200';
r = await post(port);
assert(r.status !== 200, `json200 → non-200 (got ${r.status})`);
assert(/Insufficient Balance json200/.test(r.text), 'json200 → upstream message surfaced (A)');

mode = 'instream';
r = await post(port);
assert(r.status !== 200, `instream (no message_start yet) → non-200 (got ${r.status})`);
assert(/mid-stream/.test(r.text), 'instream → upstream message surfaced (B)');

mode = 'instream_after_text';
r = await post(port);
assert(r.status === 200, `instream_after_text → 200 SSE already open (got ${r.status})`);
assert(/event: error/.test(r.text) && /boom after text/.test(r.text), 'instream_after_text → anthropic error event appended (B)');

mode = 'normal';
r = await post(port);
assert(r.status === 200, `normal → 200 (got ${r.status})`);
assert(/event: message_start/.test(r.text), 'normal → message_start present (lazy start intact)');
assert(/Hello/.test(r.text) && /world/.test(r.text), 'normal → text deltas intact');
assert(/event: message_stop/.test(r.text), 'normal → message_stop present');
assert(/"input_tokens":10/.test(r.text), 'normal → usage converted');

mode = 'sse_wrong_ct';
r = await post(port);
assert(r.status === 200, `sse_wrong_ct → 200 (got ${r.status})`);
assert(/event: message_start/.test(r.text) && /Hello/.test(r.text) && /world/.test(r.text),
  'sse_wrong_ct → CT 错标的 SSE 回退流解析,内容完整(判官项3)');
assert(/event: message_stop/.test(r.text), 'sse_wrong_ct → message_stop present(非空消息)');

mode = 'retry_effort';
r = await post(port, { effort: 'high' });
assert(r.status === 200, `retry_effort → 200 after retry (got ${r.status})`);
assert(/Hello/.test(r.text) && /world/.test(r.text) && /event: message_stop/.test(r.text),
  'retry_effort → 删参重试成功路径经 respondOk 正常转换');

upstream.close();
process.exit(process.exitCode || 0);
