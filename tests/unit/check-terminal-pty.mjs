#!/usr/bin/env node
// 内置终端 WS 桥端到端单测(真 pty),v3 身份/分离语义(首批 R01):
//   起 server → term-open 断言 generation/resumeToken → echo(seq 单调)→ 断开 ws
//   (分离,进程存活)→ 新 ws 凭 token 重连 → 断言缓冲回放 + 继续交互 → 显式
//   term-close 才杀进程;另断言畸形 JSON/未知帧回 TERM_INVALID_MESSAGE、
//   term-in 缺 data 回 TERM_INVALID_INPUT、跨连接无 token 拒绝不杀原任务。
// node-pty 不可用的环境按设计降级跳过。
// 跑法:node tests/unit/check-terminal-pty.mjs
import { createRequire } from 'module';
import { spawn } from 'child_process';
import { createServer } from 'net';
import { realpathSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
const require = createRequire(new URL('../../server/x.js', import.meta.url));
const WebSocket = require('ws');

// 端口:探测一个空闲回环端口。原固定区间 6695-6794 会被本机常驻实例占用(实测撞过
// 6710/6723/6758),撞上就是 EADDRINUSE + "server 30s 未就绪"的假失败。
const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const p = probe.address().port;
    probe.close(() => resolve(p));
  });
});
const PORT = await freePort();
const base = `http://127.0.0.1:${PORT}`;
// 让 shell 启动可预测:交互式 zsh 会 source ~/.zshrc,本机 oh-my-zsh 用
// `:omz:update mode auto` 自动升级(走网络),实测单次启动 60s+ —— 会把下面"等提示符就位"
// 的 30s 窗口耗光,用例随机变红(报 "shell 30s 内没有任何输出")。被测的应是终端协议
// (PTY/输入/resize/重连),不是本机 shell 配置的启动耗时,故给被测实例一个空的 ZDOTDIR:
// zsh 从 ZDOTDIR 找用户 rc(系统 /etc/zshenv、/etc/zshrc 照常读),空目录 = 不加载用户配置。
// 产品按 process.env.SHELL 起 shell,这里不改 SHELL(只换 rc 的落点,shell 本身不变)。
const ZDOT = mkdtempSync(join(tmpdir(), 'cgui-term-zdotdir-'));
const server = spawn('node', ['server/index.js'], {
  env: { ...process.env, PORT: String(PORT), ZDOTDIR: ZDOT },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));
const fail = (msg) => {
  console.error(`check-terminal-pty 失败: ${msg}`);
  try { server.kill('SIGKILL'); } catch {}
  process.exit(1);
};
for (let i = 0; i < 30; i++) {
  try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 500));
  if (i === 29) fail('server 30s 未就绪');
}
const status = async () => (await fetch(`${base}/api/terminal/status`)).json();
const st0 = await status();
if (!st0.available) {
  console.log(`check-terminal-pty: node-pty 不可用(${st0.error?.slice(0, 60)}),按设计降级,跳过`);
  server.kill();
  process.exit(0);
}

// 帧收集器:记录该连接全部消息(含 id=null 的错误帧,畸形帧断言需要),谓词自行过滤
let frames = [];
const attach = (ws) => {
  ws.on('message', (d) => {
    let m;
    try { m = JSON.parse(d); } catch { frames.push({ __raw: String(d) }); return; }
    frames.push(m);
  });
};
const waitFor = async (pred, label, tries = 40) => {
  for (let i = 0; i < tries; i++) {
    const hit = frames.find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 250));
  }
  fail(`等待超时: ${label} | 已见类型: ${frames.map((f) => f.type).join(',')}`);
};
// 等"本次动作的回执"必须排除历史帧:frames 是模块级累积,3) 的 term-detached 与 5b 的前置
// detach 同形且不带 id/generation 过滤时先查历史会立即命中 → 那次 detach 实际没被处理,
// 两条并发 resume 的结果就取决于"距上次附着多少毫秒"(落在 1s 窗口内两条都被
// TERM_ATTACH_CONFLICT 拒 → 5b 的"恰一个获准"断言随机变红)。mark 在发帧前取。
const waitForNew = async (mark, pred, label, tries = 40) => {
  for (let i = 0; i < tries; i++) {
    const hit = frames.slice(mark).find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 250));
  }
  fail(`等待超时: ${label} | 已见类型: ${frames.map((f) => f.type).join(',')}`);
};

const connect = () => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  ws.on('open', () => resolve(ws));
  ws.on('error', reject);
});
const rawSend = (ws, obj) => ws.send(JSON.stringify(obj));

