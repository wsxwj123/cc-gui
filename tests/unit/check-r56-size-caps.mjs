#!/usr/bin/env node
// 单测:r56 尺寸候选按模型家族过滤 + 按 provider 生图代理 + 拉取成功的「连接正常」文案。
// Run: node tests/unit/check-r56-size-caps.mjs
//
// 核心牙:
//  ① 能力表是【已知家族】的过滤,不是猜:gpt-image-2 去掉 4096x4096/K 档/比例 token 但保留
//    3840x2160 与 auto;gpt-image-1 系/DALL·E 3/DALL·E 2 是封闭清单;seedream 只去比例 token
//    (4K 与 4096x4096 都是它的合法值);未知模型一律 null = 不过滤(回落全量候选)。
//  ② 代理真的生效:mock 正向代理(http 上游 → 代理收到的是【绝对 URI】请求,这就是走了代理
//    的铁证)。配了 proxyUrl 的 provider,生成 POST / 图片下载 / gemini 拉模型三处都过代理;
//    没配的 provider 一次都不许经过代理(直连)。
//  ③ 代理地址禁内嵌账号密码(凭据会被原样落盘且 redactKey 认不出它)→ 400 带可行动文案。
//  ④ 换 undici fetch 是【等价替换】:安全锚(assertPublicBaseURL / redirect:'manual' /
//    readCapped)数量与语义一字不动 —— 数量锚在这里再钉一遍,r54/r26 系测试各自照旧。
//
// 隔离:HOME/USERPROFILE 指向 mktemp 目录(真实 ~/.claude-gui 一个字节不碰);
// 上游与代理全是本机假服务,绝不打真实网络。
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP_HOME = mkdtempSync(join(tmpdir(), 'cgui-r56-home-'));
const SAVE_DIR = mkdtempSync(join(tmpdir(), 'cgui-r56-save-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
mkdirSync(join(TMP_HOME, '.claude-gui'), { recursive: true });

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const KEY = 'sk-r56-stored-secret-abcdef123456';
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_BUF = Buffer.from(PNG_B64, 'base64');

// ───────────── 1. 能力表(纯函数,零 IO) ─────────────
const caps = await import('../../client/src/utils/imageSizeCaps.js');
const { SIZE_OPTIONS } = caps;
// r87:能力表判据改成 (上游方言, 模型) 二元(apimart 的 size 是宽高比、官方的 size 是像素,
// 同名反义)。本节校验的全部是【官方方言】那半 —— 它必须与 r56 逐字不变,故统一补 'openai'。
const sizeOptionsFor = (m) => caps.sizeOptionsFor('openai', m);
const sizeCapFor = (m) => caps.sizeCapFor('openai', m);
{
  assert.ok(Array.isArray(SIZE_OPTIONS) && SIZE_OPTIONS.length > 10, 't1: 全量候选表在位');
  assert.ok(SIZE_OPTIONS.includes('4096x4096') && SIZE_OPTIONS.includes('16:9') && SIZE_OPTIONS.includes('4K'),
    't1: 全量表仍是三类形态并存(r50 现状不许被这次过滤改掉)');

  // ── gpt-image-2:排除式 ──
  const g2 = sizeOptionsFor('gpt-image-2');
  assert.ok(Array.isArray(g2), 't1: gpt-image-2 命中能力表');
  assert.ok(!g2.includes('4096x4096'), 't1【gpt-image-2】4096x4096 超其总像素上限,必须去掉');
  assert.ok(!g2.some((s) => /^\d+K$/i.test(s)), 't1【gpt-image-2】不认 1K/2K/4K 档位 token');
  assert.ok(!g2.some((s) => s.includes(':')), 't1【gpt-image-2】没有比例参数,比例 token 全去掉');
  assert.ok(g2.includes('3840x2160'), 't1【gpt-image-2】3840x2160 是官方上限内的合法值,必须保留');
  assert.ok(g2.includes('2160x3840') && g2.includes('1024x1024') && g2.includes('1536x1024'),
    't1【gpt-image-2】其余合法 WxH 全部保留');
  assert.ok(g2.includes('auto'), 't1【gpt-image-2】auto 保留');
  assert.ok(g2.every((s) => SIZE_OPTIONS.includes(s)), 't1: 排除式过滤不许凭空造出全量表里没有的值');
  assert.equal(sizeCapFor('GPT-Image-2').family, 'gpt-image-2', 't1: 匹配不区分大小写');
  assert.deepEqual(sizeOptionsFor('gpt-image-2-mini'), g2, 't1: 同家族后缀型号走同一条');

  // ── gpt-image-1 系:封闭清单,恰 4 项 ──
  const four = ['auto', '1024x1024', '1536x1024', '1024x1536'];
  for (const m of ['gpt-image-1', 'gpt-image-1.5', 'gpt-image-1-mini', 'chatgpt-image-latest']) {
    assert.deepEqual(sizeOptionsFor(m), four, `t1【${m}】size 是枚举,恰 4 项`);
  }
  assert.equal(sizeOptionsFor('gpt-image-1').length, 4, 't1: gpt-image-1 恰 4 项');
  assert.ok(!sizeOptionsFor('gpt-image-1').includes('3840x2160'), 't1: gpt-image-1 不许混进 2 代的大尺寸');

  // ── DALL·E ──
  assert.deepEqual(sizeOptionsFor('dall-e-3'), ['1024x1024', '1792x1024', '1024x1792'], 't1【dall-e-3】恰 3 项');
  const d2 = sizeOptionsFor('dall-e-2');
  assert.deepEqual(d2, ['256x256', '512x512', '1024x1024'], 't1【dall-e-2】恰 3 项且含小尺寸');
  assert.ok(d2.includes('256x256'), 't1【dall-e-2】256x256 只在这个家族出现');
  assert.ok(!SIZE_OPTIONS.includes('256x256'), 't1: 256x256 不进全量表(只有 dall-e-2 用得上)');
  assert.ok(!sizeOptionsFor('dall-e-3').includes('256x256'), 't1: dall-e-3 不许出现 2 代的小尺寸');

  // ── seedream:只去比例 token ──
  for (const m of ['doubao-seedream-4-5', 'Seedream-4.0', 'ep-20250101-seedream']) {
    const sd = sizeOptionsFor(m);
    assert.ok(Array.isArray(sd), `t1【${m}】命中 seedream 家族`);
    assert.ok(sd.includes('4K'), `t1【${m}】1K/2K/4K 档位是它的合法值,必须保留`);
    assert.ok(sd.includes('4096x4096'), `t1【${m}】4096x4096 本就是 Seedream 系的值`);
    assert.ok(!sd.includes('16:9') && !sd.some((s) => s.includes(':')), `t1【${m}】size 不认比例 token`);
  }

  // ── 未知一律不过滤 ──
  // 【E17 / r94】与 E11 同口径:未登记模型有固定条目(unknown:true),候选仍是全量 SIZE_OPTIONS。
  for (const m of ['flux-pro-1.1', 'flux.1-schnell', 'my-relay-custom-model', 'nano-banana', '', null, undefined, 123]) {
    assert.deepEqual(sizeOptionsFor(m), SIZE_OPTIONS, `t1【E17·未登记 ${String(m)}】候选回落全量,绝不猜着过滤`);
    const cap = sizeCapFor(m);
    assert.notEqual(cap, null, `t1【E17·未登记 ${String(m)}】必须给得出条目`);
    assert.equal(cap.unknown, true, `t1【E17·未登记 ${String(m)}】unknown 为 true`);
  }

  // ── 家族标签(小字要用) ──
  assert.equal(sizeCapFor('gpt-image-1.5').family, 'gpt-image-1 系', 't1: 家族标签给人看');
  assert.equal(sizeCapFor('dall-e-2').family, 'DALL·E 2', 't1: DALL·E 2 标签');
  assert.equal(sizeCapFor('doubao-seedream-4-5').family, 'Seedream', 't1: Seedream 标签');
  for (const m of ['gpt-image-2', 'dall-e-3', 'seedream-x']) {
    assert.ok(sizeOptionsFor(m).length > 0, 't1: 命中家族的候选永远非空(空了就该回落全量)');
  }
}

// ───────────── 2. 代理:mock 正向代理 + mock 上游 ─────────────
const express = (await import('express')).default;
const imageRouter = (await import('../../server/routes/image.js')).default;

// 上游按「有没有经过代理」分别记账:代理会给转发的请求打上 x-via-proxy 头。
const hits = { viaProxy: [], direct: [] };
const record = (req, what) => {
  (req.headers['x-via-proxy'] ? hits.viaProxy : hits.direct).push(what);
};
const app = express();
app.use(express.json({ limit: '25mb' }));
app.post('/up/v1/images/generations', (req, res) => {
  record(req, 'generate');
  res.json({ data: [{ b64_json: PNG_B64 }] });
});
// 只回 URL 的上游:验第三处外联(图片下载)也过代理。URL 与 baseURL 同源(回环豁免继承)。
app.post('/url/v1/images/generations', (req, res) => {
  record(req, 'generate-url');
  res.json({ data: [{ url: `http://127.0.0.1:${server.address().port}/up/pic.png` }] });
});
app.get('/up/pic.png', (req, res) => {
  record(req, 'download');
  res.setHeader('Content-Type', 'image/png');
  res.end(PNG_BUF);
});
app.get('/up/v1beta/models', (req, res) => {
  record(req, 'models');
  res.json({ models: [{ name: 'models/gemini-3-pro-image' }] });
});
// 图生图 edits(multipart)+ 代理:undici 的 fetch 不认 Node 内建 FormData,会把它退化成
// 字面量 "[object FormData]" 发出去 —— 这个上游按 multipart 真解一遍,退化了就解不开。
let seenEdits = null;
app.post('/up/v1/images/edits', express.raw({ type: '*/*', limit: '30mb' }), async (req, res) => {
  record(req, 'edits');
  const ct = req.headers['content-type'] || '';
  try {
    const fd = await new Response(req.body, { headers: { 'content-type': ct } }).formData();
    seenEdits = { ct, model: fd.get('model'), prompt: fd.get('prompt'), images: fd.getAll('image[]').length };
    res.json({ data: [{ b64_json: PNG_B64 }] });
  } catch (e) {
    seenEdits = { ct, parseError: e.message, raw: req.body.slice(0, 40).toString('latin1') };
    res.status(400).json({ error: 'bad multipart' });
  }
});
app.use('/api', imageRouter);

const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const BASE = `http://127.0.0.1:${server.address().port}`;

// 正向代理:http 上游时客户端发的是【绝对 URI】请求行(GET http://host/path),
// 这就是"确实走了代理"的铁证 —— 直连绝不会出现这种请求。
const proxyLog = [];
// 转发:原样发给目标并打上 x-via-proxy(上游据此分辨"经代理"还是"直连")。
const forward = (req, res, u) => {
  const fwd = http.request({
    host: u.hostname, port: u.port || 80, path: `${u.pathname}${u.search}`, method: req.method,
    headers: { ...req.headers, 'x-via-proxy': '1' },
  }, (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res); });
  fwd.on('error', () => { res.writeHead(502); res.end('proxy upstream error'); });
  req.pipe(fwd);
};
// r57:客户端对 http 上游有两种走法 —— undici 8 发绝对 URI 请求行,undici 7 一律先
// CONNECT 开隧道(实测 8→7 降版后本文件整体挂死:mock 只认绝对 URI,CONNECT 无人应答)。
// 判官r57建议1(降版已知代价留痕):undici7 对 http 上游一律 CONNECT,保守企业代理常拒非 443
// 隧道 → 「http 上游 + 企业代理」组合可能从 8 可用变 7 不可用;生图上游几乎全 https、
// http 多为本机中转不过企业代理,暴露面小,接受该代价换 Node20 地板兼容。
// 两种都得认,否则这套 mock 绑死在某个 undici 大版本上。隧道里跑的是明文 HTTP,
// 交给内嵌 server 正常解析,复用同一条转发逻辑(x-via-proxy 照旧注入,记账口径不变)。
const tunnel = http.createServer((req, res) => {
  proxyLog.push(`${req.method} http://${req.headers.host}${req.url}`);
  forward(req, res, new URL(req.url, `http://${req.headers.host}`));
});
const proxy = http.createServer((req, res) => {
  proxyLog.push(`${req.method} ${req.url}`);
  let u;
  try { u = new URL(req.url); } catch { res.writeHead(400); res.end('not an absolute URI'); return; }
  forward(req, res, u);
});
proxy.on('connect', (req, socket, head) => {
  proxyLog.push(`CONNECT ${req.url}`);
  socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  if (head?.length) socket.unshift(head);
  tunnel.emit('connection', socket);
});
proxy.listen(0, '127.0.0.1');
await new Promise((r) => proxy.once('listening', r));
const PROXY_URL = `http://127.0.0.1:${proxy.address().port}`;

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
const mkProvider = async (name, path, patch = {}) => {
  const r = await api('POST', '/api/image-providers', {
    name, protocol: 'openai', baseURL: `${BASE}${path}`, apiKey: KEY, model: 'gpt-image-2', savePath: SAVE_DIR, ...patch,
  });
  assert.equal(r.status, 200, `建 provider ${name}(${r.text})`);
  return r.json.id;
};
const waitFor = async (fn, ms = 12000, step = 100) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, step));
  }
};
const settle = async (id) => waitFor(async () => {
  const r = await api('GET', '/api/image/history');
  const e = (r.json?.history || []).find((x) => x.id === id);
  return e && e.status !== 'running' ? e : null;
});

