// 白盒:checkBrowserOrigin(浏览器来源校验)判定顺序与边界。依据:.devflow/r155-origin-port-gate.md
// §12 修订版 R-3(判定顺序)/ R-7 A 项。
// node tests/unit/check-r155-origin-gate.mjs
//
// 已知局限 K2(不在此断言成"必须放行",避免给弱点上锁):跨协议 + 默认端口 + 浏览器不带
// Sec-Fetch-Site(如 Host `localhost` 与 Origin `https://localhost`,两边都补成 443)会按
// "站点一致"放行。只有后端或其前置代理监听 80/443 时才可能出现;带 cross-site 的同样输入由
// 第 3 条否决(下方有断言)。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 隔离 HOME:auth.js 在模块加载期用 homedir() 定住 network.json 路径,必须在 import 前改。
const home = mkdtempSync(join(tmpdir(), 'cgui-r155-origin-'));
mkdirSync(join(home, '.claude-gui'), { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;

const { checkBrowserOrigin } = await import('../../server/services/auth.js');

const LAN_IP = '192.168.1.20';
const TUNNEL = 't.example.com';
let lanCalls = 0;
// 与 index.js 的 isAllowedHostname 同口径的替身:回环名 / 局域网 IP(假定局域网模式)/ 隧道名。
const ctx = {
  isAllowedHostname: (h) => ['localhost', '127.0.0.1', '::1', LAN_IP, TUNNEL].includes(h),
  getLanHostnames: () => { lanCalls++; return [LAN_IP]; },
};
const req = (addr, headers = {}) => ({ socket: { remoteAddress: addr }, headers });
const check = (origin, r, c = ctx) => checkBrowserOrigin(origin, r, c);
let n = 0;
function expect(origin, r, ok, rule, msg) {
  const got = check(origin, r);
  assert.deepEqual(got, { ok, rule }, `${msg}: origin=${origin} → ${JSON.stringify(got)}`);
  n++;
}

// ── 0) 缺上下文参数 → TypeError(不默认放行)─────────────────────────
assert.throws(() => checkBrowserOrigin(undefined, req('127.0.0.1')), TypeError, '缺 ctx');
assert.throws(() => checkBrowserOrigin('http://localhost:1', req('127.0.0.1'), { isAllowedHostname: () => true }), TypeError, '缺 getLanHostnames');
assert.throws(() => checkBrowserOrigin('http://localhost:1', req('127.0.0.1'), { getLanHostnames: () => [] }), TypeError, '缺 isAllowedHostname');
assert.throws(() => checkBrowserOrigin('http://localhost:1', req('127.0.0.1'), { isAllowedHostname: true, getLanHostnames: () => [] }), TypeError, '非函数');
n += 4;

// ── 1) no-origin ────────────────────────────────────────────────────
expect(undefined, req('127.0.0.1', { host: 'localhost:6800' }), true, 'no-origin', '无 Origin');
expect('', req('8.8.8.8', {}), true, 'no-origin', '空串 Origin');
expect('http://localhost:6800', req('127.0.0.1', { host: 'localhost:6800' }), true, 'same-site', '反例:有 Origin 不走 no-origin');

// ── 2) bad-origin ───────────────────────────────────────────────────
const H = { host: '127.0.0.1:6800' };
for (const o of ['null', 'chrome-extension://abcdef', 'ftp://127.0.0.1:6800', 'http://127.0.0.1:6800/',
  'http://LOCALHOST:6800', 'HTTP://127.0.0.1:6800', 'not a url', 'http://x rule=same-site',
  'http://127.0.0.1:6800, http://evil.example', 'file:///etc/passwd']) {
  expect(o, req('127.0.0.1', H), false, 'bad-origin', '非标准 Origin');
}
assert.deepEqual(check(null, req('127.0.0.1', H)), { ok: false, rule: 'bad-origin' }, 'JS null 非字符串');
assert.deepEqual(check(42, req('127.0.0.1', H)), { ok: false, rule: 'bad-origin' }, '数字');
n += 2;
// bad-origin 先于 sfs-veto
expect('null', req('127.0.0.1', { ...H, 'sec-fetch-site': 'cross-site' }), false, 'bad-origin', 'null + cross-site');
expect('http://127.0.0.1:6800', req('127.0.0.1', H), true, 'same-site', '反例:标准写法');

// ── 3) sfs-veto(大小写不敏感、逗号拆分)───────────────────────────
for (const sfs of ['cross-site', 'same-site', 'Same-Site', 'CROSS-SITE', 'same-origin, same-site', ' none ,cross-site']) {
  expect('http://127.0.0.1:6800', req('127.0.0.1', { ...H, 'sec-fetch-site': sfs }), false, 'sfs-veto', `SFS=${sfs}`);
}
// sfs-veto 先于 no-host
expect('http://localhost:6800', req('127.0.0.1', { 'sec-fetch-site': 'same-site' }), false, 'sfs-veto', '无 Host + same-site');
// 跨协议同默认端口 + cross-site → 拒(K2 的带 SFS 情形)
expect('https://localhost', req('127.0.0.1', { host: 'localhost', 'sec-fetch-site': 'cross-site' }), false, 'sfs-veto', '跨协议');
// 反例:none / same-origin 不触发否决
expect('http://127.0.0.1:6800', req('127.0.0.1', { ...H, 'sec-fetch-site': 'none' }), true, 'same-site', 'SFS=none');
expect('http://127.0.0.1:6800', req('127.0.0.1', { ...H, 'sec-fetch-site': 'same-origin' }), true, 'same-site', 'SFS=same-origin');

// ── 4) no-host ──────────────────────────────────────────────────────
expect('http://localhost:6800', req('127.0.0.1', {}), false, 'no-host', '无 Host');
for (const host of ['', 'evil.com@127.0.0.1:6800', 'localhost:', 'localhost:6800/x', 'local host', '[::1', 'a:b:c', 'localhost:123456', 'localhost:99999']) {
  expect('http://localhost:6800', req('127.0.0.1', { host }), false, 'no-host', `Host=${JSON.stringify(host)}`);
}
expect('http://localhost:6800', req('127.0.0.1', { host: 'localhost:6800' }), true, 'same-site', '反例:合法 Host');

// ── 5) same-site / hostname-not-allowed ────────────────────────────
expect('http://localhost:6800', req('127.0.0.1', { host: 'localhost:6800' }), true, 'same-site', 'localhost');
expect('http://[::1]:6800', req('::1', { host: '[::1]:6800' }), true, 'same-site', 'IPv6 方括号');
expect('http://localhost', req('127.0.0.1', { host: 'localhost:80' }), true, 'same-site', 'http 补 80(Host 显式 80)');
expect('http://localhost', req('127.0.0.1', { host: 'localhost' }), true, 'same-site', 'http 两边都缺省');
expect('https://t.example.com', req('127.0.0.1', { host: TUNNEL, 'cf-ray': 'r', 'sec-fetch-site': 'same-origin' }), true, 'same-site', '隧道:https 补 443,带 CF 头');
expect('https://t.example.com', req('127.0.0.1', { host: 't.example.com:443' }), true, 'same-site', 'Host 显式写 443');
expect('http://t.example.com', req('127.0.0.1', { host: 'T.Example.COM' }), true, 'same-site', 'Host 大写归一');
expect('http://localhost:6800', req('127.0.0.1', { host: 'localhost:06800' }), true, 'same-site', 'Host 端口前导零归一');
expect(`http://${LAN_IP}:6800`, req(LAN_IP, { host: `${LAN_IP}:6800` }), true, 'same-site', '局域网地址直连');
expect('http://xn--bcher-kva.example:6800', req('127.0.0.1', { host: 'xn--bcher-kva.example:6800' }), false, 'hostname-not-allowed', 'punycode 站点一致但不在白名单');
expect('http://bücher.example:6800', req('127.0.0.1', { host: 'xn--bcher-kva.example:6800' }), false, 'bad-origin', 'Unicode Origin 序列化后不等于原文');
expect('http://localhost.:6800', req('127.0.0.1', { host: 'localhost.:6800' }), false, 'hostname-not-allowed', '尾点 localhost.');
expect('http://evil.com:6800', req('127.0.0.1', { host: 'evil.com:6800' }), false, 'hostname-not-allowed', 'DNS 重绑定形态(函数自包含)');
// 端口不一致 → 不走第 5 条
expect('http://localhost:6800', req('127.0.0.1', { host: 'localhost' }), false, 'site-mismatch', 'Host 无端口(80) vs Origin 6800');
expect('https://localhost', req('127.0.0.1', { host: 'localhost:80' }), false, 'site-mismatch', 'https 443 vs Host 80');
expect('https://t.example.com:8443', req('127.0.0.1', { host: TUNNEL, 'cf-ray': 'r' }), false, 'site-mismatch', '隧道端口不同');

// 惰性:第 5 条命中时 getLanHostnames 不被调用
lanCalls = 0;
check('http://127.0.0.1:6800', req('127.0.0.1', { host: '127.0.0.1:6800', 'sec-fetch-site': 'same-origin' }));
check(`http://${LAN_IP}:6800`, req(LAN_IP, { host: `${LAN_IP}:6800` }));
assert.equal(lanCalls, 0, '第 5 条命中时不得调用 getLanHostnames');
n++;

// ── 6) proxied-same-origin(开发代理:Host 被改写成后端,Origin 是 Vite)──
const dev = (addr, extra = {}) => req(addr, { host: 'localhost:6800', 'sec-fetch-site': 'same-origin', ...extra });
expect('http://127.0.0.1:6900', dev('127.0.0.1'), true, 'proxied-same-origin', '回环 v4');
expect('http://127.0.0.1:6900', dev('::ffff:127.0.0.1'), true, 'proxied-same-origin', 'v4-mapped');
expect('http://localhost:6900', dev('::1'), true, 'proxied-same-origin', '回环 v6');
expect('http://[::1]:6900', dev('127.0.0.1'), true, 'proxied-same-origin', 'Origin [::1]');
// 本机名不调 getLanHostnames;非本机名才调
lanCalls = 0;
check('http://127.0.0.1:6900', dev('127.0.0.1'));
assert.equal(lanCalls, 0, '来源是本机名时不调 getLanHostnames');
expect(`http://${LAN_IP}:6900`, dev('127.0.0.1'), true, 'proxied-same-origin', '来源为本机局域网 IP');
assert.ok(lanCalls >= 1, '来源非本机名时应查局域网名单');
n++;
// 反例
expect('http://127.0.0.1:6900', dev('127.0.0.1', { 'sec-fetch-site': 'SAME-ORIGIN' }), false, 'site-mismatch', 'SFS 大写不算');
expect('http://127.0.0.1:6900', dev('127.0.0.1', { 'sec-fetch-site': undefined }), false, 'site-mismatch', '不带 SFS');
expect('http://127.0.0.1:6900', dev('127.0.0.1', { 'sec-fetch-site': 'none' }), false, 'site-mismatch', 'SFS=none');
expect('http://127.0.0.1:6900', dev('127.0.0.1', { 'cf-ray': 'x' }), false, 'site-mismatch', '带 CF 头(isLocalReq 假)');
expect('http://127.0.0.1:6900', dev(LAN_IP), false, 'site-mismatch', '连接来自局域网地址');
expect('http://127.0.0.1:6900', req('127.0.0.1', { host: `${LAN_IP}:6800`, 'sec-fetch-site': 'same-origin' }), false, 'site-mismatch', 'Host 非本机名');
expect('https://t.example.com', dev('127.0.0.1'), false, 'site-mismatch', '隧道名不在第 6 条名单(X6/O13)');
expect('http://evil.example', dev('127.0.0.1'), false, 'site-mismatch', '陌生来源');
expect('http://localhost.:6900', dev('127.0.0.1'), false, 'site-mismatch', '尾点不在本机名单');

// ── 7) site-mismatch:本机别的端口(老浏览器不带 SFS)、别名跨站 ──────
expect('http://localhost:6803', req('127.0.0.1', { host: 'localhost:6800' }), false, 'site-mismatch', 'X1 不带 SFS');
expect('http://localhost:6803', req('127.0.0.1', { host: 'localhost:6800', 'sec-fetch-site': 'same-site' }), false, 'sfs-veto', 'X1 带 same-site');
expect('http://127.0.0.1:6803', req('127.0.0.1', { host: 'localhost:6800' }), false, 'site-mismatch', 'X2 不带 SFS');
expect('http://127.0.0.1:6800', req('127.0.0.1', { host: 'localhost:6800' }), false, 'site-mismatch', '别名同端口不同主机名');

console.log(`check-r155-origin-gate: ${n} assertions passed`);
