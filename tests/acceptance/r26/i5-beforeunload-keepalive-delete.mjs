#!/usr/bin/env node
// r26-I5【复现(源码钉)】:beforeunload 的删除链发不出去。
// 场景:侧栏删除会话有 5 秒撤销窗;用户在撤销窗内直接关页 → beforeunload 的
// flushAllPending 要先 stopSessionProcs(普通 fetch,无 keepalive).then(才发 keepalive
// DELETE)。页面卸载瞬间没有 keepalive 的 stopSessionProcs 被浏览器掐死 → then 永远不
// 执行 → DELETE 根本没发出 → 会话没被删,下次启动又冒出来(用户以为删掉了)。
// 修复后期望:beforeunload 路径跳过 stopSessionProcs,直接发 keepalive DELETE
// (进程清理由服务端兜)。
// 诚实标注:flushAllPending 是组件内闭包,纯 node 无法驱动 React 生命周期触发
// beforeunload,故本条是源码钉,精确锚在「keepalive DELETE 被排在无 keepalive 的
// stopSessionProcs 之后」这个 bug 形态上。
// Run: node tests/acceptance/r26/i5-beforeunload-keepalive-delete.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../../client/src/components/UnifiedSidebar.jsx', import.meta.url), 'utf8');

const m = src.match(/const flushAllPending = \(\) => \{[\s\S]*?\n  \};/);
assert.ok(m, 'I5: flushAllPending 应仍存在(重命名则本钉子需换锚)');
const body = m[0];

// 卸载路径上 keepalive DELETE 必须还在(防修复把整个兜底删掉)
assert.match(body, /keepalive:\s*true/, 'I5: flushAllPending 里必须保留 keepalive DELETE');

// bug 形态:DELETE 排在 stopSessionProcs(...).then 之后 —— 卸载时前者被掐死,后者永远不发
assert.ok(
  !/stopSessionProcs/.test(body),
  'I5: beforeunload 的删除链仍排在 stopSessionProcs(无 keepalive)之后 —— 页面一卸载体链就断,DELETE 发不出去',
);

// 正常路径(非卸载)的 reallyDelete 不受本钉约束:那里先停进程再删是对的。
const normal = src.match(/const reallyDelete = [\s\S]*?\n  \};/);
if (normal) {
  assert.match(normal[0], /stopSessionProcs/, 'I5: 正常删除路径的进程清理不许被顺手删掉');
}

console.log('PASS r26-i5-beforeunload-keepalive-delete');