let failure = null;
try {
  // ── 2.1 配了代理:生成 POST 走代理,直连口零命中 ──
  {
    hits.viaProxy = []; hits.direct = []; proxyLog.length = 0;
    const pid = await mkProvider('过代理', '/up/v1', { proxyUrl: PROXY_URL });
    const stored = (await api('GET', '/api/image-providers')).json.providers.find((p) => p.id === pid);
    assert.equal(stored.proxyUrl, PROXY_URL, 't2.1: proxyUrl 落盘并回传给前端(无凭据故非敏感)');
    const r = await api('POST', '/api/image/generate', { providerId: pid, prompt: '走代理' });
    const done = await settle(r.json.jobId);
    assert.equal(done?.status, 'done', `t2.1: 经代理照样出图(${JSON.stringify(done)})`);
    assert.ok(proxyLog.length >= 1, `t2.1【绕过代理即红】:代理必须收到请求(实际日志 ${JSON.stringify(proxyLog)})`);
    assert.ok(proxyLog.some((l) => l.includes(`POST http://127.0.0.1:${server.address().port}/up/v1/images/generations`)),
      `t2.1【铁证】:这条 POST 必须是代理亲手转发的(绝对 URI 请求行或 CONNECT 隧道内解析,两种都算;实际 ${JSON.stringify(proxyLog)})`);
    assert.deepEqual(hits.viaProxy, ['generate'], 't2.1: 上游看到的是代理转发来的请求');
    assert.deepEqual(hits.direct, [], 't2.1【直连口零命中】:配了代理就不许有任何直连请求');
  }

  // ── 2.2 没配代理:直连,代理零命中(回归锚) ──
  {
    hits.viaProxy = []; hits.direct = []; proxyLog.length = 0;
    const pid = await mkProvider('直连', '/up/v1');
    const stored = (await api('GET', '/api/image-providers')).json.providers.find((p) => p.id === pid);
    assert.equal(stored.proxyUrl, '', 't2.2: 不填代理 = 空串(存量条目同此默认)');
    const r = await api('POST', '/api/image/generate', { providerId: pid, prompt: '直连' });
    const done = await settle(r.json.jobId);
    assert.equal(done?.status, 'done', `t2.2: 不配代理照旧出图(${JSON.stringify(done)})`);
    assert.deepEqual(hits.direct, ['generate'], 't2.2: 直连口命中');
    assert.deepEqual(proxyLog, [], 't2.2【零回归】:没配代理的 provider 一次都不许经过代理');
    assert.deepEqual(hits.viaProxy, [], 't2.2: 上游没看到代理头');
  }

  // ── 2.3 图片下载(第三处外联)同样过代理 ──
  {
    hits.viaProxy = []; hits.direct = []; proxyLog.length = 0;
    const pid = await mkProvider('回 URL 的上游', '/url/v1', { proxyUrl: PROXY_URL });
    const r = await api('POST', '/api/image/generate', { providerId: pid, prompt: '下载也走代理' });
    const done = await settle(r.json.jobId);
    assert.equal(done?.status, 'done', `t2.3: 下载分支出图成功(${JSON.stringify(done)})`);
    assert.deepEqual(hits.viaProxy, ['generate-url', 'download'], 't2.3【图片下载过代理】:生成与下载两处都带代理头');
    assert.deepEqual(hits.direct, [], 't2.3: 没有任何一处漏成直连');
    assert.ok(proxyLog.some((l) => l.includes('/up/pic.png')), `t2.3: 代理日志里有图片下载请求(${JSON.stringify(proxyLog)})`);
  }

  // ── 2.4 拉取模型(gemini 分支)同样过代理 ──
  {
    hits.viaProxy = []; hits.direct = []; proxyLog.length = 0;
    const pid = await mkProvider('gemini 拉模型', '/up/v1beta', { protocol: 'gemini', proxyUrl: PROXY_URL, model: 'gemini-3-pro-image' });
    const r = await api('POST', '/api/image-providers/fetch-models', { id: pid, protocol: 'gemini' });
    assert.equal(r.status, 200, `t2.4: 经代理拉取成功(${r.text})`);
    assert.deepEqual(r.json.models, ['gemini-3-pro-image'], 't2.4: 模型列表照旧解析');
    assert.deepEqual(hits.viaProxy, ['models'], 't2.4【拉模型过代理】');
    assert.deepEqual(hits.direct, [], 't2.4: 拉模型没有走直连');
    assert.ok(!r.text.includes(KEY), 't2.4: 响应不含 apiKey');
  }

  // ── 2.4b 图生图 multipart 经代理:请求体不许退化成 "[object FormData]" ──
  {
    hits.viaProxy = []; hits.direct = []; proxyLog.length = 0; seenEdits = null;
    const pid = await mkProvider('图生图过代理', '/up/v1', { proxyUrl: PROXY_URL, size: '1536x1024' });
    const r = await api('POST', '/api/image/generate', {
      providerId: pid,
      prompt: '给猫戴帽子',
      refs: [{ kind: 'upload', name: '猫.png', mime: 'image/png', dataB64: PNG_B64 }],
    });
    const done = await settle(r.json.jobId);
    assert.equal(done?.status, 'done', `t2.4b: 带参考图经代理照样出图(${JSON.stringify(done)})`);
    assert.ok(seenEdits && !seenEdits.parseError,
      `t2.4b【multipart 不许退化】:上游必须能按 multipart 解开(实际 ${JSON.stringify(seenEdits)})`);
    assert.match(seenEdits.ct, /^multipart\/form-data; boundary=/, `t2.4b: Content-Type 仍带 boundary(实际 ${seenEdits.ct})`);
    assert.equal(seenEdits.model, 'gpt-image-2', 't2.4b: 各 part 照旧在位');
    assert.equal(seenEdits.prompt, '给猫戴帽子', 't2.4b: prompt part 在位');
    assert.equal(seenEdits.images, 1, 't2.4b: 参考图 part 在位');
    assert.deepEqual(hits.viaProxy, ['edits'], 't2.4b: 图生图请求同样过代理');
    assert.deepEqual(hits.direct, [], 't2.4b: 没有漏成直连');
  }

  // ── 2.5 代理地址校验:禁凭据 / 非法形态 / 空串清除 / 不传保留 ──
  {
    const bad = async (proxyUrl, why) => {
      const r = await api('POST', '/api/image-providers', {
        name: why, protocol: 'openai', baseURL: `${BASE}/up/v1`, apiKey: KEY, model: 'gpt-image-2', savePath: SAVE_DIR, proxyUrl,
      });
      assert.equal(r.status, 400, `t2.5: ${why} 必须 400(实际 ${r.status} ${r.text})`);
      return r.json?.error || '';
    };
    const credErr = await bad('http://user:pass@127.0.0.1:7897', '内嵌账号密码的代理地址');
    assert.match(credErr, /不支持内嵌账号密码/, `t2.5【禁凭据】拒因要可行动(实际:${credErr})`);
    assert.match(await bad('socks5://127.0.0.1:1080', 'socks 形态'), /http/, 't2.5: 只收 http(s)');
    assert.match(await bad('不是地址', '非 URL'), /代理地址/, 't2.5: 非法形态给人话');
    assert.equal(await bad(123, '非字符串'), '代理地址必须是字符串', 't2.5: 类型不对也拦');

    // 空串 = 清除;不传 = 保留(与 apiKey 同语义)
    const pid = await mkProvider('改代理', '/up/v1', { proxyUrl: PROXY_URL });
    const put = (patch) => api('PUT', `/api/image-providers/${pid}`, {
      name: '改代理', protocol: 'openai', baseURL: `${BASE}/up/v1`, model: 'gpt-image-2', savePath: SAVE_DIR, ...patch,
    });
    const read = async () => (await api('GET', '/api/image-providers')).json.providers.find((p) => p.id === pid).proxyUrl;
    assert.equal((await put({})).status, 200, 't2.5: 不传 proxyUrl 的 PUT 成功');
    assert.equal(await read(), PROXY_URL, 't2.5【不传保留】:没发这个字段就不许把已配的代理抹掉');
    assert.equal((await put({ proxyUrl: 'http://u:p@127.0.0.1:7897' })).status, 400, 't2.5: PUT 同样禁凭据');
    assert.equal(await read(), PROXY_URL, 't2.5: 被拒的 PUT 不改动已存值');
    assert.equal((await put({ proxyUrl: '' })).status, 200, 't2.5: 空串 PUT 成功');
    assert.equal(await read(), '', 't2.5【空串清除】:改回直连');
  }
} catch (e) {
  failure = e;
} finally {
  server.closeAllConnections?.();
  server.close();
  await new Promise((r) => server.once('close', r));
  tunnel.closeAllConnections?.(); // CONNECT 之后 socket 归内嵌 server 管,不关就退不出进程
  proxy.closeAllConnections?.();
  proxy.close();
  await new Promise((r) => proxy.once('close', r));
  for (const d of [TMP_HOME, SAVE_DIR]) rmSync(d, { recursive: true, force: true });
}
if (failure) throw failure;

