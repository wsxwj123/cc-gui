#!/usr/bin/env node
// R8-5 / r163 MCP server 状态提示护栏(client/src/utils/mcpStatus.js + App.jsx init 接线)。
// R8-5(CLI 2.1.227):init 自带 mcp_servers:[{name,status}],当时实测只见 connected / needs-auth,
//   「非 connected 都提示」没问题;此前这些 server 静默不可用,用户只看到工具调不动。
// r163(CLI 2.1.319 实测,2026-11-09):MCP 连接改成全异步不阻塞启动,init 时 15 个里 13 个非 connected,
//   其中 11 个只是 pending(正在连),2 个 needs-auth、1 个 failed。pending 连完自然变 connected,当问题报是误报,
//   而且每个新进程(回滚 / 空闲回收 / 新会话)都会重弹一遍。所以:
//   ① pending / disabled 不算问题(connected 当然也不算),其余非 connected(needs-auth / failed / 未知新值)照旧提示;
//   ② 同一个 server 同一种状态,这次运行里只提示一次(跨进程),状态变了 / 恢复后又坏才再提示。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractMcpServerIssues, formatMcpServerNotice, createMcpNoticeLedger } from '../../client/src/utils/mcpStatus.js';

// 2026-11-09 在用户真实环境里量到的 init.mcp_servers(CLI 2.1.319,冷启动第一条消息)
const REAL_INIT = [
  'pubmed:pending', 'biorender:needs-auth', 'biorxiv:pending', 'consensus:pending', 'c-trials:pending', 'chembl:pending',
  'synapse:needs-auth', 'wiley:pending', 'ot:pending', 'benchling:failed', 'pdf:pending',
  'xiaohongshu-mcp:connected', 'paper-search-mcp:pending', 'ccgui-computer-use:connected', 'deepseek-search:pending',
].map((s) => { const [name, status] = s.split(':'); return { name, status }; });
const init = (overrides = {}) => REAL_INIT.map((s) => (overrides[s.name] ? { ...s, status: overrides[s.name] } : s));

// ── ① 提取:needs-auth / failed / 未知新值提示;connected / pending / disabled 不提示 ─────────
{
  const servers = [
    { name: 'xiaohongshu-mcp', status: 'connected' },
    { name: 'linear', status: 'needs-auth' },
    { name: 'paper-search-mcp', status: 'failed' },
  ];
  const issues = extractMcpServerIssues(servers);
  assert.deepEqual(issues.map((i) => i.name), ['linear', 'paper-search-mcp'], '只留 needs-auth / failed');
  assert.deepEqual(issues.map((i) => i.status), ['needs-auth', 'failed'], '状态原样保留');
}
assert.deepEqual(extractMcpServerIssues([{ name: 'a', status: 'connected' }]), [], '全 connected 无提示');
assert.deepEqual(extractMcpServerIssues([{ name: 'a', status: 'pending' }, { name: 'b', status: 'pending' }]), [], 'r163:pending 是正在连接,不是问题');
assert.deepEqual(extractMcpServerIssues([{ name: 'a', status: 'disabled' }]), [], 'r163:disabled 是用户自己关的,不是问题');
assert.deepEqual(extractMcpServerIssues([{ name: 'a', status: 'PENDING' }, { name: 'b', status: ' Connected ' }]), [], '状态值大小写 / 首尾空白不影响判定');
assert.deepEqual(extractMcpServerIssues([{ name: 'a', status: 'error' }]).map((i) => i.status), ['error'], '未知的新状态值仍然提示(不吞)');
{
  const issues = extractMcpServerIssues(REAL_INIT);
  assert.deepEqual(issues.map((i) => `${i.name}:${i.status}`), ['biorender:needs-auth', 'synapse:needs-auth', 'benchling:failed'],
    'r163:真实冷启动 init(15 个里 13 个非 connected)只剩 3 个真问题,11 个 pending 不报');
}
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

// ── ③ 账本(跨进程去重):同一 server 同一状态这次运行只提示一次;状态变了 / 恢复后又坏才再提示 ──
{
  const ledger = createMcpNoticeLedger();
  const names = (issues) => issues.map((i) => `${i.name}:${i.status}`);
  assert.deepEqual(names(ledger.take(init())), ['biorender:needs-auth', 'synapse:needs-auth', 'benchling:failed'], '第一个新进程:3 个真问题各提示一次');
  assert.deepEqual(names(ledger.take(init())), [], '第二个新进程(回滚 / 空闲回收 / 新会话):同样的问题不再提示');
  assert.deepEqual(names(ledger.take(init())), [], '第三个也不提示');
  // pending 既不提示,也不清账:biorender 重连中(pending),之后又回到 needs-auth → 仍是同一状态,不重提
  assert.deepEqual(names(ledger.take(init({ biorender: 'pending' }))), [], 'pending 不提示');
  assert.deepEqual(names(ledger.take(init())), [], 'pending 不清账:回到 needs-auth 不重提');
  // 状态变了(benchling failed → needs-auth)提示这一个
  assert.deepEqual(names(ledger.take(init({ benchling: 'needs-auth' }))), ['benchling:needs-auth'], '状态变了:只提示变了的那个');
  assert.deepEqual(names(ledger.take(init({ benchling: 'needs-auth' }))), [], '变后的状态也只提示一次');
  // 恢复(connected)后又坏:再提示
  // (benchling 此后一直是 needs-auth:fixture 的 init() 每次都把没覆盖的项还原成默认值,这里要显式带上,免得它「状态变回去」被当成新变化)
  assert.deepEqual(names(ledger.take(init({ benchling: 'needs-auth', synapse: 'connected' }))), [], '恢复 connected:不提示');
  assert.deepEqual(names(ledger.take(init({ benchling: 'needs-auth' }))), ['synapse:needs-auth'], '恢复后又 needs-auth:再提示(账本在 connected 时已划掉)');
  // 脏数据不崩
  assert.deepEqual(ledger.take(undefined), [], '非数组 → 空');
  assert.deepEqual(ledger.take([null, { name: 'x' }, { status: 'failed' }]), [], '残缺项 → 空');
  // 两个账本互不影响
  assert.deepEqual(names(createMcpNoticeLedger().take(init())).length, 3, '新账本从头开始');
}

// ── ④ 源码守卫:App.jsx init 分支接的是账本,不再按 pid 去重 ─────────────────────
{
  const app = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'client', 'src', 'App.jsx'), 'utf8');
  assert.ok(/const mcpNoticeLedger = createMcpNoticeLedger\(\)/.test(app), 'App.jsx 应在模块级建一个账本(分屏 / 重挂载共享)');
  assert.ok(/formatMcpServerNotice\(mcpNoticeLedger\.take\(event\.mcp_servers\)\)/.test(app),
    'init 分支消费 event.mcp_servers 且走「账本 → 文案」两个纯函数');
  assert.ok(!/mcpNoticeSeenPids/.test(app), '旧的按 pid 去重已去掉(换成跨进程的账本)');
}

console.log('✓ check-mcp-status-notice: 提取(pending 不报)/静默/文案合并/账本去重/接线守卫 全过');
