// r156 网络客户端与断言助手:node:http、原始 socket(精确控制请求头/路径写法)、ws 握手探针、统一的断言助手。
// 铁规:探针永不抛错 —— 连接失败也作为结果返回,由断言以"期望值 vs 实际值"报告;WS 只记结果,不保留帧内容。
import http from 'node:http';
import net from 'node:net';
import { expect } from '@playwright/test';
import WebSocket from 'ws';

export const BLOCK_BODY = '{"error":"Cross-origin request blocked by cc-gui"}';

function pack(status, headers, body) {
  const text = body.toString('utf8');
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 也是有效观测 */ }
  return { status, headers, body, text, json, error: undefined };
}
const noReply = (error) => ({ ...pack(null, {}, Buffer.alloc(0)), error });

// ───────────────────────── HTTP ─────────────────────────
/** node:http 请求;Host 不传时 Node 自动补 127.0.0.1:端口。body 是 Buffer(逐字节原样)。 */
export function httpRequest({ port, method = 'GET', pathname, headers = {}, timeoutMs = 15_000 }) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, agent: false, headers: { Connection: 'close', ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(pack(res.statusCode, res.headers, Buffer.concat(chunks))));
      res.on('error', (e) => resolve(noReply(String(e?.message || e))));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`请求超时 ${timeoutMs}ms`)));
    req.on('error', (e) => resolve(noReply(String(e?.message || e))));
    req.end();
  });
}

