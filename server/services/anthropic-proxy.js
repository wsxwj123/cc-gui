// Embedded Anthropic passthrough proxy.
//
// Why: when the user is logged into a Claude subscription, the `claude` CLI
// attaches that subscription's OAuth token (keychain `claudeAiOauth`) to EVERY
// request and it takes precedence over the `ANTHROPIC_AUTH_TOKEN` a third-party
// provider sets in settings.json. So a deepseek/mimo/anthropic-relay provider
// gets the WRONG token (the subscription one) and dies with 401 — even though
// its own key is perfectly valid. Logging out fixes it but then the subscription
// itself is unusable.
//
// This loopback proxy breaks the conflict: point ANTHROPIC_BASE_URL at it, and
// it DROPS whatever auth the CLI sends (the poisoned OAuth token) and injects the
// real provider token before forwarding upstream. Pure passthrough — the body is
// already in Anthropic wire format, so unlike openai-proxy nothing is translated.
//
// Bound to 127.0.0.1 only — no auth, never exposed.

import http from 'node:http';

// Fixed loopback port (distinct from openai-proxy's 8788) so the URL written into
// settings.json survives watchdog restarts. Ephemeral fallback if it's taken.
export const ANTHROPIC_PROXY_PORT = 8789;

// Mutable upstream — set when an Anthropic-format third-party provider activates.
// { baseURL: 'https://api.deepseek.com/anthropic', authToken: 'sk-...' }
let upstream = null;
let server = null;
let boundPort = 0;

export function setAnthropicUpstream(next) {
  upstream = next && next.baseURL && next.authToken
    ? { baseURL: String(next.baseURL).replace(/\/+$/, ''), authToken: String(next.authToken) }
    : null;
  return upstream;
}

export function getAnthropicProxyPort() {
  return boundPort;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Bug #5+#7:Claude Code CLI 在调用 Skill / WebSearch 等"context-modifying"工具
// 时,把 skill body / 搜索结果用 `isMeta=true` 的 user 消息塞进下一轮 system
// context,**而不发对应的 anthropic tool_result content block**。
// 对真正实现 anthropic spec 的端点没问题(Claude 官方/MiMo 透传),但 DeepSeek
// 的 anthropic 兼容端点内部转 openai 时严格检查 tool_call_id 配对 → 报 400
// "An assistant message with 'tool_calls' must be followed by tool messages
// responding to each 'tool_call_id'".
//
// 修法:扫 messages,任何 assistant.tool_use 缺对应 tool_result,补一条空的
// tool_result(content="" 或"(no result returned)"),让请求结构合法。补的内容
// 不影响模型理解 — CLI 已经把真实 result(skill body)注入 system context,模型
// 看得见。
function normalizeMessagesForCompat(body) {
  let parsed;
  try { parsed = JSON.parse(body.toString('utf-8')); } catch { return body; }
  if (!parsed || !Array.isArray(parsed.messages)) return body;

  const msgs = parsed.messages;
  let patched = 0;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m?.role !== 'assistant') continue;
    const toolUses = Array.isArray(m.content)
      ? m.content.filter((c) => c?.type === 'tool_use' && c.id)
      : [];
    if (toolUses.length === 0) continue;

    // 找下一条 user message,看它的 content 是不是包含 tool_result for 每个 id
    const next = msgs[i + 1];
    const nextResults = (next?.role === 'user' && Array.isArray(next.content))
      ? new Set(next.content.filter((c) => c?.type === 'tool_result' && c.tool_use_id).map((c) => c.tool_use_id))
      : new Set();
    const missing = toolUses.filter((tu) => !nextResults.has(tu.id));
    if (missing.length === 0) continue;

    // 补 tool_result:就近合并到下一条 user(如果它已经是 user 的话),否则插入新 user
    const stubs = missing.map((tu) => ({
      type: 'tool_result',
      tool_use_id: tu.id,
      content: '(tool result fed via system context)',
    }));
    if (next?.role === 'user') {
      next.content = Array.isArray(next.content) ? [...stubs, ...next.content] : stubs.concat([{ type: 'text', text: String(next.content || '') }]);
    } else {
      msgs.splice(i + 1, 0, { role: 'user', content: stubs });
    }
    patched += missing.length;
  }

  if (patched === 0) return body;
  if (process.env.CGUI_PROXY_DEBUG) {
    process.stderr.write(`[anthropic-proxy] patched ${patched} missing tool_result(s)\n`);
  }
  return Buffer.from(JSON.stringify(parsed));
}

async function handle(req, clientRes) {
  // 快照 upstream:整个请求生命周期只用这一份。否则回合在途(await fetch 前后)时
  // 用户切 provider 改了模块级 upstream → 同一请求可能被发到新 baseURL / 注入新 token。
  const up = upstream;
  if (!up) {
    clientRes.writeHead(503, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'anthropic upstream not configured' } }));
    return;
  }

  let body = (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH')
    ? await readBody(req)
    : undefined;

  // 仅对 /v1/messages 做规范化(其他端点不动)
  if (body && req.url && req.url.includes('/v1/messages') && req.method === 'POST') {
    body = normalizeMessagesForCompat(body);
  }

  // Build a CLEAN header set. The CLI's incoming Authorization / x-api-key carries
  // the poisoned subscription OAuth token — we DROP it and inject the real provider
  // token instead. deepseek/mimo/anthropic relays accept either header shape, so we
  // send both (a server checks one and ignores the other).
  const headers = {
    'content-type': req.headers['content-type'] || 'application/json',
    'x-api-key': up.authToken,
    'authorization': `Bearer ${up.authToken}`,
    'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
  };
  if (req.headers['anthropic-beta']) headers['anthropic-beta'] = req.headers['anthropic-beta'];
  if (req.headers['accept']) headers['accept'] = req.headers['accept'];

  const url = up.baseURL + req.url;

  let upstreamResp;
  try {
    upstreamResp = await fetch(url, { method: req.method, headers, body });
  } catch (err) {
    clientRes.writeHead(502, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'upstream fetch failed: ' + err.message } }));
    return;
  }

  // Mirror upstream status + content-type. Deliberately DON'T copy content-encoding:
  // fetch already decompressed the body, so re-advertising gzip would corrupt it.
  const ct = upstreamResp.headers.get('content-type') || 'application/json';
  clientRes.writeHead(upstreamResp.status, { 'Content-Type': ct, 'Cache-Control': 'no-cache' });

  if (!upstreamResp.body) { clientRes.end(); return; }

  // Stream the (already Anthropic-shaped) response straight through, SSE included.
  try {
    const reader = upstreamResp.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      clientRes.write(Buffer.from(value));
    }
  } catch { /* upstream aborted mid-stream */ }
  clientRes.end();
}

export function startAnthropicProxy(port = ANTHROPIC_PROXY_PORT) {
  if (server) return Promise.resolve(boundPort);
  server = http.createServer((req, res) => { handle(req, res).catch(() => { try { res.end(); } catch {} }); });
  return new Promise((resolve) => {
    const onErr = (err) => {
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
