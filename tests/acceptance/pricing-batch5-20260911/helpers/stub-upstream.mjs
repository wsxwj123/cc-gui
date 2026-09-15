// Stub upstream for the [夹具] usage cases: a tiny OpenAI-Chat-Completions and Anthropic-Messages
// server whose canned `usage` payloads make R22/R23 normalization observable end to end.
// It is a *protocol fixture* (INTERFACE allows fixtures for 边界/异常); real-provider evidence for
// the same rules is separate acceptance work (see README "Limits of this suite").
//
// The scenario is chosen by the last user text: send a prompt containing `PR5SCEN=<name>`.
// The operator points one custom provider of the isolated instance at this port (README).
import http from 'node:http';

export const STUB_PORT = Number(process.env.PR5_STUB_PORT || 57881);
export const STUB_MODEL = process.env.PR5_STUB_MODEL || 'pr5-stub-model';

const SCENARIOS = {
  chat_write: {
    openai: { prompt_tokens: 15000, prompt_tokens_details: { cached_tokens: 12000, cache_write_tokens: 3000 }, completion_tokens: 4 },
    anthropic: { input_tokens: 0, output_tokens: 4, cache_read_input_tokens: 12000, cache_creation_input_tokens: 3000 },
  },
  mixed_ttl: {
    anthropic: {
      input_tokens: 0, output_tokens: 4, cache_read_input_tokens: 8000, cache_creation_input_tokens: 2000,
      cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 1000 },
    },
    openai: { prompt_tokens: 10000, prompt_tokens_details: { cached_tokens: 8000, cache_write_tokens: 2000 }, completion_tokens: 4 },
  },
  no_ttl_split: {
    anthropic: { input_tokens: 0, output_tokens: 4, cache_read_input_tokens: 8000, cache_creation_input_tokens: 2000 },
    openai: { prompt_tokens: 10000, prompt_tokens_details: { cached_tokens: 8000, cache_write_tokens: 2000 }, completion_tokens: 4 },
  },
  zero: {
    anthropic: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    openai: { prompt_tokens: 0, completion_tokens: 0 },
  },
  negative: {
    anthropic: { input_tokens: -5, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    openai: { prompt_tokens: -5, completion_tokens: 4 },
  },
  overflow: {
    anthropic: { input_tokens: 9007199254740993, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    openai: { prompt_tokens: 9007199254740993, completion_tokens: 4 },
  },
  inconsistent: {
    anthropic: { input_tokens: 1000, output_tokens: 4, cache_read_input_tokens: 12000, cache_creation_input_tokens: 3000 },
    openai: { prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 12000, cache_write_tokens: 3000 }, completion_tokens: 4 },
  },
  cum_a: {
    anthropic: { input_tokens: 1000, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    openai: { prompt_tokens: 1000, completion_tokens: 1 },
  },
  cum_b: {
    anthropic: { input_tokens: 0, output_tokens: 1, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 },
    openai: { prompt_tokens: 9000, prompt_tokens_details: { cached_tokens: 9000 }, completion_tokens: 1 },
  },
  unknown_model: {
    anthropic: { input_tokens: 1000, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    openai: { prompt_tokens: 1000, completion_tokens: 4 },
  },
  default: {
    anthropic: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    openai: { prompt_tokens: 10, completion_tokens: 4 },
  },
};

function lastUserText(body) {
  const messages = body?.messages || body?.contents || [];
  const texts = [];
  for (const message of messages) {
    const content = message?.content;
    if (typeof content === 'string') texts.push(content);
    else if (Array.isArray(content)) texts.push(content.map(part => part?.text || '').join(''));
  }
  return texts.join('\n');
}

export function scenarioOf(body) {
  // 取【最后一个】标记,不是第一个:同一会话的第二回合会把第一回合的提示词一起带上来
  // (messages 里留着 PR5SCEN=cum_a),按第一个匹配算会让第二回合重放上一回合的场景
  // (实测 PR-37 第二回合拿到 cum_a → 累计 2000 而不是 10000)。末次出现的标记才是本回合的意图。
  let name = null;
  for (const match of lastUserText(body).matchAll(/PR5SCEN=([a-z_]+)/g)) name = match[1];
  return { name: name || 'default', usage: SCENARIOS[name] || SCENARIOS.default };
}

function readBody(request) {
  return new Promise(resolve => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); }
    });
  });
}

function sendJson(response, status, payload) {
  const text = JSON.stringify(payload);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  response.end(text);
}

function openAiCompletion(body, usage) {
  return {
    id: `chatcmpl-pr5-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body?.model || STUB_MODEL,
    choices: [{ index: 0, message: { role: 'assistant', content: 'PR5_STUB_OK' }, finish_reason: 'stop' }],
    usage,
  };
}

function anthropicMessage(body, usage) {
  return {
    id: `msg_pr5_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: body?.model || STUB_MODEL,
    content: [{ type: 'text', text: 'PR5_STUB_OK' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage,
  };
}

function streamOpenAi(response, body, usage) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const chunk = extra => ({ id: 'chatcmpl-pr5-stream', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body?.model || STUB_MODEL, ...extra });
  response.write(`data: ${JSON.stringify(chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'PR5_STUB_OK' }, finish_reason: null }] }))}\n\n`);
  response.write(`data: ${JSON.stringify(chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage }))}\n\n`);
  response.write('data: [DONE]\n\n');
  response.end();
}

function streamAnthropic(response, body, usage) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const message = anthropicMessage(body, { input_tokens: usage.input_tokens ?? 0, cache_read_input_tokens: usage.cache_read_input_tokens, cache_creation_input_tokens: usage.cache_creation_input_tokens, cache_creation: usage.cache_creation });
  response.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message })}\n\n`);
  response.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`);
  response.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'PR5_STUB_OK' } })}\n\n`);
  response.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
  response.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: usage.output_tokens ?? 0 } })}\n\n`);
  response.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
  response.end();
}

export function startStub({ port = STUB_PORT } = {}) {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    if (request.method === 'GET' && /\/models$/.test(url.pathname)) {
      return sendJson(response, 200, { object: 'list', data: [{ id: STUB_MODEL, object: 'model', owned_by: 'pr5' }] });
    }
    if (request.method !== 'POST') return sendJson(response, 404, { error: { message: 'not found' } });
    const body = await readBody(request);
    const { usage } = scenarioOf(body);
    const isAnthropic = /\/messages$/.test(url.pathname) || /anthropic/.test(url.pathname);
    if (isAnthropic) {
      const anthropicUsage = usage.anthropic || SCENARIOS.default.anthropic;
      if (body.stream) return streamAnthropic(response, body, anthropicUsage);
      return sendJson(response, 200, anthropicMessage(body, anthropicUsage));
    }
    const openAiUsage = usage.openai || SCENARIOS.default.openai;
    if (body.stream) return streamOpenAi(response, body, openAiUsage);
    return sendJson(response, 200, openAiCompletion(body, openAiUsage));
  });
  // 端口被占(常见:操作者按 README 让 stub 常驻)→ reject,由调用方决定是复用已跑的那个还是报夹具缺失；
  // 没有这个 error 监听时 EADDRINUSE 会变成未捕获异常,把整个 spec 文件打崩而不是走 catch。
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(server); });
  });
}
