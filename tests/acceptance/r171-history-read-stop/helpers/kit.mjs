// r171 验收助手:一次性隔离后端、普通会话夹具、「读不完的会话文件」(命名管道 + 写入进程)。
// 只走 HTTP 与文件系统,不 import 产品代码。每个用例自己起后端、自己收尾。
// 端口只在 6700–6799 里挑空闲的,硬拒 6677 / 6689 / 6710 / 8798 / 8799。
// 收尾只按自己记录的进程号:后端、写入进程;pid 同时追加到 <运行目录>/pids.txt,供 run.sh 兜底收尾。
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SUITE = path.resolve(here, '..');
export const WORKTREE = path.resolve(SUITE, '..', '..', '..');
export const RUN_ROOT = process.env.R171_RUN_ROOT || path.join(SUITE, '.artifacts', 'runs', `adhoc-${process.pid}`);
const PRELOAD = path.join(WORKTREE, 'tests', 'unit', 'q8-helpers', 'cu-preload.mjs');
const FORBIDDEN_PORTS = [6677, 6689, 6710, 8798, 8799];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const uuid = () => crypto.randomUUID();
export const encodeProjectDir = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');

function recordPid(pid) {
  fs.mkdirSync(RUN_ROOT, { recursive: true });
  fs.appendFileSync(path.join(RUN_ROOT, 'pids.txt'), `${pid}\n`);
}

const canListen = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
});

async function freePort() {
  for (let p = 6799; p >= 6700; p -= 1) {
    if (FORBIDDEN_PORTS.includes(p)) continue;
    if (await canListen(p)) return p;
  }
  throw new Error('6700–6799 没有空闲端口');
}

/** 只回应版本查询的 claude 垫片(后端启动时会探测 claude)。 */
function writeShim(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const shim = path.join(dir, 'claude');
  fs.writeFileSync(shim, '#!/bin/sh\ncase "$1" in\n  --version|-v|version) echo "2.1.296 (Claude Code)"; exit 0;;\nesac\nexit 0\n');
  fs.chmodSync(shim, 0o755);
}

/**
 * 起一个一次性隔离后端。返回 { base, home, pid, errLog, outLog, makeWorkspace(name), stop() }。
 * 夹具工作区在运行目录下(不在 /tmp 下)。
 */
export async function startBackend(tag) {
  const root = path.join(RUN_ROOT, `${tag}-${Date.now().toString(36)}`);
  const home = path.join(root, 'home');
  const ctl = path.join(home, 'fake-claude');
  const tmp = path.join(root, 'tmp');
  const fakebin = path.join(root, 'fakebin');
  for (const d of [path.join(home, '.claude-gui'), path.join(home, '.claude', 'projects'), ctl, tmp, path.join(root, 'ws')]) fs.mkdirSync(d, { recursive: true });
  writeShim(fakebin);
  const version = JSON.parse(fs.readFileSync(path.join(WORKTREE, 'package.json'), 'utf8')).version;
  fs.writeFileSync(path.join(home, '.claude-gui', 'prefs.json'), JSON.stringify({ releaseNotesSeen: version }, null, 2));
  fs.writeFileSync(path.join(home, '.claude-gui', 'permission-guide-shown.flag'), '2026-09-15T00:00:00.000Z');
  fs.writeFileSync(path.join(home, '.claude-gui', 'network.json'), JSON.stringify({ host: '127.0.0.1' }));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ env: {} }, null, 2));

  const port = await freePort();
  const outLog = path.join(root, `server-${port}.out.log`);
  const errLog = path.join(root, `server-${port}.err.log`);
  const outFd = fs.openSync(outLog, 'a');
  const errFd = fs.openSync(errLog, 'a');
  // 干净环境:不继承宿主的任何 ANTHROPIC_*;不设 CGUI_ENABLE_LOCAL_ROUTES。
  const env = {
    PATH: `${fakebin}:${process.env.PATH}`, HOME: home, USERPROFILE: home,
    USER: os.userInfo().username, LOGNAME: os.userInfo().username, SHELL: '/bin/sh', LANG: 'en_US.UTF-8',
    TMPDIR: tmp, PORT: String(port), CGUI_FAKE_CLAUDE_DIR: ctl, CGUI_DISABLE_FILE_WATCHER: '1', CU_TEST_HOME: home,
  };
  const child = spawn(process.execPath, ['--import', pathToFileURL(PRELOAD).href, path.join(WORKTREE, 'server', 'index.js')], {
    cwd: root, env, stdio: ['ignore', outFd, errFd],
  });
  recordPid(child.pid);
  const exited = new Promise((r) => child.once('exit', r));
  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  for (;;) {
    if (child.exitCode !== null) throw new Error(`后端已退出,看 ${errLog}`);
    try { const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2_000) }); if (r.ok) break; } catch { /* 还没起来 */ }
    if (Date.now() - t0 > 40_000) { child.kill('SIGKILL'); throw new Error(`后端 40 秒没起来,看 ${errLog}`); }
    await sleep(300);
  }

  const inst = { base, home, root, port, pid: child.pid, errLog, outLog };
  inst.makeWorkspace = (name) => {
    const dir = path.join(root, 'ws', name);
    fs.mkdirSync(dir, { recursive: true });
    return fs.realpathSync(dir);
  };
  inst.stop = async () => {
    if (child.exitCode !== null) return;
    try { process.kill(child.pid, 'SIGTERM'); } catch { return; }
    const done = await Promise.race([exited.then(() => true), sleep(8_000).then(() => false)]);
    if (!done) { try { process.kill(child.pid, 'SIGKILL'); } catch { /* 已退 */ } await exited; }
  };
  return inst;
}

