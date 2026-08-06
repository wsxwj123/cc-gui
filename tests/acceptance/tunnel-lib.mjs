// 隧道鉴权验收测试的共享小工具。
// 依据:.devflow/INTERFACE-tunnel.md(唯一事实来源)。只打 HTTP/WS,不看实现。
// 只依赖 node 内置模块 + 项目已有依赖 ws。
//
// 注意:Node 自带 fetch(undici)会静默忽略自定义 Host 头(实测),
// 凡是需要伪造 Host 的请求一律走这里的 node:http 封装。

import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

export const TUNNEL = process.env.TUNNEL_HOSTNAME || 'tunnel.example.com';
export const PORT = Number(process.env.CGUI_TEST_PORT || '');
export const PASSWORD = process.env.CGUI_TEST_PASSWORD || null;

if (!PORT || PORT === 6677) {
  console.error('需要环境变量 CGUI_TEST_PORT,且绝不能是 6677(生产实例)。请用 run-tunnel.sh 入口。');
  process.exit(2);
}

// 本机 LAN IPv4(取 en* 网卡,跳过 utun 等虚拟网卡)
export const LAN_IP = (() => {
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (!/^en\d/.test(name)) continue;
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
})();

// ── 请求来源构造法(对应 INTERFACE §1 的代号表)─────────────────
// target=127.0.0.1 的形态,socket 都是回环;lan 形态 target=LAN_IP,socket 非回环。
export const forms = {
  local: () => ({ target: '127.0.0.1', headers: {} }),
  tunnelAnon: (cfip = '203.0.113.9') => ({
    target: '127.0.0.1',
    headers: { Host: TUNNEL, 'CF-Ray': 'test-ray-abc', 'CF-Connecting-IP': cfip },
  }),
  forgedEvil: () => ({ target: '127.0.0.1', headers: { Host: 'evil.com' } }),
  forgedLocalhost: () => ({
    target: '127.0.0.1',
    headers: { Host: 'localhost', 'CF-Ray': 'test-ray-abc', 'CF-Connecting-IP': '203.0.113.9' },
  }),
  noCfTunnel: () => ({ target: '127.0.0.1', headers: { Host: TUNNEL } }),
  lan: () => ({ target: LAN_IP, headers: {} }),
};
export const withCookie = (formFn, cookie) => {
  const f = formFn();
  f.headers.Cookie = cookie;
  return f;
};
// 伪造签名/垃圾 token,代表 INTERFACE 的 EXPIRED-TOKEN 形态(过期与伪造同路径:视为无 cookie)
export const FORGED_TOKEN_COOKIE = 'cgui_token=forged.invalid.signature';

// ── HTTP 请求(支持自定义 Host 等任意头)─────────────────────────
export function request(form, { method = 'GET', path = '/', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: form.target,
        port: PORT,
        path,
        method,
        headers: {
          Connection: 'close',
          ...form.headers,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        timeout: 4000,
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(buf); } catch { /* 非 JSON */ }
          resolve({ status: res.statusCode, headers: res.headers, text: buf, json });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('请求超时(4s)')));
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// POST /api/login,顺手解析 Set-Cookie 里的 cgui_token
export async function login(form, password) {
  const r = await request(form, { method: 'POST', path: '/api/login', body: { password } });
  const lines = r.headers['set-cookie'] || [];
  const line = lines.find((c) => c.startsWith('cgui_token=')) || '';
  const token = (line.match(/cgui_token=([^;]*)/) || [])[1] || null;
  return { ...r, setCookie: line, token };
}

// ── WebSocket 握手:返回 { upgraded:boolean, error? } ───────────
export function wsAttempt(form, path = '/ws') {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      try { ws.terminate(); } catch { /* 忽略 */ }
      resolve(v);
    };
    const ws = new WebSocket(`ws://${form.target}:${PORT}${path}`, {
      headers: form.headers,
      handshakeTimeout: 4000,
    });
    ws.once('open', () => done({ upgraded: true }));
    ws.once('error', (e) => done({ upgraded: false, error: String(e && e.message ? e.message : e) }));
    ws.once('unexpected-response', (_req, res) =>
      done({ upgraded: false, error: `unexpected-response ${res.statusCode}` }),
    );
  });
}