// term-opened 只说明 PTY 起来了,不说明 shell 已能读输入:启动期间塞进去的输入会把 shell
// 顶住 —— 实测只看到 tty 回显,命令既不执行、提示符也不再出现(等待窗口过后用例以
// "等待超时: echo 输出"随机变红)。所以先只读地等 shell **自己吐出第一段输出**(=提示符
// 就位)再发第一条命令,不在启动窗口里抢输入。ZDOTDIR 隔离的是**启动耗时**(见文件头),
// 这条等待本身是判据的一部分("真 shell 跑起来了并能接受输入"),不放宽。
const shellReady = async (sink, id, tries = 120) => {
  for (let i = 0; i < tries; i++) {
    if (sink.some((m) => m.type === 'term-out' && m.id === id && m.data)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  fail(`shell 30s 内没有任何输出(提示符未就位;多为交互式 zsh 启动被拖住,不是终端协议缺陷)`);
};

// 1) 开终端:term-opened 必带 generation/resumeToken/state,lastSeq 与 seq 一致
let ws1 = await connect();
attach(ws1, 't1');
rawSend(ws1, { type: 'term-open', id: 't1', cols: 100, rows: 30 });
const opened1 = await waitFor((m) => m.type === 'term-opened', 'term-opened');
// 失败信息只带非敏感字段:resumeToken 是 shell 控制凭据,不进任何日志/证据文件
if (!Number.isInteger(opened1.generation) || opened1.generation < 1) fail(`term-opened 应带 generation,实为 ${JSON.stringify({ ...opened1, resumeToken: opened1.resumeToken ? '<redacted>' : opened1.resumeToken })}`);
if (typeof opened1.resumeToken !== 'string' || opened1.resumeToken.length < 16) fail('term-opened 应带高熵 resumeToken');
if (opened1.state !== 'attached') fail(`新建应 state=attached,实为 ${opened1.state}`);
if (!Number.isInteger(opened1.pid)) fail('term-opened 应带 pid');

// 2) echo:term-out 带单调 seq 与同代 generation,且求值输出可见(非输入回显)
await shellReady(frames, 't1');
rawSend(ws1, { type: 'term-in', id: 't1', generation: opened1.generation, data: 'echo pty-ok-$((6*6))\r' });
const out1 = await waitFor((m) => m.type === 'term-out' && m.data.includes('pty-ok-36'), 'echo 输出');
if (out1.generation !== opened1.generation) fail('term-out generation 应与 opened 一致');
if (!(out1.seq > opened1.lastSeq)) fail(`seq 应大于 opened.lastSeq(严格递增),实为 ${out1.seq} vs ${opened1.lastSeq}`);
if (out1.replay !== false) fail('在线输出 replay 应为 false');

// 2b) 反证:干净 ZDOTDIR 只是不加载用户 rc,跑的还是**产品按 $SHELL 起的那个真 login shell**
//     (不是被换成了别的东西)。期望值用与产品同一条规则从同一 env 推导,不会自说自话。
const shellName = (process.env.SHELL || '/bin/bash').split('/').pop();
const shellRe = new RegExp(`shell:.*\\b${shellName}\\b`);
const outText = () => frames.filter((m) => m.type === 'term-out').map((m) => m.data).join('');
rawSend(ws1, { type: 'term-in', id: 't1', generation: opened1.generation, data: 'echo "shell:$0"\r' });
for (let i = 0; i < 40 && !shellRe.test(outText()); i++) await new Promise((r) => setTimeout(r, 250));
if (!shellRe.test(outText())) fail(`PTY 里应是 $SHELL(${shellName})的 login shell 在跑,实见:${JSON.stringify(outText().slice(-200))}`);

// 3) 断开 ws = 分离:进程存活(active 计 1,含分离),回 term-detached
rawSend(ws1, { type: 'term-detach', id: 't1', generation: opened1.generation });
const detached1 = await waitFor((m) => m.type === 'term-detached' && m.reason === 'detached', 'term-detached');
if (detached1.generation !== opened1.generation) fail('term-detached 应带原 generation');
ws1.close();
await new Promise((r) => setTimeout(r, 600));
const st1 = await status();
if (st1.active !== 1) fail(`面板关闭后应分离存活(active=1),实为 ${st1.active}`);

// 3b) 分离期间输出进缓冲:无连接时 shell 仍可执行(由下一连接重连后回放证实)

// 4) 跨连接无 token open:拒绝(TERM_TOKEN_REQUIRED)且不杀原任务
let ws2 = await connect();
attach(ws2, 't1');
rawSend(ws2, { type: 'term-open', id: 't1', cols: 100, rows: 30 });
const err1 = await waitFor((m) => m.type === 'term-error', '无 token 拒绝');
if (err1.code !== 'TERM_TOKEN_REQUIRED') fail(`跨连接无 token 应 TERM_TOKEN_REQUIRED,实为 ${err1.code}`);
if ((await status()).active !== 1) fail('拒绝后原任务必须存活');

// 4b) 同 id 并发 open:最多一个存活 generation(后者 TERM_OPEN_CONFLICT),不泄漏第二个 PTY
{
  const c1 = await connect();
  const c2 = await connect();
  const f1 = [];
  const f2 = [];
  c1.on('message', (d) => f1.push(JSON.parse(d)));
  c2.on('message', (d) => f2.push(JSON.parse(d)));
  // 带 cwd 强制走 realpath(真实 I/O await),让两个 open 的创建窗口真实重叠。
  // HOME 自身含符号链接时(隔离环境 HOME 常在 /tmp 下,服务端按真实路径比较家目录)
  // 不带 cwd:此时无 await 点、第二个 open 必然看到已登记的终端,失败方拿
  // TERM_TOKEN_REQUIRED —— 契约只要求"最多一个存活 generation",两种都对。
  const cwd = realpathSync(process.env.HOME) === process.env.HOME ? process.env.HOME : undefined;
  if (!cwd) console.log('  · HOME 含符号链接,并发 open 不带 cwd(失败方将走 TOKEN_REQUIRED 分支)');
  rawSend(c1, { type: 'term-open', id: 't2', cols: 90, rows: 25, cwd });
  rawSend(c2, { type: 'term-open', id: 't2', cols: 90, rows: 25, cwd });
  const settle = async (arr, label) => {
    for (let i = 0; i < 40; i++) {
      const hit = arr.find((m) => m.type === 'term-opened' || m.type === 'term-error');
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 250));
    }
    fail(`等待超时: ${label}`);
  };
  const r1 = await settle(f1, '并发 open c1');
  const r2 = await settle(f2, '并发 open c2');
  const results = [r1, r2];
  if (results.filter((m) => m.type === 'term-opened').length !== 1) fail(`并发同 id open 应恰一个成功,实为 ${results.map((m) => `${m.type}${m.code ? ':' + m.code : ''}`).join(',')}${results.map((m) => m.error ? ` [${m.error}]` : '').join('')}`);
  // 契约只要求"最多一个存活 generation";失败方要么撞上创建中的闸(OPEN_CONFLICT),
  // 要么创建已完成、id 已归属他人(token 必需)——两者都不杀不换
  const loser = results.find((m) => m.type === 'term-error');
  if (!['TERM_OPEN_CONFLICT', 'TERM_TOKEN_REQUIRED'].includes(loser.code)) fail(`并发同 id open 失败方应被拒(OPEN_CONFLICT/TOKEN_REQUIRED),实为 ${loser.code}`);
  console.log(`  · 并发同 id open:失败方错误码 = ${loser.code}`);
  const stT2 = await status();
  if (stT2.active !== 2) fail(`并发同 id open 只应多一个存活 shell(active=2),实为 ${stT2.active}`);
  const winnerWs = r1.type === 'term-opened' ? c1 : c2;
  const winnerFrames = r1.type === 'term-opened' ? f1 : f2;
  const t2 = results.find((m) => m.type === 'term-opened');
  await shellReady(winnerFrames, 't2');
  rawSend(winnerWs, { type: 'term-in', id: 't2', generation: t2.generation, data: 'echo t2-ok-$((2*5))\r' });
  for (let i = 0; i < 40 && !winnerFrames.some((m) => m.type === 'term-out' && m.data.includes('t2-ok-10')); i++) await new Promise((r) => setTimeout(r, 250));
  if (!winnerFrames.some((m) => m.type === 'term-out' && m.data.includes('t2-ok-10'))) fail('并发 open 的胜者应可交互');
  rawSend(winnerWs, { type: 'term-close', id: 't2', generation: t2.generation });
  for (let i = 0; i < 40 && !winnerFrames.some((m) => m.type === 'term-closed' && m.id === 't2'); i++) await new Promise((r) => setTimeout(r, 250));
  if (!winnerFrames.some((m) => m.type === 'term-closed' && m.id === 't2')) fail('t2 显式关闭未回 term-closed');
  c1.close();
  c2.close();
  await new Promise((r) => setTimeout(r, 300));
  if ((await status()).active !== 1) fail(`t2 关闭后只应剩分离的 t1(active=1),实为 ${(await status()).active}`);
}

