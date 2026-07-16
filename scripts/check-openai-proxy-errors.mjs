// Self-check: fake OpenAI upstream × real openai-proxy, error forms + normal stream.
// Guards the "swallow upstream error" fix: 200+stream-error / 200+JSON-error must
// surface as non-200 anthropic error bodies; normal SSE must still convert (lazy
// message_start intact). Run: `node scripts/check-openai-proxy-errors.mjs`.
import http from 'node:http';
import { setOpenAIUpstream, startOpenAIProxy, getProxyPort } from '../server/services/openai-proxy.js';

let mode = 'normal';
const upstream = http.createServer((req, res) => {
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
  } else { // normal
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":" world"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

async function post(port) {
  const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'x', stream: true, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }),
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

upstream.close();
process.exit(process.exitCode || 0);
