#!/usr/bin/env node
// r26-J15 单测:assertPublicBaseURL 公网强制 https + 回环豁免 + 既有 SSRF 闸不回归。
// 全用 IP 字面量,dns.lookup 对字面量本地返回,不打真实 DNS、不连任何第三方。
// 哨兵:①http 公网 → 拒;②https 公网 → 过;③http 回环(127.x/::1/localhost)→ 过;
// ④http 私网字面量 → 拒;⑤https 私网/链路本地 → 拒(既有闸不回归);
// ⑥198.18.0.0/15(Clash TUN fake-IP)https 仍放行(既有豁免不回归);
// ⑦allowLoopback:false 时 http 回环也拒;⑧非 http(s) 协议拒。
// Run: node tests/unit/check-assert-public-baseurl-https.mjs
import assert from 'node:assert/strict';

const { assertPublicBaseURL } = await import('../../server/routes/settings.js');

let n = 0;
const ok = (v, m) => { assert.ok(v, m); n += 1; };
const passes = async (u, opts, m) => {
  try { await assertPublicBaseURL(u, opts); ok(true, m); }
  catch (e) { ok(false, `${m} —— 应放行却被拒:${e.message}`); }
};
const rejects = async (u, opts, m) => {
  try { await assertPublicBaseURL(u, opts); ok(false, `${m} —— 应拒绝却放行`); }
  catch (e) { ok(e.status === 400, `${m}(拒绝 status=${e.status})`); }
};

// ③ http 回环豁免
await passes('http://127.0.0.1:8080/v1', undefined, 'http://127.0.0.1 回环豁免');
await passes('http://[::1]:9000', undefined, 'http://[::1] 回环豁免');
await passes('http://localhost:3000', undefined, 'http://localhost 回环豁免');

// ① http 公网 → 拒(明文密钥防外泄)
await rejects('http://8.8.8.8/v1', undefined, 'http 公网 IP 必须拒');
// ④ http 私网字面量 → 拒(不是回环,http 一律不够格)
await rejects('http://10.0.0.1/v1', undefined, 'http 私网必须拒');
await rejects('http://192.168.1.1/v1', undefined, 'http LAN 地址必须拒');

// ② https 公网 → 过
await passes('https://8.8.8.8/v1', undefined, 'https 公网 IP 放行');
await passes('https://127.0.0.1:8443', undefined, 'https 回环放行');

// ⑤ 既有 SSRF 闸不回归(https 私网/链路本地仍拒)
await rejects('https://169.254.169.254/latest', undefined, 'https 云元数据(链路本地)仍拒');
await rejects('https://10.0.0.1/v1', undefined, 'https 私网仍拒');

// ⑥ Clash TUN fake-IP 段(198.18.0.0/15)https 豁免不回归
await passes('https://198.18.0.1/v1', undefined, '198.18/15 fake-IP 段 https 仍放行');

// ⑦ allowLoopback:false(第三方回传值场景)回环也拒
await rejects('http://127.0.0.1:8080', { allowLoopback: false }, 'allowLoopback:false 时 http 回环也拒');
await rejects('https://127.0.0.1:8443', { allowLoopback: false }, 'allowLoopback:false 时 https 回环也拒');

// ⑧ 非 http(s) 协议拒
await rejects('ftp://127.0.0.1/x', undefined, 'ftp 协议拒');
await rejects('not-a-url', undefined, '非法 URL 拒');

console.log(`PASS check-assert-public-baseurl-https (${n} assertions)`);