// 5) 重连(带 generation+resumeToken):opened(generation/pid 不变)+ 缓冲回放 + 继续交互
rawSend(ws2, { type: 'term-open', id: 't1', generation: opened1.generation, resumeToken: opened1.resumeToken });
const opened2 = await waitFor((m) => m.type === 'term-opened' && m.reused === true, '重连 opened');
if (opened2.generation !== opened1.generation) fail('重连 generation 应不变');
if (opened2.pid !== opened1.pid) fail('重连 pid 应不变(同一存活进程)');
if (opened2.state !== 'attached') fail('重连后应 attached');
if (opened2.resumeToken !== opened1.resumeToken) fail('takeover 不轮换 resumeToken');
rawSend(ws2, { type: 'term-in', id: 't1', generation: opened2.generation, data: 'echo rebind-ok\r' });
await waitFor((m) => m.type === 'term-out' && m.data.includes('rebind-ok'), '重连后继续交互');
// 回放完整性:pty-ok-36(连接 1 期间的输出)必须在重连后再次可见
rawSend(ws2, { type: 'term-in', id: 't1', generation: opened2.generation, data: 'echo replay-check-$((7*7))\r' });
await waitFor((m) => m.type === 'term-out' && m.data.includes('replay-check-49'), '回放探针输出');
const replayed = frames.filter((m) => m.type === 'term-out' && m.replay === true);
if (!replayed.some((m) => m.data.includes('pty-ok-36'))) fail('重连应回放分离期历史(缓冲丢失)');
const seqs = replayed.map((m) => m.seq);
if (seqs.some((s, i) => i > 0 && s <= seqs[i - 1])) fail(`回放 seq 必须升序,实为 ${seqs.join(',')}`);