// ── HTTP/1.0 整体缺 Host(INTERFACE §2 末表),raw socket 发 ──────
export function http10NoHostAuthStatus(target) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PORT, target, () => {
      sock.write('GET /api/auth-status HTTP/1.0\r\nConnection: close\r\n\r\n');
    });
    let buf = '';
    sock.setTimeout(4000, () => sock.destroy(new Error('HTTP/1.0 请求超时')));
    sock.on('data', (c) => (buf += c));
    sock.on('error', reject);
    sock.on('end', () => {
      const m = buf.match(/^HTTP\/\d\.\d (\d+)/);
      const bodyStart = buf.indexOf('\r\n\r\n');
      let json = null;
      try { json = JSON.parse(buf.slice(bodyStart + 4)); } catch { /* 非 JSON */ }
      resolve({ status: m ? Number(m[1]) : null, json, text: buf });
    });
  });
}

// ── 断言助手 ─────────────────────────────────────────────────
export function assertAuthStatus(json, exp, ctx = '') {
  assert.ok(json, `${ctx} 响应应是 JSON`);
  assert.equal(json.required, exp.required, `${ctx} required`);
  assert.equal(json.authed, exp.authed, `${ctx} authed`);
  assert.equal(json.isLocal, exp.isLocal, `${ctx} isLocal`);
}

export function assertUnauthorized(r, ctx = '') {
  assert.equal(r.status, 401, `${ctx} 状态码`);
  assert.equal(r.json?.error, 'unauthorized', `${ctx} error 字段`);
  assert.equal(r.json?.authRequired, true, `${ctx} authRequired 字段`);
}

export function assertHostBlocked(r, ctx = '') {
  assert.equal(r.status, 403, `${ctx} 状态码`);
  assert.equal(r.json?.error, 'Host not allowed (DNS-rebinding protection)', `${ctx} error 字段`);
}

export function assertLoginOk(r, ctx = '') {
  assert.equal(r.status, 200, `${ctx} 状态码`);
  assert.equal(r.json?.ok, true, `${ctx} ok 字段`);
  assert.ok(r.setCookie, `${ctx} 应发 Set-Cookie: cgui_token`);
  assert.match(r.setCookie, /cgui_token=[^;]+/, `${ctx} cookie 名`);
  assert.match(r.setCookie, /HttpOnly/i, `${ctx} HttpOnly`);
  assert.match(r.setCookie, /Path=\//i, `${ctx} Path=/`);
  assert.match(r.setCookie, /SameSite=Lax/i, `${ctx} SameSite=Lax`);
  assert.match(r.setCookie, /Max-Age=2592000/i, `${ctx} Max-Age=2592000(30 天)`);
}

export function assertLoginRejected(r, ctx = '') {
  assert.equal(r.status, 401, `${ctx} 状态码`);
  assert.equal(r.json?.error, '密码错误', `${ctx} error 字段`);
  assert.ok(!r.setCookie, `${ctx} 错误密码绝不应发 Set-Cookie`);
}

export function assertTooMany(r, ctx = '') {
  assert.equal(r.status, 429, `${ctx} 状态码`);
  assert.match(String(r.json?.error ?? ''), /尝试过多/, `${ctx} error 文案`);
  assert.match(String(r.json?.error ?? ''), /\d+/, `${ctx} 应含剩余秒数 N`);
}

// ── 计数与退出码(与 tests/acceptance 现有风格一致)──────────────
let passed = 0;
let failed = 0;
let skipped = 0;

export async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  }
}

export function skip(name, reason) {
  skipped++;
  console.log(`  SKIP  ${name}\n        ${reason}`);
}

export function summary(suite) {
  console.log(`\n[${suite}] ${passed} pass / ${failed} fail / ${skipped} skip`);
  process.exit(failed ? 1 : 0);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
