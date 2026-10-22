// r151m 验收夹具:黑盒调用接口文件列出的公开入口(startOpenAIProxy / setOpenAIUpstream /
// startAnthropicProxy / setAnthropicUpstream),上游用本进程内的假 HTTP 服务。
// 不 import 产品内部模块;代理实现只在公开入口后面被调用。
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SUITE_DIR = path.resolve(HERE, '..');
export const REPO_ROOT = path.resolve(SUITE_DIR, '../../..');

// 只在本套件里使用的哨兵,用于验证日志不泄露;同时也作为假上游收到的凭据。
export const OPENAI_KEY = 'sk-r151m-openai-secret-4f8a7c';
export const ANTHROPIC_TOKEN = 'tok-r151m-anthropic-secret-9c2d1b';
export const CLIENT_KEY = 'client-side-r151m-key';

const PORT_MIN = 6700;
const PORT_MAX = 6999;
// 本机常驻/其它套件端口,一律不碰。
const FORBIDDEN = new Set([6677, 6689, 6710, 8788, 8789, 8798, 8799, 8000]);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function canBind(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      srv.close(() => resolve(true));
    });
  });
}

// 在 6700–6999 里找一个当前能 bind 的端口。base 让不同用例的端口段错开,
// 顺序跑、任意顺序跑都不容易撞上 TIME_WAIT 或残留监听。
export async function pickPort({ base = PORT_MIN, exclude = [] } = {}) {
  const span = PORT_MAX - PORT_MIN + 1;
  const start = ((base - PORT_MIN) % span + span) % span;
  const used = new Set(exclude);
  for (let i = 0; i < span; i += 1) {
    const port = PORT_MIN + ((start + i) % span);
    if (FORBIDDEN.has(port) || used.has(port)) continue;
    if (await canBind(port)) return port;
  }
  throw new Error('6700-6999 内没有可用端口(或全被占用)');
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function requestPath(url) {
  try {
    return new URL(url, 'http://fake-upstream.local').pathname;
  } catch {
    return url;
  }
}

function sendJSON(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// OpenAI 形态假上游:POST /chat/completions;记录 body,返回合法非流式响应或 SSE。
function respondOpenAI(req, res, json) {
  const model = typeof json?.model === 'string' ? json.model : 'unknown';
  if (json?.stream === true) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const chunk = (delta, finishReason = null, usage) => {
      const obj = {
        id: 'chatcmpl-r151m',
        object: 'chat.completion.chunk',
        created: 1700000000,
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      };
      if (usage) obj.usage = usage;
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };
    chunk({ role: 'assistant', content: '' });
    chunk({ content: 'stream-fake-ok' });
    chunk({}, 'stop', { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }
  sendJSON(res, 200, {
    id: 'chatcmpl-r151m',
    object: 'chat.completion',
    created: 1700000000,
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'openai-fake-ok' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
  });
}

// Anthropic 形态假上游:POST /v1/messages;记录 body,返回合法 Anthropic 响应。
function respondAnthropic(req, res, json) {
  const model = typeof json?.model === 'string' ? json.model : 'unknown';
  sendJSON(res, 200, {
    id: 'msg_r151m',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: 'anthropic-fake-ok' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 7, output_tokens: 3 },
  });
}

export async function startFakeUpstream({ port, shape }) {
  const records = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      let json = null;
      try {
        json = raw ? JSON.parse(raw) : null;
      } catch {
        json = null;
      }
      const pathname = requestPath(req.url);
      records.push({
        method: req.method,
        url: req.url,
        path: pathname,
        headers: { ...req.headers },
        raw,
        json,
      });
      if (shape === 'openai' && req.method === 'POST' && pathname.endsWith('/chat/completions')) {
        respondOpenAI(req, res, json);
        return;
      }
      if (shape === 'anthropic' && req.method === 'POST' && pathname === '/v1/messages') {
        respondAnthropic(req, res, json);
        return;
      }
      sendJSON(res, 404, {
        error: {
          type: 'not_found',
          message: `fake ${shape} upstream got ${req.method} ${pathname}`,
        },
      });
    });
  });
  await listen(server, port);
  return {
    shape,
    port,
    url: `http://127.0.0.1:${port}`,
    records,
    async close() {
      await new Promise((resolve) => {
        server.close(() => resolve());
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      });
    },
  };
}