// 5b) 并发同 token resume 只一个获准,另一个 TERM_ATTACH_CONFLICT,PTY 不死
{
  const detachMark = frames.length;
  rawSend(ws2, { type: 'term-detach', id: 't1', generation: opened2.generation });
  // 必须等到**本次** detach 的回执(带 id+generation):否则并发双 resume 会对着仍附着的
  // 终端做,结果变成"看距上次附着的毫秒数",5b 随机变红(见 waitForNew 注释)
  await waitForNew(detachMark, (m) => m.type === 'term-detached' && m.id === 't1' && m.generation === opened2.generation && m.reason === 'detached', '并发前先分离');
  const wsA = await connect();
  const wsB = await connect();
  const fa = [];
  const fb = [];
  wsA.on('message', (d) => fa.push(JSON.parse(d)));
  wsB.on('message', (d) => fb.push(JSON.parse(d)));
  rawSend(wsA, { type: 'term-open', id: 't1', generation: opened2.generation, resumeToken: opened2.resumeToken });
  rawSend(wsB, { type: 'term-open', id: 't1', generation: opened2.generation, resumeToken: opened2.resumeToken });
  const firstOf = async (arr, label) => {
    for (let i = 0; i < 40; i++) {
      const hit = arr.find((m) => m.type === 'term-opened' || m.code === 'TERM_ATTACH_CONFLICT');
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 250));
    }
    fail(`等待超时: ${label}`);
  };
  const ra = await firstOf(fa, 'wsA resume 结果');
  const rb = await firstOf(fb, 'wsB resume 结果');
  const results = [ra, rb];
  if (results.filter((m) => m.type === 'term-opened').length !== 1) fail(`并发 resume 应恰一个获准,实为 ${results.map((m) => m.type).join(',')}`);
  if (results.filter((m) => m.code === 'TERM_ATTACH_CONFLICT').length !== 1) fail('并发 resume 应恰一个 TERM_ATTACH_CONFLICT');
  if ((await status()).active !== 1) fail('并发 resume 冲突不得杀 PTY');
  const winnerWs = ra.type === 'term-opened' ? wsA : wsB;
  const sink = ra.type === 'term-opened' ? fa : fb;
  rawSend(winnerWs, { type: 'term-in', id: 't1', generation: opened2.generation, data: 'echo race-winner-ok\r' });
  for (let i = 0; i < 40 && !sink.some((m) => m.type === 'term-out' && m.data.includes('race-winner-ok')); i++) await new Promise((r) => setTimeout(r, 250));
  if (!sink.some((m) => m.type === 'term-out' && m.data.includes('race-winner-ok'))) fail('获准方应可继续交互');
  wsA.close();
  wsB.close();
  await new Promise((r) => setTimeout(r, 400));
}

// 5c) 同连接重复 open:同参幂等返回原项,异参 TERM_OPEN_CONFLICT(不杀不换)
{
  // 上一段两个连接已关闭,t1 处于分离态 → 先用 ws2 重接管
  rawSend(ws2, { type: 'term-open', id: 't1', generation: opened2.generation, resumeToken: opened2.resumeToken });
  const again = await waitFor((m) => m.type === 'term-opened' && m !== opened2, '同连接同参重连');
  if (again.generation !== opened2.generation) fail('重连应返回原 generation');
  // 同连接再发一次相同 resume:幂等
  rawSend(ws2, { type: 'term-open', id: 't1', generation: opened2.generation, resumeToken: opened2.resumeToken });
  const again2 = await waitFor((m) => m.type === 'term-opened' && m !== opened2 && m !== again, '同连接同参幂等');
  if (again2.generation !== opened2.generation) fail('同参重复 open 应返回原 generation');
  // 异参(尺寸不同)的新建 open → TERM_OPEN_CONFLICT
  rawSend(ws2, { type: 'term-open', id: 't1', cols: 120 });
  const conflict = await waitFor((m) => m.type === 'term-error' && m.code === 'TERM_OPEN_CONFLICT', '异参 open 冲突');
  if ((await status()).active !== 1) fail('OPEN_CONFLICT 不得影响存活终端');
  ws2.close();
  await new Promise((r) => setTimeout(r, 400));
  // ws2 关闭后 t1 转分离,换新连接重接管,后续步骤以它为所有者
  const ws5 = await connect();
  attach(ws5);
  rawSend(ws5, { type: 'term-open', id: 't1', generation: opened2.generation, resumeToken: opened2.resumeToken });
  await waitFor((m) => m.type === 'term-opened' && m.generation === opened2.generation, '分离后重接管');
  ws2 = ws5;
  await new Promise((r) => setTimeout(r, 200));
}

