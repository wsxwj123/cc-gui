#!/usr/bin/env node
// 用量统计「重算落地 → 前端静默刷新」的接线锁(2026-09-14 批)。
// 这条链是三段字符串拼出来的,任一处改名都是**静默失效**:服务端照广播、前端永远不刷新,
// 没有任何报错。服务端那段由验收套件 U10 真连 WS 验过,前端这两段是浏览器行为,
// 在 node 里只能锁字面量 —— 但断链的失败模式恰恰就是"某个字面量对不上"。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');
const stats = read('server/services/usage-stats.js');
const hook = read('client/src/hooks/useWebSocket.js');
const panel = read('client/src/components/UsagePanel.jsx');

// ① 服务端:重算落地即广播。② WS 派发。③ 面板监听(必须成对卸载,否则重挂载后叠加)。
assert.match(stats, /broadcast\(\{ type: 'usage-updated' \}\)/, '服务端重算落地必须广播 usage-updated');
assert.match(hook, /case 'usage-updated':/, 'useWebSocket 必须认 usage-updated(否则广播到了也被 switch 丢掉)');
assert.match(hook, /dispatchEvent\(new CustomEvent\('cgui:usage-updated'\)\)/, 'WS 消息要转成 cgui: 前缀的 window 事件(与 chat-done 同惯例)');
assert.match(panel, /addEventListener\('cgui:usage-updated'/, 'UsagePanel 必须监听它做静默刷新');
assert.match(panel, /removeEventListener\('cgui:usage-updated'/, '监听必须成对卸载');
assert.match(panel, /onUsageUpdated = \(\) => fetchStats\(true\)/, '收到广播要走静默刷新(不能闪 loading)');

// 旧值不许当新值展示:meta.stale 为真时面板必须如实说明。
assert.match(panel, /stats\.meta\?\.stale && \(/, 'meta.stale 为真时必须给出如实说明');
assert.match(panel, /统计中，数据可能略旧/, '说明文案');

// 不许顺手改掉的东西(BRIEF 明确不做):loading 文案、30 秒轮询兜底、既有 chat-done 刷新。
assert.match(panel, /正在统计全部会话/, 'loading 分支文案保持不变');
assert.match(panel, /setInterval\(\(\) => fetchStats\(true\), 30_000\)/, '30 秒轮询兜底保持');
assert.match(panel, /cgui:chat-done/, '既有的回合完成刷新不许丢');

console.log('check-usage-updated-wiring: PASS');
process.exit(0);
