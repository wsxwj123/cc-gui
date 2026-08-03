#!/usr/bin/env node
// 批L L1-a:后台代理"在等你"的字段透传。
// 回归对象:CLI 把等待状态落盘在两处 —— ~/.claude/sessions/<pid>.json 的
// {status, waitingFor} 与 ~/.claude/jobs/<id>/state.json 的 {state, needs, tempo};
// GUI 两个文件都读了,却把字段全丢在解析层(status 硬编码 'alive'、后台代理条目直接
// continue),于是"代理卡在等授权、永久不动"在界面上和"正常在跑"长得一模一样。
//
// 映射体是纯函数,这里真 import;前端渲染(JSX,node 直跑不了)用源码守卫。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildCliSessionEntry } from '../../server/routes/agents.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const panel = readFileSync(join(root, 'client/src/components/AgentMonitorPanel.jsx'), 'utf8');
const agentsSrc = readFileSync(join(root, 'server/routes/agents.js'), 'utf8');

// ── 1. 外部 CLI 会话:无 status → 仍是 'alive'(批K 语义不得被推翻)────────
{
  const e = buildCliSessionEntry(
    { pid: 123, sessionId: 'sid-ext', cwd: '/tmp', kind: 'interactive', entrypoint: 'claude-desktop', startedAt: 1000 },
    'fallback',
  );
  assert.equal(e.status, 'alive', '无 status 的外部会话仍报 alive');
  assert.equal(e.waitingFor, null, '没有等待原因就是 null');
  assert.equal(e.stoppable, true, '外部会话可停(走 /processes/:pid/kill 白名单)');
  assert.equal(e.cliKind, 'interactive');
  assert.equal(e.sessionId, 'sid-ext');
  assert.ok(!('state' in e) && !('needs' in e), '非后台代理不带后台字段');
}

// ── 2. 注册表写了 busy/idle 等其它取值 → 【仍报 alive】────────────────────
// 这些取值前端没有对应桶,盲目透传会把外部终端会话甩进"其他"桶(批K 的"存活(外部会话)"
// 分组失效)。只有 'waiting' 是能确知的新事实。
{
  for (const status of ['busy', 'shell', 'idle']) {
    const e = buildCliSessionEntry({ pid: 1, sessionId: 's', kind: 'interactive', status }, 'f');
    assert.equal(e.status, 'alive', `status=${status} 不得透传(前端无对应桶)`);
  }
}

// ── 3. status='waiting' → 透传 + waitingFor 一起带出 ──────────────────────
{
  const e = buildCliSessionEntry(
    { pid: 7, sessionId: 'sid-w', kind: 'interactive', status: 'waiting', waitingFor: 'input needed' },
    'f',
  );
  assert.equal(e.status, 'waiting', "CLI 明写的 waiting 必须透传");
  assert.equal(e.waitingFor, 'input needed');
}

// ── 4. 后台代理:只读条目 + 落盘 state/needs/tempo ─────────────────────────
{
  const job = { jobState: 'blocked', needs: 'approve Write: /abs/path.txt', tempo: 'blocked', detail: 'x' };
  const e = buildCliSessionEntry(
    { pid: 42, sessionId: 'sid-bg', kind: 'bg', jobId: 'abcd1234', status: 'waiting', waitingFor: 'permission prompt' },
    'f',
    job,
  );
  assert.equal(e.stoppable, false, '后台代理绝不能给 pid kill 按钮(pid 是共用 supervisor,会连坐全停)');
  assert.equal(e.status, 'waiting');
  assert.equal(e.waitingFor, 'permission prompt');
  assert.equal(e.state, 'blocked', 'jobs/<id>/state.json 的 state 要透传');
  assert.equal(e.needs, 'approve Write: /abs/path.txt', 'needs 是人话待办,必须透传');
  assert.equal(e.tempo, 'blocked');
  assert.equal(e.cliKind, 'bg');
}

// ── 5. 注册表还没写 waiting、但 job 已 blocked → 也算"在等你" ─────────────
{
  const e = buildCliSessionEntry({ pid: 42, sessionId: 'sid-bg2', kind: 'bg' }, 'f', { jobState: 'blocked', needs: '', tempo: null });
  assert.equal(e.status, 'waiting', 'state=blocked 即在等人,不能报 alive');
}

// ── 6. 后台代理还在跑 → 不是 waiting ─────────────────────────────────────
{
  const e = buildCliSessionEntry({ pid: 42, sessionId: 'sid-bg3', kind: 'bg' }, 'f', { jobState: 'working', needs: '', tempo: 'fast' });
  assert.equal(e.status, 'alive', '在跑的后台代理不谎称在等你');
  assert.equal(e.state, 'working');
}

