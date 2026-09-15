#!/usr/bin/env node
// Q8 审查项 13(进程在首条事件前退出,被误报成"15 秒未初始化,请勿重发"):
//   a. 进程已经死了的 POST /api/chat 不得回 504 CHAT_START_TIMEOUT(修前应红)
//   b. 文案不得是"内容可能稍后到达,请勿据此重发"(用户此时必须看错误、修配置后重发)(修前应红)
//   c. 真实错误必须送到调用方:要么在 POST 的错误体里,要么(若改回"有 pid 就回 200")在 SSE 里以 error 事件到达(修前应红)
//   d. 反向:进程真的 15 秒不开口时,仍是 504 CHAT_START_TIMEOUT + "请勿据此重发"(修前应绿,约 15 秒)
//   e. 反向:进程一死 POST 就应立刻返回(≤10s),不是干等满 15 秒(修前应绿)
// 由 run-isolated.sh 起:本脚本自己 spawn 隔离实例(临时 HOME + PATH 上的假 claude),按 pid 收尾。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeReport, sleep } from '../../unit/q8-helpers/report.mjs';

const SUITE = path.dirname(fileURLToPath(import.meta.url));
const WORKTREE = process.env.WORKTREE || path.resolve(SUITE, '..', '..', '..');
const PORT = Number(process.env.Q8_PORT);
if (!Number.isInteger(PORT) || PORT < 6700 || PORT > 6999 || [6677, 6689, 6710].includes(PORT)) {
  console.error(`拒绝:Q8_PORT=${process.env.Q8_PORT} 不在 6700–6999 或撞上用户/他项目端口(6677/6689/6710);请用 run-isolated.sh 起`);
  process.exit(2);
}

const ROOT = path.join(SUITE, '.artifacts', 'runtime-data');
fs.rmSync(ROOT, { recursive: true, force: true });
const home = path.join(ROOT, 'home');
const ctl = path.join(home, 'fake-claude');
const proj = path.join(ROOT, 'project');
const fakebin = path.join(SUITE, '.artifacts', 'fakebin');
for (const d of [path.join(home, '.claude'), path.join(home, '.claude-gui'), ctl, proj, fakebin]) fs.mkdirSync(d, { recursive: true });
const shim = path.join(fakebin, 'claude');
fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${path.join(SUITE, 'helpers', 'fake-claude-earlyexit.mjs')}" "$@"\n`);
fs.chmodSync(shim, 0o755);
fs.writeFileSync(path.join(ctl, 'mode'), 'exit');

const env = { ...process.env };
for (const k of Object.keys(env)) if (/^ANTHROPIC_|^CLAUDE_CODE_OAUTH_TOKEN$/.test(k)) delete env[k];
Object.assign(env, {
  PORT: String(PORT), HOST: '127.0.0.1', HOME: home, USERPROFILE: home, // 只绑回环:测试实例不暴露到局域网
  // 显式列全 index.js 会前置的目录,保证假 claude 恒在最前
  PATH: [fakebin, '/opt/homebrew/bin', '/usr/local/bin', '/usr/local/git/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
  CGUI_FAKE_CLAUDE_DIR: ctl, CGUI_DISABLE_FILE_WATCHER: '1', NODE_ENV: 'production',
});
const logFile = path.join(ROOT, 'server.log');
const logFd = fs.openSync(logFile, 'w');
const server = spawn(process.execPath, [path.join(WORKTREE, 'server', 'index.js')], { cwd: WORKTREE, env, stdio: ['ignore', logFd, logFd] });
const base = `http://127.0.0.1:${PORT}`;
console.log(`[q8-13] 隔离实例 pid=${server.pid} port=${PORT} HOME=${home}`);

async function waitHealthy() {
  const t0 = Date.now();
  while (Date.now() - t0 < 40_000) {
    if (server.exitCode !== null) break;
    try { const r = await fetch(`${base}/api/health`); if (r.ok) return; } catch { /* 还没起 */ }
    await sleep(300);
  }
  throw new Error(`隔离实例没起来:${fs.readFileSync(logFile, 'utf8').slice(-1500)}`);
}

async function postChat(clientTurnId) {
  const t0 = Date.now();
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'Q8 探测:进程早退', cwd: proj, clientTurnId, createdAt: Date.now() }),
  });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body, ms: Date.now() - t0 };
}

