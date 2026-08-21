#!/usr/bin/env node
// r26-J1【复现+错误路径】:生图 POST 跟随 302。
// 场景:上游(中转站)对 /images/generations 回 302。下载分支早已 redirect:'manual' +
// 3xx 报错(防跳过内网校验),而【生成 POST】分支没有 —— fetch 默认跟随重定向,请求的
// 去向脱离 assertPublicBaseURL 刚验过的那个 origin:302 可以把带着 apiKey 的请求(或
// 响应读取)引到攻击者控制的地址。
// 修复后期望:生成 POST 同样 redirect:'manual',3xx 一律报错;跳转目标一次都不许被打。
// 夹具:6703 = 被测路由 + 假上游(回 302),6704 = 跳转目标(记录被打次数)。跑完杀干净。
// Run: node tests/acceptance/r26/j1-image-post-redirect.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readdirSync } from 'node:fs';
import { listenWithRetry, stopServer, makeTmpHome, makeTmpDir, cleanupDirs } from './lib.mjs';

const TMP_HOME = makeTmpHome('j1');
const SAVE_DIR = makeTmpDir('j1-save');

const express = (await import('express')).default;
const imageRouter = (await import('../../../server/routes/image.js')).default;

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const app = express();
app.use(express.json({ limit: '25mb' }));
// 假上游:生成 POST 直接 302 到 6704
app.post('/up/v1/images/generations', (_req, res) => {
  res.redirect(302, 'http://127.0.0.1:6704/final');
});
app.use('/api', imageRouter);

// 跳转目标:若被打,说明重定向被跟随了
let targetHits = 0;
const target = createServer((_req, res) => {
  targetHits += 1;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }));
});

let server = null;
let failure = null;
try {
  server = await listenWithRetry(6703, (p) => app.listen(p, '127.0.0.1'));
  await listenWithRetry(6704, (p) => target.listen(p, '127.0.0.1'));
  const BASE = 'http://127.0.0.1:6703';
  const api = async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  };

  const mk = await api('POST', '/api/image-providers', {
    name: '会 302 的上游', protocol: 'openai', baseURL: `${BASE}/up/v1`,
    apiKey: 'sk-test-j1', model: 'm', savePath: SAVE_DIR,
  });
  assert.equal(mk.status, 200, `J1 夹具:provider 建好(${JSON.stringify(mk.json)})`);

  const g = await api('POST', '/api/image/generate', { providerId: mk.json.id, prompt: 'x' });

  // 核心断言(修前必红):3xx 必须报错,且跳转目标零命中
  assert.equal(g.status, 502, `J1: 上游 302 必须报错(实际 ${g.status} —— 重定向被静默跟随且出图"成功")`);
  assert.match(g.json?.error || '', /跳转|重定向|redirect|302/i,
    `J1: 报错必须点明是跳转(实际:${g.json?.error})`);
  assert.equal(targetHits, 0, `J1: 跳转目标被打了 ${targetHits} 次 —— redirect:'manual' 没生效`);
  assert.equal(readdirSync(SAVE_DIR).length, 0, 'J1: 被拒的请求不得有图片落盘');
} catch (e) {
  failure = e;
} finally {
  await stopServer(server);
  await stopServer(target);
  cleanupDirs(TMP_HOME, SAVE_DIR);
}
if (failure) throw failure;

console.log('PASS r26-j1-image-post-redirect');
