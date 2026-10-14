#!/usr/bin/env node
// r151a:录 openai 协议代理的"改动前"基线。只应在**未改动**的工作树上跑一次(2026-10-14 已跑,结果提交在
// fixtures/proxy-baseline.json);实现落地后不要重录,否则基线会变成新代码的输出,"与改动前逐字节相同"就测不到东西了。
// 用法: node capture-proxy-baseline.mjs <mockPort> <proxyPort> <scratchDir>
// 自己起一份假接口 + 一份代理(端口由调用方给,须在 6700–6999),录完按 pid 收掉。录两遍,两遍不一致就报错(不确定的输出没法当基线)。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASELINE_INPUTS } from './proxy-cases.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const [mockPort, proxyPort, scratch] = process.argv.slice(2);
for (const p of [mockPort, proxyPort]) if (!(Number(p) >= 6700 && Number(p) <= 6999) || ['6677', '6689', '6710'].includes(p)) throw new Error(`端口 ${p} 不允许`);
fs.mkdirSync(scratch, { recursive: true });
const home = path.join(scratch, 'home'); fs.mkdirSync(home, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mock = spawn(process.execPath, [path.join(here, 'mock-upstream.mjs'), mockPort, path.join(scratch, 'mock')], { stdio: 'ignore' });
const proxy = spawn(process.execPath, [path.join(here, 'proxyhost.mjs'), proxyPort, `http://127.0.0.1:${mockPort}/lane/base`],
  { env: { PATH: process.env.PATH, HOME: home, CGUI_USAGE_ISSUES_PATH: path.join(home, 'usage-issues.json') }, stdio: ['ignore', 'pipe', 'inherit'] });
let ready = false;
proxy.stdout.on('data', (d) => { if (String(d).includes('"ready":true')) ready = true; });
try {
  for (let i = 0; i < 60 && !ready; i += 1) await sleep(100);
  if (!ready) throw new Error('代理没起来');
  const log = path.join(scratch, 'mock', 'lanes', 'base', 'requests.jsonl');
  const runOnce = async () => {
    const got = {};
    for (const [name, body] of Object.entries(BASELINE_INPUTS)) {
      try { fs.rmSync(log); } catch { /* */ }
      const r = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'dummy', 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body) });
      await r.text();
      const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      if (lines.length !== 1) throw new Error(`${name}:上游收到 ${lines.length} 个请求`);
      got[name] = { path: lines[0].path, raw: lines[0].raw };
    }
    return got;
  };
  const a = await runOnce();
  const b = await runOnce();
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error('两遍输出不一致,不能当基线');
  const version = JSON.parse(fs.readFileSync(path.join(here, '..', '..', '..', '..', 'package.json'), 'utf8')).version;
  const out = { note: '改动前(未改动的工作树)openai 协议代理发往上游的请求体原文;只录一次,不要在实现落地后重录', version, capturedAt: new Date().toISOString(), cases: a };
  fs.writeFileSync(path.join(here, '..', 'fixtures', 'proxy-baseline.json'), `${JSON.stringify(out, null, 2)}\n`);
  console.log(`[r151a] 基线已写入 fixtures/proxy-baseline.json(${Object.keys(a).length} 条,版本 ${version})`);
} finally {
  try { proxy.kill(); } catch { /* */ }
  try { mock.kill(); } catch { /* */ }
}
