#!/usr/bin/env node
// r26-H2 单测:network/password clear 的 LAN 守卫。
// server/index.js 是整服务器入口(import 即监听 6677),无法单测级启动 ——
// 按本仓惯例(check-protected-secret-files.mjs)落文本哨兵,钉住守卫的存在、
// 顺序与文案,改坏即红。
// 哨兵:①clear 分支在 clearPassword() 之前先判 lanMode/configHost;②拒绝是 409
// 且文案引导改回 127.0.0.1;③回环路径的 clear 保留(200 出口还在)。
// Run: node tests/unit/check-network-password-clear-guard.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(join(ROOT, 'server/index.js'), 'utf8');
let n = 0;
const ok = (v, m) => { assert.ok(v, m); n += 1; };

// 截取 /api/network/password 路由体(到下一个路由定义为界)
const start = src.indexOf("app.post('/api/network/password'");
ok(start > 0, '找到 /api/network/password 路由');
const rest = src.slice(start);
const endOff = rest.search(/app\.(post|get|put|delete)\('\/api\/(?!network\/password)/);
const body = endOff > 0 ? rest.slice(0, endOff) : rest;
ok(body.length > 100, '路由体截取非空');

// ① 守卫存在且在 clearPassword() 之前(顺序哨兵:先判后清,反了等于没守)
const guardAt = body.indexOf("configHost === '0.0.0.0'");
const clearAt = body.indexOf('clearPassword()');
ok(guardAt > 0, 'clear 分支必须判 configHost/lanMode');
ok(body.includes('lanMode'), '守卫须覆盖 live 绑定(lanMode)');
ok(clearAt > guardAt, 'clearPassword() 必须在守卫之后(先判后清)');

// ② 409 + 引导文案
const guardBlock = body.slice(guardAt, clearAt);
ok(guardBlock.includes('res.status(409)'), 'LAN 下清密码必须 409(不是静默放行也不是 400)');
ok(guardBlock.includes('127.0.0.1'), '拒绝文案必须引导先把监听地址改回 127.0.0.1');
ok(/局域网/.test(guardBlock), '拒绝文案须说明是局域网监听模式的原因');

// ③ 回环路径仍在:守卫之后正常 clearPassword + ok 出口
ok(body.includes('hasPassword: false'), '回环下清密码的 200 出口保留');

console.log(`PASS check-network-password-clear-guard (${n} assertions)`);
