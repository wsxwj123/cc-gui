#!/usr/bin/env node
// r26-J13【单测】:b64 分支解码后必须再过一次体积闸。
// 修前:只挡 base64 字符串长度(>64MB×1.4 粗估)—— 1.4 不是精确 4/3,存在
// "字符串过闸、解码后超 64MB"的窗口(约 89.6MB~94MB 字符串 → 65MB~70MB 字节)。
// 哨兵:①65MB 二进制(b64 后 ~90.9MB,过字符串闸)→ 解码后超 64MB → 413 体积错误;
// ②63MB 合法图正常落盘(闸下不误伤);③既有字符串闸(92MB+)仍 502 图片过大(回归)。
// 夹具:6703 假上游 + 隔离 HOME + /tmp 保存目录,跑完杀干净。
// Run: node tests/unit/check-r26-j13-decode-size-cap.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP_HOME = mkdtempSync(join(tmpdir(), 'cgui-j13-home-'));
const SAVE_DIR = mkdtempSync(join(tmpdir(), 'cgui-j13-save-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;

const express = (await import('express')).default;
const imageRouter = (await import('../../server/routes/image.js')).default;

// 65MB:解码后超 64MB 闸,但 b64 字符串 ~90.9MB < 1.4×64MB 字符串闸(恰好落在旧窗口里)
const OVER_B64 = Buffer.alloc(65 * 1024 * 1024).toString('base64');
// 63MB:两闸都该过的合法图
const OK_B64 = Buffer.alloc(63 * 1024 * 1024).toString('base64');

const app = express();
app.use(express.json({ limit: '25mb' }));
app.post('/over/v1/images/generations', (_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.write('{"data":[{"b64_json":"');
  res.write(OVER_B64);
  res.end('"}]}');
});
app.post('/ok/v1/images/generations', (_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.write('{"data":[{"b64_json":"');
  res.write(OK_B64);
  res.end('"}]}');
});
app.use('/api', imageRouter);

const server = await new Promise((resolve, reject) => {
  const s = app.listen(6703, '127.0.0.1', () => resolve(s));
  s.once('error', reject);
});
const BASE = 'http://127.0.0.1:6703';
const api = async (method, path, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const mk = (name, base) => api('POST', '/api/image-providers', {
  name, protocol: 'openai', baseURL: base, apiKey: 'sk-test-j13', model: 'm', savePath: SAVE_DIR,
});
// r51:出图已任务化 —— POST 秒回 { jobId },成败落在 /api/image/history 的条目里。
// status 返回【任务终态】('done' / 'error'),不是 HTTP 码;体积闸的人话错误在 json.error。
const gen = async (body) => {
  const submit = await api('POST', '/api/image/generate', body);
  if (submit.status !== 200 || !submit.json?.jobId) return submit;
  for (let i = 0; i < 600; i++) {
    const h = await api('GET', '/api/image/history');
    const e = (h.json?.history || []).find((x) => x.id === submit.json.jobId);
    if (e && e.status !== 'running') return { status: e.status, json: e };
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('出图任务 30s 内未落终态');
};

let n = 0;
let failure = null;
try {
  // 夹具自检:65MB 的 b64 确实落在"字符串闸下、字节闸上"的旧窗口里
  assert.ok(OVER_B64.length < 64 * 1024 * 1024 * 1.4, '夹具:字符串长度必须过旧字符串闸');
  assert.ok(65 * 1024 * 1024 > 64 * 1024 * 1024, '夹具:字节数必须超上限');
  n += 2;

  // ① 解码后超限 → 413 + 体积错误(解码闸哨兵)
  const over = await mk('解码后超限', `${BASE}/over/v1`);
  assert.equal(over.status, 200, '夹具:provider 建好');
  const g1 = await gen({ providerId: over.json.id, prompt: 'x' });
  assert.equal(g1.status, 'error', `J13: 解码后超限必须失败(实际 ${g1.status})`);
  assert.match(g1.json?.error || '', /图片过大/, `J13: 人话错误(实际:${g1.json?.error})`);
  assert.equal(readdirSync(SAVE_DIR).length, 0, 'J13: 超限图不得落盘');
  n += 3;

  // ② 63MB 合法图正常出图(防误伤哨兵)
  const okP = await mk('合法大图', `${BASE}/ok/v1`);
  const g2 = await gen({ providerId: okP.json.id, prompt: 'x' });
  assert.equal(g2.status, 'done', `J13: 闸下大图正常出图(实际 ${g2.status} ${g2.json?.error || ''})`);
  assert.equal(g2.json.bytes, 63 * 1024 * 1024, 'J13: 字节数完整');
  assert.equal(readdirSync(SAVE_DIR).length, 1, 'J13: 合法图正常落盘');
  n += 3;
} catch (e) {
  failure = e;
} finally {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  rmSync(TMP_HOME, { recursive: true, force: true });
  rmSync(SAVE_DIR, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(`PASS check-r26-j13-decode-size-cap (${n} assertions)`);
// ③ 92MB+ 字符串闸回归由 check-image-gen t9 覆盖(b64 超长 → 502 图片过大),此处不重复灌大 body。
