#!/usr/bin/env node
// r145 F2:MCP 在界面关掉再打开(PUT /mcp/:name/disable → /enable)之后,配置必须与禁用前完全一致:
// command / args(含带空格的单个参数)/ env / headers / scope。此前禁用只从 `claude mcp get` 的文本里抠
// Command 与 Args(按空白切),不存 env;启用只拼 `mcp add -- cmd ...args`,不带 -e —— 带 `-e KEY=VALUE`
// 的 stdio MCP 往返一次环境变量(多为密钥)永久丢失,带空格的参数被拆成几个。
// 另:disabled-mcp.json 读不出时被当 {},下一次禁用把此前所有禁用项冲掉 —— 修好后应拒写并报错。
//
// 做法:PATH 前挂一个假 claude,按本机 CLI 2.1.293 实抓的形态模拟 `mcp get / remove / add / add-json / list`,
// 真实读写临时 HOME 下的 ~/.claude.json(user 顶层 mcpServers;local 记在 projects[cwd].mcpServers),并把
// 每次 argv 记进日志。断言只看"往返前后 ~/.claude.json 里该条目是否深度相等、仍在原 scope",不绑定
// 实现走 add 还是 add-json。express 挂 mcp 路由,端口 6700–6999。
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { isolateHome, writeFakeCommand, listenInRange, makeChecker } from './r145-helpers/common.mjs';

const { home, bin, cleanup } = isolateHome('f2');
const PROJ = join(home, 'proj');
mkdirSync(PROJ, { recursive: true });
process.chdir(PROJ);
const CWD = process.cwd(); // 物理路径(macOS 上 /var → /private/var),假 claude 与被测代码看到的是同一个
const CLAUDE_JSON = join(home, '.claude.json');
const DISABLED = join(home, '.claude', 'gui', 'disabled-mcp.json');
const LOG = join(home, 'fake-claude.log');

writeFakeCommand(bin, 'claude', String.raw`
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const home = process.env.HOME;
const CFG = join(home, '.claude.json');
const argv = process.argv.slice(2);
appendFileSync(join(home, 'fake-claude.log'), JSON.stringify(argv) + '\n');
const [sub, cmd, ...rest] = argv;
if (sub !== 'mcp') process.exit(0);
const j = existsSync(CFG) ? JSON.parse(readFileSync(CFG, 'utf8')) : {};
const save = () => writeFileSync(CFG, JSON.stringify(j, null, 2));
const cwd = process.cwd();
j.mcpServers ||= {};
j.projects ||= {};
j.projects[cwd] ||= {};
j.projects[cwd].mcpServers ||= {};
const S = { user: j.mcpServers, local: j.projects[cwd].mcpServers };
const findScope = (name) => ['local', 'user'].find((s) => S[s][name]);
const fail = (msg) => { process.stderr.write(msg + '\n'); process.exit(1); };
if (cmd === 'list') { process.stdout.write('No MCP servers configured.\n'); process.exit(0); }
if (cmd === 'get') {
  const name = rest[0]; const s = findScope(name);
  if (!s) fail('No MCP server found with name: ' + name);
  const c = S[s][name]; const type = c.type || 'stdio';
  const scopeLine = s === 'user' ? 'User config (available in all your projects)' : 'Local config (private to you in this project)';
  let out = name + ':\n  Scope: ' + scopeLine + '\n  Status: ✘ Failed to connect\n  Type: ' + type + '\n';
  if (type === 'stdio') {
    out += '  Command: ' + c.command + '\n  Args: ' + (c.args || []).join(' ') + '\n';
    const env = Object.entries(c.env || {});
    if (env.length) out += '  Environment:\n' + env.map(([k, v]) => '    ' + k + '=' + v + '\n').join('');
  } else {
    out += '  URL: ' + c.url + '\n';
    const h = Object.entries(c.headers || {});
    if (h.length) out += '  Headers:\n' + h.map(([k, v]) => '    ' + k + ': ' + v + '\n').join('');
  }
  out += '\nTo remove this server, run: claude mcp remove ' + name + ' -s ' + s + '\n';
  process.stdout.write(out); process.exit(0);
}
if (cmd === 'remove') {
  const name = rest[0]; const si = rest.indexOf('-s'); const want = si >= 0 ? rest[si + 1] : null;
  const s = want ? (S[want] && S[want][name] ? want : null) : findScope(name);
  if (!s) fail('No MCP server found with name: "' + name + '"');
  delete S[s][name]; save(); process.stdout.write('Removed MCP server ' + name + ' from ' + s + ' config\n'); process.exit(0);
}
if (cmd === 'add-json') {
  let scope = 'local'; const pos = [];
  for (let i = 0; i < rest.length; i++) { if (rest[i] === '-s' || rest[i] === '--scope') scope = rest[++i]; else pos.push(rest[i]); }
  const [name, json] = pos;
  if (!S[scope]) fail('Invalid scope: ' + scope);
  if (S[scope][name]) fail('MCP server ' + name + ' already exists in ' + scope + ' config');
  S[scope][name] = JSON.parse(json); save(); process.stdout.write('Added server ' + name + ' to ' + scope + ' config\n'); process.exit(0);
}
if (cmd === 'add') {
  // 照 commander 语义:-e / -H 是变长参数,吞到下一个以 - 开头的参数为止;-- 之后全是位置参数。
  let scope = 'local', transport = 'stdio', tail = null; const env = {}, headers = {}, pos = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--') { tail = rest.slice(i + 1); break; }
    if (a === '-s' || a === '--scope') { scope = rest[++i]; continue; }
    if (a === '-t' || a === '--transport') { transport = rest[++i]; continue; }
    if (a === '-e' || a === '--env' || a === '-H' || a === '--header') {
      const isEnv = a === '-e' || a === '--env';
      while (i + 1 < rest.length && !rest[i + 1].startsWith('-')) {
        const v = rest[++i];
        if (isEnv) { const k = v.indexOf('='); env[v.slice(0, k)] = v.slice(k + 1); }
        else { const k = v.indexOf(':'); headers[v.slice(0, k).trim()] = v.slice(k + 1).trim(); }
      }
      continue;
    }
    pos.push(a);
  }
  const name = pos[0];
  if (S[scope][name]) fail('MCP server ' + name + ' already exists in ' + scope + ' config');
  if (transport === 'stdio') {
    const parts = tail || pos.slice(1);
    S[scope][name] = { type: 'stdio', command: parts[0], args: parts.slice(1), env };
  } else {
    S[scope][name] = { type: transport, url: pos[1], ...(Object.keys(headers).length ? { headers } : {}) };
  }
  save(); process.stdout.write('Added ' + transport + ' MCP server ' + name + ' to ' + scope + ' config\n'); process.exit(0);
}
process.exit(0);
`);

