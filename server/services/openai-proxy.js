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
import { isCountTokensRequest, estimateInputTokens } from '../utils/context-tokens.js';
import { lookupModelCapabilities, EFFORT_IDS } from '../utils/model-capabilities.js';

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
  if (!next || !next.baseURL) {
    upstream = null;
    return upstream;
  }
  upstream = {
    baseURL: String(next.baseURL).replace(/\/+$/, ''),
    apiKey: next.apiKey ? String(next.apiKey) : '',
    // model 供 upstreamNoVision 判定 opencode+deepseek 场景剥图;不带 model 的旧调用
    // (baseURL+apiKey)仍工作,model 为空、行为不变。
    model: next.model ? String(next.model) : '',
  };
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

// CI-4:已知无 vision 的 OpenAI 兼容上游(对 image_url 报 400 "unknown variant 'image_url'")。
// 按 baseURL 命中,后续可扩展。命中时把 image block 剥成文本占位,避免整个请求 400 失败。
const NO_VISION_HOSTS = /deepseek/i;
const OPENCODE_HOST = /opencode/i;
const DEEPSEEK_MODEL = /deepseek/i;
export function upstreamNoVision() {
  if (!upstream?.baseURL) return false;
  if (NO_VISION_HOSTS.test(upstream.baseURL)) return true;
  // opencode 走 OpenAI 协议,baseURL 不含 deepseek;但选 deepseek 系模型时上游同样无 vision,
  // 历史 image 块原样转发会 400。按「opencode baseURL + deepseek 系 model」补判。
  return OPENCODE_HOST.test(upstream.baseURL) && DEEPSEEK_MODEL.test(upstream.model || '');
}

