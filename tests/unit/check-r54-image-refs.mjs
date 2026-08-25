#!/usr/bin/env node
// 单测:r54 图生图(参考图)+ 取消生成中任务。
// Run: node tests/unit/check-r54-image-refs.mjs
//
// 核心牙:
//  ①【纯文生图零回归】没有 refs 时,四种形态构造出的请求与加本功能之前【逐字一致】
//    (chat 的 content 仍是纯字符串、openai 仍打 /images/generations 且 body 无 image)。
//  ② 四协议分流各按官方形态:openai/edits 走 multipart(image[] 重复字段)、
//    openai/generations-image 走 body.image 的 dataURI 数组、gemini 的 parts 文本在前
//    inline_data 在后、chat 走 content 分片的 image_url。
//  ③ 安全:history 形态的参考图必须过与预览同款的两道闸(拒 `..`、savePath 之外一律 400),
//    upload 形态过 mime 白名单与体积闸;历史文件里【绝不出现 base64】。
//  ④ 取消:只掐点名的那一个 job,条目落 cancelled、名额立刻归还;
//    上游超时抛出的异常与手动 abort 同形态,必须仍落既有的超时 error 文案(不是 cancelled)。
//
// 隔离:HOME/USERPROFILE 指向 mktemp 目录(真实 ~/.claude-gui 一个字节不碰);
// 上游全是本机假服务(6703 / 6704),绝不打真实网络。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP_HOME = mkdtempSync(join(tmpdir(), 'cgui-r54-home-'));
const SAVE_DIR = mkdtempSync(join(tmpdir(), 'cgui-r54-save-'));
const OUTSIDE_DIR = mkdtempSync(join(tmpdir(), 'cgui-r54-outside-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
// 只为让「超时」这条在秒级可验(产品默认仍是 120s)。必须在 import 路由之前设。
process.env.CGUI_IMAGE_GENERATE_TIMEOUT_MS = '3000';
mkdirSync(join(TMP_HOME, '.claude-gui'), { recursive: true });
const HISTORY_FILE = join(TMP_HOME, '.claude-gui', 'image-history.json');

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const KEY = 'sk-r54-stored-secret-abcdef123456';
// 1x1 png
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_BUF = Buffer.from(PNG_B64, 'base64');
// savePath 之下预置一张图,给 history 形态的参考图用。
const REF_IN_SAVE = join(SAVE_DIR, 'seed.png');
writeFileSync(REF_IN_SAVE, PNG_BUF);
const REF_OUTSIDE = join(OUTSIDE_DIR, 'secret.png');
writeFileSync(REF_OUTSIDE, PNG_BUF);

const { buildImageRequest } = await import('../../server/utils/image-protocols.js');

// ───────────── 0. 纯函数:无 refs 逐字锚 + 四协议分流 ─────────────
{
  const req = (cfg, prompt, refs) => buildImageRequest(cfg, prompt, refs);
  const oa = { protocol: 'openai', baseURL: 'https://up.example.com/v1', apiKey: 'k', model: 'gpt-image-2', size: '1024x1024' };
  const gm = { protocol: 'gemini', baseURL: 'https://up.example.com/v1beta', apiKey: 'k', model: 'nano-banana' };
  const ch = { protocol: 'chat', baseURL: 'https://up.example.com/v1', apiKey: 'k', model: 'some-chat' };
  const refs = [
    { kind: 'upload', name: 'a.png', mime: 'image/png', base64: PNG_B64 },
    { kind: 'history', name: 'seed.jpg', mime: 'image/jpeg', base64: PNG_B64 },
  ];

  // ── 回归锚:没有参考图时,请求三要素与本功能之前逐字一致 ──
  const strip = (s) => ({ url: s.url, headers: s.headers, body: s.body });
  assert.deepEqual(strip(req(oa, '一只猫')), {
    url: 'https://up.example.com/v1/images/generations',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer k' },
    body: { model: 'gpt-image-2', prompt: '一只猫', n: 1, size: '1024x1024' },
  }, 't0【回归锚】openai 无 refs:仍是 generations + 原样 body(不许多出 image 字段)');
  assert.deepEqual(strip(req(gm, '一只猫')), {
    url: 'https://up.example.com/v1beta/models/nano-banana:generateContent',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer k' },
    body: { contents: [{ parts: [{ text: '一只猫' }] }], generationConfig: { responseModalities: ['IMAGE'] } },
  }, 't0【回归锚】gemini 无 refs:parts 仍只有一个 text');
  assert.deepEqual(strip(req(ch, '一只猫')), {
    url: 'https://up.example.com/v1/chat/completions',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer k' },
    body: { model: 'some-chat', messages: [{ role: 'user', content: '一只猫' }] },
  }, 't0【回归锚】chat 无 refs:content 仍是纯字符串(不是分片数组)');
  for (const cfg of [oa, gm, ch]) {
    assert.equal(req(cfg, 'x').form, null, 't0: 无 refs 一律不是 multipart 形态');
    assert.equal(req(cfg, 'x', []).form, null, 't0: 空 refs 数组等同无 refs');
  }
  assert.deepEqual(strip(req({ ...oa, i2iMode: 'generations-image' }, '一只猫')), strip(req(oa, '一只猫')),
    't0【回归锚】i2iMode 不影响无参考图的请求');

  // ── openai / edits(默认形态):multipart ──
  const edits = req(oa, '把猫改成戴帽子', refs);
  assert.equal(edits.url, 'https://up.example.com/v1/images/edits', 't0: edits 形态打官方 /images/edits');
  assert.ok(edits.form instanceof FormData, 't0: edits 用原生 FormData(零新依赖)');
  assert.equal(edits.body, null, 't0: multipart 形态不带 JSON body');
  assert.ok(!('Content-Type' in edits.headers), 't0: 不许自己写 Content-Type(boundary 交给 fetch)');
  assert.equal(edits.headers.Authorization, 'Bearer k', 't0: 鉴权头照旧');
  assert.equal(edits.form.get('model'), 'gpt-image-2', 't0: model 在位');
  assert.equal(edits.form.get('prompt'), '把猫改成戴帽子', 't0: prompt 在位');
  assert.equal(edits.form.get('size'), '1024x1024', 't0: size 有则带(multipart 支持任意 WxH)');
  assert.equal(edits.form.getAll('image[]').length, 2, 't0: 逐张 image[] 重复字段');

  // ── openai / generations-image(方舟):generations + image dataURI 数组 ──
  const ark = req({ ...oa, i2iMode: 'generations-image' }, '改成戴帽子', refs);
  assert.equal(ark.url, 'https://up.example.com/v1/images/generations', 't0: 方舟形态没有 edits 端点,仍打 generations');
  assert.equal(ark.form, null, 't0: 方舟形态是 JSON 不是 multipart');
  assert.ok(Array.isArray(ark.body.image), 't0: image 是数组');
  assert.equal(ark.body.image.length, 2, 't0: 逐张进 image');
  assert.ok(ark.body.image[0].startsWith(`data:image/png;base64,`), `t0: dataURI 前缀按方舟形态(实际 ${ark.body.image[0].slice(0, 30)})`);
  assert.ok(ark.body.image[1].startsWith('data:image/jpeg;base64,'), 't0: mime 跟随每张图,且小写');
  assert.equal(ark.body.prompt, '改成戴帽子', 't0: 其余字段照旧');

  // ── gemini:text 在前,inline_data 逐张在后 ──
  const gp = req(gm, '改成戴帽子', refs).body.contents[0].parts;
  assert.equal(gp.length, 3, 't0: gemini parts = 1 文本 + 2 图');
  assert.equal(gp[0].text, '改成戴帽子', 't0: 文本 part 在最前(官方示例顺序)');
  assert.equal(gp[1].inline_data.mime_type, 'image/png', 't0: 图 part 用 inline_data');
  assert.equal(gp[1].inline_data.data, PNG_B64, 't0: inline_data 存裸 base64(不带 dataURI 前缀)');
  assert.equal(gp[2].inline_data.mime_type, 'image/jpeg', 't0: 第二张在第一张之后');

  // ── chat:content 分片 ──
  const cc = req(ch, '改成戴帽子', refs).body.messages[0].content;
  assert.ok(Array.isArray(cc), 't0: 带参考图时 content 是分片数组');
  assert.deepEqual(cc[0], { type: 'text', text: '改成戴帽子' }, 't0: 文本分片在前');
  assert.equal(cc[1].type, 'image_url', 't0: 图走 image_url 分片');
  assert.ok(cc[1].image_url.url.startsWith('data:image/png;base64,'), 't0: image_url 用 dataURI');
  assert.equal(cc.length, 3, 't0: 逐张成分片');
}

const express = (await import('express')).default;
const imageRouter = (await import('../../server/routes/image.js')).default;

const app = express();
app.use(express.json({ limit: '25mb' }));
let seenEdits = null; let seenGen = null;
// multipart 上游:用原生 Response.formData() 反解,断言各 part 真在请求里。
app.post('/edits/v1/images/edits', express.raw({ type: '*/*', limit: '30mb' }), async (req, res) => {
  const ct = req.headers['content-type'] || '';
  let parsed = null;
  try { parsed = await new Response(req.body, { headers: { 'content-type': ct } }).formData(); }
  catch (e) { seenEdits = { ct, parseError: e.message }; return res.status(400).json({ error: 'bad multipart' }); }
  const images = parsed.getAll('image[]');
  seenEdits = {
    ct,
    model: parsed.get('model'),
    prompt: parsed.get('prompt'),
    size: parsed.get('size'),
    quality: parsed.get('quality'),
    images: images.map((f) => ({ name: f.name, type: f.type, size: f.size })),
  };
  res.json({ data: [{ b64_json: PNG_B64 }] });
});
app.post('/edits/v1/images/generations', (req, res) => {
  seenGen = { path: 'edits-provider-hit-generations', body: req.body };
  res.json({ data: [{ b64_json: PNG_B64 }] });
});
// 方舟形态上游 + 纯文生图回归上游(同一处记录请求体)。
app.post('/ark/v1/images/generations', (req, res) => {
  seenGen = { path: '/images/generations', ct: req.headers['content-type'], body: req.body };
  res.json({ data: [{ b64_json: PNG_B64 }] });
});
app.post('/ark/v1/images/edits', (_req, res) => { seenGen = { path: 'ark-hit-edits' }; res.status(404).json({ error: 'no such endpoint' }); });
// 慢/挂死上游:取消用。
app.post('/hang/v1/images/generations', () => { /* 永不响应:等取消或超时 */ });
app.post('/fast/v1/images/generations', (_req, res) => res.json({ data: [{ b64_json: PNG_B64 }] }));
app.use('/api', imageRouter);

async function listenWithRetry(port, tries = 40, make = (p) => app.listen(p, '127.0.0.1')) {
  for (let i = 0; i < tries; i++) {
    const s = make(port);
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
const server = await listenWithRetry(6703);
const BASE = 'http://127.0.0.1:6703';
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
const historyOf = async (id) => {
  const r = await api('GET', '/api/image/history');
  assert.equal(r.status, 200, `GET /image/history(${r.status})`);
  const list = r.json?.history || [];
  return { list, text: r.text, entry: id ? list.find((e) => e.id === id) : null };
};
const settle = (id) => waitFor(async () => {
  const h = await historyOf(id);
  return h.entry && h.entry.status !== 'running' ? h : null;
});

let failure = null;
try {
  // ───────────── 1. openai/edits:multipart 真的发出去了 ─────────────
  {
    const pid = await mkProvider('官方 edits', '/edits/v1', { size: '1536x1024', extra: { quality: 'high' } });
    const r = await api('POST', '/api/image/generate', {
      providerId: pid,
      prompt: '把这只猫改成戴帽子',
      refs: [
        { kind: 'upload', name: '我的猫.png', mime: 'image/png', dataB64: PNG_B64 },
        { kind: 'history', file: REF_IN_SAVE },
      ],
    });
    assert.equal(r.status, 200, `t1: 带参考图的请求被受理(${r.text})`);
    const done = await settle(r.json.jobId);
    assert.ok(done, 't1: 任务落终态');
    assert.equal(done.entry.status, 'done', `t1: 出图成功(${JSON.stringify(done.entry)})`);
    assert.ok(seenEdits, 't1: 上游收到了请求');
    assert.ok(!seenEdits.parseError, `t1: 上游能按 multipart 解开(${seenEdits.parseError})`);
    assert.match(seenEdits.ct, /^multipart\/form-data; boundary=/, `t1【Content-Type】:必须是带 boundary 的 multipart(实际 ${seenEdits.ct})`);
    assert.equal(seenEdits.model, 'gpt-image-2', 't1: model part 在位');
    assert.equal(seenEdits.prompt, '把这只猫改成戴帽子', 't1: prompt part 在位');
    assert.equal(seenEdits.size, '1536x1024', 't1: size part 在位(multipart 支持任意 WxH)');
    assert.equal(seenEdits.quality, 'high', 't1: 附加参数照旧并入');
    assert.equal(seenEdits.images.length, 2, 't1【逐张 image[]】:两张参考图各一个 part');
    assert.equal(seenEdits.images[0].name, '我的猫.png', 't1: 上传图带文件名');
    assert.equal(seenEdits.images[0].type, 'image/png', 't1: 每个 part 带自己的 Content-Type');
    assert.equal(seenEdits.images[0].size, PNG_BUF.length, 't1: part 里是解码后的二进制,不是 base64 文本');
    assert.equal(seenEdits.images[1].name, 'seed.png', 't1: history 形态由服务端读盘转成 part');

    // 历史摘要:有 refs 元数据,但整份历史文件里没有 base64
    assert.ok(Array.isArray(done.entry.refs), 't1: 条目带 refs 摘要(前端据此打「图生图」角标)');
    assert.deepEqual(done.entry.refs, [{ kind: 'upload', name: '我的猫.png' }, { kind: 'history', file: REF_IN_SAVE }], 't1: 摘要只有 kind + 名称/路径');
    const raw = readFileSync(HISTORY_FILE, 'utf8');
    assert.ok(!raw.includes(PNG_B64), 't1【绝不存 base64】:历史文件里不许出现图片内容');
    assert.ok(!raw.includes(PNG_B64.slice(0, 40)), 't1: 连片段也不许有');
    assert.ok(!done.text.includes(KEY), 't1: 历史响应不含 apiKey');
  }

  // ───────────── 2. 无 refs 的纯文生图:仍走 generations,body 里没有 image ─────────────
  {
    seenGen = null;
    const pid = await mkProvider('纯文生图回归', '/ark/v1');
    const r = await api('POST', '/api/image/generate', { providerId: pid, prompt: '一只普通的猫' });
    const done = await settle(r.json.jobId);
    assert.equal(done.entry.status, 'done', `t2: 纯文生图照旧出图(${JSON.stringify(done.entry)})`);
    assert.equal(seenGen.path, '/images/generations', 't2【零回归】:没有参考图就不该碰 edits 端点');
    assert.equal(seenGen.ct, 'application/json', 't2: 仍是 JSON 请求');
    assert.deepEqual(seenGen.body, { model: 'gpt-image-2', prompt: '一只普通的猫', n: 1 }, 't2【逐字一致】:请求体与本功能之前一模一样');
    assert.ok(!('refs' in done.entry), 't2: 无参考图的条目不写 refs 字段');
  }

  // ───────────── 3. i2iMode=generations-image:方舟形态 ─────────────
  {
    seenGen = null;
    const pid = await mkProvider('方舟 Seedream', '/ark/v1', { i2iMode: 'generations-image', model: 'doubao-seedream-4-5' });
    const list = await api('GET', '/api/image-providers');
    const stored = (list.json.providers || []).find((p) => p.id === pid);
    assert.equal(stored.i2iMode, 'generations-image', 't3: i2iMode 落盘并回传给前端');
    const r = await api('POST', '/api/image/generate', {
      providerId: pid, prompt: '给它加个帽子', refs: [{ kind: 'history', file: REF_IN_SAVE }],
    });
    const done = await settle(r.json.jobId);
    assert.equal(done.entry.status, 'done', `t3: 出图成功(${JSON.stringify(done.entry)})`);
    assert.equal(seenGen.path, '/images/generations', 't3【分流】:方舟形态不打 edits(它没这个端点)');
    assert.ok(Array.isArray(seenGen.body.image), 't3: 参考图走 body.image 数组');
    assert.equal(seenGen.body.image.length, 1, 't3: 一张参考图一个元素');
    assert.ok(seenGen.body.image[0].startsWith('data:image/png;base64,'), `t3【dataURI】前缀必须是 data:image/png;base64,(实际 ${String(seenGen.body.image[0]).slice(0, 32)})`);
    assert.equal(seenGen.body.image[0].slice('data:image/png;base64,'.length), PNG_B64, 't3: dataURI 里是该图的 base64');
    assert.equal(seenGen.body.prompt, '给它加个帽子', 't3: 其余字段照旧');
  }

  // ───────────── 4. 安全:路径穿透 / 体积 / 张数 / 格式 ─────────────
  {
    const pid = await mkProvider('安全闸', '/fast/v1');
    const bad = async (refs, why) => {
      const before = (await historyOf()).list.length;
      const r = await api('POST', '/api/image/generate', { providerId: pid, prompt: '越界', refs });
      assert.equal(r.status, 400, `t4: ${why} 必须 400(实际 ${r.status} ${r.text})`);
      assert.ok(r.json?.error, `t4: ${why} 要给人话`);
      assert.equal((await historyOf()).list.length, before, `t4: ${why} 不写历史条目(不进后台任务)`);
    };
    await bad([{ kind: 'history', file: join(SAVE_DIR, '..', 'etc', 'passwd.png') }], '带 .. 段的路径');
    await bad([{ kind: 'history', file: REF_OUTSIDE }], 'savePath 之外的绝对路径');
    await bad([{ kind: 'history', file: 'seed.png' }], '相对路径');
    await bad([{ kind: 'history', file: join(SAVE_DIR, 'x.json') }], '非图片扩展名');
    await bad([{ kind: 'history', file: join(SAVE_DIR, '不存在.png') }], '不存在的文件');
    // 16MB > MAX_REF_BYTES(15MB) 但编码后仍在 express.json 的 25mb 之内 —— 打的正是
    // 我们自己的体积闸(再大就变成 body 解析层 413,测不到这道闸)。
    const huge = Buffer.alloc(16 * 1024 * 1024, 7).toString('base64');
    await bad([{ kind: 'upload', name: 'huge.png', mime: 'image/png', dataB64: huge }], '超大上传图');
    await bad([{ kind: 'upload', name: 'x.svg', mime: 'image/svg+xml', dataB64: PNG_B64 }], '白名单外的 mime');
    await bad(Array.from({ length: 7 }, () => ({ kind: 'upload', name: 'a.png', mime: 'image/png', dataB64: PNG_B64 })), '超过 6 张');
    await bad('不是数组', '非数组的 refs');
    await bad([{ kind: 'unknown', file: REF_IN_SAVE }], '未知的 kind');

    // 软链穿透:savePath 里预埋一个指向外部文件的软链
    const { symlinkSync } = await import('node:fs');
    const linkPath = join(SAVE_DIR, 'link.png');
    try { symlinkSync(REF_OUTSIDE, linkPath); } catch { /* 无权建软链的环境跳过这条 */ }
    if (existsSync(linkPath)) await bad([{ kind: 'history', file: linkPath }], '指向 savePath 之外的软链');
  }

  // ───────────── 5. 取消:cancelled + 名额归还 + 幂等 ─────────────
  {
    const hangId = await mkProvider('挂死上游', '/hang/v1');
    const jobs = [];
    for (const p of ['取消-1', '取消-2', '取消-3']) {
      const r = await api('POST', '/api/image/generate', { providerId: hangId, prompt: p });
      assert.equal(r.status, 200, `t5: 受理 ${p}(${r.text})`);
      jobs.push(r.json.jobId);
    }
    // 名额占满:第 4 个 429
    const over = await api('POST', '/api/image/generate', { providerId: hangId, prompt: '取消-第四个' });
    assert.equal(over.status, 429, 't5: 三个在跑时第四个 429(名额确实被占着)');

    const t0 = Date.now();
    const c = await api('POST', `/api/image/jobs/${jobs[0]}/cancel`);
    assert.equal(c.status, 200, `t5: cancel 端点存在(${c.status} ${c.text.slice(0, 80)})`);
    assert.equal(c.json?.ok, true, `t5: 在跑的任务可取消(${c.text})`);
    const cancelled = await waitFor(async () => {
      const h = await historyOf(jobs[0]);
      return h.entry?.status === 'cancelled' ? h : null;
    }, 3000);
    assert.ok(cancelled, 't5【取消生效】:1s 级内条目变 cancelled');
    assert.ok(Date.now() - t0 < 1000, `t5: 取消到落 cancelled 应在 1s 内(实际 ${Date.now() - t0}ms)`);
    assert.ok(!cancelled.entry.error, `t5【不落 error 文案】:取消不是失败(实际 error=${cancelled.entry.error})`);
    assert.equal(typeof cancelled.entry.tookMs, 'number', 't5: 记下耗时');

    // 名额归还:立刻能发新任务(不 429)
    const again = await api('POST', '/api/image/generate', { providerId: hangId, prompt: '取消后补位' });
    assert.equal(again.status, 200, `t5【名额归还】:取消后必须能立刻发新任务(实际 ${again.status} ${again.text})`);
    jobs.push(again.json.jobId);

    // 只掐点名的那一个:其余两个还在跑
    const others = await historyOf();
    for (const id of [jobs[1], jobs[2]]) {
      assert.equal(others.list.find((e) => e.id === id)?.status, 'running', 't5【只作用于点名的 job】:同批其他任务不受影响');
    }

    // 幂等:已终态 / 不存在 → ok:false 且不是错误状态码
    const dup = await api('POST', `/api/image/jobs/${jobs[0]}/cancel`);
    assert.equal(dup.status, 200, 't5: 重复取消不算错(200)');
    assert.equal(dup.json?.ok, false, 't5: 已结束的任务 ok:false');
    assert.ok(dup.json?.error, 't5: 给出「已结束或不存在」的说明');
    const ghost = await api('POST', '/api/image/jobs/no-such-job/cancel');
    assert.equal(ghost.status, 200, 't5: 不存在的 jobId 同样幂等');
    assert.equal(ghost.json?.ok, false, 't5: 不存在 → ok:false');

    // 收尾:把剩下几个挂死任务都取消掉,免得拖到超时影响后面的用例
    for (const id of jobs.slice(1)) await api('POST', `/api/image/jobs/${id}/cancel`);
    await waitFor(async () => !(await historyOf()).list.some((e) => e.status === 'running'), 5000);

    // 取消不是「已完成」:done 条目取消也走幂等分支
    const fastId = await mkProvider('快上游(幂等)', '/fast/v1');
    const okJob = await api('POST', '/api/image/generate', { providerId: fastId, prompt: '正常完成' });
    const okDone = await settle(okJob.json.jobId);
    assert.equal(okDone.entry.status, 'done', 't5: 正常任务照常 done');
    const cDone = await api('POST', `/api/image/jobs/${okJob.json.jobId}/cancel`);
    assert.equal(cDone.json?.ok, false, 't5: 对已完成条目取消 → ok:false,且不改它的状态');
    assert.equal((await historyOf(okJob.json.jobId)).entry.status, 'done', 't5: done 条目状态不被取消改写');
  }

  // ───────────── 6. 超时 ≠ 取消(两者异常形态相同,只能靠 controller 侧标志位区分) ─────────────
  {
    const hangId = await mkProvider('挂死上游(超时)', '/hang/v1');
    const r = await api('POST', '/api/image/generate', { providerId: hangId, prompt: '等到超时' });
    const done = await settle(r.json.jobId);
    assert.ok(done, 't6: 超时也要落终态');
    assert.equal(done.entry.status, 'error', `t6【超时≠取消】:没人点取消的超时必须仍是 error(实际 ${done.entry.status})`);
    assert.match(done.entry.error || '', /生成超时（\d+ 秒），上游没有返回/, `t6: 超时落既有原文案(实际:${done.entry.error})`);
  }

  // ───────────── 6b. 删除历史:删记录 / 删文件 / 守卫 / running 先取消 ─────────────
  {
    const fastId = await mkProvider('删除用', '/fast/v1');
    const mk = async (prompt) => {
      const r = await api('POST', '/api/image/generate', { providerId: fastId, prompt });
      const done = await settle(r.json.jobId);
      assert.equal(done.entry.status, 'done', `t6b: ${prompt} 先正常出图`);
      return done.entry;
    };
    // ── 单删:只删记录,磁盘上的图仍在 ──
    {
      const e = await mk('删记录-保留文件');
      assert.ok(existsSync(e.file), 't6b: 图片确实落盘了');
      const before = (await historyOf()).list.length;
      const r = await api('POST', '/api/image/history/delete', { ids: [e.id] });
      assert.equal(r.status, 200, `t6b: 删除端点存在(${r.status} ${r.text.slice(0, 100)})`);
      assert.equal(r.json?.ok, true, `t6b: 删除成功(${r.text})`);
      assert.equal(r.json.removed, 1, 't6b: removed 计数');
      assert.equal(r.json.filesDeleted, 0, 't6b【默认不删文件】:没传 deleteFile 就一个文件都不许删');
      const after = await historyOf();
      assert.equal(after.list.length, before - 1, 't6b: 历史少一条');
      assert.ok(!after.list.some((x) => x.id === e.id), 't6b: 该条目已移除');
      assert.ok(existsSync(e.file), 't6b【只删记录】:磁盘上的图片必须还在');
      const onDisk = JSON.parse(readFileSync(HISTORY_FILE, 'utf8'));
      assert.ok(!onDisk.some((x) => x.id === e.id), 't6b: 删除结果落盘(不是只在响应里改)');
    }
    // ── deleteFile=true:连文件一起删 ──
    {
      const e = await mk('删记录-连文件');
      const r = await api('POST', '/api/image/history/delete', { ids: [e.id], deleteFile: true });
      assert.equal(r.json?.filesDeleted, 1, `t6b: 勾选后删掉 1 个文件(${r.text})`);
      assert.deepEqual(r.json.skipped, [], 't6b: 正常路径不进 skipped');
      assert.ok(!existsSync(e.file), 't6b【删文件】:磁盘上的图片已被删除');
      assert.ok(!(await historyOf()).list.some((x) => x.id === e.id), 't6b: 条目同时移除');
    }
    // ── 批量:一次删多条 ──
    {
      const a = await mk('批量-1'); const b = await mk('批量-2'); const c = await mk('批量-3');
      const r = await api('POST', '/api/image/history/delete', { ids: [a.id, b.id], deleteFile: true });
      assert.equal(r.json?.removed, 2, 't6b: 批量删两条');
      assert.equal(r.json.filesDeleted, 2, 't6b: 两个文件都删了');
      const list = (await historyOf()).list;
      assert.ok(!list.some((x) => x.id === a.id || x.id === b.id), 't6b: 两条都不在了');
      assert.ok(list.some((x) => x.id === c.id), 't6b: 没点名的条目不受影响');
      assert.ok(existsSync(c.file), 't6b: 没点名的文件不受影响');
    }
    // ── 守卫:条目里夹带一个 savePath 之外的 file,该文件必须幸存并进 skipped ──
    {
      const e = await mk('越界-file-被改写');
      const outsideFile = join(OUTSIDE_DIR, 'must-survive.png');
      writeFileSync(outsideFile, PNG_BUF);
      // 直接改历史文件,模拟条目的 file 字段被写成 savePath 之外的路径。
      const list = JSON.parse(readFileSync(HISTORY_FILE, 'utf8'));
      list.find((x) => x.id === e.id).file = outsideFile;
      writeFileSync(HISTORY_FILE, JSON.stringify(list, null, 2));
      const r = await api('POST', '/api/image/history/delete', { ids: [e.id], deleteFile: true });
      assert.equal(r.json?.ok, true, 't6b: 请求本身成功');
      assert.equal(r.json.removed, 1, 't6b: 记录照删');
      assert.equal(r.json.filesDeleted, 0, 't6b【守卫】:savePath 之外的文件一个都不许删');
      assert.deepEqual(r.json.skipped, [outsideFile], 't6b: 被跳过的路径如实回报');
      assert.ok(existsSync(outsideFile), 't6b【守卫】:savePath 之外的文件必须幸存');
    }
    // ── running 条目:先取消再删,名额归还 ──
    {
      const hangId = await mkProvider('挂死上游(删除)', '/hang/v1');
      const jobs = [];
      for (const p of ['删除-running-1', '删除-running-2', '删除-running-3']) {
        const r = await api('POST', '/api/image/generate', { providerId: hangId, prompt: p });
        jobs.push(r.json.jobId);
      }
      assert.equal((await api('POST', '/api/image/generate', { providerId: hangId, prompt: '第四个' })).status, 429,
        't6b: 三个在跑,名额确实占满');
      const r = await api('POST', '/api/image/history/delete', { ids: jobs });
      assert.equal(r.json?.removed, 3, `t6b: running 条目也能删(${r.text})`);
      const gone = await waitFor(async () => {
        const l = (await historyOf()).list;
        return jobs.every((id) => !l.some((e) => e.id === id)) ? true : null;
      }, 3000);
      assert.ok(gone, 't6b: 三条 running 记录都已移除');
      const again = await api('POST', '/api/image/generate', { providerId: fastId, prompt: '删除后补位' });
      assert.equal(again.status, 200, `t6b【名额归还】:删掉 running 条目 = 先取消,名额必须回来(实际 ${again.status})`);
      await settle(again.json.jobId);
    }
    // ── 入参校验 ──
    {
      assert.equal((await api('POST', '/api/image/history/delete', { ids: [] })).status, 400, 't6b: 空 ids → 400');
      assert.equal((await api('POST', '/api/image/history/delete', { ids: 'x' })).status, 400, 't6b: 非数组 ids → 400');
      const ghost = await api('POST', '/api/image/history/delete', { ids: ['no-such-id'] });
      assert.equal(ghost.json?.removed, 0, 't6b: 删不存在的 id → removed 0,不报错');
    }
  }

  // ───────────── 7. 启动清障只清 running,不碰 cancelled ─────────────
  {
    writeFileSync(HISTORY_FILE, JSON.stringify([
      { id: 'zombie', prompt: '上次没跑完', status: 'running', startedAt: 1 },
      { id: 'was-cancelled', prompt: '上次取消的', status: 'cancelled', startedAt: 1 },
    ], null, 2));
    const freshRouter = (await import('../../server/routes/image.js?r54-restart')).default;
    const app2 = express();
    app2.use(express.json());
    app2.use('/api', freshRouter);
    const s2 = await listenWithRetry(6704, 40, (p) => app2.listen(p, '127.0.0.1'));
    try {
      const rr = await fetch('http://127.0.0.1:6704/api/image/history');
      const list = (await rr.json()).history || [];
      assert.equal(list.find((e) => e.id === 'zombie')?.status, 'interrupted', 't7: 遗留 running 仍被清成 interrupted');
      assert.equal(list.find((e) => e.id === 'was-cancelled')?.status, 'cancelled', 't7【不碰终态】:cancelled 条目原样保留');
    } finally {
      s2.closeAllConnections?.();
      s2.close();
      await new Promise((res) => s2.once('close', res));
    }
  }
} catch (e) {
  failure = e;
} finally {
  server.closeAllConnections?.();
  server.close();
  await new Promise((r) => server.once('close', r));
  for (const d of [TMP_HOME, SAVE_DIR, OUTSIDE_DIR]) rmSync(d, { recursive: true, force: true });
}
if (failure) throw failure;

// ───────────── 8. 服务端源码:安全链路零改动 + 取消/参考图的关键判据 ─────────────
{
  const src = readFileSync(join(REPO, 'server/routes/image.js'), 'utf8');
  const count = (s, re) => (s.match(re) || []).length;
  // r51 基线:安全锚点只许加,不许被删被弱化(参考图与取消都不该动这些)。
  assert.equal(count(src, /await assertPublicBaseURL\(/g), 4, 't8: assertPublicBaseURL 调用点数量不变');
  assert.equal(count(src, /redirect: 'manual'/g), 3, "t8: redirect:'manual' 出现次数不变");
  assert.equal(count(src, /readCapped\(/g), 4, 't8: readCapped 出现次数不变');
  assert.ok(count(src, /redactKey\(/g) >= 7, 't8: redactKey 不少于原有 7 处');
  assert.match(src, /finally \{\n\s*activeJobs -= 1;/, 't8: 名额仍在 finally 归还(取消复用同一条路径)');
  // 参考图:两道闸都要用上,且历史只写摘要
  assert.match(src, /resolvePreviewPath\(String\(r\.file[\s\S]{0,200}realPathInsideSaveDirs\(full, saveDirs\)/,
    't8【路径守卫】:history 形态的参考图必须过 resolvePreviewPath + realPathInsideSaveDirs');
  assert.match(src, /MAX_REF_BYTES/, 't8: 参考图体积闸在位');
  assert.match(src, /MAX_REFS/, 't8: 参考图张数闸在位');
  assert.match(src, /REF_UPLOAD_MIMES/, 't8: 上传 mime 白名单在位');
  assert.match(src, /resolved\.meta \? \{ refs: resolved\.meta \}/, 't8: 历史只写摘要');
  assert.ok(!/refs:\s*resolved\.refs/.test(src), 't8: 历史条目不许直接写含 base64 的 refs');
  // 取消:标志位区分 + per-job controller
  assert.match(src, /const jobControllers = new Map\(\)/, 't8: per-job AbortController 登记表');
  assert.match(src, /const cancelledJobs = new Set\(\)/, 't8【超时/取消区分】:靠 controller 侧标志位,不是靠 e.name');
  assert.match(src, /cancelledJobs\.has\(jobId\) \? Promise\.resolve\(\)/, 't8: 取消时不覆写 error 文案');
  assert.match(src, /cancelledJobs\.add\(id\);[\s\S]{0,120}controller\.abort\(\)/, 't8: 先打标志再 abort(顺序反了会先写成 error)');
  assert.match(src, /'\/image\/jobs\/:id\/cancel'/, 't8: cancel 端点在位');
  assert.match(src, /AbortSignal\.any\(\[controller\.signal, AbortSignal\.timeout\(GENERATE_TIMEOUT_MS\)\]\)/,
    't8: 生成请求同时受取消与超时约束');
  assert.match(src, /GENERATE_TIMEOUT_MS = Number\(process\.env\.CGUI_IMAGE_GENERATE_TIMEOUT_MS\) \|\| 120_000/,
    't8: 默认超时仍是 120s(环境变量只为单测下调)');
  assert.match(src, /if \(e && e\.status === 'running'\)/, 't8: 启动清障仍只认 running');
  // 删除:守卫 + 只删单文件 + 走 withHistory
  assert.match(src, /'\/image\/history\/delete'/, 't8: 删除端点在位');
  assert.match(src, /const full = resolvePreviewPath\(String\(e\.file\), saveDirs\);\s*\n\s*if \(!full \|\| !realPathInsideSaveDirs\(full, saveDirs\)\) \{ skipped\.push/,
    't8【删文件守卫】:每个待删文件都必须过 resolvePreviewPath + realPathInsideSaveDirs,不过就跳过');
  const delStart = src.indexOf("router.post('/image/history/delete'");
  const delBlock = src.slice(delStart, src.indexOf('router.', delStart + 10));
  assert.ok(delStart > 0 && delBlock.length > 200, 't8: 能定位删除端点源码块');
  assert.equal(count(delBlock, /await unlink\(/g), 1, 't8: 删除端点里只有一处 unlink(删单个文件)');
  assert.ok(!/\brm\(|rmSync|rmdir|recursive: true/.test(delBlock), 't8【禁递归删除】:删除端点里不许出现任何递归/目录删除');
  assert.match(src, /router\.post\('\/image\/history\/delete'[\s\S]{0,1600}await withHistory\(/, 't8: 历史移除在 withHistory 串行队列内完成');
  assert.match(src, /cancelledJobs\.add\(id\);[\s\S]{0,200}controller\.abort\(\)[\s\S]{0,400}withHistory/, 't8: 删除 running 条目先复用取消链路');
}

// ───────────── 9. 前端源码:参考图条 / 以此图修改 / 取消 / 角标 / 表单 hidden ─────────────
{
  const src = readFileSync(join(REPO, 'client/src/components/ImagePanel.jsx'), 'utf8');
  // 参考图条
  assert.match(src, /type="file"[\s\S]{0,120}accept=\{REF_ACCEPT\}[\s\S]{0,80}multiple/, 't9: 参考图走多选文件选择器');
  assert.match(src, /REF_ACCEPT = 'image\/png,image\/jpeg,image\/webp'/, 't9: 只收 png/jpeg/webp');
  assert.match(src, /添加参考图/, 't9:「添加参考图」按钮在位');
  assert.match(src, /refs\.length \+ picked\.length > MAX_REFS/, 't9: 前端预检张数');
  assert.match(src, /f\.size > MAX_REF_BYTES/, 't9: 前端预检单张体积');
  assert.match(src, /图生图（\{refs\.length\} 张参考）/, 't9: 生成按钮旁给出图生图提示');
  assert.match(src, /setRefs\(\(cur\) => cur\.filter\(\(_, j\) => j !== i\)\)/, 't9: 每张参考图可单独移除');
  assert.ok(!/localStorage\.setItem\([^)]*[Rr]ef/.test(src), 't9: 参考图不进 localStorage 草稿(体积大)');
  // 发请求
  assert.match(src, /payload\.refs = refs\.map/, 't9: 有参考图才带 refs 字段');
  assert.match(src, /kind: 'history', file: r\.file/, 't9: history 形态只传路径,不回传图片内容');
  assert.match(src, /r\.status === 413/, 't9: 总体积超限给人话(413 响应不是 JSON)');
  // 以此图修改
  assert.match(src, /以此图修改/, 't9:「以此图修改」按钮在位');
  assert.match(src, /addHistoryRef = \(h\)/, 't9: 引用已生成图的入口');
  assert.match(src, /const addHistoryRef = \(h\) => \{[\s\S]{0,120}setTab\('gen'\)/, 't9:「以此图修改」自动切回生图页');
  // 取消
  assert.match(src, /\/api\/image\/jobs\/\$\{encodeURIComponent\(id\)\}\/cancel/, 't9: 取消调 /api/image/jobs/:id/cancel');
  assert.match(src, /h\.status === 'running' && \([\s\S]{0,400}cancelJob\(h\.id\)/, 't9: running 条目才有「取消」按钮');
  assert.ok(!/const cancelJob = async \(id\) => \{[\s\S]{0,500}confirmDialog/.test(src),
    't9: 取消不弹确认(可重发,不是破坏性操作);删除才弹');
  assert.ok(!/key === 'Escape'|onKeyDown/.test(src), 't9: 取消不绑 Esc 与任何快捷键');
  assert.match(src, /cancelled: '已取消'/, 't9: cancelled 有终态文案');
  // 角标
  assert.equal((src.match(/h\.refs\?\.length \?/g) || []).length, 2, 't9:「图生图」角标在网格与列表两种视图都有');
  // provider 表单
  assert.match(src, /form\.protocol === 'openai' && \([\s\S]{0,400}form\.i2iMode/, 't9: 图生图形态只在 openai 协议显示');
  assert.match(src, /i2iMode: form\.i2iMode \|\| 'edits'/, 't9: 保存时带上 i2iMode');
  assert.match(src, /i2iMode: p\.i2iMode \|\| 'edits'/, 't9: 编辑时回填 i2iMode');
  // 删除:单删 + 批量 + 确认对话框(带勾选框)
  assert.match(src, /deleteEntries\(\[h\.id\]\)/, 't9: 每条都有单删入口');
  assert.match(src, /deleteEntries\(\[\.\.\.selectedIds\]\)/, 't9: 批量删所选');
  assert.match(src, /\/api\/image\/history\/delete/, 't9: 走删除端点');
  assert.match(src, /checkbox: \{ label: '同时删除本地图片文件（不可恢复）' \}/, 't9: 确认框带「同时删除本地图片文件」勾选框');
  assert.match(src, /confirmDialog\([\s\S]{0,240}danger: true/, 't9: 删除确认是 danger 形态(Tauri 禁原生 confirm,必须走 confirmDialog)');
  assert.match(src, /deleteFile: !!answer\.checked/, 't9: 勾选与否决定是否删文件(默认不勾 → 不删)');
  assert.match(src, /if \(!answer\?\.confirmed\) return;/, 't9: 未确认不发请求');
  assert.match(src, /\{selectMode \? '退出选择' : '选择'\}/, 't9:「选择」开关在位');
  assert.match(src, /'取消全选' : '全选'/, 't9:「全选」在位');
  assert.match(src, /删除所选（\{selectedIds\.size\}）/, 't9:「删除所选(N)」在位');
  assert.match(src, /onClick=\{\(\) => deleteEntries\(\[\.\.\.selectedIds\]\)\}\s*\n\s*disabled=\{!selectedIds\.size\}/, 't9: 一条没选时「删除所选」禁用');
  assert.equal((src.match(/checked=\{selectedIds\.has\(h\.id\)\}/g) || []).length, 2, 't9: 网格与列表两种视图都有勾选框');
  assert.match(src, /其中 \$\{runningCount\} 条仍在生成中，将先取消再删除/, 't9: 选中生成中的条目时对话框如实提示');
  assert.match(src, /setSelectedIds\(new Set\(\)\);\s*\n\s*setSelectMode\(false\);/, 't9: 删除后选择态复位');
  assert.match(src, /d\.skipped\?\.length/, 't9: 有文件因守卫被跳过时如实告知');
  // r51 判官建议2:表单区改 hidden 切换
  assert.ok(!/\{tab === 'gen' && \(form/.test(src), "t9【hidden 切换】:表单宿主区不许再用 tab === 'gen' && 条件渲染(切走会丢未保存字段)");
  assert.match(src, /<div className=\{tab === 'gen' \? '' : 'hidden'\}>\{\(form/, 't9: 表单宿主区用 hidden 类切换');
}

console.log('✓ check-r54-image-refs: 四协议参考图分流(multipart/dataURI/inline_data/image_url)+ 纯文生图零回归 + 路径与体积守卫 + 取消(超时可区分)+ 历史删除(守卫/只删单文件/running 先取消)+ 前端参考图条/以此图修改/批量删除/角标/表单 hidden 全部通过');
