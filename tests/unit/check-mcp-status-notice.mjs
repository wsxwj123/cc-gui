#!/usr/bin/env node
// R8-5 MCP server 状态提示护栏(client/src/utils/mcpStatus.js + App.jsx init 接线)。
// 语义依据(spike-a 实测,CLI 2.1.227):init 自带 mcp_servers:[{name,status}],
// status 实测见 connected / needs-auth;非 connected 的任何值都提示(failed/未来新增)。
// 此前这些 server 静默不可用,用户只看到工具调不动。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractMcpServerIssues, formatMcpServerNotice } from '../../client/src/utils/mcpStatus.js';

// ── ① 提取:非 connected 项(fixture 按 init 真实形态) ─────────────────────
{
  // 真实 init.mcp_servers 形态(spike-a):混合 connected / needs-auth / failed
  const servers = [
    { name: 'xiaohongshu-mcp', status: 'connected' },
    { name: 'linear', status: 'needs-auth' },
    { name: 'paper-search-mcp', status: 'failed' },
  ];
  const issues = extractMcpServerIssues(servers);
  assert.deepEqual(issues.map((i) => i.name), ['linear', 'paper-search-mcp'], '只留非 connected 项');
  assert.deepEqual(issues.map((i) => i.status), ['needs-auth', 'failed'], '状态原样保留');
}
// 全 connected → 空
assert.deepEqual(extractMcpServerIssues([{ name: 'a', status: 'connected' }]), [], '全 connected 无提示');
// 字段缺失/空数组/非数组 → 静默空(老 CLI 不带 mcp_servers 时零扰动)
assert.deepEqual(extractMcpServerIssues(undefined), [], '字段缺失静默');
assert.deepEqual(extractMcpServerIssues(null), [], 'null 静默');
assert.deepEqual(extractMcpServerIssues([]), [], '空数组静默');
assert.deepEqual(extractMcpServerIssues('connected'), [], '非数组形态静默');
// 残缺项(缺 name/status)跳过,不因脏数据崩
assert.deepEqual(extractMcpServerIssues([{ status: 'failed' }, { name: 'x' }, null, { name: 'ok', status: 'connected' }]), [],
  '缺 name/缺 status/null 项全部跳过');

// ── ② 文案:客观陈述 + 多个合并成一条 ────────────────────────────────────
{
  const one = formatMcpServerNotice([{ name: 'linear', status: 'needs-auth' }]);
  assert.equal(one, 'MCP 服务器 linear 状态:needs-auth(需在 MCP 面板完成授权)', 'needs-auth 附授权入口说明');
  const two = formatMcpServerNotice([
    { name: 'linear', status: 'needs-auth' },
    { name: 'paper-search-mcp', status: 'failed' },
  ]);
  assert.ok(two.includes('linear') && two.includes('paper-search-mcp'), '多个 server 合并进同一条');
  assert.ok(!two.includes('\n'), '合并为单条(分号连接,不换行不多弹)');
  assert.ok(two.includes('状态:failed'), '非 needs-auth 状态如实报状态值');
  assert.ok(!/failed\(需在 MCP 面板完成授权\)/.test(two), '授权说明只跟 needs-auth,不错挂到 failed 上');
}
assert.equal(formatMcpServerNotice([]), null, '空问题列表 → null(调用侧不弹)');
assert.equal(formatMcpServerNotice(undefined), null, '缺失 → null');

// ── ③ 去重语义(与 App.jsx 接线同构):同一 pid 只提示一次,新 pid 重新评估;
//      「只在真提示过后记账」→ 首个 init 干净、后续 init(setModel 补发)出问题仍能提示 ──
{
  const seen = new Set();
  const fired = [];
  const onInit = (pid, mcpServers) => {
    if (seen.has(String(pid))) return;
    const notice = formatMcpServerNotice(extractMcpServerIssues(mcpServers));
    if (notice) { seen.add(String(pid)); fired.push(notice); }
  };
  const bad = [{ name: 'linear', status: 'needs-auth' }];
  const good = [{ name: 'linear', status: 'connected' }];
  onInit('sdk-1', good);          // 首个 init 全 connected:不提示、不记账
  onInit('sdk-1', bad);           // setModel 补发的 init 出了问题:仍要提示(没被首个 init 锁死)
  onInit('sdk-1', bad);           // 同进程再次 init:去重,不重复提示
  onInit('sdk-2', bad);           // 进程重建(新 pid):MCP 重连,重新提示
  assert.deepEqual(fired.length, 2, '同 pid 一次 + 新 pid 一次');
}

// ── ④ 源码守卫:App.jsx init 分支真接了线(按 pid 去重 + 用 notice 机制) ─────
{
  const app = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'client', 'src', 'App.jsx'), 'utf8');
  assert.ok(/mcpNoticeSeenPids\.has\(String\(pid\)\)/.test(app), 'init 分支必须按 pid 去重');
  assert.ok(/formatMcpServerNotice\(extractMcpServerIssues\(event\.mcp_servers\)\)/.test(app),
    'init 分支消费 event.mcp_servers 且走纯函数');
}

console.log('✓ check-mcp-status-notice: 提取/静默/文案合并/去重/接线守卫 全过');
