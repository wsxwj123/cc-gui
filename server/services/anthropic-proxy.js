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

export function getAnthropicUpstream() {
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

async function handle(req, clientRes) {
  if (!upstream) {
    clientRes.writeHead(503, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'anthropic upstream not configured' } }));
    return;
  }

  const body = (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH')
    ? await readBody(req)
    : undefined;

  // Build a CLEAN header set. The CLI's incoming Authorization / x-api-key carries
  // the poisoned subscription OAuth token — we DROP it and inject the real provider
  // token instead. deepseek/mimo/anthropic relays accept either header shape, so we
  // send both (a server checks one and ignores the other).
  const headers = {
    'content-type': req.headers['content-type'] || 'application/json',
    'x-api-key': upstream.authToken,
    'authorization': `Bearer ${upstream.authToken}`,
    'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
  };
  if (req.headers['anthropic-beta']) headers['anthropic-beta'] = req.headers['anthropic-beta'];
  if (req.headers['accept']) headers['accept'] = req.headers['accept'];

  const url = upstream.baseURL + req.url;

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

export function stopAnthropicProxy() {
  if (server) { try { server.close(); } catch {} server = null; boundPort = 0; }
}
