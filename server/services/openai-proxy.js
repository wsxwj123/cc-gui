// Embedded Anthropic↔OpenAI translation proxy.
//
// Why: the `claude` CLI only speaks the Anthropic Messages API. Some cc-switch
// providers (app_type=codex/opencode) expose only an OpenAI-compatible
// /v1/chat/completions endpoint. This loopback proxy lets the CLI target an
// OpenAI-only model: point ANTHROPIC_BASE_URL at this proxy, and it rewrites
// each request to OpenAI shape, forwards it upstream, and streams the reply
// back as Anthropic SSE.
//
// Scope (MVP): text + tool calls + (optional) reasoning, streaming and
// non-streaming. Images and prompt-caching headers are passed through best-
// effort but not translated. Bound to 127.0.0.1 only — no auth, never exposed.

import http from 'node:http';

// Fixed loopback port so the ANTHROPIC_BASE_URL written into settings.json
// stays valid across server restarts (watchdog). Falls back to an ephemeral
// port only if this one is already taken.
export const PROXY_PORT = 8788;

// Mutable upstream — set when the user activates an OpenAI-format provider.
// { baseURL: 'https://host/v1', apiKey: 'sk-...' }
let upstream = null;
let server = null;
let boundPort = 0;

export function setOpenAIUpstream(next) {
  upstream = next && next.baseURL && next.apiKey
    ? { baseURL: String(next.baseURL).replace(/\/+$/, ''), apiKey: String(next.apiKey) }
    : null;
  return upstream;
}

export function getOpenAIUpstream() {
  return upstream;
}

export function getProxyPort() {
  return boundPort;
}

// ── request translation: Anthropic → OpenAI ──────────────────────────────
function systemToText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system.map((b) => (typeof b === 'string' ? b : b?.text || '')).join('\n');
  }
  return '';
}

function anthropicToOpenAIMessages(messages, system) {
  const out = [];
  const sys = systemToText(system);
  if (sys) out.push({ role: 'system', content: sys });

  for (const msg of messages || []) {
    const role = msg.role;
    const content = msg.content;

    if (typeof content === 'string') {
      out.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;

    // Split a single Anthropic message into: text/image parts, tool_use
    // (assistant tool_calls), and tool_result (separate role:'tool' msgs).
    const textParts = [];
    const toolCalls = [];
    const toolResults = [];

    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text') {
        textParts.push(block.text || '');
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
        });
      } else if (block.type === 'tool_result') {
        const c = block.content;
        let text;
        if (typeof c === 'string') text = c;
        else if (Array.isArray(c)) text = c.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('\n');
        else text = c == null ? '' : JSON.stringify(c);
        toolResults.push({ role: 'tool', tool_call_id: block.tool_use_id, content: text });
      }
      // image blocks are skipped for now (MVP: text + tool calls only)
    }

    if (role === 'assistant') {
      const m = { role: 'assistant' };
      const txt = textParts.join('');
      if (txt) m.content = txt;
      if (toolCalls.length) m.tool_calls = toolCalls;
      if (m.content != null || m.tool_calls) out.push(m);
    } else {
      // user (or tool) — emit tool_result FIRST, then text.
      // OpenAI 协议要求 assistant.tool_calls 后必须立即跟 tool messages 配对,
      // 任何中间 user.content 插入都会被严格端点(DeepSeek 等)拒绝:
      //   API Error 400: "An assistant message with 'tool_calls' must be followed
      //   by tool messages responding to each 'tool_call_id'."
      for (const tr of toolResults) out.push(tr);
      const txt = textParts.join('');
      if (txt) out.push({ role: 'user', content: txt });
    }
  }

  // Bug #7 真根因(用户 v0.1.26 仍报错):CLI 在调 Skill 等 context-modifying 工具
  // 时,**根本不把 tool_result 作为 anthropic content block 发上来** —— 它把
  // skill body 用 isMeta=true 的 user.text 注入 system context,只把工具调用的
  // assistant.tool_use 留在 messages 里。结果 openai-proxy 转换出的序列形如:
  //   user: prompt
  //   assistant: tool_calls=[X]
  //   user: <skill body>   ← 缺 tool message!
  // → DeepSeek 严格端点 400 拒绝。
  //
  // 修法:转换完成后扫一遍 messages,任何 assistant.tool_calls 后没立即跟够 tool
  // 配对,补一条 stub tool message(content="(tool result fed via system context)")。
  // 不影响模型理解 — 真 result 已在 system prompt 里,模型读得到。
  let patched = 0;
  for (let i = 0; i < out.length; i++) {
    const m = out[i];
    if (m?.role !== 'assistant' || !Array.isArray(m.tool_calls) || m.tool_calls.length === 0) continue;
    // 收下一段连续 role:'tool' 已配对的 tool_call_id
    const seen = new Set();
    let j = i + 1;
    while (j < out.length && out[j]?.role === 'tool') {
      if (out[j].tool_call_id) seen.add(out[j].tool_call_id);
      j++;
    }
    const stubs = m.tool_calls
      .filter((tc) => tc.id && !seen.has(tc.id))
      .map((tc) => ({ role: 'tool', tool_call_id: tc.id, content: '(tool result fed via system context)' }));
    if (stubs.length) {
      out.splice(j, 0, ...stubs);
      patched += stubs.length;
      i = j + stubs.length - 1; // 跳过新插入的
    }
  }
  if (patched && process.env.CGUI_PROXY_DEBUG) {
    process.stderr.write(`[openai-proxy] patched ${patched} missing tool message(s)\n`);
  }

  return out;
}

