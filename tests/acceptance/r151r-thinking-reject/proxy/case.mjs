#!/usr/bin/env node
// 单条用例子进程(r151m/r151q 的做法):HOME 由父进程指向临时目录,进程内只调 openai-proxy 的公开入口
// (startOpenAIProxy / setOpenAIUpstream,经 r151m 夹具),上游是本进程内按剧本逐块吐 reasoning_content / content / tool_calls 的假服务。
// 结果打印成一行 R151R_RESULT <json>;断言在 a-proxy.spec.mjs。用法:node case.mjs <1..6>
import http from 'node:http';
import { homeIsolationProblem, pickPort, startProxy, setOpenAIUpstream, postMessages, parseSSE, sleep } from '../../r151m-model-fallback/lib/harness.mjs';

const id = Number(process.argv[2]);
const problem = homeIsolationProblem();
if (problem) { console.error(problem); process.exit(2); }

const MODEL = 'r151r-model';
const USAGE = { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 };
const FIRST = { role: 'assistant', content: '' };
const think = (s) => ({ reasoning_content: s });
const say = (s) => ({ content: s });
const toolHead = { tool_calls: [{ index: 0, id: 'call_r151r_1', type: 'function', function: { name: 'get_weather', arguments: '' } }] };
const toolArgs = (s) => ({ tool_calls: [{ index: 0, function: { arguments: s } }] });

// 上游剧本:chunks 逐块吐(块间隔几毫秒,让代理按多个网络块收到),最后补 finish_reason + usage 与 [DONE]
const SCRIPTS = {
  1: { chunks: [FIRST, think('\n'), think('\n'), say('你好')], finish: 'stop' },
  2: { chunks: [FIRST, think('\n'), think('想'), think('一下'), say('好')], finish: 'stop' },
  3: { chunks: [FIRST, think('  '), toolHead, toolArgs('{"city":'), toolArgs('"北京"}')], finish: 'tool_calls' },
  4: { chunks: [FIRST, think('\n\t ')], finish: 'stop' },
  5: { chunks: [FIRST, think('abc'), say('x')], finish: 'stop' },
  6: { stream: false, message: { role: 'assistant', content: 'ok', reasoning_content: '\n\n' } },
};
const script = SCRIPTS[id];
if (!script) { console.error(`未知用例编号 ${id}`); process.exit(2); }

const frame = (delta, finish = null, usage) => ({
  id: 'chatcmpl-r151r', object: 'chat.completion.chunk', created: 1700000000, model: MODEL,
  choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}),
});

const calls = [];
const upstream = http.createServer((req, res) => {
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (c) => { raw += c; });
  req.on('end', async () => {
    let json = null;
    try { json = raw ? JSON.parse(raw) : null; } catch { json = null; }
    const pathname = new URL(req.url, 'http://fake-upstream.local').pathname;
    calls.push({ method: req.method, path: pathname, stream: Boolean(json && json.stream === true), model: json && json.model });
    if (req.method !== 'POST' || !pathname.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'not_found', message: `fake upstream got ${req.method} ${pathname}` } }));
      return;
    }
    if (json && json.stream === true) {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
      for (const delta of script.chunks || []) { res.write(`data: ${JSON.stringify(frame(delta))}\n\n`); await sleep(8); }
      res.write(`data: ${JSON.stringify(frame({}, script.finish || 'stop', USAGE))}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      id: 'chatcmpl-r151r', object: 'chat.completion', created: 1700000000, model: MODEL,
      choices: [{ index: 0, message: script.message || { role: 'assistant', content: 'unused' }, finish_reason: 'stop' }], usage: USAGE,
    }));
  });
});

const fakePort = await pickPort({ base: 6700 + ((id * 23) % 280) });
const proxyPort = await pickPort({ base: 6700 + ((id * 23 + 9) % 280), exclude: [fakePort] });
await new Promise((resolve, reject) => { upstream.once('error', reject); upstream.listen(fakePort, '127.0.0.1', resolve); });
await startProxy('openai', proxyPort);
await setOpenAIUpstream({ baseURL: `http://127.0.0.1:${fakePort}`, apiKey: 'sk-r151r-upstream-key', model: MODEL });

const body = { model: 'claude-opus-4-7', max_tokens: 64, messages: [{ role: 'user', content: 'r151r ping' }] };
if (script.stream !== false) body.stream = true;
if (id === 3) body.tools = [{ name: 'get_weather', description: '查天气', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }];

let result;
try {
  const res = await postMessages(`http://127.0.0.1:${proxyPort}`, body, { timeout: 20_000 });
  result = {
    status: res.status, contentType: res.headers['content-type'] || '', rawHead: res.text.slice(0, 1500),
    events: script.stream === false ? null : parseSSE(res.text), json: res.json, upstreamCalls: calls,
  };
} catch (err) {
  result = { status: 0, contentType: '', rawHead: `请求代理失败:${err && err.message}`, events: null, json: null, upstreamCalls: calls };
}
console.log(`R151R_RESULT ${JSON.stringify(result)}`);
process.exit(0);
