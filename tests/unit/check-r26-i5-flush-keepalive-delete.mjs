#!/usr/bin/env node
// r26-I5 单测:beforeunload 删除链(源码钉,与 acceptance r26/i5 同锚,双保险)。
// 前置核实结论(交付报告同款):服务端 DELETE /api/sessions/:sessionId 在 unlink 前
// await closePersistentForSession(sessionId)(sessions.js,chat.js:983 closing+abort
// 强杀该会话全部在跑进程,5s 超时兜底)→ 兜底成立,走 PLAN 分支一:卸载路径跳过
// stopSessionProcs,直接发 keepalive DELETE。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../client/src/components/UnifiedSidebar.jsx', import.meta.url), 'utf8');

const m = src.match(/const flushAllPending = \(\) => \{[\s\S]*?\n  \};/);
assert.ok(m, 'flushAllPending 应仍存在(重命名则换锚)');
const body = m[0];

// t1 keepalive DELETE 必须保留(防把兜底删没)
assert.match(body, /keepalive:\s*true/, 't1: flushAllPending 里必须保留 keepalive DELETE');
assert.match(body, /method: 'DELETE'/, 't1: 卸载路径发 DELETE');

// t2 bug 形态钉:DELETE 不许再排在无 keepalive 的 stopSessionProcs 之后
assert.ok(!/stopSessionProcs/.test(body), 't2: 卸载路径不许再过 stopSessionProcs(页面一卸载链就断)');

// t3 正常删除路径(非卸载)的进程清理不许被顺手删掉
const normal = src.match(/const reallyDelete = [\s\S]*?\n  \};/);
assert.ok(normal, 'reallyDelete 应仍存在');
assert.match(normal[0], /await stopSessionProcs\(session\.sessionId\)/, 't3: 正常路径仍先停进程再删');
assert.ok(!/keepalive/.test(normal[0]), 't3: 正常路径不需要 keepalive(页面活着)');

// t4 服务端兜底语义钉(分支一成立的前提,防服务端改动悄悄抽掉兜底)
const sessions = readFileSync(new URL('../../server/routes/sessions.js', import.meta.url), 'utf8');
const delRoute = sessions.match(/router\.delete\('\/sessions\/:sessionId'[\s\S]*?\n\}\);/);
assert.ok(delRoute, 't4: DELETE 会话路由应存在');
assert.match(delRoute[0], /await closePersistentForSession\(req\.params\.sessionId\)/, 't4: 服务端删除前必须停该会话进程(分支一前提)');
const unlinkIdx = delRoute[0].indexOf('await unlink(file)');
const closeIdx = delRoute[0].indexOf('await closePersistentForSession');
assert.ok(closeIdx > -1 && unlinkIdx > -1 && closeIdx < unlinkIdx, 't4: 停进程必须先于 unlink(防残余进程复活已删 jsonl)');

console.log('check-r26-i5-flush-keepalive-delete: all passed');
