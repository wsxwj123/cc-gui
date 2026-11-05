// r155 网络客户端与断言助手:node:http(可伪造 Host)、ws 握手探针、原始 socket、统一的"拒绝/放行"断言。
// 铁规:所有探针永不抛错 —— 连接失败也作为结果返回,由断言以"期望值 vs 实际值"报告,而不是超时/抛错。
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { expect } from '@playwright/test';
import WebSocket from 'ws';
import { PASSWORD, TUNNEL_HOST } from './world.mjs';

export const BLOCK_BODY = '{"error":"Cross-origin request blocked by cc-gui"}';
export const HOST_GATE_BODY = '{"error":"Host not allowed (DNS-rebinding protection)"}';

// ───────────────────────── 请求头构造 ─────────────────────────
/** 只写传入的头;host 不传 = 让 Node 自动补 127.0.0.1:端口。 */
export function H({ host, origin, sfs, cookie, extra = {} } = {}) {
  const h = {};
  if (host !== undefined) h.Host = host;
  if (origin !== undefined) h.Origin = origin;
  if (sfs !== undefined) h['Sec-Fetch-Site'] = sfs;
  if (cookie) h.Cookie = cookie;
  return { ...h, ...extra };
}
/** 模拟 Cloudflare 隧道来源的 CF-* 头(已用真实隧道核对过形态)。 */
export const CF = { 'CF-Ray': 'test-ray', 'CF-Connecting-IP': '203.0.113.9', 'CF-Visitor': '{"scheme":"https"}', 'X-Forwarded-Proto': 'https' };
export function tunnelHeaders({ host = TUNNEL_HOST, origin = `https://${TUNNEL_HOST}`, sfs = 'same-origin', cookie } = {}) {
  return H({ host, origin, sfs, cookie, extra: CF });
}

// ───────────────────────── HTTP ─────────────────────────
export function httpRequest({ port, target = '127.0.0.1', method = 'GET', pathname, headers = {}, body, timeoutMs = 15_000 }) {
  const payload = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
  return new Promise((resolve) => {
    const req = http.request({
      host: target, port, method, path: pathname, agent: false,
      headers: { Connection: 'close', ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* 非 JSON 也是有效观测 */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json, error: undefined });
      });
      res.on('error', (e) => resolve({ status: null, headers: {}, text: '', json: null, error: String(e?.message || e) }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`请求超时 ${timeoutMs}ms`)));
    req.on('error', (e) => resolve({ status: null, headers: {}, text: '', json: null, error: String(e?.message || e) }));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
// 四种探针(见接口文件 2.3)
export const readProbe = (i, headers, pathname = '/api/health') => httpRequest({ port: i.port, pathname, headers });
export const loginProbe = (i, headers, password = PASSWORD) => httpRequest({ port: i.port, method: 'POST', pathname: '/api/login', headers, body: JSON.stringify({ password }) });
export const preflightProbe = (i, headers) => httpRequest({
  port: i.port, method: 'OPTIONS', pathname: '/api/login',
  headers: { ...headers, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
});
export const authProbe = (i, headers) => httpRequest({ port: i.port, pathname: '/api/network', headers });

/** 从登录应答里取 "cgui_token=…" (可直接放进 Cookie 头);没有返回 null。 */
export function cookieFrom(res) {
  const line = [].concat(res.headers?.['set-cookie'] || []).find((c) => c.startsWith('cgui_token='));
  return line ? line.split(';')[0] : null;
}
/** 本机形态(无 Origin、Host 默认)用正确密码登录,拿 cookie,供 WS 探针区分"来源校验拒"与"没登录拒"。 */
export async function localCookie(inst) {
  const r = await loginProbe(inst, {});
  return cookieFrom(r);
}

// ───────────────────────── WebSocket ─────────────────────────
/** 结果只分 open / rejected(带状态码)/ error。frames 只计数,不保留内容。 */
export function wsProbe(inst, headers, { waitFrameMs = 0, target = '127.0.0.1', path = '/ws' } = {}) {
  return new Promise((resolve) => {
    const out = { kind: undefined, status: undefined, frames: 0, error: undefined };
    let done = false;
    let timer = null;
    const ws = new WebSocket(`ws://${target}:${inst.port}${path}`, { headers, handshakeTimeout: 10_000, perMessageDeflate: false });
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.terminate(); } catch { /* 已关 */ }
      resolve(out);
    };
    ws.on('open', () => { out.kind = 'open'; if (waitFrameMs > 0) timer = setTimeout(finish, waitFrameMs); else finish(); });
    ws.on('message', () => { out.frames += 1; if (waitFrameMs > 0) finish(); });
    ws.on('unexpected-response', (_req, res) => { out.kind = 'rejected'; out.status = res.statusCode; res.resume(); finish(); });
    ws.on('error', (e) => { if (!out.kind) { out.kind = 'error'; out.error = String(e?.message || e); } finish(); });
    ws.on('close', () => { if (!out.kind) { out.kind = 'error'; out.error = '连接在握手前关闭'; } finish(); });
  });
}