// 家目录隔离守卫(r151q)。代理在"claude 名不在模型列表里"时会读家目录下的 .claude/settings.json 决定映射目标,
// 所以用例进程的 HOME(Windows 还有 USERPROFILE)必须指到临时目录:既不能等于真实家目录,
// 也不能没设(没设时 os.homedir() 会回落到真实家目录)。返回 null = 通过;返回字符串 = 拒绝原因。
function canonicalPath(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

export function homeIsolationProblem(env = process.env) {
  const realHome = canonicalPath(os.userInfo().homedir);
  const keys = process.platform === 'win32' ? ['HOME', 'USERPROFILE'] : ['HOME'];
  for (const key of keys) {
    const value = env[key];
    if (!value) {
      return `拒绝运行:${key} 没有设置(会回落到真实家目录 ${realHome});请用 ${key}=<临时目录> 启动`;
    }
    if (canonicalPath(value) === realHome) {
      return `拒绝运行:${key} 指向真实家目录 ${realHome};请用 ${key}=<临时目录> 启动`;
    }
  }
  return null;
}

const modules = new Map();
async function loadProxyModule(kind) {
  if (!modules.has(kind)) {
    const file = kind === 'openai' ? 'openai-proxy.js' : 'anthropic-proxy.js';
    modules.set(
      kind,
      await import(pathToFileURL(path.join(REPO_ROOT, 'server/services', file)).href),
    );
  }
  return modules.get(kind);
}

function connectOnce(port, timeoutMs = 300) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('connect timeout'));
    }, timeoutMs);
    sock.once('connect', () => {
      clearTimeout(timer);
      sock.destroy();
      resolve();
    });
    sock.once('error', (err) => {
      clearTimeout(timer);
      sock.destroy();
      reject(err);
    });
  });
}

async function waitForPort(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      await connectOnce(port);
      return;
    } catch (err) {
      lastErr = err;
      await sleep(40);
    }
  }
  throw new Error(`代理端口 ${port} 未在 ${timeoutMs}ms 内监听:${lastErr?.message || 'unknown'}`);
}

// 只调用接口文件里的 start* / set* 入口。
export async function startProxy(kind, port) {
  const mod = await loadProxyModule(kind);
  if (kind === 'openai') {
    const ret = mod.startOpenAIProxy(port);
    if (ret && typeof ret.then === 'function') await ret;
  } else {
    const ret = mod.startAnthropicProxy(port);
    if (ret && typeof ret.then === 'function') await ret;
  }
  await waitForPort(port);
}

export async function setOpenAIUpstream(config) {
  const mod = await loadProxyModule('openai');
  mod.setOpenAIUpstream(config);
}

export async function setAnthropicUpstream(config) {
  const mod = await loadProxyModule('anthropic');
  mod.setAnthropicUpstream(config);
}

function recordPorts(ctx, pairs) {
  if (!ctx.artifactDir) return;
  fs.mkdirSync(ctx.artifactDir, { recursive: true });
  fs.appendFileSync(
    path.join(ctx.artifactDir, 'ports.txt'),
    pairs.map(([kind, port]) => `${ctx.caseId} ${kind} ${port}\n`).join(''),
  );
}

// 每个用例进程一个 context:同一形态的代理/假上游只起一次,set*Upstream 每次重设。
// 代理没有公开 close 入口,所以靠用例进程退出收端口;run.sh 只按记录 pid 收进程。
export async function createContext({ caseId, artifactDir }) {
  // 守卫:case.mjs 被单独直跑(node case.mjs N)时也要过这一关,HOME 没指到临时目录就不跑用例。
  const homeProblem = homeIsolationProblem();
  if (homeProblem) throw new Error(homeProblem);
  const used = new Set();
  const base = PORT_MIN + (((caseId - 1) * 8) % (PORT_MAX - PORT_MIN + 1));

  const ctx = {
    caseId,
    artifactDir,
    checker: new Checker(caseId),
    openai: null,
    anthropic: null,

    async prepareOpenAI(opts = {}) {
      if (!ctx.openai) {
        const fakePort = await pickPort({ base, exclude: [...used] });
        used.add(fakePort);
        const fake = await startFakeUpstream({ port: fakePort, shape: 'openai' });
        const proxyPort = await pickPort({ base, exclude: [...used] });
        used.add(proxyPort);
        await startProxy('openai', proxyPort);
        ctx.openai = { fake, proxyPort, base: `http://127.0.0.1:${proxyPort}` };
        recordPorts(ctx, [
          ['fake-openai', fakePort],
          ['openai-proxy', proxyPort],
        ]);
      }
      const cfg = { baseURL: ctx.openai.fake.url, apiKey: OPENAI_KEY };
      if (Object.prototype.hasOwnProperty.call(opts, 'model')) cfg.model = opts.model;
      if (Object.prototype.hasOwnProperty.call(opts, 'models')) cfg.models = opts.models;
      await setOpenAIUpstream(cfg);
      ctx.openai.fake.records.length = 0;
      return ctx.openai;
    },

    async prepareAnthropic(opts = {}) {
      if (!ctx.anthropic) {
        const fakePort = await pickPort({ base, exclude: [...used] });
        used.add(fakePort);
        const fake = await startFakeUpstream({ port: fakePort, shape: 'anthropic' });
        const proxyPort = await pickPort({ base, exclude: [...used] });
        used.add(proxyPort);
        await startProxy('anthropic', proxyPort);
        ctx.anthropic = { fake, proxyPort, base: `http://127.0.0.1:${proxyPort}` };
        recordPorts(ctx, [
          ['fake-anthropic', fakePort],
          ['anthropic-proxy', proxyPort],
        ]);
      }
      const cfg = { baseURL: ctx.anthropic.fake.url, authToken: ANTHROPIC_TOKEN };
      if (Object.prototype.hasOwnProperty.call(opts, 'model')) cfg.model = opts.model;
      if (Object.prototype.hasOwnProperty.call(opts, 'models')) cfg.models = opts.models;
      await setAnthropicUpstream(cfg);
      ctx.anthropic.fake.records.length = 0;
      return ctx.anthropic;
    },

    async cleanup() {
      for (const upstream of [ctx.openai?.fake, ctx.anthropic?.fake]) {
        if (upstream) await upstream.close();
      }
    },
  };
  return ctx;
}

