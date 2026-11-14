// r184 · 各用例共用的小工具:临时家目录、写偏好文件、预置会话文件、起/停隔离后端、取 JSON。
// 只走对外接口(HTTP)与隔离家目录里的数据文件;不 import 任何产品模块。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const WORKTREE = path.resolve(here, '../../../..');
const noOutboundUrl = pathToFileURL(path.join(here, 'no-outbound.mjs')).href;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FORBIDDEN = new Set([6677, 6689, 6710, 8788, 8789, 8798, 8799]);
const STRIP = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'CGUI_ENABLE_LOCAL_ROUTES'];

/** 新建一个临时根目录(系统临时目录下,不递归删除,留给系统清理)。 */
export function tmpRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `r184-${label}-`));
}

/** 在 root 下建家目录(含 .claude/projects 与 .claude-gui),返回家目录路径。 */
export function buildHome(root, name = 'home') {
  const home = path.join(root, name);
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude-gui'), { recursive: true });
  return home;
}

export const prefsFile = (home) => path.join(home, '.claude-gui', 'prefs.json');
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** 直接往 prefs.json 写字节。content 可以是对象(序列化成合法 JSON)或原样字符串(坏 JSON)。bom=true 时前面加 EF BB BF。 */
export function writePrefs(home, content, { bom }) {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  const body = Buffer.from(text, 'utf8');
  fs.writeFileSync(prefsFile(home), bom ? Buffer.concat([BOM, body]) : body);
}

export const projectDir = (home, name) => path.join(home, '.claude', 'projects', name);

export function userLine(sessionId, text, ts = new Date().toISOString()) {
  return JSON.stringify({ type: 'user', uuid: `u-${sessionId}-${Math.random().toString(36).slice(2, 8)}`, timestamp: ts, sessionId, message: { role: 'user', content: text } });
}

export function assistantLine(sessionId, msgId, outputTokens, ts = new Date().toISOString()) {
  return JSON.stringify({
    type: 'assistant', uuid: `a-${sessionId}-${msgId}`, timestamp: ts, sessionId,
    message: {
      id: msgId, role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: '好的' }],
      usage: { input_tokens: 10, output_tokens: outputTokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  });
}

/** 在 file 处写一个会话文件(每行一个 JSON 对象)。 */
export function writeSession(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
}

function freePort(start) {
  return new Promise((resolve, reject) => {
    const tryPort = (p) => {
      if (p > 6999) { reject(new Error('6700–6999 没有空闲端口')); return; }
      if (FORBIDDEN.has(p)) { tryPort(p + 1); return; }
      const s = net.createServer();
      s.once('error', () => tryPort(p + 1));
      s.listen(p, '127.0.0.1', () => s.close(() => resolve(p)));
    };
    tryPort(start);
  });
}

/**
 * 起一个隔离的真后端(server/index.js)。家目录必须已建好、数据文件已放好。
 * 返回 { pid, port, base, home, log(), stop() };stop 先 SIGTERM,2 秒后还在就 SIGKILL。
 */
export async function startBackend({ root, home, label = 'backend', healthTimeoutMs = 40_000 }) {
  const port = await freePort(6700 + Math.floor(Math.random() * 250));
  const logPath = path.join(root, `${label}.log`);
  const fd = fs.openSync(logPath, 'a');
  const childEnv = {
    ...process.env,
    HOME: home, USERPROFILE: home, PORT: String(port),
    CGUI_DISABLE_FILE_WATCHER: '1', DISABLE_AUTOUPDATER: '1',
    NODE_OPTIONS: `--import=${noOutboundUrl}`,
    R184_BLOCKED_LOG: path.join(root, `${label}.blocked.log`),
  };
  for (const k of STRIP) delete childEnv[k];
  const child = spawn(process.execPath, [path.join(WORKTREE, 'server', 'index.js')], { cwd: root, env: childEnv, stdio: ['ignore', fd, fd] });
  let exited = false;
  const pidFile = process.env.R184_PID_DIR ? path.join(process.env.R184_PID_DIR, `pid-${child.pid}`) : null;
  if (pidFile) { try { fs.writeFileSync(pidFile, String(child.pid)); } catch { /* 忽略 */ } }
  child.on('exit', () => {
    exited = true;
    try { fs.closeSync(fd); } catch { /* 忽略 */ }
    if (pidFile) { try { fs.unlinkSync(pidFile); } catch { /* 忽略 */ } }
  });
  const base = `http://127.0.0.1:${port}`;
  const handle = {
    pid: child.pid, port, base, home, logPath,
    log: () => { try { return fs.readFileSync(logPath, 'utf8'); } catch { return ''; } },
    async stop() {
      if (exited) return;
      child.kill('SIGTERM');
      for (let i = 0; i < 20 && !exited; i += 1) await sleep(100);
      if (!exited) { child.kill('SIGKILL'); for (let i = 0; i < 30 && !exited; i += 1) await sleep(100); }
    },
  };
  const deadline = Date.now() + healthTimeoutMs;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`后端 ${label} 起来就退出了:看 ${logPath}`);
    try {
      const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return handle;
    } catch { /* 还没起来 */ }
    await sleep(150);
  }
  await handle.stop();
  throw new Error(`后端 ${label}(pid ${child.pid},端口 ${port})${healthTimeoutMs}ms 内没就绪:看 ${logPath}`);
}

/** GET 一个接口并解析 JSON。超时抛出带说明的错误。 */
export async function getJson(base, url, timeoutMs = 15_000) {
  const res = await fetch(base + url, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, text, json };
}