/** 读 SSE 最多 timeoutMs,返回解析出的事件列表。 */
async function readStream(pid, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const events = [];
  try {
    const res = await fetch(`${base}/api/chat/${pid}/stream`, { signal: ac.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        for (const l of frame.split('\n')) if (l.startsWith('data: ')) { try { events.push(JSON.parse(l.slice(6))); } catch { /* 心跳等 */ } }
      }
      if (events.some((e) => e.type === 'done')) break;
    }
  } catch { /* abort / 结束 */ } finally { clearTimeout(timer); }
  return events;
}

const MARKER = /Q8_FAKE_BOOT_FAILURE|exited with code 7|code 7/i;
const report = makeReport('q13-early-exit');
try {
  await waitHealthy();
  const r = await postChat('q8-13-early');
  const summary = `status=${r.status} code=${r.body?.code} error=${String(r.body?.error || '').slice(0, 140)} (${r.ms}ms)`;

  await report.check('Q8-13a', '进程首条事件前已退出:POST /api/chat 不得回 504 CHAT_START_TIMEOUT', 'red', async () => {
    assert.ok(!(r.status === 504 && r.body?.code === 'CHAT_START_TIMEOUT'), `把"已经死了"报成了"还在初始化": ${summary}`);
  });
  await report.check('Q8-13b', '进程已死时文案不得是"内容可能稍后到达,请勿据此重发"', 'red', async () => {
    assert.doesNotMatch(String(r.body?.error || ''), /请勿据此重发/, `文案让用户别重发,但进程已死、必须修配置后重发: ${summary}`);
  });
  await report.check('Q8-13c', '真实失败原因必须送到调用方(错误体或 SSE error 事件里含 CLI 的退出原因)', 'red', async () => {
    if (r.body && r.body.ok === false) {
      assert.match(String(r.body.error || ''), MARKER, `错误体里没有真实原因: ${summary}`);
      return;
    }
    assert.ok(r.body?.pid, `既不是错误体也没有 pid 可 attach: ${summary}`);
    const events = await readStream(r.body.pid, 6_000);
    const err = events.find((e) => e.type === 'error' && MARKER.test(String(e.error || '')));
    assert.ok(err, `SSE 里没有带真实原因的 error 事件;收到: ${JSON.stringify(events).slice(0, 300)}`);
  });
  await report.check('Q8-13e', '反向:进程一死 POST 就应立刻返回(≤10s),不是干等满 15 秒', 'green', async () => {
    assert.ok(r.ms <= 10_000, `POST 耗时 ${r.ms}ms`);
  });

  fs.writeFileSync(path.join(ctl, 'mode'), 'hang');
  const h = await postChat('q8-13-hang');
  await report.check('Q8-13d', '反向:进程真的 15 秒不开口 → 仍是 504 CHAT_START_TIMEOUT + "请勿据此重发"', 'green', async () => {
    assert.equal(h.status, 504, `status=${h.status} body=${JSON.stringify(h.body).slice(0, 200)}`);
    assert.equal(h.body?.code, 'CHAT_START_TIMEOUT');
    assert.match(String(h.body?.error || ''), /请勿据此重发/);
    assert.ok(h.ms >= 14_000 && h.ms <= 18_000, `应在 15s 上下返回,实际 ${h.ms}ms`);
  });
} catch (e) {
  console.log(`✗ 环境/夹具异常: ${e.message}`);
  report.cases.push({ id: 'Q8-13', title: '夹具异常', expectation: 'red', ok: false, error: e.message });
} finally {
  server.kill('SIGTERM');
  await new Promise((r) => { server.once('exit', r); setTimeout(r, 3000); });
  if (server.exitCode === null) { try { server.kill('SIGKILL'); } catch { /* 已退出 */ } }
  console.log(`[q8-13] 实例已收尾(pid ${server.pid});日志 ${logFile}`);
}
process.exit(report.finish());