// ───────────── 3. 服务端源码:undici 接线 + 代理池 + 安全锚零改动 ─────────────
{
  const src = readFileSync(join(REPO, 'server/routes/image.js'), 'utf8');
  const count = (s, re) => (s.match(re) || []).length;
  assert.match(src, /import \{ fetch as undiciFetch, ProxyAgent \} from 'undici'/, 't3: 生图链路用 undici 的 fetch');
  // r87 新增第四处直接调用点(报价查询)。pollTask 那处走 io.fetch || undiciFetch 的注入口,
  // 不在这个正则的射程内 —— 计数只覆盖"直接 undiciFetch(" 的写法。
  // 【E23 / r94】新增两处外联(upload-ref 上传、apimart buttons GET)走同一套 fetch,不另起网络栈 → 4 → 6。
  // 规则仍是【只增不减】;新值以实现落地后的实测为准,但不得低于 4。
  assert.equal(count(src, /undiciFetch\(/g), 6, 't3【E23·外联点】生成 POST / 图片下载 / gemini 拉模型 / 报价 / 上传参考图 / buttons 拉取');
  assert.ok(!/[^i]\bfetch\(spec\.url|[^i]\bfetch\(picked\.url/.test(src), 't3: 不许留下混用全局 fetch 的调用点(同链路两套网络栈)');
  assert.match(src, /const proxyAgents = new Map\(\)/, 't3: 代理池按 url 缓存(同 url 复用连接池)');
  assert.match(src, /MAX_PROXY_AGENTS = 8/, 't3: 缓存上限 8 条');
  assert.match(src, /proxyAgents\.delete\(key\);\s*proxyAgents\.set\(key, hit\)/, 't3: 命中挪到队尾 = LRU');
  assert.match(src, /new ProxyAgent\(key\)/, 't3: dispatcher 来自 undici 的 ProxyAgent');
  assert.match(src, /function dispatchOpts\(proxyUrl\)[\s\S]{0,220}return agent \? \{ dispatcher: agent \} : \{\}/,
    't3【无代理零改动】:没配代理时不传 dispatcher,请求形态与原先逐字一致');
  // r82 起 runner 之外还有第四处外联(pollTask 查任务状态),同样走 provider 自己的代理。
  // 【E24 / r94】两处新外联打的是 provider 上游,按同口径带 dispatcher → 3 → 5(只增不减)。
  assert.equal(count(src, /\.\.\.proxy,/g), 5, 't3【E24】生成 POST / 图片下载 / 任务轮询 / 上传参考图 / buttons 拉取共用 provider 的 dispatcher');
  assert.match(src, /dispatchOpts\(proxyUrl\)/, 't3: 拉模型分支按传入的代理走');
  assert.match(src, /if \(u\.username \|\| u\.password\) return \{ error: '代理地址不支持内嵌账号密码/,
    't3【禁凭据】:校验在服务端(前端提示只是说明)');
  assert.match(src, /proxyUrl: typeof p\.proxyUrl === 'string' \? p\.proxyUrl : ''/, 't3: publicView 回传 proxyUrl');
  assert.match(src, /proxyUrl = typeof stored\.proxyUrl === 'string'/, 't3: 编辑态拉模型用【存储的】代理,不认请求体(同 baseURL 口径)');
  assert.match(src, /const packed = new Response\(spec\.form\);[\s\S]{0,200}packed\.arrayBuffer\(\)/,
    't3【multipart 不许退化】:undici 不认内建 FormData,必须先用 Node 自己的序列化器压成字节再发');
  assert.match(src, /headers: formType \? \{ \.\.\.headers, 'Content-Type': formType \} : headers/,
    't3: boundary 跟着序列化结果走(不是自己编一个)');
  // 安全锚:换 fetch 实现不许动它们(r54/r26 系各自还会再验一遍)
  // r84:新增 /image/actions(MJ 二次操作)后多一处前置校验 → 基线 4 → 5。只增不减。
  // r87:新增第五处外联(GET /api/pricing/model 报价查询,免鉴权)。它同样带 origin 前置校验、
  // redirect:'manual' 与一处限量读 → 三条基线各 +1。语义仍是「只许加不许减」;既有链路原样
  // 的真牙在下面的 runner 切片计数(一个都没变)。
  // 【E25 / r94】upload-ref 与 buttons GET 各加一处出站前 SSRF 闸 → 6 → 8(只增不减)。
  assert.equal(count(src, /await assertPublicBaseURL\(/g), 8, 't3【E25】assertPublicBaseURL 调用点(新增两处外联各 1)');
  // r82 的第四处外联带同款 redirect:'manual' + 两处限量读 → 两条基线各 +1 / +2
  // (它的 fetch 默认就是 undiciFetch,单测可注入;"只许加不许减"的语义没变)。
  // 【E18 / r94】两处新外联同样带 redirect:'manual' → 5 → 7(只增不减)。
  assert.equal(count(src, /redirect: 'manual'/g), 7, "t3【E18】redirect:'manual' 次数(r51 3 + r82 1 + r87 1 + r94 上传 1 + buttons 1)");
  // 【E18 / r94】两处新外联各至少一处限量读 → 7 → 9(只增不减;实测更多时按实测上调,不得低于 9)。
  assert.equal(count(src, /readCapped\(/g), 9, 't3【E18】readCapped 次数(r51 4 + r82 2 + r87 1 + r94 上传/buttons 各 1)');
  assert.ok(count(src, /redactKey\(/g) >= 7, 't3: redactKey 不少于原有 7 处');
}

// ───────────── 4. 前端源码:候选接线 / 小字 / 代理输入框 / 连接正常 ─────────────
{
  const src = readFileSync(join(REPO, 'client/src/components/ImagePanel.jsx'), 'utf8');
  // r87:能力表唯一副本搬去 server/utils/image-caps.js(前后端共用:协议层要按它门控下发,
  // 不能只有前端有);client/src/utils/imageSizeCaps.js 只剩一层再导出。
  const capsSrc = readFileSync(join(REPO, 'server/utils/image-caps.js'), 'utf8');
  const shimSrc = readFileSync(join(REPO, 'client/src/utils/imageSizeCaps.js'), 'utf8');
  assert.match(shimSrc, /from '\.\.\/\.\.\/\.\.\/server\/utils\/image-caps\.js'/,
    't4: 界面侧只是再导出共享能力表(仿 providerList.js 再导出 avatar.js)');
  // 不许带任何 node 内置依赖 —— 带了就进不了浏览器包。原来只挡 node:/fs/os,
  // path / crypto / child_process / url 同样是内置模块,一并挡住。
  assert.ok(!/^import .*from ['"](node:[^'"]*|fs|fs\/promises|os|path|crypto|child_process|url|util|stream|http|https|net|zlib)['"]/m.test(capsSrc),
    't4: 共享能力表不许带 node 内置模块依赖(否则进不了浏览器包)');
  // r87-S6:三个名字都要锁 —— 原来只锁了 SIZE_OPTIONS 与 sizeCapFor,把 sizeOptionsFor
  // 从 import 里删掉都不红(它正是 datalist 候选那条线用的)。
  for (const name of ['SIZE_OPTIONS', 'sizeCapFor', 'sizeOptionsFor']) {
    assert.match(src, new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from '\\.\\./utils/imageSizeCaps\\.js'`),
      `t4: 面板从能力表模块取 ${name}(全量表在纯函数模块,单测可直接 import)`);
  }
  // r87:候选按 (方言, 模型) 二元查(官方方言那半的产物与 r56 逐字相同,见 t1)。
  assert.match(src, /\(sizeOptionsFor\(dialect, form\.model\) \?\? SIZE_OPTIONS\)\.map/,
    't4【datalist 接线】:候选随模型实时过滤,未命中回落全量');
  assert.match(src, /const sizeCap = sizeCapFor\(dialect, form\.model\)/, 't4: 小字读同一份能力表');
  assert.match(src, /\{sizeCap && \([\s\S]{0,220}候选已按 \{sizeCap\.family\} 的官方支持范围过滤；手动输入不受限制。/,
    't4【小字条件渲染】:命中家族才提示,且明说手输不受限');
  const sizeInput = src.split('\n').find((l) => l.includes('list="cgui-image-size-options"')) || '';
  assert.match(sizeInput, /<input .*value=\{form\.size\}/, 't4: 尺寸仍是可自由输入的 input(不是 select)');
  assert.ok(!/disabled|readOnly/.test(sizeInput), `t4【手输不受限】:尺寸输入框不许被禁用/只读(实际:${sizeInput.trim()})`);
  assert.match(src, /size: form\.size/, 't4【发送逻辑零改动】:保存时原样发用户填的值,不按候选表校正');
  // 代理输入框
  assert.match(src, /代理地址（可选）/, 't4:「代理地址(可选)」字段在位');
  assert.match(src, /placeholder="http:\/\/127\.0\.0\.1:7897"/, 't4: placeholder 给本机代理端口示例');
  assert.match(src, /留空直连。填写后本 provider 的生成、拉取模型、图片下载均经此代理（如 Clash 本机端口）；地址不支持内嵌账号密码。/,
    't4: 小字说清作用范围与凭据限制');
  assert.match(src, /proxyUrl: \(form\.proxyUrl \|\| ''\)\.trim\(\)/, 't4: 保存时带上代理(空串 = 清除)');
  assert.match(src, /proxyUrl: p\.proxyUrl \|\| ''/, 't4: 编辑时回填已配代理');
  assert.match(src, /proxyUrl: \(form\.proxyUrl \|\| ''\)\.trim\(\) \}/, 't4: 新建态拉模型也带上表单里的代理');
  // 连接正常
  assert.match(src, /连接正常，拉到 \$\{list\.length\} 个模型/, 't4【连接正常】:拉取成功即连通性 OK');
  assert.match(src, /连接正常，但该服务返回了空的模型列表/, 't4: 空列表也是连上了,别让用户以为没通');
  // 能力表注释必须标出处(能力表是"人写的事实",没出处就是猜)
  // r87 的 apimart 那半同理,出处是 .devflow/RESEARCH-r87-image-params.md(每格都有文档 URL)。
  for (const k of ['OpenAI 官方 Images API', '火山方舟', 'PROJECT.md', 'RESEARCH-r87-image-params.md']) {
    assert.ok(capsSrc.includes(k), `t4: 能力表注释标注来源 ${k}`);
  }
  assert.ok(capsSrc.includes('宁可保留不过滤'), 't4: 红线写在能力表里(拿不准就别过滤)');
}

console.log('✓ check-r56-size-caps: 能力表(gpt-image-2 排除式/1 系与 DALL·E 封闭清单/seedream 去比例/未知回落 null)+ 按 provider 代理(生成/下载/拉模型三处过代理、未配零经过、禁凭据、空串清除、不传保留)+ 连接正常文案 全部通过');