const ORIGINAL = {
  mcpServers: {
    'r145-stdio': { type: 'stdio', command: '/usr/bin/true', args: ['arg with space', '--flag', 'x=1'], env: { API_KEY: 'sk-r145 secret=1', B: '2' } },
    'r145-http': { type: 'http', url: 'https://example.invalid/mcp', headers: { 'X-Key': 'abc def' } },
  },
  projects: { [CWD]: { mcpServers: { 'r145-local': { type: 'stdio', command: '/usr/bin/true', args: ['--config', 'a b.json'], env: { LOCAL_TOKEN: 't 1' } } } } },
};
writeFileSync(CLAUDE_JSON, JSON.stringify(ORIGINAL, null, 2));

const mcpRouter = (await import('../../server/routes/mcp.js')).default;
const express = (await import('express')).default;
const app = express();
app.use(express.json({ limit: '25mb' }));
app.use('/api', mcpRouter);
const httpServer = createServer(app);
const apiPort = await listenInRange(httpServer);
const BASE = `http://127.0.0.1:${apiPort}`;

async function put(path) {
  const r = await fetch(`${BASE}${path}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 保持 null */ }
  return { status: r.status, json, text };
}
const cfg = () => JSON.parse(readFileSync(CLAUDE_JSON, 'utf8'));
const entryOf = (j, scope, name) => (scope === 'user' ? j.mcpServers?.[name] : j.projects?.[CWD]?.mcpServers?.[name]);
const logLines = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

async function roundTrip(name, scope) {
  const before = structuredClone(entryOf(cfg(), scope, name));
  assert.ok(before, `夹具里没有 ${scope}:${name}`);
  const d = await put(`/api/mcp/${encodeURIComponent(name)}/disable`);
  assert.equal(d.status, 200, `禁用应 200,实际 ${d.status} ${d.text.slice(0, 200)}`);
  assert.equal(entryOf(cfg(), scope, name), undefined, '禁用后该条目应已从 CLI 配置移除');
  const e = await put(`/api/mcp/${encodeURIComponent(name)}/enable`);
  assert.equal(e.status, 200, `启用应 200,实际 ${e.status} ${e.text.slice(0, 200)}`);
  const after = entryOf(cfg(), scope, name);
  const other = entryOf(cfg(), scope === 'user' ? 'local' : 'user', name);
  assert.equal(other, undefined, `启用后跑到了别的 scope(应仍在 ${scope})`);
  assert.deepEqual(after, before, '禁用 → 启用往返后配置与禁用前不一致');
}

const { check, finish } = makeChecker('check-r145-mcp-disable-roundtrip');
let exitCode = 1;
try {
  console.log('F2 · 禁用 → 启用往返后 command / args / env / headers / scope 原样');
  await check('stdio(user):带空格的参数不被拆、-e 环境变量(值含空格与 =)不丢', () => roundTrip('r145-stdio', 'user'));
  await check('http(user):URL 与请求头原样', () => roundTrip('r145-http', 'user'));
  await check('stdio(local):scope 不变、env 与带空格参数原样', () => roundTrip('r145-local', 'local'));

  console.log('F2 · disabled-mcp.json 读不出时拒绝写入,不冲掉此前的禁用项');
  await check('disabled 表半截 → 禁用请求报错;表逐字节不变;没有去 remove 该 MCP', async () => {
    mkdirSync(join(home, '.claude', 'gui'), { recursive: true });
    const broken = '{\n  "earlier-disabled": { "name": "earlier-disabled", "command": "/usr/bin/true", "args": [] },\n  "anot';
    writeFileSync(DISABLED, broken);
    const before = readFileSync(DISABLED);
    const logBefore = logLines().length;
    const r = await put('/api/mcp/r145-stdio/disable');
    assert.ok(r.status >= 400, `应报错(非 2xx),实际 ${r.status}`);
    assert.ok(readFileSync(DISABLED).equals(before), 'disabled-mcp.json 被改写了(此前的禁用项被冲掉)');
    const removes = logLines().slice(logBefore).filter((a) => a[0] === 'mcp' && a[1] === 'remove');
    assert.deepEqual(removes, [], '表都没记上就去 remove 了该 MCP(配置会永久丢失)');
    assert.ok(entryOf(cfg(), 'user', 'r145-stdio'), 'MCP 条目被移除了');
  });

  exitCode = finish();
} finally {
  process.chdir(home);
  cleanup();
}
// mcp.js 模块顶层有 8s / 9s 的启动预热定时器(未 unref):显式退出。
process.exit(exitCode);