// 6) 非所有者写入被拒(所有权绑定当前连接),回显 id
rawSend(ws2, { type: 'term-in', id: 't1', generation: opened2.generation, data: 'echo owner-ok\r' });
await waitFor((m) => m.type === 'term-out' && m.data.includes('owner-ok'), '当前所有者写入');
let ws4 = await connect();
attach(ws4, 't1');
rawSend(ws4, { type: 'term-in', id: 't1', generation: opened2.generation, data: 'echo hijack-no\r' });
const err2 = await waitFor((m) => m.type === 'term-error' && m.code === 'TERM_FORBIDDEN', '非所有者写入被拒');
if (!err2.id) fail('term-error 应回显 id');

// 7) 畸形 JSON / 未知 term-* 帧 → TERM_INVALID_MESSAGE(id=null / 回显),零副作用
let ws3 = await connect();
attach(ws3, 't1');
ws3.send('{broken-json');
const err3 = await waitFor((m) => m.type === 'term-error' && m.code === 'TERM_INVALID_MESSAGE', '畸形 JSON 拒绝');
if (err3.id !== null) fail(`畸形 JSON 的 id 应为 null,实为 ${JSON.stringify(err3.id)}`);
rawSend(ws3, { type: 'term-unknown', id: 't1' });
await waitFor((m) => m.type === 'term-error' && m.code === 'TERM_INVALID_MESSAGE' && m.id === 't1', '未知帧拒绝');
if ((await status()).active !== 1) fail('畸形帧不得影响存活终端');

// 8) term-in 缺 data / 非字符串 → TERM_INVALID_INPUT,零输入
rawSend(ws2, { type: 'term-in', id: 't1', generation: opened2.generation, data: 42 });
const err4 = await waitFor((m) => m.type === 'term-error' && m.code === 'TERM_INVALID_INPUT', '非法 data 拒绝');
if (err4.generation !== undefined) fail('term-error 不应携带他人 generation');
rawSend(ws2, { type: 'term-in', id: 't1', generation: opened2.generation });
await waitFor((m) => m.type === 'term-error' && m.code === 'TERM_INVALID_INPUT', '缺 data 拒绝');

// 9) 显式 close:才真正杀进程(回 term-closed,active 归零)
rawSend(ws2, { type: 'term-close', id: 't1', generation: opened2.generation });
const closed = await waitFor((m) => m.type === 'term-closed', 'term-closed');
if (closed.generation !== opened2.generation) fail('term-closed 应带原 generation');
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 300));
  if ((await status()).active === 0) break;
  if (i === 19) fail(`显式关闭后 active 应为 0,实为 ${(await status()).active}`);
}

