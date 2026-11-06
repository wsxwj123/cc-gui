#!/usr/bin/env node
// 白盒:checkNoOriginFetchSite(K3:无 Origin 且浏览器自报 same-site/cross-site 就拒)判定表。
// 依据:.devflow/r156-raw-content-k3.md §5.2。
// node tests/unit/check-r156-no-origin-fetch-site.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 隔离 HOME:auth.js 在模块加载期用 homedir() 定住 network.json 路径,必须在 import 前改。
const home = mkdtempSync(join(tmpdir(), 'cgui-r156-k3-'));
mkdirSync(join(home, '.claude-gui'), { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;

const { checkNoOriginFetchSite, checkBrowserOrigin } = await import('../../server/services/auth.js');

const req = (headers = {}) => ({ socket: { remoteAddress: '127.0.0.1' }, headers });
const VETO = { ok: false, rule: 'no-origin-sfs-veto' };
let n = 0;
function expectOk(r, msg) {
  const got = checkNoOriginFetchSite(r);
  assert.equal(got.ok, true, `${msg}: ${JSON.stringify(r.headers)} → ${JSON.stringify(got)}`);
  assert.equal(typeof got.rule, 'string', `${msg}: rule 是字符串`);
  n++;
}
function expectVeto(r, msg) {
  assert.deepEqual(checkNoOriginFetchSite(r), VETO, `${msg}: ${JSON.stringify(r.headers)}`);
  n++;
}

// ── 有非空 Origin → 不归它管(哪怕 sfs 是 cross-site:交给 checkBrowserOrigin 的 sfs-veto)──
expectOk(req({ origin: 'http://127.0.0.1:6700', 'sec-fetch-site': 'cross-site' }), '有 Origin + cross-site');
expectOk(req({ origin: 'https://evil.example', 'sec-fetch-site': 'same-site' }), '有 Origin + same-site');
expectOk(req({ origin: 'null', 'sec-fetch-site': 'cross-site' }), 'Origin 字面值 null 也算有 Origin');
expectOk(req({ origin: 'http://127.0.0.1:6700' }), '有 Origin 无 sfs');

// ── 无 Origin(缺失或空串)+ 放行的 sfs ──
for (const origin of [undefined, '']) {
  const o = origin === undefined ? {} : { origin };
  const tag = origin === undefined ? '缺 Origin' : '空串 Origin';
  expectOk(req({ ...o }), `${tag} + 缺 sfs`);
  expectOk(req({ ...o, 'sec-fetch-site': 'none' }), `${tag} + none`);
  expectOk(req({ ...o, 'sec-fetch-site': 'same-origin' }), `${tag} + same-origin`);
  expectOk(req({ ...o, 'sec-fetch-site': 'SAME-ORIGIN' }), `${tag} + SAME-ORIGIN`);
  expectOk(req({ ...o, 'sec-fetch-site': 'bogus' }), `${tag} + 未知值`);
  expectOk(req({ ...o, 'sec-fetch-site': '' }), `${tag} + 空串 sfs`);
  expectOk(req({ ...o, 'sec-fetch-site': ' , ,' }), `${tag} + 只有逗号空白`);
  expectOk(req({ ...o, 'sec-fetch-site': 'same-sitex' }), `${tag} + 近似值 same-sitex`);
  expectOk(req({ ...o, 'sec-fetch-site': 'cross site' }), `${tag} + 近似值 cross site`);
  expectOk(req({ ...o, 'sec-fetch-site': 'none, same-origin' }), `${tag} + 多值均放行`);

  // ── 无 Origin + 自报跨站 → 拒 ──
  expectVeto(req({ ...o, 'sec-fetch-site': 'same-site' }), `${tag} + same-site`);
  expectVeto(req({ ...o, 'sec-fetch-site': 'cross-site' }), `${tag} + cross-site`);
  expectVeto(req({ ...o, 'sec-fetch-site': 'Cross-Site' }), `${tag} + 大小写 Cross-Site`);
  expectVeto(req({ ...o, 'sec-fetch-site': 'SAME-SITE' }), `${tag} + 大写 SAME-SITE`);
  expectVeto(req({ ...o, 'sec-fetch-site': ' cross-site ' }), `${tag} + 首尾空白`);
  expectVeto(req({ ...o, 'sec-fetch-site': 'same-origin, cross-site' }), `${tag} + 逗号多值(后一项跨站)`);
  expectVeto(req({ ...o, 'sec-fetch-site': 'none,same-site' }), `${tag} + 逗号多值无空格`);
  // Node 对同名重复头合并成逗号串;数组形态也按同一口径处理
  expectVeto(req({ ...o, 'sec-fetch-site': 'same-origin, same-site' }), `${tag} + 重复头合并值`);
  expectVeto(req({ ...o, 'sec-fetch-site': ['same-origin', 'same-site'] }), `${tag} + 数组形态`);
  expectVeto(req({ ...o, 'sec-fetch-site': 'bogus, cross-site' }), `${tag} + 未知值+跨站`);
}

// ── 异常输入不抛:缺 headers / 缺 req → 放行(无 Origin、无 sfs)──
for (const r of [undefined, null, {}, { headers: null }, { headers: {} }]) {
  const got = checkNoOriginFetchSite(r);
  assert.equal(got.ok, true, `异常输入 ${JSON.stringify(r)}`);
  n++;
}

// ── 与 checkBrowserOrigin 口径一致:无 Origin 时它恒放行(no-origin),K3 只补这一块 ──
const ctx = { isAllowedHostname: () => true, getLanHostnames: () => [] };
for (const sfs of ['same-site', 'cross-site', 'none', undefined]) {
  const headers = sfs ? { 'sec-fetch-site': sfs } : {};
  assert.deepEqual(checkBrowserOrigin(undefined, req(headers), ctx), { ok: true, rule: 'no-origin' }, `既有规则不变 ${sfs}`);
  assert.deepEqual(checkBrowserOrigin('', req(headers), ctx), { ok: true, rule: 'no-origin' }, `既有规则不变(空串)${sfs}`);
  n += 2;
}

console.log(`check-r156-no-origin-fetch-site: ${n} assertions passed`);