function dechunk(buf) {
  const out = [];
  let i = 0;
  for (;;) {
    const j = buf.indexOf('\r\n', i);
    if (j < 0) break;
    const n = parseInt(buf.subarray(i, j).toString('latin1'), 16);
    if (!n) break;
    out.push(buf.subarray(j + 2, j + 2 + n));
    i = j + 2 + n + 2;
  }
  return Buffer.concat(out);
}
/** 原始 socket:lines 不含结尾空行(函数补 \r\n\r\n)。同名头出现多次时,返回的 headers 用 ", " 合并。 */
export function rawRequest(port, lines, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    let settled = false;
    let error;
    let timer = null;
    const sock = net.connect(port, '127.0.0.1');
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch { /* 已关 */ }
      const buf = Buffer.concat(chunks);
      const sep = buf.indexOf('\r\n\r\n');
      const head = (sep >= 0 ? buf.subarray(0, sep) : buf).toString('latin1');
      let body = sep >= 0 ? buf.subarray(sep + 4) : Buffer.alloc(0);
      const headers = {};
      for (const l of head.split('\r\n').slice(1)) {
        const i = l.indexOf(':');
        if (i <= 0) continue;
        const k = l.slice(0, i).trim().toLowerCase();
        const v = l.slice(i + 1).trim();
        headers[k] = k in headers ? `${headers[k]}, ${v}` : v;
      }
      if (/chunked/i.test(headers['transfer-encoding'] || '')) body = dechunk(body);
      const m = head.match(/^HTTP\/\d\.\d (\d{3})/);
      resolve({ ...pack(m ? Number(m[1]) : null, headers, body), head, error });
    };
    timer = setTimeout(() => { error = `原始请求超时 ${timeoutMs}ms`; finish(); }, timeoutMs);
    sock.on('connect', () => sock.write(`${lines.join('\r\n')}\r\n\r\n`));
    sock.on('data', (c) => chunks.push(c));
    sock.on('end', finish);
    sock.on('close', finish);
    sock.on('error', (e) => { error = String(e?.message || e); finish(); });
  });
}
/** 原始 GET:Host 固定 127.0.0.1:端口;extra 是额外的整行头(可重复同名)。 */
export const rawGet = (port, pathname, extra = [], opts) => rawRequest(port, [`GET ${pathname} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Connection: close', ...extra], opts);

// ───────────────────────── WebSocket 握手探针 ─────────────────────────
/** 结果只分 open / rejected(带状态码)/ error / timeout;不保留任何帧内容。 */
export function wsProbe(port, headers, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const out = { kind: undefined, status: undefined, error: undefined, ms: 0 };
    let done = false;
    let timer = null;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers, handshakeTimeout: timeoutMs + 5000, perMessageDeflate: false });
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      out.ms = Date.now() - t0;
      try { ws.terminate(); } catch { /* 已关 */ }
      resolve(out);
    };
    timer = setTimeout(() => { out.kind = out.kind || 'timeout'; finish(); }, timeoutMs);
    ws.on('open', () => { out.kind = 'open'; finish(); });
    ws.on('unexpected-response', (_req, res) => { out.kind = 'rejected'; out.status = res.statusCode; res.resume(); finish(); });
    ws.on('error', (e) => { if (!out.kind) { out.kind = 'error'; out.error = String(e?.message || e); } finish(); });
  });
}

// ───────────────────────── 断言助手(全部 soft:一个用例里多个输入都能一次报出来)─────────────────────────
export const acaNames = (r) => Object.keys(r.headers || {}).filter((k) => k.toLowerCase().startsWith('access-control-allow-'));
export const mediaType = (r) => String(r.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase();
export const cspItems = (v) => String(v ?? '').split(';').map((s) => s.trim()).filter(Boolean);
/** redact=true:失败信息里不带正文(例如 /api/network 的应答)。 */
export const describeHttp = (r, redact = false) => (r.status == null ? `无应答(${r.error})` : `${r.status}${redact ? '' : ` ${JSON.stringify(String(r.text).slice(0, 80))}`}`);

/** 被来源校验或 K3 拒绝的完整形态(接口文件 0.7):403、JSON、固定正文(恰好)、无 ACA 头。 */
export function expectBlocked(r, label, { redact = false } = {}) {
  expect.soft(r.status, `${label}:期望被拒绝 403,实际 ${describeHttp(r, redact)}`).toBe(403);
  expect.soft(String(r.headers?.['content-type'] ?? ''), `${label}:Content-Type 应含 application/json`).toMatch(/application\/json/i);
  expect.soft(r.text === BLOCK_BODY, `${label}:正文应恰为固定拒绝文案,实际 ${redact ? '(不打印)' : JSON.stringify(String(r.text).slice(0, 80))}`).toBe(true);
  expect.soft(acaNames(r), `${label}:拒绝应答不得带任何 Access-Control-Allow-* 头`).toEqual([]);
}

export function expectSandboxCsp(r, label) {
  const raw = r.headers?.['content-security-policy'];
  expect.soft(raw !== undefined, `${label}:应带 Content-Security-Policy 头`).toBe(true);
  expect.soft(cspItems(raw).includes('sandbox'), `${label}:CSP 按分号拆开后应有一项恰为 sandbox,实际 ${JSON.stringify(raw)}`).toBe(true);
  expect.soft(String(raw ?? '').includes('allow-'), `${label}:CSP 整条值里不得出现 allow-,实际 ${JSON.stringify(raw)}`).toBe(false);
}
export function expectNoCsp(r, label) {
  expect.soft(r.headers?.['content-security-policy'], `${label}:不得带 Content-Security-Policy 头`).toBeUndefined();
  expect.soft(r.headers?.['content-security-policy-report-only'], `${label}:不得带 Content-Security-Policy-Report-Only 头`).toBeUndefined();
}

/** raw=1 成功应答:状态 200、类型、长度、nosniff、CSP(sandbox 或 none)、字节原样。 */
export function expectRawResponse(r, { label, type, bytes, csp }) {
  expect.soft(r.status, `${label}:状态码(${describeHttp(r)})`).toBe(200);
  expect.soft(mediaType(r), `${label}:Content-Type`).toBe(type);
  expect.soft(r.headers?.['content-length'], `${label}:Content-Length 应等于文件字节数`).toBe(String(bytes.length));
  expect.soft(r.headers?.['x-content-type-options'], `${label}:X-Content-Type-Options 应为 nosniff`).toBe('nosniff');
  if (csp === 'sandbox') expectSandboxCsp(r, label); else expectNoCsp(r, label);
  expect.soft(r.body.equals(bytes), `${label}:正文应与磁盘文件逐字节相同(实际 ${r.body.length} 字节,期望 ${bytes.length} 字节)`).toBe(true);
}