// 9b) 自然退出(R03):不计 active、旧 token 不能复活、归属连接可 term-restart 开新 generation
let ws6 = await connect();
attach(ws6);
rawSend(ws6, { type: 'term-open', id: 't3', cols: 80, rows: 24 });
const opened3 = await waitFor((m) => m.type === 'term-opened' && m.id === 't3', 't3 新建');
await shellReady(frames, 't3');
rawSend(ws6, { type: 'term-in', id: 't3', generation: opened3.generation, data: 'echo pre-exit-$((3*3))\r' });
await waitFor((m) => m.type === 'term-out' && m.id === 't3' && m.data.includes('pre-exit-9'), '退出前输出');
rawSend(ws6, { type: 'term-in', id: 't3', generation: opened3.generation, data: 'exit 7\r' });
const exited3 = await waitFor((m) => m.type === 'term-exit' && m.id === 't3', 'term-exit');
if (exited3.generation !== opened3.generation) fail('term-exit 应带原 generation');
if (exited3.exitCode !== 7) fail(`term-exit 应带退出码 7,实为 ${exited3.exitCode}`);
if ((await status()).active !== 0) fail(`已退出不计入 active,实为 ${(await status()).active}`);
// 旧 token 不能复活退出进程(FB-T06 同款:TOKEN_REVOKED/STALE/EXITED)
const other = await connect();
const otherFrames = [];
other.on('message', (d) => otherFrames.push(JSON.parse(d)));
rawSend(other, { type: 'term-open', id: 't3', generation: opened3.generation, resumeToken: opened3.resumeToken });
for (let i = 0; i < 40 && !otherFrames.some((m) => m.type === 'term-error'); i++) await new Promise((r) => setTimeout(r, 250));
const revive = otherFrames.find((m) => m.type === 'term-error');
if (!['TERM_TOKEN_REVOKED', 'TERM_STALE', 'TERM_EXITED'].includes(revive?.code)) fail(`退出后 resume 应被拒(TOKEN_REVOKED/STALE/EXITED),实为 ${revive?.code}`);
// 归属连接 term-restart:新 generation / 新 pid / 新 token,可交互
rawSend(ws6, { type: 'term-restart', id: 't3', generation: opened3.generation });
const restarted = await waitFor((m) => m.type === 'term-opened' && m.id === 't3' && m.generation !== opened3.generation, '重启 opened');
if (restarted.pid === opened3.pid) fail('重启应是新进程(新 pid)');
if (restarted.resumeToken === opened3.resumeToken) fail('重启应换新 resumeToken');
rawSend(ws6, { type: 'term-in', id: 't3', generation: restarted.generation, data: 'echo after-restart-$((5*5))\r' });
await waitFor((m) => m.type === 'term-out' && m.id === 't3' && m.data.includes('after-restart-25'), '重启后交互');
// 同连接重复相同 restart:幂等返回已创建的新项
rawSend(ws6, { type: 'term-restart', id: 't3', generation: opened3.generation });
const againRestart = await waitFor((m) => m.type === 'term-opened' && m.id === 't3' && m !== restarted && m.generation === restarted.generation, '重复 restart 幂等');
if (againRestart.generation !== restarted.generation) fail(`重复 restart 应回同一新项(generation ${restarted.generation}),实为 ${againRestart.generation}`);
if ((await status()).active !== 1) fail(`重启后台只剩 t3 存活(active=1),实为 ${(await status()).active}`);
// 退出后非归属连接的 restart:记录归属他人 → TERM_FORBIDDEN
rawSend(ws6, { type: 'term-in', id: 't3', generation: restarted.generation, data: 'exit 0\r' });
const exited4 = await waitFor((m) => m.type === 'term-exit' && m.id === 't3' && m.generation === restarted.generation, '再次退出');
const errsBefore = otherFrames.filter((m) => m.type === 'term-error').length;
rawSend(other, { type: 'term-restart', id: 't3', generation: restarted.generation });
for (let i = 0; i < 40 && otherFrames.filter((m) => m.type === 'term-error').length <= errsBefore; i++) await new Promise((r) => setTimeout(r, 250));
const foreign = otherFrames.filter((m) => m.type === 'term-error')[errsBefore];
if (foreign?.code !== 'TERM_FORBIDDEN') fail(`非归属连接的 restart 应 TERM_FORBIDDEN,实为 ${foreign?.code}`);
if ((await status()).active !== 0) fail('被拒的 restart 不得开出新进程');
ws6.close();
other.close();
await new Promise((r) => setTimeout(r, 300));