// ── 7. 服务端接线守卫 ────────────────────────────────────────────────────
{
  // 后台代理不再被整条 continue 掉(否则角标没有数据源)
  assert.ok(!/if \(s\.kind === 'bg' \|\| s\.kind === 'background'\) continue;/.test(agentsSrc),
    '后台代理条目必须放行为只读条目,不能整条 continue');
  assert.ok(/out\.push\(buildCliSessionEntry\(/.test(agentsSrc), 'cli-session 条目须经 buildCliSessionEntry 生成');
  // 终态后台代理不列出(supervisor pid 长期存活,否则永久残留)
  assert.ok(/BG_TERMINAL_STATES\.has\(job\.jobState\)\) continue;/.test(agentsSrc), '终态后台代理不进 active 列表');
  // jobs state 的 state 不得直接叫 state 回传 —— 会覆盖 /background 里 `claude agents --json` 的权威值
  assert.ok(/jobState: typeof s\.state === 'string'/.test(agentsSrc),
    'readBgJobState 的落盘 state 必须用 jobState 键,防覆盖 --json 的权威 state');
  assert.ok(/needs: typeof s\.needs === 'string'/.test(agentsSrc), 'readBgJobState 须透传 needs');
  assert.ok(/tempo: typeof s\.tempo === 'string'/.test(agentsSrc), 'readBgJobState 须透传 tempo');
  // /agents/background:非终态也读 job state(blocked 的 needs 才是等待信息)
  const bgSeg = agentsSrc.slice(agentsSrc.indexOf("router.get('/agents/background'"), agentsSrc.indexOf("router.post('/agents/background/dispatch'"));
  assert.ok(/if \(a\.kind === 'background'\) \{/.test(bgSeg), '后台代理一律读 job state,不再只读终态');
  assert.ok(!/BG_TERMINAL_STATES\.has\(a\.state\)/.test(bgSeg), '不得再用终态门控 job state 读取');
  assert.ok(/status: null, waitingFor: null, needs: '', tempo: null/.test(bgSeg), 'base 须带等待态四件套');
}

// ── 8. 前端守卫:徽章 / 副标题 / 分桶 / 去重 ──────────────────────────────
{
  assert.ok(/waiting:\s*\{ label: '等待中'/.test(panel), "StatusBadge 必须有 waiting 徽章(否则显示原文 waiting)");
  assert.ok(/const WAITING_FOR_LABEL = \{/.test(panel), 'waitingFor 须有中文映射');
  for (const k of ['permission prompt', 'input needed', 'dialog open', 'sandbox request', 'worker request']) {
    assert.ok(panel.includes(`'${k}'`), `waitingFor 映射缺 ${k}`);
  }
  assert.ok(/function StatusBadge\(\{ status, waitingFor = null, needs = '' \}\)/.test(panel),
    'StatusBadge 须接收 waitingFor/needs');
  assert.ok(/title=\{needs \|\| undefined\}/.test(panel), 'needs 放 tooltip');
  // 后台代理不在"本机 Claude 进程"区重复显示
  assert.ok(/const procAgents = remote\.agents\.filter\(\(a\) => a\.cliKind !== 'bg'/.test(panel),
    '后台代理只读条目须从"本机 Claude 进程"区过滤掉(它由后台代理区呈现)');
  // 等待桶排最前
  const groupsSeg = panel.slice(panel.indexOf('const groups = ['), panel.indexOf('].filter((g) => g.list.length > 0)'));
  assert.ok(groupsSeg.indexOf("key: 'waiting'") < groupsSeg.indexOf("key: 'working'"), '"等待输入"必须排在"工作中"前面');
  assert.ok(/key: 'alive'.*defaultOpen: false/.test(groupsSeg), 'alive 分组语义不变(批K 红线)');
  // 同一 supervisor 下多个后台会话 pid 相同 → key 必须优先 sessionId
  assert.ok(/key=\{a\.sessionId \|\| a\.pid \|\| a\.id \|\| i\}/.test(panel), 'RemoteBucket 的 key 须优先 sessionId(pid 会撞)');
  // 后台代理区:在等你的排最前 + needs 直接写出来
  assert.ok(/const waitsForYou = \(a\) => a\.state === 'blocked' \|\| a\.status === 'waiting'/.test(panel),
    '后台代理区须把"在等你"的排最前');
  assert.ok(/\{a\.needs && \(/.test(panel), '后台代理卡片须显示 needs(它在等你什么)');
}

console.log('✓ check-agents-waiting-fields: 等待字段透传 + 只读后台条目 + 面板分桶全过');