function anthropicToolsToOpenAI(tools) {
  if (!Array.isArray(tools)) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.input_schema || { type: 'object', properties: {} },
    },
  }));
}

function buildOpenAIRequest(body) {
  const req = {
    model: body.model,
    messages: anthropicToOpenAIMessages(body.messages, body.system),
    stream: body.stream !== false,
  };
  if (body.max_tokens) req.max_tokens = body.max_tokens;
  if (typeof body.temperature === 'number') req.temperature = body.temperature;
  if (typeof body.top_p === 'number') req.top_p = body.top_p;
  const tools = anthropicToolsToOpenAI(body.tools);
  if (tools && tools.length) {
    req.tools = tools;
    if (body.tool_choice) {
      const tc = body.tool_choice;
      if (tc.type === 'auto') req.tool_choice = 'auto';
      else if (tc.type === 'any') req.tool_choice = 'required';
      else if (tc.type === 'tool' && tc.name) req.tool_choice = { type: 'function', function: { name: tc.name } };
    }
  }
  if (req.stream) req.stream_options = { include_usage: true };
  return req;
}

// ── response translation: OpenAI stream → Anthropic SSE ───────────────────
function sse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

const STOP_MAP = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', content_filter: 'end_turn' };

function streamOpenAIToAnthropic(upstreamRes, clientRes, model) {
  const msgId = 'msg_' + Math.random().toString(36).slice(2, 14);
  clientRes.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  sse(clientRes, 'message_start', {
    type: 'message_start',
    message: { id: msgId, type: 'message', role: 'assistant', model, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
  });

  // Block bookkeeping. Index 0 reserved for text once it starts; tool calls get
  // subsequent indices keyed by the OpenAI tool_call index.
  let textOpen = false;
  let nextIndex = 0;
  const toolBlocks = new Map(); // openaiToolIndex → { anthropicIndex, started }
  let finishReason = null;
  let usage = null;
  let buf = '';

  const ensureTextBlock = () => {
    if (textOpen === false) {
      const idx = nextIndex++;
      sse(clientRes, 'content_block_start', { type: 'content_block_start', index: idx,
        content_block: { type: 'text', text: '' } });
      textOpen = idx;
    }
    return textOpen;
  };
  const closeTextBlock = () => {
    if (textOpen !== false) {
      sse(clientRes, 'content_block_stop', { type: 'content_block_stop', index: textOpen });
      textOpen = false;
    }
  };

  const handleChunk = (json) => {
    if (json.usage) {
      usage = { input_tokens: json.usage.prompt_tokens || 0, output_tokens: json.usage.completion_tokens || 0 };
    }
    const choice = (json.choices || [])[0];
    if (!choice) return;
    const delta = choice.delta || {};

    if (typeof delta.content === 'string' && delta.content.length) {
      const idx = ensureTextBlock();
      sse(clientRes, 'content_block_delta', { type: 'content_block_delta', index: idx,
        delta: { type: 'text_delta', text: delta.content } });
    }

    if (Array.isArray(delta.tool_calls)) {
      // text must close before tool blocks open (Anthropic orders blocks)
      for (const tc of delta.tool_calls) {
        const oaIdx = tc.index ?? 0;
        let entry = toolBlocks.get(oaIdx);
        if (!entry) {
          closeTextBlock();
          const aIdx = nextIndex++;
          entry = { anthropicIndex: aIdx };
          toolBlocks.set(oaIdx, entry);
          sse(clientRes, 'content_block_start', { type: 'content_block_start', index: aIdx,
            content_block: { type: 'tool_use', id: tc.id || ('toolu_' + oaIdx + '_' + msgId), name: tc.function?.name || '', input: {} } });
        }
        const argFrag = tc.function?.arguments;
        if (argFrag) {
          sse(clientRes, 'content_block_delta', { type: 'content_block_delta', index: entry.anthropicIndex,
            delta: { type: 'input_json_delta', partial_json: argFrag } });
        }
      }
    }

    if (choice.finish_reason) finishReason = choice.finish_reason;
  };

  upstreamRes.on('data', (chunk) => {
    buf += chunk.toString('utf-8');
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line || !line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try { handleChunk(JSON.parse(payload)); } catch {}
    }
  });

  upstreamRes.on('end', () => {
    closeTextBlock();
    for (const entry of toolBlocks.values()) {
      sse(clientRes, 'content_block_stop', { type: 'content_block_stop', index: entry.anthropicIndex });
    }
    sse(clientRes, 'message_delta', { type: 'message_delta',
      delta: { stop_reason: STOP_MAP[finishReason] || 'end_turn', stop_sequence: null },
      usage: usage || { output_tokens: 0 } });
    sse(clientRes, 'message_stop', { type: 'message_stop' });
    clientRes.end();
  });

  upstreamRes.on('error', () => { try { clientRes.end(); } catch {} });
}