// ───────────────────────── 原始 socket(无 Host 头等 Node 客户端发不出的请求)─────────────────────────
function decodeChunked(s) {
  let out = '';
  let rest = s;
  for (;;) {
    const i = rest.indexOf('\r\n');
    if (i < 0) return out;
    const n = parseInt(rest.slice(0, i), 16);
    if (!n) return out;
    out += rest.slice(i + 2, i + 2 + n);
    rest = rest.slice(i + 2 + n + 2);
  }
}
export function rawRequest(port, payload, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    let settled = false;
    let extra = {};
    const sock = net.connect(port, '127.0.0.1');
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch { /* 已关 */ }
      const text = buf.toString('utf8');
      const m = text.match(/^HTTP\/\d\.\d (\d{3})/);
      const i = text.indexOf('\r\n\r\n');
      const head = i >= 0 ? text.slice(0, i) : text;
      let body = i >= 0 ? text.slice(i + 4) : '';
      if (/transfer-encoding:\s*chunked/i.test(head)) body = decodeChunked(body);
      let json = null;
      try { json = JSON.parse(body); } catch { /* 非 JSON */ }
      resolve({ status: m ? Number(m[1]) : null, head, body, json, ...extra });
    };
    const timer = setTimeout(() => { extra = { error: `原始请求超时 ${timeoutMs}ms` }; finish(); }, timeoutMs);
    sock.on('connect', () => sock.write(payload));
    sock.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      if (buf.indexOf('\r\n\r\n') >= 0 && /^HTTP\/1\.[01] 101/.test(buf.toString('latin1', 0, 12))) finish(); // 101 后连接不会关,握手头到手即可
    });
    sock.on('end', finish);
    sock.on('close', finish);
    sock.on('error', (e) => { extra = { error: String(e?.message || e) }; finish(); });
  });
}
export const wsUpgradeNoHost = (origin) => [
  'GET /ws HTTP/1.1', 'Upgrade: websocket', 'Connection: Upgrade',
  `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}`, 'Sec-WebSocket-Version: 13',
  ...(origin ? [`Origin: ${origin}`] : []), '', '',
].join('\r\n');

// ───────────────────────── 断言助手(全部 soft:一个用例里多个输入都能报出来)─────────────────────────
export const acaNames = (r) => Object.keys(r.headers || {}).filter((k) => k.toLowerCase().startsWith('access-control-allow-'));
export const varyHasOrigin = (r) => String(r.headers?.vary ?? '').split(',').map((s) => s.trim().toLowerCase()).includes('origin');
export const describeHttp = (r) => (r.status == null ? `无应答(${r.error})` : `${r.status} ${String(r.text).slice(0, 100)}`);
export const describeWs = (w) => (w.kind === 'open' ? '放行(101)' : w.kind === 'rejected' ? `拒绝(${w.status})` : `连接错误(${w.error})`);

/** HTTP 被来源校验拒绝的完整形态(接口文件 4.1)。 */
export function expectHttpBlocked(r, label) {
  expect.soft(r.status, `${label}:期望被来源校验拒绝 403,实际 ${describeHttp(r)}`).toBe(403);
  expect.soft(String(r.headers?.['content-type'] ?? ''), `${label}:Content-Type 应为 application/json`).toMatch(/^application\/json/i);
  expect.soft((r.text ?? '').trim(), `${label}:正文应为固定的来源拒绝文案`).toBe(BLOCK_BODY);
  expect.soft(acaNames(r), `${label}:拒绝应答不得带任何 Access-Control-Allow-* 头`).toEqual([]);
}
/** HTTP 放行:状态 + ACAO 等于请求的 Origin 原值 + Vary 含 Origin。status 默认 200。 */
export function expectHttpAllowed(r, label, { origin, status = 200, vary = true } = {}) {
  expect.soft(r.status, `${label}:期望放行 ${status},实际 ${describeHttp(r)}`).toBe(status);
  if (origin !== undefined) {
    expect.soft(r.headers?.['access-control-allow-origin'], `${label}:Access-Control-Allow-Origin 应等于请求的 Origin 原值`).toBe(origin);
    if (vary) expect.soft(varyHasOrigin(r), `${label}:Vary 头应含 Origin,实际 ${JSON.stringify(r.headers?.vary)}`).toBe(true);
  }
}
export const expectWsOpen = (w, label) => expect.soft(describeWs(w), `${label}:WS 握手期望放行`).toBe('放行(101)');
export const expectWsBlocked = (w, label) => expect.soft(describeWs(w), `${label}:WS 握手期望被拒绝 401`).toBe('拒绝(401)');