// 9c) 分离超 6h 到期(用 CCGUI_TERM_DETACH_MAX_MS 把阈值压到 1.5s 单独起一个实例):
//     重连回 TERM_EXPIRED(不是"不存在"),墓碑不提供重启,回收后不占存活名额
{
  const PORT2 = await freePort();
  const srv2 = spawn('node', ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT2), CCGUI_TERM_DETACH_MAX_MS: '1500', ZDOTDIR: ZDOT },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv2.stderr.on('data', () => {});
  const base2 = `http://127.0.0.1:${PORT2}`;
  let up = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${base2}/api/health`)).ok) { up = true; break; } } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) fail('到期验证的第二实例 30s 未就绪');
  const wsE = await new Promise((resolve, reject) => {
    const w = new WebSocket(`ws://127.0.0.1:${PORT2}/ws`);
    w.on('open', () => resolve(w));
    w.on('error', reject);
  });
  const fe = [];
  wsE.on('message', (d) => fe.push(JSON.parse(d)));
  const waitE = async (pred, label) => {
    for (let i = 0; i < 40; i++) {
      const hit = fe.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 250));
    }
    fail(`等待超时(到期实例):${label}`);
  };
  rawSend(wsE, { type: 'term-open', id: 'exp1', cols: 80, rows: 24 });
  const openedE = await waitE((m) => m.type === 'term-opened' && m.id === 'exp1', 'exp1 新建');
  rawSend(wsE, { type: 'term-detach', id: 'exp1', generation: openedE.generation });
  await waitE((m) => m.type === 'term-detached' && m.id === 'exp1', 'exp1 分离');
  // 9c-1) 到期必须靠定时器生效:分离后**不再触碰任何 open/restart**,阈值 1.5s 给 6s 窗口,
  //       active 必须自己归零 —— 只靠 open/restart 时的惰性 sweep 时这里会一直 active=1,
  //       分离后无人访问的 shell 就能活过 6h(R29:资源上限不能只在测试触发时才成立)。
  let reaped = false;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 300));
    if ((await (await fetch(`${base2}/api/terminal/status`)).json()).active === 0) { reaped = true; break; }
  }
  if (!reaped) fail('分离满阈值后无人访问也应被回收:1.5s 阈值过了 6s 仍 active=1(缺定时 sweep)');
  await new Promise((r) => setTimeout(r, 3000)); // 超过 1.5s 阈值
  rawSend(wsE, { type: 'term-open', id: 'exp2', cols: 80, rows: 24 }); // 触发 sweep
  await waitE((m) => m.type === 'term-opened' && m.id === 'exp2', 'exp2 新建(sweep)');
  rawSend(wsE, { type: 'term-open', id: 'exp1', generation: openedE.generation, resumeToken: openedE.resumeToken });
  const expired = await waitE((m) => m.type === 'term-error' && m.id === 'exp1', '到期重连被拒');
  if (expired.code !== 'TERM_EXPIRED') fail(`分离超龄重连应 TERM_EXPIRED,实为 ${expired.code}`);
  rawSend(wsE, { type: 'term-restart', id: 'exp1', generation: openedE.generation });
  const noRestart = await waitE((m) => m.type === 'term-error' && m.id === 'exp1' && m !== expired, '过期墓碑不提供重启');
  if (noRestart.code !== 'TERM_NOT_FOUND') fail(`过期墓碑重启应 TERM_NOT_FOUND,实为 ${noRestart.code}`);
  const stE = await (await fetch(`${base2}/api/terminal/status`)).json();
  if (stE.active !== 1) fail(`到期回收不影响 exp2(active=1),实为 ${stE.active}`);
  wsE.close();
  srv2.kill('SIGKILL');
}

// 9d) 同 id 两帧并发 restart:只允许开出一个 generation(旧实现两帧都在 await spawnPty 前通过
//     检查 → 双 spawn,先注册的 PTY 成孤儿:不计 active、killAll 杀不到、输出无处去)
{
  const wsR = await connect();
  const fr = [];
  wsR.on('message', (d) => fr.push(JSON.parse(d)));
  const waitR = async (pred, label) => {
    for (let i = 0; i < 40; i++) {
      const hit = fr.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 250));
    }
    fail(`等待超时: ${label}`);
  };
  rawSend(wsR, { type: 'term-open', id: 't4', cols: 80, rows: 24 });
  const o4 = await waitR((m) => m.type === 'term-opened' && m.id === 't4', 't4 新建');
  await shellReady(fr, 't4');
  rawSend(wsR, { type: 'term-in', id: 't4', generation: o4.generation, data: 'exit 0\n' });
  await waitR((m) => m.type === 'term-exit' && m.id === 't4', 't4 退出');
  const mark4 = fr.length;
  rawSend(wsR, { type: 'term-restart', id: 't4', generation: o4.generation });
  rawSend(wsR, { type: 'term-restart', id: 't4', generation: o4.generation });
  await new Promise((r) => setTimeout(r, 2500));
  const opened4 = fr.slice(mark4).filter((m) => m.type === 'term-opened' && m.id === 't4');
  if (opened4.length !== 1) fail(`同 id 并发 restart 只应开出 1 个 generation,实为 ${opened4.length} 个(pid=${opened4.map((m) => m.pid).join(',')});多出来的那个 PTY 无人登记`);
  if ((await status()).active !== 1) fail(`并发 restart 后应只多 1 个存活 shell(active=1),实为 ${(await status()).active}`);
  rawSend(wsR, { type: 'term-close', id: 't4', generation: opened4[0].generation });
  await waitR((m) => m.type === 'term-closed' && m.id === 't4', 't4 关闭');
  wsR.close();
  await new Promise((r) => setTimeout(r, 300));
  if ((await status()).active !== 0) fail(`t4 关闭后 active 应为 0,实为 ${(await status()).active}`);
}

