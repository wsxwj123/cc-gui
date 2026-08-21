#!/usr/bin/env node
// r26-J2【复现+边界】:生图 POST 的响应 r.text() 无界读。
// 场景:坏掉/恶意的中转站对生成 POST 回一个超大 body(下载分支早有 content-length 预检
// + 限量读,生成分支没有)→ 单进程后端把整个 body 读进内存,一坨大响应就是全局 OOM。
// 修复后期望:生成分支同样 content-length 预检 + 限量读,超限按「体积过大」人话报错,
// 而不是读完后按「不是 JSON」报(读完 = 内存已经吃了)。
// 夹具:6703 = 被测路由 + 假上游(回 100MB 非法 JSON,Content-Length 如实)。
// 区分点:修前错误文案是「上游响应不是 JSON」(读完了才解析失败);修后必须是体积类错误。
// Run: node tests/acceptance/r26/j2-image-response-cap.mjs
import assert from 'node:assert/strict';
import { listenWithRetry, stopServer, makeTmpHome, makeTmpDir, cleanupDirs } from './lib.mjs';

const TMP_HOME = makeTmpHome('j2');
const SAVE_DIR = makeTmpDir('j2-save');

const express = (await import('express')).default;
const imageRouter = (await import('../../../server/routes/image.js')).default;

const BIG = 100 * 1024 * 1024; // 100MB,超过任何合理的响应上限
const app = express();
app.use(express.json({ limit: '25mb' }));
app.post('/big/v1/images/generations', (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(BIG) });
  // 分块写,客户端早退时服务端会 EPIPE —— 忽略之,不让假上游自己崩
  const chunk = Buffer.alloc(4 * 1024 * 1024, 'x');
  let sent = 0;
  const write = () => {
    while (sent < BIG) {
      sent += chunk.length;
      if (!res.write(chunk)) { res.once('drain', write); return; }
    }
    res.end();
  };
  res.on('error', () => {});
  write();
});
app.use('/api', imageRouter);

let server = null;
let failure = null;
try {
  server = await listenWithRetry(6703, (p) => app.listen(p, '127.0.0.1'));
  const BASE = 'http://127.0.0.1:6703';
  const api = async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  };

  const mk = await api('POST', '/api/image-providers', {
    name: '回 100MB 的上游', protocol: 'openai', baseURL: `${BASE}/big/v1`,
    apiKey: 'sk-test-j2', model: 'm', savePath: SAVE_DIR,
  });
  assert.equal(mk.status, 200, 'J2 夹具:provider 建好');

  const g = await api('POST', '/api/image/generate', { providerId: mk.json.id, prompt: 'x' });

  // 核心断言(修前必红):必须是「体积过大」类错误,而不是读完后的「不是 JSON」
  assert.equal(g.status, 502, `J2: 超大响应应 502(实际 ${g.status})`);
  const err = g.json?.error || '';
  assert.ok(!/不是 JSON/.test(err),
    `J2: 错误文案是「${err.slice(0, 40)}…」= 整个 100MB 已经被读进内存才解析失败 —— 无界读的 bug 形态`);
  assert.match(err, /过大|上限|超限|超出|too large|exceed/i,
    `J2: 超限必须按体积类错误报(实际:${err.slice(0, 60)})`);
} catch (e) {
  failure = e;
} finally {
  await stopServer(server);
  cleanupDirs(TMP_HOME, SAVE_DIR);
}
if (failure) throw failure;

console.log('PASS r26-j2-image-response-cap');
