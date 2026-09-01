#!/usr/bin/env node
// r26-J1【单测】:生图 POST 不跟随重定向(redirect:'manual' + 3xx 报错)。
// 哨兵:①上游 302 到内网目标 → 502 且报错点明跳转,目标零命中,无落盘;
// ②301/307 同拒(不只认 302);③200 正常出图(防误伤);④源码钉住 redirect:'manual'。
// 隔离 HOME + /tmp 样本;端口取 OS 临时口(listen(0),真实端口从 server.address() 读回),跑完杀干净。
// Run: node tests/unit/check-r26-j1-image-post-redirect.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP_HOME = mkdtempSync(join(tmpdir(), 'cgui-j1-home-'));
const SAVE_DIR = mkdtempSync(join(tmpdir(), 'cgui-j1-save-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;

const express = (await import('express')).default;
const imageRouter = (await import('../../server/routes/image.js')).default;

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const app = express();
app.use(express.json({ limit: '25mb' }));
// 假上游:/r302 /r301 /r307 各回一种 3xx 到跳转目标;/ok 正常出图
for (const code of [302, 301, 307]) {
  app.post(`/r${code}/v1/images/generations`, (_req, res) => res.redirect(code, `http://127.0.0.1:${target.address().port}/final`));
}
app.post('/ok/v1/images/generations', (_req, res) => res.json({ data: [{ b64_json: PNG_B64 }] }));
app.use('/api', imageRouter);

// 跳转目标:被打了就说明重定向被跟随
let targetHits = 0;
const target = createServer((_req, res) => {
  targetHits += 1;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }));
});

const server = await new Promise((r) => { const s = createServer(app).listen(0, '127.0.0.1', () => r(s)); });
await new Promise((r) => target.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const api = async (method, path, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};
// r51:出图已任务化 —— POST 秒回 { jobId },成败落在 /api/image/history 的条目里。
// 这里提交后轮询到终态,返回 { status, json }:status 是【任务终态】('done' / 'error'),
// 不是 HTTP 码(提交只要过了前置校验就恒 200);前置校验失败仍是同步 HTTP 错误,原样返回。
const gen = async (body) => {
  const submit = await api('POST', '/api/image/generate', body);
  if (submit.status !== 200 || !submit.json?.jobId) return submit;
  for (let i = 0; i < 300; i++) {
    const h = await api('GET', '/api/image/history');
    const e = (h.json?.history || []).find((x) => x.id === submit.json.jobId);
    if (e && e.status !== 'running') return { status: e.status, json: e };
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('出图任务 15s 内未落终态');
};

let n = 0;
const ok = (v, m) => { assert.ok(v, m); n += 1; };
let failure = null;
try {
  const mk = (name, base) => api('POST', '/api/image-providers', {
    name, protocol: 'openai', baseURL: base, apiKey: 'sk-test-j1', model: 'm', savePath: SAVE_DIR,
  });

  // ①② 三种 3xx 全部拒绝,目标零命中
  for (const code of [302, 301, 307]) {
    const p = await mk(`回${code}的上游`, `${BASE}/r${code}/v1`);
    assert.equal(p.status, 200, `夹具:${code} provider 建好`);
    const g = await gen({ providerId: p.json.id, prompt: 'x' });
    assert.equal(g.status, 'error', `J1: 上游 ${code} 必须报错(实际 ${g.status} —— 重定向被跟随)`);
    assert.match(g.json?.error || '', /跳转|重定向|redirect/i, `J1: 报错必须点明跳转(实际:${g.json?.error})`);
    n += 2;
  }
  ok(targetHits === 0, `J1: 跳转目标被打了 ${targetHits} 次 —— redirect:'manual' 没生效`);
  ok(readdirSync(SAVE_DIR).length === 0, 'J1: 被拒的请求不得有图片落盘');

  // ③ 正常 200 不受影响(防误伤哨兵)
  const good = await mk('正常上游', `${BASE}/ok/v1`);
  const g2 = await gen({ providerId: good.json.id, prompt: 'x' });
  ok(g2.status === 'done', `J1: 正常出图不受 redirect:'manual' 影响(实际 ${g2.status})`);
  ok(readdirSync(SAVE_DIR).length === 1, 'J1: 正常请求正常落盘');

  // ④ 源码钉住:生成 POST 带 redirect:'manual'(防回归)
  const src = readFileSync(new URL('../../server/routes/image.js', import.meta.url), 'utf8');
  const postBlock = src.slice(src.indexOf('const post = (headers)'), src.indexOf('let r;'));
  ok(/redirect:\s*'manual'/.test(postBlock), 'J1: 生成 POST 必须 redirect:\'manual\'');
} catch (e) {
  failure = e;
} finally {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  target.closeAllConnections?.();
  await new Promise((r) => target.close(r));
  rmSync(TMP_HOME, { recursive: true, force: true });
  rmSync(SAVE_DIR, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(`PASS check-r26-j1-image-post-redirect (${n} assertions)`);