// 9e) 不同 id 并发 open 不得越过 maxTerminals:名额判定要把"正在 spawn 的其它 id"算进来,
//     只看 terminals.size 会让两个不同 id 的并发 open(或 open+restart)都通过 → active 超上限。
//     带 cwd 强制走 realpath(真实 I/O await),让创建窗口真实重叠。
{
  const wsL = await connect();
  const fl = [];
  wsL.on('message', (d) => fl.push(JSON.parse(d)));
  const cwdL = realpathSync(process.env.HOME) === process.env.HOME ? process.env.HOME : undefined;
  const ids = ['l1', 'l2', 'l3', 'l4', 'l5'];
  for (const id of ids) rawSend(wsL, { type: 'term-open', id, cols: 80, rows: 24, cwd: cwdL });
  for (let i = 0; i < 40; i++) {
    if (fl.filter((m) => (m.type === 'term-opened' || m.type === 'term-error') && ids.includes(m.id)).length >= ids.length) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const openedL = fl.filter((m) => m.type === 'term-opened' && ids.includes(m.id));
  const limitedL = fl.filter((m) => m.type === 'term-error' && m.code === 'TERM_LIMIT' && ids.includes(m.id));
  const cap = (await status()).maxTerminals;
  if (openedL.length !== cap) fail(`并发 open ${ids.length} 个不同 id 应恰好放行 ${cap} 个,实为 ${openedL.length} 个`);
  if (limitedL.length !== ids.length - cap) fail(`其余 ${ids.length - cap} 个应回 TERM_LIMIT,实为 ${limitedL.length} 个`);
  if ((await status()).active !== cap) fail(`并发 open 后存活 shell 应为上限 ${cap},实为 ${(await status()).active}(超限即并发判定漏算在飞创建)`);
  for (const o of openedL) rawSend(wsL, { type: 'term-close', id: o.id, generation: o.generation });
  for (let i = 0; i < 40; i++) {
    if (fl.filter((m) => m.type === 'term-closed' && ids.includes(m.id)).length >= openedL.length) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  wsL.close();
  await new Promise((r) => setTimeout(r, 300));
  if ((await status()).active !== 0) fail(`并发 open 用例收尾后 active 应为 0,实为 ${(await status()).active}`);
}

// 9f) resize 后重启保持新尺寸:term-resize 必须回写 entry.cols/rows —— term-restart 用
//     rec.cols/rec.rows 重建 PTY,只改 pty 不回写会让重启出来的 shell 回到旧尺寸。
{
  const wsZ = await connect();
  const fz = [];
  wsZ.on('message', (d) => fz.push(JSON.parse(d)));
  const waitZ = async (pred, label) => {
    for (let i = 0; i < 40; i++) {
      const hit = fz.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 250));
    }
    fail(`等待超时: ${label}`);
  };
  const probe = (n) => new RegExp(`SZ${n} (\\d+) (\\d+)`);
  rawSend(wsZ, { type: 'term-open', id: 'z1', cols: 80, rows: 24 });
  const oz = await waitZ((m) => m.type === 'term-opened' && m.id === 'z1', 'z1 新建');
  await shellReady(fz, 'z1');
  rawSend(wsZ, { type: 'term-resize', id: 'z1', generation: oz.generation, cols: 120, rows: 40 });
  await new Promise((r) => setTimeout(r, 400));
  rawSend(wsZ, { type: 'term-in', id: 'z1', generation: oz.generation, data: 'echo "SZ1 $(stty size)"\n' });
  const z1 = await waitZ((m) => m.type === 'term-out' && probe(1).test(String(m.data)), 'resize 后尺寸');
  const size1 = probe(1).exec(String(z1.data)).slice(1).join('x');
  rawSend(wsZ, { type: 'term-in', id: 'z1', generation: oz.generation, data: 'exit 0\n' });
  await waitZ((m) => m.type === 'term-exit' && m.id === 'z1', 'z1 退出');
  rawSend(wsZ, { type: 'term-restart', id: 'z1', generation: oz.generation });
  const rz = await waitZ((m) => m.type === 'term-opened' && m.id === 'z1' && m.generation !== oz.generation, 'z1 重启');
  await shellReady(fz, 'z1');
  rawSend(wsZ, { type: 'term-in', id: 'z1', generation: rz.generation, data: 'echo "SZ2 $(stty size)"\n' });
  const z2 = await waitZ((m) => m.type === 'term-out' && probe(2).test(String(m.data)), '重启后尺寸');
  const size2 = probe(2).exec(String(z2.data)).slice(1).join('x');
  if (size1 !== '40x120') fail(`resize 到 120x40 后 stty size 应为 40x120,实为 ${size1}(夹取/下发有误)`);
  if (size2 !== size1) fail(`重启后 shell 尺寸回退:${size2}(应等于 ${size1})—— term-resize 没回写 entry.cols/rows`);
  rawSend(wsZ, { type: 'term-close', id: 'z1', generation: rz.generation });
  await waitZ((m) => m.type === 'term-closed' && m.id === 'z1', 'z1 关闭');
  wsZ.close();
  await new Promise((r) => setTimeout(r, 300));
}

// 10) status 契约:maxTerminals=4
const st2 = await status();
if (st2.maxTerminals !== 4) fail(`status 应带 maxTerminals=4,实为 ${st2.maxTerminals}`);

ws1.close(); ws2.close(); ws3.close();
server.kill();
console.log('check-terminal-pty: 全部断言通过 ✓(v3 身份/分离/回放/错误码/显式关闭才杀)');
process.exit(0);
