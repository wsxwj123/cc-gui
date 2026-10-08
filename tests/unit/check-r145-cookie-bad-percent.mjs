#!/usr/bin/env node
// r145 F5:设了口令时,非本机来源的请求只要带一个含裸 % 的 cookie(如别的站点写的 `x=100%`),
// parseCookies 里的 decodeURIComponent 抛 URIError —— 该设备所有 /api/* 回 500,WS 握手
// (server/index.js 的 verifyClient 调同一个 parseCookies)抛未捕获异常。修好后:解码失败的那一个
// cookie 按"没有"处理或保留原文,其余 cookie 照常解析,绝不抛。
// 真 import services/auth.js(临时 HOME,口令写在临时 ~/.claude-gui/network.json),用伪造的外部来源请求
// 走 parseCookies / isAuthorized / authMiddleware 三层;WS 握手调用点做接线断言(它就是同一个函数)。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolateHome, makeChecker } from './r145-helpers/common.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { cleanup } = isolateHome('f5');
const auth = await import('../../server/services/auth.js');
auth.setPassword('pw-r145-test');
const token = auth.issueToken();
// 局域网手机:非回环 socket + 局域网 Host —— isLocalReq 判外部,必须走 cookie token。
const ext = (cookie) => ({ path: '/sessions', headers: { cookie, host: '192.168.1.23:6677' }, socket: { remoteAddress: '192.168.1.23' } });
const fakeRes = () => ({ code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });

const { check, finish } = makeChecker('check-r145-cookie-bad-percent');
let exitCode = 1;
try {
  console.log('F5 · 含裸 % 的 cookie 不让解析抛错');
  await check('parseCookies:坏的那个按没有 / 原文处理,其余照常(含正常的 %20 解码)', () => {
    let c;
    assert.doesNotThrow(() => { c = auth.parseCookies(ext(`x=100%; cgui_token=${token}; y=a%20b; z=%E4%B8%AD`)); });
    assert.equal(c.cgui_token, token);
    assert.equal(c.y, 'a b');
    assert.equal(c.z, '中');
    assert.ok(!Object.prototype.hasOwnProperty.call(c, 'x') || c.x === '100%', `坏 cookie 只能是"没有"或原文,实际 ${JSON.stringify(c.x)}`);
  });
  await check('isAuthorized:外部来源 + 有效 token + 一个坏 cookie → 放行,不抛', () => {
    let ok;
    assert.doesNotThrow(() => { ok = auth.isAuthorized(ext(`x=100%; cgui_token=${token}`)); });
    assert.equal(ok, true);
  });
  await check('authMiddleware:外部来源 + 只有坏 cookie → 401(不是 500 / 抛错)', () => {
    const res = fakeRes();
    let nexted = false;
    assert.doesNotThrow(() => auth.authMiddleware(ext('x=100%; theme=dark%'), res, () => { nexted = true; }));
    assert.equal(nexted, false);
    assert.equal(res.code, 401);
  });
  await check('接线:WS 握手(index.js verifyClient)用的就是 services/auth.js 的 parseCookies', () => {
    const src = readFileSync(join(root, 'server', 'index.js'), 'utf8');
    assert.match(src, /import\s*\{[^}]*\bparseCookies\b[^}]*\}\s*from\s*'\.\/services\/auth\.js'/, 'index.js 不再从 services/auth.js 引 parseCookies');
    assert.match(src, /verifyToken\(parseCookies\(info\.req\)\.cgui_token\)/, 'WS verifyClient 的 cookie 解析不是 parseCookies');
  });
  exitCode = finish();
} finally {
  cleanup();
}
process.exit(exitCode);