export function anthropicToOpenAIMessages(messages, system) {
  const out = [];
  const noVision = upstreamNoVision();
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
    const imageParts = [];
    const toolCalls = [];
    const toolResults = [];
    const thinkingParts = [];

    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text') {
        textParts.push(block.text || '');
      } else if (block.type === 'thinking') {
        // 历史 thinking 块不能丢:deepseek 系上游要求 thinking 轮次必须回传 reasoning_content,
        // 缺了同会话续聊报 400。收集后作 assistant 顶层字段,不进 content(正文/思考分离)。
        thinkingParts.push(block.thinking || '');
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
      } else if (block.type === 'image') {
        if (noVision) {
          // CI-4:deepseek 等无 vision 上游不认 image_url → 剥成文本占位,模型据此说明
          // "看不到图片",整个请求不再 400(前端也会提前提示,这里是兜底)。
          textParts.push('[图片已忽略:当前 provider 不支持视觉输入]');
        } else {
          const source = block.source || {};
          if (source.type === 'base64' && source.data) {
            imageParts.push({
              type: 'image_url',
              image_url: { url: `data:${source.media_type || 'image/png'};base64,${source.data}` },
            });
          } else if (source.type === 'url' && source.url) {
            imageParts.push({ type: 'image_url', image_url: { url: source.url } });
          }
        }
      }
    }

    if (role === 'assistant') {
      const m = { role: 'assistant' };
      const txt = textParts.join('');
      if (txt) m.content = txt;
      if (toolCalls.length) m.tool_calls = toolCalls;
      if (thinkingParts.length) m.reasoning_content = thinkingParts.join('');
      if (m.content != null || m.tool_calls || m.reasoning_content != null) out.push(m);
    } else {
      // user (or tool) — emit tool_result FIRST, then text.
      // OpenAI 协议要求 assistant.tool_calls 后必须立即跟 tool messages 配对,
      // 任何中间 user.content 插入都会被严格端点(DeepSeek 等)拒绝:
      //   API Error 400: "An assistant message with 'tool_calls' must be followed
      //   by tool messages responding to each 'tool_call_id'."
      for (const tr of toolResults) out.push(tr);
      const txt = textParts.join('');
      if (txt || imageParts.length) {
        if (imageParts.length) {
          out.push({
            role: 'user',
            content: [
              ...(txt ? [{ type: 'text', text: txt }] : []),
              ...imageParts,
            ],
          });
        } else {
          out.push({ role: 'user', content: txt });
        }
      }
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

const READ_PAGES_RE = /^(\d+|\d+\s*-\s*\d+)(\s*,\s*(\d+|\d+\s*-\s*\d+))*$/;
function sanitizeToolInput(name, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const next = { ...input };
  if (name === 'Read' && 'pages' in next) {
    if (typeof next.pages !== 'string' || !READ_PAGES_RE.test(next.pages.trim())) {
      delete next.pages;
    } else {
      next.pages = next.pages.trim().replace(/\s+/g, '');
    }
  }
  return next;
}

// r15-4:'max' 的折算从"一刀切降成 xhigh"改为按目标模型的实测档位决定。
// 旧行为的来历是 OpenAI codex 系(gpt-5*-codex 认 xhigh 不认 max),但一刀切套到所有
// OpenAI 兼容端点就错了:DeepSeek 官方 reasoning_effort 只认 low/high/max,且把 xhigh
// 映射回 high —— 于是中转站上「高」和「极限」发的是同一个东西,max 档白给。
// 判据只信数据表(family==='table'),正则命中的"全档"是兜底猜测、不足以据此升档,
// 故那些情况一律维持既有的 xhigh(保守,不改变未知模型的现状)。
function translateMaxEffort(model) {
  // [1m] 是 GUI 给 1M 上下文会话追加的后缀(App.jsx 发送前拼、chat.js 原样 --model 下发),
  // 带着它查表必落空 → 整套折算对 1M 会话失效(客户端同一 lookup 在 effortCaps.js 早已剥)。
  const hit = lookupModelCapabilities(String(model || '').replace(/\[1m\]/i, ''), 'openai');
  // r26-F5:reasoning===false 必须先于 family 判断 —— 正则判死的模型(如 gpt-4 系、qwen2
  // 系,family 是正则家族名而非 'table')显式关思考永远优先于「维持旧行为 xhigh」,
  // 否则非思考模型被下发 reasoning_effort=xhigh,上游可能报错或静默误解。
  if (hit && hit.reasoning === false) return null;   // 显式关思考(表或正则)→ 干脆不下发
  if (hit?.family !== 'table') return 'xhigh';      // 表外 / 只被正则猜中 → 维持旧行为
  if (!hit.efforts) return 'max';                    // 表说全档 → 它确实认 max
  if (hit.efforts.includes('max')) return 'max';
  if (hit.efforts.includes('xhigh')) return 'xhigh';
  return [...EFFORT_IDS].reverse().find((e) => hit.efforts.includes(e)) || 'xhigh'; // 落该模型最高可用档
}

export function normalizeReasoningEffort(body) { // export 仅为可单测
  const raw = body?.effort || body?.reasoning_effort || body?.thinking?.effort;
  if (typeof raw !== 'string') return null;
  if (raw === 'max') return translateMaxEffort(body?.model);
  if (['low', 'medium', 'high', 'xhigh', 'minimal', 'none'].includes(raw)) return raw;
  return null;
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
  const reasoningEffort = normalizeReasoningEffort(body);
  if (reasoningEffort) req.reasoning_effort = reasoningEffort;
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

// 上下文超限错误归一化(auto-compact 修复核心):CLI 只认 anthropic 原文
// "prompt is too long" 才会缩减分组重试摘要请求;OpenAI/中转措辞不被识别 →
// compact 判失败 → 回合被杀。窄匹配超限特征,命中则改写为 CLI 可识别措辞,
// 原文截断保留在后(用户仍看得到上游真实信息)。401/429/余额类不含这些特征,不受影响。
// 后三条为窄字面特征(fable判官补漏):Anthropic "input length and max_tokens exceed
// context limit"(无s)、Gemini 系、Kimi;均不与限流文案("exceeded your per-minute rate
// limit"/"tokens per min (TPM)")重叠,断言见 check-compact-error-normalize.mjs。
const CTX_OVERFLOW_RE = /maximum context length|context_length_exceeded|too many tokens|exceeds\b.{0,40}\bcontext|input\b.{0,20}\btoo long|exceed context limit|exceeds the maximum number of tokens allowed|exceeded model token limit/i;
export function normalizeContextOverflow(msg) {
  const s = String(msg ?? '');
  if (/prompt is too long/i.test(s)) return s; // 已是 CLI 可识别措辞(含幂等:避免重复前缀)
  if (!CTX_OVERFLOW_RE.test(s)) return s;
  return 'prompt is too long: ' + s.slice(0, 400);
}

// 从上游 OpenAI error 对象(或裸错误体)提取人类可读文案与合理状态码。
function rawErrMsg(e) {
  if (!e) return 'upstream error';
  if (typeof e === 'string') return e;
  return e.message || (typeof e.error === 'string' ? e.error : '') || JSON.stringify(e);
}
function errMsg(e) {
  // 429 门:某些中转 200+error{code:429} 的限流文案含 "too many tokens",改写成
  // prompt is too long 会让 CLI 误触发 compact 而非退避;无 code 的真超限体仍归一化。
  const raw = rawErrMsg(e);
  return errStatus(e) === 429 ? raw : normalizeContextOverflow(raw);
}
function errStatus(e) {
  // 上游 error 里带数字 code/status 就用它,否则(多为字符串码如 insufficient_quota)回 502。
  const c = e && (e.status ?? e.code);
  const n = typeof c === 'number' ? c : parseInt(c, 10);
  return n >= 400 && n < 600 ? n : 502;
}

function streamOpenAIToAnthropic(upstreamRes, clientRes, model) {
  const msgId = 'msg_' + Math.random().toString(36).slice(2, 14);
  // 惰性 message_start:收到首个正常块才发。在此之前发现上游流内错误,可以改回非 200 +
  // anthropic 错误体(CLI 只在非 200 时透出上游 message);已发流则退化成 anthropic error 事件。
  let started = false;
  let aborted = false;
  const ensureStarted = () => {
    if (started) return;
    started = true;
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
  };
  const emitUpstreamError = (err) => {
    aborted = true;
    if (!started) {
      clientRes.writeHead(errStatus(err), { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: errMsg(err) } }));
    } else {
      sse(clientRes, 'error', { type: 'error', error: { type: 'api_error', message: errMsg(err) } });
      try { clientRes.end(); } catch {}
    }
  };

  // Block bookkeeping. Index 0 reserved for text once it starts; tool calls get
  // subsequent indices keyed by the OpenAI tool_call index.
  let textOpen = false;
  let nextIndex = 0;
  const toolBlocks = new Map(); // openaiToolIndex → { anthropicIndex, id, name, jsonBuf }
  let finishReason = null;
  let usage = null;
  let buf = '';

  const ensureTextBlock = () => {
    ensureStarted();
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
    if (json.error) { emitUpstreamError(json.error); return; }
    if (json.usage) {
      // W8(R4):OpenAI 的 prompt_tokens 是【含缓存】的总输入,其中命中缓存的部分在
      // prompt_tokens_details.cached_tokens。此前直接整段当 input_tokens → 经本网关
      // 的 provider 永远不显示缓存命中、且 input 虚高。拆开对齐 Anthropic 语义
      // (input_tokens = 未命中缓存的新 token)。OpenAI 无 cache write 概念,留空。
      // BB4:DeepSeek 不返 prompt_tokens_details.cached_tokens,而是顶层
      // prompt_cache_hit_tokens → 不回退就让 deepseek 缓存命中恒 0、input 虚高。
      const cached = json.usage.prompt_tokens_details?.cached_tokens
        ?? json.usage.prompt_cache_hit_tokens ?? 0;
      usage = {
        input_tokens: Math.max(0, (json.usage.prompt_tokens || 0) - cached),
        cache_read_input_tokens: cached,
        output_tokens: json.usage.completion_tokens || 0,
      };
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
          ensureStarted();
          closeTextBlock();
          const aIdx = nextIndex++;
          entry = {
            anthropicIndex: aIdx,
            id: tc.id || ('toolu_' + oaIdx + '_' + msgId),
            name: tc.function?.name || '',
            jsonBuf: '',
          };
          toolBlocks.set(oaIdx, entry);
          sse(clientRes, 'content_block_start', { type: 'content_block_start', index: aIdx,
            content_block: { type: 'tool_use', id: entry.id, name: entry.name, input: {} } });
        }
        if (tc.id && !entry.id) entry.id = tc.id;
        if (tc.function?.name && !entry.name) entry.name = tc.function.name;
        const argFrag = tc.function?.arguments;
        if (argFrag) {
          entry.jsonBuf += argFrag;
        }
      }
    }

    if (choice.finish_reason) finishReason = choice.finish_reason;
  };

  upstreamRes.on('data', (chunk) => {
    if (aborted) return;
    buf += chunk.toString('utf-8');
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (aborted) return;
      if (!line) continue;
      if (!line.startsWith('data:')) {
        // 兜底:CT 声明是 event-stream,却把裸 JSON 错误体当 body 发(某些中转站)。
        // 未发流时识别 .error → 回非 200。跨行 pretty-JSON 靠改动点 A 的 CT 检查拦下,这里只认单行。
        if (!started) {
          try { const j = JSON.parse(line); if (j && j.error) { emitUpstreamError(j.error); return; } } catch {}
        }
        continue;
      }
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try { handleChunk(JSON.parse(payload)); } catch {}
      if (aborted) return;
    }
  });

  upstreamRes.on('end', () => {
    if (aborted) return;
    ensureStarted(); // 空但成功的流:仍补出合法(空)的 anthropic 收尾
    closeTextBlock();
    for (const entry of toolBlocks.values()) {
      let input = {};
      try { input = JSON.parse(entry.jsonBuf || '{}'); } catch {}
      const clean = JSON.stringify(sanitizeToolInput(entry.name, input));
      if (clean !== '{}') {
        sse(clientRes, 'content_block_delta', { type: 'content_block_delta', index: entry.anthropicIndex,
          delta: { type: 'input_json_delta', partial_json: clean } });
      }
      sse(clientRes, 'content_block_stop', { type: 'content_block_stop', index: entry.anthropicIndex });
    }
    sse(clientRes, 'message_delta', { type: 'message_delta',
      delta: { stop_reason: STOP_MAP[finishReason] || 'end_turn', stop_sequence: null },
      usage: usage || { output_tokens: 0 } });
    sse(clientRes, 'message_stop', { type: 'message_stop' });
    clientRes.end();
  });

  upstreamRes.on('error', (err) => {
    if (aborted) return;
    if (!started) {
      try {
        clientRes.writeHead(502, { 'Content-Type': 'application/json' });
        clientRes.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'upstream stream error: ' + (err?.message || '') } }));
      } catch {}
    } else {
      try { clientRes.end(); } catch {}
    }
  });
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
    const name = tc.function?.name;
    content.push({ type: 'tool_use', id: tc.id, name, input: sanitizeToolInput(name, input) });
  }
  return {
    id: json.id || ('msg_' + Math.random().toString(36).slice(2)),
    type: 'message', role: 'assistant', model, content,
    stop_reason: STOP_MAP[choice.finish_reason] || 'end_turn', stop_sequence: null,
    // W8(R4):同流式路径 —— 拆出 cached_tokens 对齐 Anthropic 缓存语义。
    usage: (() => {
      // BB4:DeepSeek 用顶层 prompt_cache_hit_tokens(无 cached_tokens)→ 回退兼容。
      const cached = json.usage?.prompt_tokens_details?.cached_tokens
        ?? json.usage?.prompt_cache_hit_tokens ?? 0;
      return {
        input_tokens: Math.max(0, (json.usage?.prompt_tokens || 0) - cached),
        cache_read_input_tokens: cached,
        output_tokens: json.usage?.completion_tokens || 0,
      };
    })(),
  };
}

