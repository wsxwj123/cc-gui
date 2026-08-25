#!/usr/bin/env node
// 单测:r57 三修 —— ①undici 的 Node 地板必须 ≤ app 地板(20)+ 踩地板时的兜底文案;
// ②生成分支的连接错误带 cause(ECONNREFUSED 等);③dispatchOpts 在 try 内(名额不泄漏)。
// Run: node tests/unit/check-r57-node-floor.mjs
//
// 核心牙:
//  ① undici@8 的 fetch() 第一句就调 Promise.withResolvers(Node 22+),Node 20 上 import
//    成功、启动无警,三处外联却全抛 TypeError —— 公开版 Node 20 用户生图链路全死。
//    依赖判据落在 package.json/package-lock 上(engines 必须涵盖 Node 20.18);
//    文案判据落在 nodeFloorHint 上(将来再踩地板时如实说"Node 版本过低"而不是"连不上")。
//  ② 代理配错/没起时,undici 抛的是 TypeError('fetch failed'),真因只在 e.cause 里 ——
//    只报 message 等于让用户对着"fetch failed"猜。
//  ③ 名额与 controller 的归还全靠 runner 的 finally;try 之外的任何调用抛错都绕过 finally,
//    3 次后永久 429(生图彻底发不出去)。
//
// 隔离:HOME/USERPROFILE 指向 mktemp 目录(真实 ~/.claude-gui 一个字节不碰);
// 上游是本机假服务,代理指向一个【没人监听】的本机端口,绝不打真实网络。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP_HOME = mkdtempSync(join(tmpdir(), 'cgui-r57-home-'));
const SAVE_DIR = mkdtempSync(join(tmpdir(), 'cgui-r57-save-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
mkdirSync(join(TMP_HOME, '.claude-gui'), { recursive: true });

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const KEY = 'sk-r57-stored-secret-abcdef123456';
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
// 死代理:握手直接 ECONNREFUSED(端口没人监听)。选一个不在测试端口段的高位口。
const DEAD_PROXY = 'http://127.0.0.1:6799';

const express = (await import('express')).default;
const imageMod = await import('../../server/routes/image.js');
const imageRouter = imageMod.default;

const app = express();
app.use(express.json({ limit: '2mb' }));
app.post('/up/v1/images/generations', (_req, res) => res.json({ data: [{ b64_json: PNG_B64 }] }));
app.use('/api', imageRouter);

async function listenWithRetry(port, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const s = app.listen(port, '127.0.0.1');
    const r = await new Promise((resolve) => {
      s.once('listening', () => resolve({ ok: true }));
      s.once('error', (e) => resolve({ ok: false, err: e }));
    });
    if (r.ok) return s;
    if (r.err?.code !== 'EADDRINUSE') throw r.err;
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`端口 ${port} 持续被占用(隔壁 worktree 的 E2E?),重试 ${tries} 次后放弃`);
}
const server = await listenWithRetry(6705);
const BASE = 'http://127.0.0.1:6705';
const api = async (method, path, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, text, json };
};
const waitFor = async (fn, ms = 5000, step = 100) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, step));
  }
};
const entryOf = async (id) => {
  const r = await api('GET', '/api/image/history');
  return (r.json?.history || []).find((e) => e.id === id) || null;
};