function fmt(value) {
  if (typeof value === 'string') return JSON.stringify(value.length > 400 ? `${value.slice(0, 400)}…` : value);
  try {
    const s = JSON.stringify(value);
    if (s === undefined) return String(value);
    return s.length > 400 ? `${s.slice(0, 400)}…` : s;
  } catch {
    return String(value);
  }
}

function same(a, b) {
  if (Object.is(a, b)) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

export class Checker {
  constructor(caseId) {
    this.caseId = caseId;
    this.items = [];
  }

  pass(label, detail = '') {
    this.items.push({ ok: true, label, detail });
  }

  fail(label, actual, expected) {
    this.items.push({
      ok: false,
      label,
      detail: `expected=${fmt(expected)} actual=${fmt(actual)}`,
    });
  }

  check(label, cond, actual, expected) {
    if (cond) this.pass(label, `actual=${fmt(actual)}`);
    else this.fail(label, actual, expected);
  }

  equal(label, actual, expected) {
    this.check(label, same(actual, expected), actual, expected);
  }

  includes(label, haystack, needle) {
    this.check(
      label,
      typeof haystack === 'string' && haystack.includes(needle),
      haystack,
      `包含 ${needle}`,
    );
  }

  report() {
    let failed = 0;
    for (const item of this.items) {
      if (item.ok) {
        console.log(`  PASS ${item.label}${item.detail ? ` — ${item.detail}` : ''}`);
      } else {
        failed += 1;
        console.log(`  FAIL ${item.label}${item.detail ? ` — ${item.detail}` : ''}`);
      }
    }
    console.log(`[CASE ${this.caseId}] ${failed === 0 ? 'PASS' : 'FAIL'} (${this.items.length - failed}/${this.items.length} assertions)`);
    return failed === 0;
  }
}

export function makeChatBody(model, { stream = false } = {}) {
  return {
    model,
    max_tokens: 64,
    messages: [{ role: 'user', content: 'r151m acceptance ping' }],
    ...(stream ? { stream: true } : {}),
  };
}

// 客户端请求也用 node 原生 http,不依赖 fetch/外部测试框架。
export function postMessages(proxyBase, body, { timeout = 8000, headers = {} } = {}) {
  const url = new URL(`${proxyBase}/v1/messages`);
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': payload.length,
          'anthropic-version': '2023-06-01',
          'x-api-key': CLIENT_KEY,
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.setTimeout(timeout, () => {
      req.destroy(new Error(`client timeout after ${timeout}ms`));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

export function parseSSE(text) {
  const events = [];
  for (const block of text.split(/\n\n+/)) {
    let event = null;
    let data = null;
    for (const line of block.split(/\n/)) {
      if (line.startsWith('event: ')) event = line.slice(7).trim();
      else if (line.startsWith('data: ')) data = line.slice(6).trim();
    }
    if (!event && !data) continue;
    let parsed = data;
    if (data) {
      try {
        parsed = JSON.parse(data);
      } catch {
        parsed = data;
      }
    }
    events.push({ event, data: parsed });
  }
  return events;
}

// 拦截 console.* 以及直接写 stdout/stderr 的日志,用于验证“只记一次/不泄露 key”。
export function captureLogs() {
  const entries = [];
  const restores = [];
  const record = (chunk) => {
    if (typeof chunk === 'string') entries.push(chunk);
    else if (Buffer.isBuffer(chunk)) entries.push(chunk.toString('utf8'));
    else if (chunk instanceof Uint8Array) entries.push(Buffer.from(chunk).toString('utf8'));
    else entries.push(String(chunk));
  };

  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
    const original = console[method];
    restores.push(() => {
      console[method] = original;
    });
    console[method] = (...args) => {
      record(
        args
          .map((a) => (typeof a === 'string' ? a : util.inspect(a, { depth: 5, breakLength: Infinity })))
          .join(' '),
      );
      record('\n');
    };
  }

  for (const stream of ['stdout', 'stderr']) {
    const original = process[stream].write;
    restores.push(() => {
      process[stream].write = original;
    });
    process[stream].write = (chunk, encoding, callback) => {
      record(chunk);
      if (typeof encoding === 'function') encoding();
      else if (typeof callback === 'function') callback();
      return true;
    };
  }

  return {
    entries,
    text: () => entries.join(''),
    stop() {
      for (let i = restores.length - 1; i >= 0; i -= 1) restores[i]();
    },
  };
}