// non-streaming fallback
function openAIToAnthropicMessage(json, model) {
  const choice = (json.choices || [])[0] || {};
  const m = choice.message || {};
  const content = [];
  if (m.content) content.push({ type: 'text', text: m.content });
  for (const tc of m.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(tc.function?.arguments || '{}'); } catch {}
    content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input });
  }
  return {
    id: json.id || ('msg_' + Math.random().toString(36).slice(2)),
    type: 'message', role: 'assistant', model, content,
    stop_reason: STOP_MAP[choice.finish_reason] || 'end_turn', stop_sequence: null,
    usage: { input_tokens: json.usage?.prompt_tokens || 0, output_tokens: json.usage?.completion_tokens || 0 },
  };
}

// ── proxy server ──────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function handle(req, clientRes) {
  if (req.method !== 'POST' || !req.url.includes('/v1/messages')) {
    clientRes.writeHead(404); clientRes.end('not found'); return;
  }
  if (!upstream) {
    clientRes.writeHead(503, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'OpenAI upstream not configured' } }));
    return;
  }
  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch { clientRes.writeHead(400); clientRes.end('bad json'); return; }

  const oaReq = buildOpenAIRequest(body);
  const wantStream = oaReq.stream;
  const url = upstream.baseURL + '/chat/completions';

  let upstreamResp;
  try {
    upstreamResp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${upstream.apiKey}` },
      body: JSON.stringify(oaReq),
    });
  } catch (err) {
    clientRes.writeHead(502, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'upstream fetch failed: ' + err.message } }));
    return;
  }

  if (!upstreamResp.ok) {
    const txt = await upstreamResp.text().catch(() => '');
    clientRes.writeHead(upstreamResp.status, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `upstream ${upstreamResp.status}: ${txt.slice(0, 500)}` } }));
    return;
  }

  if (wantStream) {
    // adapt web ReadableStream → node stream-ish via async iterator
    const nodeStream = streamFromWeb(upstreamResp.body);
    streamOpenAIToAnthropic(nodeStream, clientRes, body.model);
  } else {
    const json = await upstreamResp.json().catch(() => ({}));
    clientRes.writeHead(200, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify(openAIToAnthropicMessage(json, body.model)));
  }
}

// Wrap a WHATWG ReadableStream in a minimal EventEmitter-like object exposing
// .on('data'|'end'|'error') so streamOpenAIToAnthropic stays transport-agnostic.
function streamFromWeb(webStream) {
  const listeners = { data: [], end: [], error: [] };
  const emitter = { on: (ev, cb) => { (listeners[ev] || []).push(cb); return emitter; } };
  (async () => {
    try {
      const reader = webStream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        listeners.data.forEach((cb) => cb(Buffer.from(value)));
      }
      listeners.end.forEach((cb) => cb());
    } catch (err) {
      listeners.error.forEach((cb) => cb(err));
    }
  })();
  return emitter;
}

export function startOpenAIProxy(port = PROXY_PORT) {
  if (server) return boundPort;
  server = http.createServer((req, res) => { handle(req, res).catch(() => { try { res.end(); } catch {} }); });
  return new Promise((resolve) => {
    const onErr = (err) => {
      // Preferred port busy → fall back to ephemeral so the proxy still works
      // this session (restart-robustness is lost only in this rare case).
      if (err && err.code === 'EADDRINUSE' && port !== 0) {
        server.removeListener('error', onErr);
        server.listen(0, '127.0.0.1', () => { boundPort = server.address().port; resolve(boundPort); });
      } else {
        server = null; boundPort = 0; resolve(0);
      }
    };
    server.once('error', onErr);
    server.listen(port, '127.0.0.1', () => {
      boundPort = server.address().port;
      resolve(boundPort);
    });
  });
}

export function stopOpenAIProxy() {
  if (server) { try { server.close(); } catch {} server = null; boundPort = 0; }
}