let failure = null;
try {
  // ───────────── 1. F1 文案兜底:踩 Node 地板时如实点名,不再冒充"连不上" ─────────────
  {
    const hint = imageMod.nodeFloorHint;
    assert.equal(typeof hint, 'function', 't1: nodeFloorHint 导出(三处外联共用同一判据)');
    const real = new TypeError('Promise.withResolvers is not a function');
    assert.ok(hint(real), 't1【地板判据】:undici 在低版本 Node 上的 TypeError 必须被认出来');
    assert.match(hint(real), /Node/, 't1: 文案点名 Node');
    assert.match(hint(real), /20\.18/, 't1: 文案给出所需版本(可行动)');
    assert.ok(hint(new TypeError('xxx.foo is not a function')), 't1: "not a function" 形态一并认');
    // 不误判:常规网络失败(undici 的 fetch failed 同样是 TypeError)必须走原有文案
    assert.equal(hint(new TypeError('fetch failed')), null, 't1【不误判】:普通 fetch failed 不算 Node 地板');
    assert.equal(hint(new Error('Promise.withResolvers is not a function')), null, 't1: 非 TypeError 不认');
    assert.equal(hint(undefined), null, 't1: 空输入不炸');
  }

  // ───────────── 2. I2 + S1 行为:死代理连发 4 个 ─────────────
  // 每个都必须 ①落 error 且文案带 cause(不是裸 fetch failed);②归还名额 → 第 4 个不 429。
  {
    const mk = await api('POST', '/api/image-providers', {
      name: '死代理', protocol: 'openai', baseURL: `${BASE}/up/v1`,
      apiKey: KEY, model: 'm', savePath: SAVE_DIR, proxyUrl: DEAD_PROXY,
    });
    assert.equal(mk.status, 200, `t2: 建 provider(${mk.text})`);
    const pid = mk.json.id;
    // 先把 4 个都发完(每个等它落终态再发下一个)——名额判据必须排在最前面:
    // 泄漏时第 4 个会 429,这条要第一个红,才指得准根因(而不是被"没落终态"抢先报错)。
    const settled = [];
    for (let i = 1; i <= 4; i++) {
      const r = await api('POST', '/api/image/generate', { providerId: pid, prompt: `死代理-${i}` });
      assert.equal(r.status, 200,
        `t2【名额归还】:第 ${i} 个请求必须被受理 —— 前 3 个失败都该走 finally 还名额,`
        + `429 就意味着名额泄漏(dispatchOpts 之类跑在 try 之外抛错时会这样,实际 ${r.status} ${r.text})`);
      settled.push(await waitFor(async () => {
        const e = await entryOf(r.json.jobId);
        return e && e.status !== 'running' ? e : null;
      }));
    }
    for (const [i, done] of settled.entries()) {
      assert.ok(done, `t2: 第 ${i + 1} 个任务应落终态(代理拒连是秒失败)`);
      assert.equal(done.status, 'error', `t2: 连不上代理 → error(实际 ${JSON.stringify(done)})`);
      assert.match(done.error, /连接上游失败/, 't2: 仍是原有归类文案');
      assert.match(done.error, /ECONNREFUSED|ECONNRESET|EHOSTUNREACH/,
        `t2【cause】:错误必须带上真因,不许只有裸 "fetch failed"(实际:${done.error})`);
      assert.ok(!done.error.includes(KEY), 't2: 错误文案不含明文 key');
    }
  }
} catch (e) {
  failure = e;
} finally {
  server.closeAllConnections?.();
  server.close();
  await new Promise((r) => server.once('close', r));
  for (const d of [TMP_HOME, SAVE_DIR]) rmSync(d, { recursive: true, force: true });
}
if (failure) throw failure;

// ───────────── 3. 源码锚 ─────────────
{
  const src = readFileSync(join(REPO, 'server/routes/image.js'), 'utf8');
  const count = (s, re) => (s.match(re) || []).length;

  // F1:三处外联(生成 POST / 图片下载 / gemini 拉模型)都要过地板判据
  assert.match(src, /e instanceof TypeError[\s\S]{0,80}withResolvers\|not a function/,
    't3: 地板判据(TypeError + withResolvers/not a function)在位');
  assert.equal(count(src, /nodeFloorHint\(/g), 4, 't3: 判据函数 1 处定义 + 三处外联各 1 处调用');

  // I2:生成分支的 catch 与拉模型分支同款,把 cause 拼进文案
  assert.equal(count(src, /e\?\.cause\?\.code \|\| e\?\.cause\?\.message/g), 2,
    't3: 生成分支与拉模型分支都取 cause(抄齐,不是只有拉模型有)');

  // S1:dispatchOpts 必须在 runner 的 try 内 —— try 之外抛错会绕过 finally 的名额归还
  const start = src.indexOf('async function runImageJob');
  assert.ok(start > 0, 't3: 找得到 runImageJob');
  const end = src.indexOf("router.post('/image/generate'", start);
  const runner = src.slice(start, end);
  const tryAt = runner.indexOf('\n  try {');
  const dispatchAt = runner.indexOf('dispatchOpts(provider.proxyUrl)');
  assert.ok(tryAt > 0 && dispatchAt > 0, 't3: 找得到 runner 的 try 与 dispatchOpts 调用');
  assert.ok(dispatchAt > tryAt,
    't3【名额不泄漏】:dispatchOpts 调用必须在 try 内,否则它抛错就绕过 finally 的 activeJobs 归还');
  assert.match(runner, /finally \{\n\s*activeJobs -= 1;/, 't3: 名额仍在 finally 里归还');
}

// ───────────── 4. 依赖地板:undici 的 engines 不许高于 app 地板(Node 20) ─────────────
{
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  assert.match(pkg.dependencies.undici, /^\^7\./,
    `t4【致命回归防线】:undici 必须锁 ^7(^8 要求 Node ≥22.19,高于 app 地板 20 → 生图全死),实际 ${pkg.dependencies.undici}`);
  const lock = JSON.parse(readFileSync(join(REPO, 'package-lock.json'), 'utf8'));
  const locked = lock.packages?.['node_modules/undici'];
  assert.ok(locked, 't4: lock 里有 undici');
  assert.match(locked.version, /^7\./, `t4: lock 锁在 7.x(实际 ${locked.version})`);
  const floor = locked.engines?.node || '';
  const major = Number((floor.match(/(\d+)/) || [])[1]);
  assert.ok(major <= 20, `t4: undici 的 Node 地板(${floor})不许高于 app 地板 20`);
}

console.log('✓ check-r57-node-floor: undici 地板对齐 + 踩地板兜底文案 + 生成分支带 cause + dispatchOpts 在 try 内 全部通过');