/** 普通会话:summary + user/assistant 交替,count 必须是偶数;每条 assistant 带固定 usage。 */
export function seedNormalSession(inst, name, count) {
  if (count % 2 !== 0) throw new Error('count 必须是偶数');
  const sid = uuid();
  const cwd = inst.makeWorkspace(name);
  const projectHash = encodeProjectDir(cwd);
  const dir = path.join(inst.home, '.claude', 'projects', projectHash);
  fs.mkdirSync(dir, { recursive: true });
  const base = { isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: '2.1.296', gitBranch: '' };
  const t0 = Date.parse('2026-10-01T08:00:00.000Z');
  const texts = Array.from({ length: count }, (_, i) => `R171-${name}-${String(i).padStart(3, '0')}`);
  const lines = [{ type: 'summary', summary: `R171 ${name} ${count}`, leafUuid: `${sid}-a${count / 2 - 1}` }];
  for (let i = 0; i < count / 2; i += 1) {
    lines.push({ ...base, type: 'user', uuid: `${sid}-u${i}`, parentUuid: i ? `${sid}-a${i - 1}` : null, timestamp: new Date(t0 + i * 2000).toISOString(), message: { role: 'user', content: texts[i * 2] } });
    lines.push({
      ...base, type: 'assistant', uuid: `${sid}-a${i}`, parentUuid: `${sid}-u${i}`, timestamp: new Date(t0 + i * 2000 + 1000).toISOString(),
      requestId: `req_${sid.slice(0, 8)}_${String(i).padStart(4, '0')}`,
      message: {
        id: `msg_${sid.slice(0, 8)}_${String(i).padStart(4, '0')}`, type: 'message', role: 'assistant', model: 'r171-chat',
        content: [{ type: 'text', text: texts[i * 2 + 1] }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    });
  }
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { sid, cwd, projectHash, texts };
}

/**
 * 「读不完的会话文件」:把 <home>/.claude/projects/<hash>/<sid>.jsonl 建成命名管道,
 * 起写入进程(每 300ms 写一行,一直不结束)。必须在后端起来之后调用。
 * 返回 { sid, projectHash, readState(), stop() };stop() 结束写入进程并删掉管道文件。
 */
export function startStuckSession(inst, name) {
  const sid = uuid();
  const cwd = inst.makeWorkspace(name);
  const projectHash = encodeProjectDir(cwd);
  const dir = path.join(inst.home, '.claude', 'projects', projectHash);
  fs.mkdirSync(dir, { recursive: true });
  const fifoPath = path.join(dir, `${sid}.jsonl`);
  execFileSync('/usr/bin/mkfifo', [fifoPath]);
  const writerStatePath = path.join(inst.root, `writer-${sid}.json`);
  const writer = spawn(process.execPath, [path.join(here, 'fifo-writer.mjs'), fifoPath, writerStatePath, sid, cwd], { stdio: 'ignore' });
  recordPid(writer.pid);
  const exited = new Promise((r) => writer.once('exit', r));
  const readState = () => {
    try { return JSON.parse(fs.readFileSync(writerStatePath, 'utf8')); } catch { return { opened: false, error: null, writes: 0 }; }
  };
  const stop = async () => {
    if (writer.exitCode === null && writer.signalCode === null) {
      try { process.kill(writer.pid, 'SIGKILL'); } catch { /* 已退 */ }
      await Promise.race([exited, sleep(3_000)]);
    }
    try { fs.unlinkSync(fifoPath); } catch { /* 已删 */ }
  };
  return { sid, projectHash, readState, stop };
}

/** 轮询直到 fn 返回真值,返回它;超时返回 null。 */
export async function waitFor(fn, ms, step = 100) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(step);
  }
}

/** GET /api/sessions/:sid/messages,可传 signal;返回 { status, body, text, elapsedMs }。 */
export async function getHistory(base, sid, projectHash, { limit, signal } = {}) {
  const u = new URLSearchParams({ projectHash });
  if (limit !== undefined) u.set('limit', String(limit));
  const t0 = Date.now();
  const r = await fetch(`${base}/api/sessions/${encodeURIComponent(sid)}/messages?${u}`, { signal: signal || AbortSignal.timeout(40_000) });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { status: r.status, body, text, elapsedMs: Date.now() - t0 };
}

export const messageText = (m) => {
  const raw = m && (m.text !== undefined ? m.text : m.displayText);
  if (Array.isArray(raw)) return raw.join('');
  return raw === undefined || raw === null ? '' : String(raw);
};