// 上游 HTTP 200 时的统一收尾(流式/非流式共用,retry 成功路径也走这里)。
// A:中转站常在 200 下返 JSON 错误体(Content-Type 非 event-stream)——不能当流处理,
// 读 JSON 有 .error 则回非 200 anthropic 错误体(CLI 才透出上游 message);否则按非流式回复转换。
async function respondOk(upstreamResp, wantStream, clientRes, model) {
  if (wantStream) {
    const ct = upstreamResp.headers.get('content-type') || '';
    if (/event-stream/i.test(ct)) {
      streamOpenAIToAnthropic(streamFromWeb(upstreamResp.body), clientRes, model);
      return;
    }
    // 判官项3:劣质中转常把真 SSE body 错标成 text/plain/缺失 CT——直接 .json() 必失败,
    // 会回归成 200 空消息(旧代码不看 CT 逐行解析本可用)。先试 JSON(保住 A 的 200+error
    // 归一化透传,即使 error 文案里恰好含 "data:" 也不会误判),解析失败且 body 有 data:
    // 行时把已缓冲文本回放给现有 SSE 转换链。
    // ponytail: 回放是整体缓冲,错标 CT 的上游丢增量流式;要保首字延迟再做首块嗅探。
    const txt = await upstreamResp.text().catch(() => '');
    let j = null;
    try { j = JSON.parse(txt); } catch {}
    if (!j && /(^|\n)\s*data:/.test(txt)) {
      streamOpenAIToAnthropic(streamFromWeb(new Response(txt).body), clientRes, model);
      return;
    }
    if (j && j.error) {
      clientRes.writeHead(errStatus(j.error), { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: errMsg(j.error) } }));
      return;
    }
    clientRes.writeHead(200, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify(openAIToAnthropicMessage(j || {}, model)));
    return;
  }
  const json = await upstreamResp.json().catch(() => ({}));
  if (json && json.error) { // 非流式同样可能是 200+error 体
    clientRes.writeHead(errStatus(json.error), { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: errMsg(json.error) } }));
    return;
  }
  clientRes.writeHead(200, { 'Content-Type': 'application/json' });
  clientRes.end(JSON.stringify(openAIToAnthropicMessage(json, model)));
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
  // r11-⑨:count_tokens —— OpenAI 协议上游没有等价端点,且本函数原来把任何含
  // /v1/messages 的 URL 都当生成请求转 chat/completions:count_tokens 会变成一次
  // 【真实计费的生成调用】且响应缺 input_tokens(实证,精确计算必失败)。这里直接
  // 本地估算返回(与 CLI 第三方本地估算同口径),请求体不转发到任何地址(红线;
  // 对 OpenAI 协议"先透传上游"无意义 —— 端点在协议层就不存在,试探只会误打生成)。
  if (isCountTokensRequest(req.method, req.url)) {
    let parsedBody = {};
    try { parsedBody = JSON.parse(await readBody(req)) || {}; } catch {}
    clientRes.writeHead(200, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify(estimateInputTokens(parsedBody)));
    return;
  }
  if (req.method !== 'POST' || !req.url.includes('/v1/messages')) {
    clientRes.writeHead(404); clientRes.end('not found'); return;
  }
  // 快照 upstream:整个请求(含重试)只用这一份,避免在途切 provider 把请求/key 发错。
  const up = upstream;
  if (!up) {
    clientRes.writeHead(503, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'OpenAI upstream not configured' } }));
    return;
  }
  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch { clientRes.writeHead(400); clientRes.end('bad json'); return; }

  const oaReq = buildOpenAIRequest(body);
  const wantStream = oaReq.stream;
  const url = up.baseURL + '/chat/completions';

  // 连接超时:上游 TCP 连上却迟迟不吐响应头(错 baseURL/geo 卡/上游挂)时,无超时的
  // fetch 会无限挂 → CLI 永久 "connecting" 无反馈(用户实报)。90s 到点 abort → 转 502 报错。
  // 收到响应头(fetch settle)即 clearTimeout,故正文流式不受影响(长回复不会被切断)。
  const postUpstream = (payload) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 90000);
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${up.apiKey}` },
      body: JSON.stringify(payload),
      signal: ac.signal,
      // 不跟随重定向:上游 3xx 会把带 apiKey 的请求引到任意主机(密钥外泄/SSRF)。
      // 3xx 落到下方 !ok 分支按原逻辑解析错误体上报。
      redirect: 'manual',
    }).finally(() => clearTimeout(t));
  };

  let upstreamResp;
  try {
    upstreamResp = await postUpstream(oaReq);
  } catch (err) {
    clientRes.writeHead(502, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'upstream fetch failed: ' + err.message } }));
    return;
  }

  if (!upstreamResp.ok) {
    let txt = await upstreamResp.text().catch(() => '');
    if (oaReq.reasoning_effort && /reasoning_effort|unsupported parameter|unknown parameter/i.test(txt)) {
      const retryReq = { ...oaReq };
      delete retryReq.reasoning_effort;
      try {
        upstreamResp = await postUpstream(retryReq);
        if (upstreamResp.ok) {
          return respondOk(upstreamResp, wantStream, clientRes, body.model);
        }
        txt = await upstreamResp.text().catch(() => txt);
      } catch {}
    }
    // C:文案打磨 —— 解析出上游 error.message,别把整段原始 JSON(带双状态码前缀)塞给用户。
    let up_msg = txt;
    try { const j = JSON.parse(txt); up_msg = rawErrMsg(j.error || j); } catch {}
    // 归一化只收 400/413(真超限状态码):某些中转 429 限流文案含 "too many tokens",
    // 改写成 prompt is too long 会让 CLI 误触发 compact 而非退避。
    if (upstreamResp.status === 400 || upstreamResp.status === 413) {
      up_msg = normalizeContextOverflow(up_msg);
    }
    clientRes.writeHead(upstreamResp.status, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: String(up_msg).slice(0, 500) } }));
    return;
  }

  return respondOk(upstreamResp, wantStream, clientRes, body.model);
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
