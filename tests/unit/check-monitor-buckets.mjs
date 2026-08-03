#!/usr/bin/env node
// 批K K1:监控面板语义。两条回归对象——
//   ① 外部 CLI 会话(终端 / Claude Desktop 开的 claude)一律被报成 status:'running',
//      前端 isWorking 含 'running' → 8 个外部会话全部落"工作中"桶,而服务端物理上
//      只能知道"进程活着"(注册表文件只在启动时写一次,mtime 恒等 startedAt)。
//   ② workflow 内层 agent 全量渲染,跑完不退场(用户实测 37 条堆满面板),
//      而本地 Task 的终态桶早有 recentTerminal 截断。
// 纯 JSX 不能真 import,按本仓惯例:源码守卫 + 复刻取值语义双保险。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const panel = readFileSync(join(root, 'client/src/components/AgentMonitorPanel.jsx'), 'utf8');
const agentsSrc = readFileSync(join(root, 'server/routes/agents.js'), 'utf8');

// ── 1. 服务端:cli-session 条目报 'alive' 而不是 'running' ─────────────
{
  const i = agentsSrc.indexOf("kind: 'cli-session'");
  assert.ok(i > 0, "server/routes/agents.js 必须仍有 kind: 'cli-session' 条目");
  const seg = agentsSrc.slice(i, agentsSrc.indexOf('stoppable: true', i));
  assert.ok(/status: 'alive'/.test(seg),
    "cli-session 只能确知进程活着,status 必须是 'alive'");
  assert.ok(!/status: 'running'/.test(seg),
    "cli-session 不得报 'running'(注册表无法判断是否正在生成)");
}

// ── 2. 前端:alive 有独立徽章 + 独立分组,且绝不落"工作中" ───────────
{
  assert.ok(/alive:\s*\{ label: '存活'/.test(panel), 'StatusBadge 必须有 alive 徽章');
  // 中性色:不得用工作中/运行中的活跃蓝
  const badge = panel.slice(panel.indexOf("alive:       { label: '存活'"), panel.indexOf("alive:       { label: '存活'") + 160);
  assert.ok(!/bg-blue-|text-blue-/.test(badge), 'alive 徽章必须中性色,不与"工作中"同色');

  const iw = panel.match(/const isWorking = \(a\) => (\[[^\]]*\])/);
  assert.ok(iw, '必须仍有 isWorking 判据');
  assert.ok(!/alive/.test(iw[1]), "isWorking 列表不得含 'alive'");

  assert.ok(/const isAlive = \(a\) => a\.status === 'alive'/.test(panel), '必须有 isAlive 判据');
  assert.ok(/key: 'alive'.*defaultOpen: false/.test(panel), 'alive 必须单独成组且默认折叠');
  // "其他" 兜底桶要排除 alive,否则同一条目出现两次
  const other = panel.slice(panel.indexOf("key: 'other'"), panel.indexOf("key: 'other'") + 260);
  assert.ok(/!isAlive\(a\)/.test(other), '"其他"桶必须排除 alive(否则重复渲染)');

  // 区块标题不再自称"子进程"(外部终端 / Desktop 会话不是 GUI 的子进程)
  assert.ok(!/title=\{`Claude 子进程/.test(panel), '区块标题不得再叫"Claude 子进程"');
  assert.ok(/title=\{`本机 Claude 进程/.test(panel), '区块标题应体现"本机所有 Claude 进程"');
}

// ── 3. 复刻分桶语义:alive 只进 alive 桶 ────────────────────────────
{
  const isWorking = (a) => ['streaming', 'starting', 'running', 'working'].includes(a.status);
  const isDone = (a) => ['done', 'finished', 'completed'].includes(a.status);
  const isError = (a) => ['error', 'failed'].includes(a.status);
  const isWaiting = (a) => ['needs_input', 'waiting'].includes(a.status);
  const isAlive = (a) => a.status === 'alive';
  const agents = [
    { pid: '1', kind: 'chat-process', status: 'streaming' },
    { pid: '2', kind: 'cli-session', status: 'alive' },
    { pid: '3', kind: 'cli-session', status: 'alive' },
    { pid: '4', kind: 'chat-process', status: 'idle' },
  ];
  const buckets = {
    working: agents.filter(isWorking),
    waiting: agents.filter(isWaiting),
    alive: agents.filter(isAlive),
    done: agents.filter(isDone),
    error: agents.filter(isError),
    other: agents.filter((a) => !isWorking(a) && !isDone(a) && !isError(a) && !isWaiting(a) && !isAlive(a)),
  };
  assert.deepEqual(buckets.working.map((a) => a.pid), ['1'], '外部会话不得落"工作中"');
  assert.deepEqual(buckets.alive.map((a) => a.pid), ['2', '3'], '外部会话落 alive 桶');
  assert.deepEqual(buckets.other.map((a) => a.pid), ['4'], 'idle 仍走"其他",alive 不重复出现');
  const total = Object.values(buckets).reduce((n, l) => n + l.length, 0);
  assert.equal(total, agents.length, '分桶不重不漏');
}

// ── 4. workflow 内层 agent:running 全留,终态截断到最近 10 条 ─────────
{
  assert.ok(/b\.lastActivity/.test(panel),
    'recentTerminal 排序须兜底 lastActivity(workflow 内层 agent 没有 finishedAt/startedAt)');
  assert.ok(/const wfShown = \[/.test(panel), '必须有 wfShown(截断后的 workflow 列表)');
  assert.ok(/wfShown\.map\(/.test(panel) && !/\{wfAgents\.map\(/.test(panel),
    'workflow 区必须渲染 wfShown 而不是全量 wfAgents');
  assert.ok(/title=\{`workflow 内层 agent \(\$\{wfShown\.length\}\)`\}/.test(panel),
    '区块计数须按真正渲染出来的条数算');

  // 复刻:3 个 running + 30 个终态 → 3 + 10 = 13,且 running 一个不少
  const recentTerminal = (list) => list.slice()
    .sort((a, b) => (b.finishedAt || b.startedAt || b.lastActivity || 0) - (a.finishedAt || a.startedAt || a.lastActivity || 0))
    .slice(0, 10);
  const wfAgents = [
    ...Array.from({ length: 3 }, (_, i) => ({ id: `r${i}`, status: 'running', lastActivity: 1000 + i })),
    ...Array.from({ length: 30 }, (_, i) => ({ id: `d${i}`, status: i % 2 ? 'done' : 'idle', lastActivity: i })),
  ];
  const wfShown = [...wfAgents.filter((a) => a.status === 'running'), ...recentTerminal(wfAgents.filter((a) => a.status !== 'running'))];
  assert.equal(wfShown.length, 13, 'running 全留 + 终态最近 10 条');
  assert.equal(wfShown.filter((a) => a.status === 'running').length, 3, '在跑的一个都不能藏');
  assert.equal(wfShown[3].id, 'd29', '终态按最近活动时间倒序');
  assert.ok(!wfShown.some((a) => a.id === 'd0'), '最老的终态条目退场');
}

console.log('✓ check-monitor-buckets: 监控面板 alive 语义 + workflow 截断全过');
