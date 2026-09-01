#!/usr/bin/env node
// 单测:r16-3 自定义生图 —— 三协议请求组装/取图(纯函数)+ 文件名 + 预览路径穿透防护
// + apiKey 不外泄 + CRUD/出图/预览的端到端(本地假上游,绝不打真实生图 API)。
// Run: node tests/unit/check-image-gen.mjs
//
// 隔离:HOME 指向 mktemp 目录(真实 ~/.claude-gui 一个字节不碰);端口只用 6702,退出即释放。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, symlinkSync, chmodSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 必须在 import 路由前改 HOME:真实 HOME 下的用户数据只读不写(红线)。
const TMP_HOME = mkdtempSync(join(tmpdir(), 'cgui-img-home-'));
const SAVE_DIR = mkdtempSync(join(tmpdir(), 'cgui-img-save-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;

const {
  buildImageRequest, extractImage, buildImageFileName, imageExtFromMime,
  resolvePreviewPath, redactKey, IMAGE_PROTOCOLS,
} = await import('../../server/utils/image-protocols.js');

const KEY = 'sk-cgui-test-secret-abcdef123456';
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// ─────────────────── 1. buildImageRequest:三协议请求组装 ───────────────────
{
  // r82:三种同步协议之后追加任务制的 mj(顺序不变、只在尾部加 —— 前三项的行为红线见下文)。
  assert.deepEqual(IMAGE_PROTOCOLS, ['openai', 'gemini', 'chat', 'mj'], 't1: 三种同步协议 + r82 的 mj');

  // openai:POST {base}/images/generations,body {model, prompt, n:1, size}
  const oa = buildImageRequest(
    { protocol: 'openai', baseURL: 'https://api.example.com/v1/', apiKey: KEY, model: 'gpt-image-2', size: '1024x1024' },
    '一只猫',
  );
  assert.equal(oa.url, 'https://api.example.com/v1/images/generations', 't1: openai 端点(尾斜杠已归一)');
  assert.equal(oa.headers.Authorization, `Bearer ${KEY}`, 't1: openai 走 Bearer');
  assert.equal(oa.headers['Content-Type'], 'application/json');
  assert.deepEqual(oa.body, { model: 'gpt-image-2', prompt: '一只猫', n: 1, size: '1024x1024' }, 't1: openai body');
  assert.equal(oa.altHeaders, null, 't1: openai 无认证回落');
  // gpt-image 系不支持 response_format → 不得主动带
  assert.ok(!('response_format' in oa.body), 't1: 不主动带 response_format(gpt-image 传了会 400)');
  // size 为空时不下发该字段
  assert.ok(!('size' in buildImageRequest({ protocol: 'openai', baseURL: 'https://a.co/v1', apiKey: KEY, model: 'm' }, 'p').body),
    't1: 未填尺寸则不带 size');
  // extra 透传并可覆盖
  assert.equal(
    buildImageRequest({ protocol: 'openai', baseURL: 'https://a.co/v1', apiKey: KEY, model: 'm', extra: { quality: 'high' } }, 'p').body.quality,
    'high', 't1: extra 透传进 body');

  // gemini(官方端点):x-goog-api-key 优先,Bearer 作回落
  const gOfficial = buildImageRequest(
    { protocol: 'gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta', apiKey: KEY, model: 'models/gemini-3-pro-image' },
    '雪山',
  );
  assert.equal(gOfficial.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent',
    't1: gemini 端点(model 的 models/ 前缀不重复)');
  assert.equal(gOfficial.headers['x-goog-api-key'], KEY, 't1: 官方端点优先 x-goog-api-key');
  assert.ok(!gOfficial.headers.Authorization, 't1: 官方端点不同时押 Bearer');
  assert.equal(gOfficial.altHeaders.Authorization, `Bearer ${KEY}`, 't1: 官方端点回落 Bearer');
  assert.deepEqual(gOfficial.body, {
    contents: [{ parts: [{ text: '雪山' }] }],
    generationConfig: { responseModalities: ['IMAGE'] },
  }, 't1: gemini body');

  // gemini(中转站端点):Bearer 优先,x-goog-api-key 作回落 —— 按端点形态自动选,不一刀切
  const gRelay = buildImageRequest(
    { protocol: 'gemini', baseURL: 'https://relay.example.com/v1beta', apiKey: KEY, model: 'gemini-3-pro-image' },
    '雪山',
  );
  assert.equal(gRelay.headers.Authorization, `Bearer ${KEY}`, 't1: 中转站端点优先 Bearer');
  assert.equal(gRelay.altHeaders['x-goog-api-key'], KEY, 't1: 中转站端点回落 x-goog-api-key');
  // extra.generationConfig 与默认深合并(不覆盖 responseModalities)
  const gExtra = buildImageRequest(
    { protocol: 'gemini', baseURL: 'https://relay.example.com/v1beta', apiKey: KEY, model: 'm', extra: { generationConfig: { imageConfig: { aspectRatio: '16:9' } } } },
    'x',
  );
  assert.deepEqual(gExtra.body.generationConfig, { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '16:9' } },
    't1: extra.generationConfig 深合并');

  // chat:POST {base}/chat/completions
  const ch = buildImageRequest({ protocol: 'chat', baseURL: 'https://relay.co/v1', apiKey: KEY, model: 'nano-banana' }, '画只狗');
  assert.equal(ch.url, 'https://relay.co/v1/chat/completions', 't1: chat 端点');
  assert.deepEqual(ch.body, { model: 'nano-banana', messages: [{ role: 'user', content: '画只狗' }] }, 't1: chat body');
  assert.equal(ch.headers.Authorization, `Bearer ${KEY}`, 't1: chat 走 Bearer');

  // 入参缺失 → 人话报错而不是发出畸形请求
  assert.throws(() => buildImageRequest({ protocol: 'sd-webui', baseURL: 'https://a.co', model: 'm' }, 'p'), /未知协议/, 't1: 未知协议拒');
  assert.throws(() => buildImageRequest({ protocol: 'openai', baseURL: '', model: 'm' }, 'p'), /baseURL/, 't1: 缺 baseURL 拒');
  assert.throws(() => buildImageRequest({ protocol: 'openai', baseURL: 'https://a.co', model: '' }, 'p'), /模型/, 't1: 缺模型拒');
  assert.throws(() => buildImageRequest({ protocol: 'openai', baseURL: 'https://a.co', model: 'm' }, '   '), /提示词/, 't1: 空提示词拒');
}

// ─────────────────── 2. extractImage:三种取图形态 ───────────────────
{
  // openai:b64 与 url 两种都要能拿到(gpt-image 恒 b64,dall-e-3 两种都可能)
  assert.deepEqual(extractImage('openai', { data: [{ b64_json: PNG_B64 }] }), { mime: 'image/png', base64: PNG_B64 }, 't2: openai b64');
  assert.deepEqual(extractImage('openai', { data: [{ b64_json: PNG_B64, output_format: 'JPEG' }] }),
    { mime: 'image/jpeg', base64: PNG_B64 }, 't2: openai b64 带 output_format');
  assert.deepEqual(extractImage('openai', { data: [{ url: 'https://cdn.example.com/a.png' }] }),
    { mime: '', url: 'https://cdn.example.com/a.png' }, 't2: openai url');
  assert.equal(extractImage('openai', { data: [] }), null, 't2: openai 空 data → null');
  assert.equal(extractImage('openai', { data: [{ url: 'javascript:alert(1)' }] }), null, 't2: 非 http(s) url 不认');

  // gemini:camelCase(官方)与 snake_case(部分中转站)都认;非图 part 要跳过
  assert.deepEqual(
    extractImage('gemini', { candidates: [{ content: { parts: [{ text: '好的' }, { inlineData: { mimeType: 'image/png', data: PNG_B64 } }] } }] }),
    { mime: 'image/png', base64: PNG_B64 }, 't2: gemini inlineData(跳过文本 part)');
  assert.deepEqual(
    extractImage('gemini', { candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/jpeg', data: PNG_B64 } }] } }] }),
    { mime: 'image/jpeg', base64: PNG_B64 }, 't2: gemini snake_case');
  assert.equal(extractImage('gemini', { candidates: [{ content: { parts: [{ text: '拒绝生成' }] } }] }), null, 't2: gemini 纯文本 → null');

  // chat:markdown / 裸链 / data URL
  assert.deepEqual(extractImage('chat', { choices: [{ message: { content: '生成好了：![图](https://cdn.x.com/a.png)' } }] }),
    { mime: '', url: 'https://cdn.x.com/a.png' }, 't2: chat markdown');
  assert.deepEqual(extractImage('chat', { choices: [{ message: { content: '这是链接 https://cdn.x.com/b.jpg?sig=1 请查收' } }] }),
    { mime: '', url: 'https://cdn.x.com/b.jpg?sig=1' }, 't2: chat 裸 URL(带 query)');
  assert.deepEqual(extractImage('chat', { choices: [{ message: { content: `![](data:image/webp;base64,${PNG_B64})` } }] }),
    { mime: 'image/webp', base64: PNG_B64 }, 't2: markdown 包着的 data URL 按 base64 取(不能当链接去下载)');
  // 多模态分片数组形态
  assert.deepEqual(extractImage('chat', { choices: [{ message: { content: [{ type: 'text', text: '![](https://cdn.x.com/c.png)' }] } }] }),
    { mime: '', url: 'https://cdn.x.com/c.png' }, 't2: chat content 数组');
  // 正文里只有说明性链接(非图片扩展名)→ 不当图去下,免得把 HTML 落盘成 .png
  assert.equal(extractImage('chat', { choices: [{ message: { content: '失败了，详见 https://docs.example.com/errors' } }] }), null,
    't2: 非图片链接不误判');
  assert.equal(extractImage('chat', { choices: [{ message: { content: '' } }] }), null, 't2: 空正文 → null');
}

// ─────────────────── 3. 文件名 / mime ───────────────────
{
  const d = new Date(2026, 7, 19, 21, 30, 45);
  assert.equal(buildImageFileName('一只戴帽子的橘猫在窗台上晒太阳并且打哈欠特别可爱', 'png', d),
    '20260819-213045-一只戴帽子的橘猫在窗台上晒太阳并且打哈欠.png',
    't3: 时间戳 + prompt 前 20 字符 slug(超出部分截断)');
  // 提示词不得控制文件名形态:路径分隔符 / `..` / 空白一律折成 `-`
  const evil = buildImageFileName('../../etc/passwd hack', 'png', d);
  assert.ok(!evil.includes('/') && !evil.includes('..'), `t3: 提示词穿透被折平(实际 ${evil})`);
  assert.equal(buildImageFileName('   ', 'png', d), '20260819-213045.png', 't3: 空 slug 只留时间戳');
  assert.equal(buildImageFileName('x', 'exe', d), '20260819-213045-x.png', 't3: 非白名单扩展名回落 png');
  assert.equal(imageExtFromMime('image/jpeg'), 'jpg');
  assert.equal(imageExtFromMime('image/webp'), 'webp');
  assert.equal(imageExtFromMime('application/octet-stream'), 'png', 't3: 认不出回落 png');
}

// ─────────────────── 4. 预览路径穿透防护 ───────────────────
{
  const roots = ['/Users/x/Pictures/ai', '/Users/x/Downloads/img'];
  assert.equal(resolvePreviewPath('/Users/x/Pictures/ai/a.png', roots), '/Users/x/Pictures/ai/a.png', 't4: savePath 之下放行');
  assert.equal(resolvePreviewPath('/Users/x/Pictures/ai/sub/b.jpg', roots), '/Users/x/Pictures/ai/sub/b.jpg', 't4: 子目录放行');
  assert.equal(resolvePreviewPath('/Users/x/Downloads/img/c.webp', roots), '/Users/x/Downloads/img/c.webp', 't4: 第二个 savePath 放行');
  assert.equal(resolvePreviewPath('/Users/x/Pictures/ai/../../.ssh/id_rsa.png', roots), null, 't4: `..` 穿透拒');
  assert.equal(resolvePreviewPath('/etc/passwd.png', roots), null, 't4: 绝对路径逃逸拒');
  assert.equal(resolvePreviewPath('/Users/x/Pictures/ai-evil/x.png', roots), null, 't4: 同前缀兄弟目录拒(前缀比对不能按字符串)');
  assert.equal(resolvePreviewPath('/Users/x/Pictures/ai/.env', roots), null, 't4: 非图片扩展名拒');
  assert.equal(resolvePreviewPath('a.png', roots), null, 't4: 相对路径拒');
  assert.equal(resolvePreviewPath('/Users/x/Pictures/ai', roots), null, 't4: savePath 自身不是文件');
  assert.equal(resolvePreviewPath('/Users/x/Pictures/ai/a.png', []), null, 't4: 无任何 savePath 时全拒');
}

// ─────────────────── 5. redactKey:密钥不进错误/日志 ───────────────────
{
  const echoed = `401 unauthorized: key ${KEY} rejected`;
  const safe = redactKey(echoed, KEY);
  assert.ok(!safe.includes(KEY), 't5: 上游回显的 key 被剥掉');
  assert.ok(safe.includes('***'), 't5: 剥掉后留掩码');
  assert.ok(!redactKey('Authorization: Bearer sk-other-key-999888', null).includes('sk-other-key-999888'), 't5: Bearer 形态兜底');
  assert.ok(!redactKey('{"api_key": "sk-leak-777666"}', null).includes('sk-leak-777666'), 't5: api_key 字段兜底');
  assert.equal(redactKey('普通错误', KEY), '普通错误', 't5: 无 key 的文本原样透传');
}

// ─────────────────── 6. 端到端:本地假上游(6702)+ 隔离 HOME ───────────────────
const express = (await import('express')).default;
const imageRouter = (await import('../../server/routes/image.js')).default;

const app = express();
app.use(express.json({ limit: '25mb' }));
// 假上游:三协议各一个端点 + 一个图片直链 + 一个"回显 key 的错误"端点。
// upstreamHits 用来钉死"保存目录不可用时不该白打一次上游"(生图是要花钱的调用)。
let upstreamHits = 0;
app.use('/fake', (_req, _res, next) => { upstreamHits++; next(); });
app.post('/fake/v1/images/generations', (req, res) => res.json({ data: [{ b64_json: PNG_B64 }] }));
app.post('/fake/v1/models/:model', (req, res) => res.json({
  candidates: [{ content: { parts: [{ text: '给你' }, { inlineData: { mimeType: 'image/png', data: PNG_B64 } }] } }],
}));
app.post('/fake/v1/chat/completions', (_req, res) => res.json({
  choices: [{ message: { content: '好了：![out](http://127.0.0.1:6702/fake/out.png)' } }],
}));
app.get('/fake/out.png', (_req, res) => { res.setHeader('Content-Type', 'image/png'); res.end(Buffer.from(PNG_B64, 'base64')); });
app.post('/boom/v1/images/generations', (req, res) => res.status(401).json({
  error: { message: `invalid key ${req.headers.authorization}` }, // 故意回显鉴权头
}));

// —— 判官必修①/②的假上游 ——
// 只认 x-goog-api-key 的假 gemini:端点形态是"中转站"(127.0.0.1)→ 路由主用 Bearer,
// 必须 401 后换 x-goog-api-key 重试才拿得到图。googAttempts 记录尝试顺序。
const googAttempts = [];
app.post('/goog/v1/models/:model', (req, res) => {
  googAttempts.push(req.headers['x-goog-api-key'] ? 'goog' : (req.headers.authorization ? 'bearer' : 'none'));
  if (!req.headers['x-goog-api-key']) return res.status(401).json({ error: 'API key required' });
  res.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG_B64 } }] } }] });
});
// 上游把图片链接指向"内网 + 非图片 Content-Type"(URL 却以 .png 结尾)
app.post('/badct/v1/chat/completions', (_req, res) => res.json({
  choices: [{ message: { content: '![x](http://127.0.0.1:6702/internal/creds.png)' } }],
}));
app.get('/internal/creds.png', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<html>INTERNAL-SECRET-BODY</html>'); });
// 图片链接 302 跳转(跟随即绕过内网检查)
app.post('/redir/v1/chat/completions', (_req, res) => res.json({
  choices: [{ message: { content: '![x](http://127.0.0.1:6702/redirect.png)' } }],
}));
app.get('/redirect.png', (_req, res) => res.redirect(302, 'http://127.0.0.1:6702/fake/out.png'));
// 图片链接指向云元数据(链路本地地址)
app.post('/meta/v1/chat/completions', (_req, res) => res.json({
  choices: [{ message: { content: '![x](http://169.254.169.254/latest/meta-data/iam.png)' } }],
}));
// content-length 声明 200MB(真身只有几十字节)→ 读 body 前就该早退
app.post('/huge/v1/chat/completions', (_req, res) => res.json({
  choices: [{ message: { content: '![x](http://127.0.0.1:6702/huge.png)' } }],
}));
app.get('/huge.png', (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(200 * 1024 * 1024) });
  res.end(Buffer.from(PNG_B64, 'base64'));
});
// b64 分支超限:直接吐一坨 92MB 的 base64 文本(> 64MB × 1.4 阈值)
const BIG_B64_BYTES = 92 * 1024 * 1024;
app.post('/bigb64/v1/images/generations', (_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.write('{"data":[{"b64_json":"');
  res.write(Buffer.alloc(BIG_B64_BYTES, 'A'));
  res.end('"}]}');
});
// 出图过程中把保存目录弄坏:pre-check 已过,写盘那一刻才失败 → 钉住错误分类
const RM_DIR = mkdtempSync(join(tmpdir(), 'cgui-img-rm-'));
const RO_DIR = mkdtempSync(join(tmpdir(), 'cgui-img-ro-'));
app.post('/rmdir/v1/images/generations', (_req, res) => {
  rmSync(RM_DIR, { recursive: true, force: true });
  res.json({ data: [{ b64_json: PNG_B64 }] });
});
app.post('/chmod/v1/images/generations', (_req, res) => {
  chmodSync(RO_DIR, 0o500); // 只读目录 → writeFile 报 EACCES
  res.json({ data: [{ b64_json: PNG_B64 }] });
});
// 【r22-⑤】上游把图片链接指向【本机另一个端口】,且那个端点回真正的 image/png ——
// 事后的 Content-Type 检查对它完全无效,只有"下载前不豁免跨源回环"这道闸拦得住。
app.post('/evil/v1/chat/completions', (_req, res) => res.json({
  choices: [{ message: { content: '![x](http://127.0.0.1:6703/evil.png)' } }],
}));
app.use('/api', imageRouter);

// 那个"本机别的端口"的服务(6703)。evilHits 钉死"拒绝必须发生在 fetch 之前"。
let evilHits = 0;
const evilServer = createServer((_req, res) => {
  evilHits += 1;
  res.writeHead(200, { 'Content-Type': 'image/png' });
  res.end(Buffer.from(PNG_B64, 'base64'));
});

// 端口只许 6702/6703,但隔壁分支的 E2E 也在用 → EADDRINUSE 退让重试,不当假失败。
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
const server = await listenWithRetry(6702);
await listenWithRetry(6703, 40, (p) => evilServer.listen(p, '127.0.0.1'));
const BASE = 'http://127.0.0.1:6702';
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
// r51:出图已任务化 —— POST 秒回 { jobId },真正的成败落在 /api/image/history 的条目里。
// 提交后轮询到终态,返回 { status, json, text }:
//   status = 【任务终态】'done' / 'error'(不是 HTTP 码,提交过了前置校验就恒 200);
//   json   = 该历史条目(file / previewUrl / bytes / tookMs / error 都在里面);
//   前置校验失败(provider 不存在、保存目录不可用……)仍是同步 HTTP 错误,原样返回。
const gen = async (body) => {
  const submit = await api('POST', '/api/image/generate', body);
  if (submit.status !== 200 || !submit.json?.jobId) return submit;
  for (let i = 0; i < 400; i++) {
    const h = await api('GET', '/api/image/history');
    const e = (h.json?.history || []).find((x) => x.id === submit.json.jobId);
    if (e && e.status !== 'running') return { status: e.status, json: e, text: JSON.stringify(e) };
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('出图任务 20s 内未落终态');
};

let failure = null;
try {
  // 6.1 CRUD:创建三个 provider(三协议各一)。apiKey 落盘但绝不回传。
  const mk = (name, protocol, base) => api('POST', '/api/image-providers', {
    name, protocol, baseURL: base, apiKey: KEY, model: 'test-model', size: '1024x1024', savePath: SAVE_DIR,
  });
  const oa = await mk('假 openai', 'openai', `${BASE}/fake/v1`);
  assert.equal(oa.status, 200, `t6: 创建 openai provider(${oa.text})`);
  const gm = await mk('假 gemini', 'gemini', `${BASE}/fake/v1`);
  const ct = await mk('假 chat', 'chat', `${BASE}/fake/v1`);
  assert.ok(gm.json.id && ct.json.id, 't6: 三个 provider 都建好');

  // 配置落在隔离 HOME,真实 ~/.claude-gui 未被触碰
  const cfgPath = join(TMP_HOME, '.claude-gui', 'image-providers.json');
  assert.ok(existsSync(cfgPath), 't6: 配置写进 ~/.claude-gui/image-providers.json(隔离 HOME)');
  assert.ok(!existsSync(join(TMP_HOME, '.claude', 'settings.json')), 't6: 绝不写 ~/.claude/settings.json');
  assert.ok(readFileSync(cfgPath, 'utf8').includes(KEY), 't6: key 落盘(server 侧自用)');

  // 列表/更新响应一律 grep 不到 key
  const list = await api('GET', '/api/image-providers');
  assert.ok(!list.text.includes(KEY), 't6: GET 响应不含 apiKey');
  assert.equal(list.json.providers.length, 3);
  assert.equal(list.json.providers[0].hasKey, true, 't6: 只回 hasKey');
  assert.equal(list.json.providers[0].savePath, SAVE_DIR);

  // 编辑:apiKey 留空 = 保留原 key(前端从不持有 key,空字段不能把 key 抹了)
  const put = await api('PUT', `/api/image-providers/${oa.json.id}`, {
    name: '改个名', protocol: 'openai', baseURL: `${BASE}/fake/v1`, apiKey: '', model: 'test-model', savePath: SAVE_DIR,
  });
  assert.equal(put.status, 200, `t6: 编辑成功(${put.text})`);
  assert.ok(!put.text.includes(KEY), 't6: PUT 响应不含 apiKey');
  assert.ok(JSON.parse(readFileSync(cfgPath, 'utf8')).find((p) => p.id === oa.json.id).apiKey === KEY, 't6: 留空不抹 key');

  // 6.2 出图:三协议各跑一次,落盘 + 预览
  for (const [label, id] of [['openai', oa.json.id], ['gemini', gm.json.id], ['chat', ct.json.id]]) {
    const g = await gen({ providerId: id, prompt: `测试 ${label} 出图` });
    assert.equal(g.status, 'done', `t6: ${label} 出图成功(${g.text})`);
    assert.ok(g.json.file.startsWith(SAVE_DIR), `t6: ${label} 落盘到配置的 savePath`);
    assert.ok(existsSync(g.json.file), `t6: ${label} 文件真的存在`);
    assert.equal(readFileSync(g.json.file).length, Buffer.from(PNG_B64, 'base64').length, `t6: ${label} 图片字节完整`);
    assert.ok(typeof g.json.tookMs === 'number', 't6: 返回耗时');
    assert.ok(!g.text.includes(KEY), `t6: ${label} 出图响应不含 apiKey`);
    // 预览回源
    const pv = await fetch(`${BASE}${g.json.previewUrl}`);
    assert.equal(pv.status, 200, `t6: ${label} 预览 200`);
    assert.equal(pv.headers.get('content-type'), 'image/png', `t6: ${label} 预览 Content-Type`);
  }
  // 重名加序号:同一秒内连出两张不会互相覆盖
  const a1 = await gen({ providerId: oa.json.id, prompt: '同名' });
  const a2 = await gen({ providerId: oa.json.id, prompt: '同名' });
  assert.notEqual(a1.json.file, a2.json.file, 't6: 重名加序号,不覆盖已有图');

  // 6.3 预览路径穿透:savePath 之外的文件一律 400(即便真的存在)
  const secret = join(TMP_HOME, 'secret.png');
  writeFileSync(secret, 'TOP-SECRET');
  const esc1 = await api('GET', `/api/image/preview?file=${encodeURIComponent(secret)}`);
  assert.equal(esc1.status, 400, 't6: savePath 之外的绝对路径拒');
  assert.ok(!esc1.text.includes('TOP-SECRET'), 't6: 内容没漏出去');
  const esc2 = await api('GET', `/api/image/preview?file=${encodeURIComponent(`${SAVE_DIR}/../secret.png`)}`);
  assert.equal(esc2.status, 400, 't6: `..` 穿透拒');
  const esc3 = await api('GET', `/api/image/preview?file=${encodeURIComponent(join(SAVE_DIR, 'x.txt'))}`);
  assert.equal(esc3.status, 400, 't6: 非图片扩展名拒');
  const miss = await api('GET', `/api/image/preview?file=${encodeURIComponent(join(SAVE_DIR, 'nope.png'))}`);
  assert.equal(miss.status, 404, 't6: 路径合法但文件不存在 → 404');

  // 6.4 上游报错:原文透传但先剥 key
  const boom = await mk('会报错的', 'openai', `${BASE}/boom/v1`);
  const bad = await gen({ providerId: boom.json.id, prompt: '炸' });
  assert.equal(bad.status, 'error', 't6: 上游 401 → 任务落 error');
  assert.ok(bad.json.error.includes('invalid key'), 't6: 上游报错原文透传');
  assert.ok(!bad.text.includes(KEY), `t6: 报错里的 key 被剥掉(实际:${bad.json.error})`);

  // 6.5 落盘失败:保存目录被删 → 人话错误,不是抛栈
  const goneDir = mkdtempSync(join(tmpdir(), 'cgui-img-gone-'));
  const gone = await mk('目录会消失', 'openai', `${BASE}/fake/v1`);
  {
    // 先合法创建(创建时目录还在),再删目录模拟"用户把文件夹挪走了"
    const upd = await api('PUT', `/api/image-providers/${gone.json.id}`, {
      name: '目录会消失', protocol: 'openai', baseURL: `${BASE}/fake/v1`, model: 'm', savePath: goneDir,
    });
    assert.equal(upd.status, 200, `t6: 换保存路径成功(${upd.text})`);
  }
  rmSync(goneDir, { recursive: true, force: true });
  const hitsBefore = upstreamHits;
  const noDir = await gen({ providerId: gone.json.id, prompt: 'x' });
  assert.equal(noDir.status, 400, 't6: 目录不存在 → 400');
  assert.match(noDir.json.error, /保存目录不存在或不可写/, 't6: 人话错误');
  assert.ok(!/at .*\.js:\d+/.test(noDir.text), 't6: 不返回调用栈');
  assert.equal(upstreamHits, hitsBefore, 't6: 目录不可用时不打上游(生图调用要花钱,先校验再发请求)');

  // 表单侧:savePath 缺失/非法直接拒,不落一条半残配置
  const noPath = await api('POST', '/api/image-providers', {
    name: 'x', protocol: 'openai', baseURL: `${BASE}/fake/v1`, apiKey: KEY, model: 'm',
  });
  assert.equal(noPath.status, 400, 't6: 保存路径必填');
  assert.match(noPath.json.error, /保存路径必填/);

  // 6.6 删除
  const del = await api('DELETE', `/api/image-providers/${boom.json.id}`);
  assert.equal(del.status, 200);
  assert.equal((await api('DELETE', `/api/image-providers/${boom.json.id}`)).status, 404, 't6: 重复删除 404');

  // 6.7 未知 provider
  assert.equal((await gen({ providerId: 'nope', prompt: 'x' })).status, 404, 't6: 未知 provider 404');

  // ── 7. gemini 认证头回落(路由那半) ──
  // 纯函数只钉住了 altHeaders 的形状,重试这段路由代码此前一行没测:整块删掉全套仍绿。
  {
    const g = await mk('只认 goog 头的中转站', 'gemini', `${BASE}/goog/v1`);
    const r = await gen({ providerId: g.json.id, prompt: '换头重试' });
    assert.equal(r.status, 'done', `t7: 401 后换认证头重试应最终成功(${r.text})`);
    assert.deepEqual(googAttempts, ['bearer', 'goog'], 't7: 尝试序列 = 先按端点形态用 Bearer,401 后回落 x-goog-api-key');
    assert.ok(existsSync(r.json.file), 't7: 重试成功后正常落盘');
    await api('DELETE', `/api/image-providers/${g.json.id}`);
  }

  // ── 8. SSRF:上游回的图片链接是攻击者可控性最高的一处 ──
  {
    const filesBefore = new Set(readdirSync(SAVE_DIR));
    // 8.1 内网地址 + 非图片 Content-Type(URL 以 .png 结尾,后缀是攻击者写的,不能当证据)
    const badct = await mk('回内网链接的', 'chat', `${BASE}/badct/v1`);
    const r1 = await gen({ providerId: badct.json.id, prompt: 'x' });
    assert.equal(r1.status, 'error', 't8: 非图片 Content-Type 的链接被拒');
    assert.match(r1.json.error, /不是图片/, 't8: 报错说明是 Content-Type 问题');
    assert.ok(!r1.text.includes('INTERNAL-SECRET-BODY'), 't8: 内网响应体没被回显');
    assert.deepEqual([...readdirSync(SAVE_DIR)].filter((f) => !filesBefore.has(f)), [], 't8: 内网响应没被落盘成"图片"');

    // 8.2 302 跳转不跟随(事后校验挡不住重定向)
    const redir = await mk('会跳转的', 'chat', `${BASE}/redir/v1`);
    const r2 = await gen({ providerId: redir.json.id, prompt: 'x' });
    assert.equal(r2.status, 'error', 't8: 图片链接发生跳转 → 拒');
    assert.match(r2.json.error, /跳转/, 't8: 报错点明跳转');

    // 8.3 云元数据地址(链路本地)在下载前就被 SSRF 守卫拦下
    const meta = await mk('指向元数据的', 'chat', `${BASE}/meta/v1`);
    const r3 = await gen({ providerId: meta.json.id, prompt: 'x' });
    assert.equal(r3.status, 'error', 't8: 169.254.169.254 被拒');
    assert.match(r3.json.error, /拒绝下载该链接/, 't8: 走的是下载前的 SSRF 守卫,不是事后校验');

    // 8.4【r22-⑤】回环、但与用户自填的 baseURL【不同源】:上游把图片链接指到本机另一个
    // 端口,那个端点回的是真 image/png —— 事后 Content-Type 检查一点用没有。修之前
    // assertPublicBaseURL 对回环一律放行,这条会 200 并把内网响应落盘成图片。
    const evil = await mk('把链接指到本机别的端口的', 'chat', `${BASE}/evil/v1`);
    const r4 = await gen({ providerId: evil.json.id, prompt: 'x' });
    assert.equal(r4.status, 'error', `t8: 回环跨端口的图片链接必须被拒(实际 ${r4.status} ${r4.text})`);
    assert.match(r4.json.error, /拒绝下载该链接/, 't8: 拒绝要发生在下载前的 SSRF 守卫,不是靠事后 Content-Type');
    assert.equal(evilHits, 0, 't8: 服务端一次都不许打到那个端口(闸门在 fetch 之前)');

    assert.deepEqual([...readdirSync(SAVE_DIR)].filter((f) => !filesBefore.has(f)), [], 't8: 四种攻击一张图都没落盘');
    for (const p of [badct, redir, meta, evil]) await api('DELETE', `/api/image-providers/${p.json.id}`);

    // 8.5 反向钉死:【同源】回环必须继续放行。回环豁免是刻意的(用户接本机 ComfyUI /
    // one-api),信任的是"用户自己填的那个 host:port",不是"本机所有端口"。
    // 一刀切禁回环会把这个正当用法砍掉,故这条与 8.4 必须同时绿。
    const localRelay = await mk('本机中转(同源)', 'chat', `${BASE}/fake/v1`);
    const r5 = await gen({ providerId: localRelay.json.id, prompt: 'x' });
    assert.equal(r5.status, 'done', `t8: 同源回环的图片链接照常下载(${r5.text})`);
    assert.ok(existsSync(r5.json.file), 't8: 同源回环正常落盘');
    // localhost 与 127.0.0.1 是同一个服务:用户填 localhost、本机服务回 127.0.0.1 的
    // 链接很常见,按字符串比 origin 会把这种正当用法误杀。
    const aliasRelay = await mk('本机中转(localhost 别名)', 'chat', 'http://localhost:6702/fake/v1');
    const r6 = await gen({ providerId: aliasRelay.json.id, prompt: 'x' });
    assert.equal(r6.status, 'done', `t8: localhost ↔ 127.0.0.1 同端口视为同源,不许误杀(${r6.text})`);
    for (const p of [localRelay, aliasRelay]) await api('DELETE', `/api/image-providers/${p.json.id}`);
  }

  // ── 9. 体积上限:后端单进程扛全部会话,一坨大 body 就是全局 OOM ──
  {
    const huge = await mk('回超大图的', 'chat', `${BASE}/huge/v1`);
    const r1 = await gen({ providerId: huge.json.id, prompt: 'x' });
    assert.equal(r1.status, 'error', 't9: content-length 超限 → 任务落 error(读 body 前早退)');
    assert.match(r1.json.error, /图片过大/, 't9: 人话错误');

    const big = await mk('回超长 b64 的', 'openai', `${BASE}/bigb64/v1`);
    const r2 = await gen({ providerId: big.json.id, prompt: 'x' });
    assert.equal(r2.status, 'error', 't9: b64 超长 → 任务落 error');
    assert.match(r2.json.error, /图片过大/, 't9: b64 分支同样给人话错误');
    for (const p of [huge, big]) await api('DELETE', `/api/image-providers/${p.json.id}`);
  }

  // ── 10. 软链穿透:两层语义分别钉死 ──
  // savePath 里预埋 `evil.png -> 目录外的文件`(把保存目录设成 ~/Downloads 再解压一个
  // 带软链的 zip 就能触发)。纯函数只做字面计算【会放行】,必须由路由层的 realpath 复核拦下。
  {
    const outside = join(TMP_HOME, 'outside-secret.png');
    writeFileSync(outside, 'OUTSIDE-SECRET-CONTENT');
    const link = join(SAVE_DIR, 'evil.png');
    symlinkSync(outside, link);
    assert.equal(resolvePreviewPath(link, [SAVE_DIR]), link, 't10: 纯函数(零 IO)按字面放行 —— 所以不能只靠它');
    const pv = await api('GET', `/api/image/preview?file=${encodeURIComponent(link)}`);
    assert.equal(pv.status, 400, 't10: 路由层 realpath 复核拦下软链');
    assert.ok(!pv.text.includes('OUTSIDE-SECRET-CONTENT'), 't10: 目录外文件内容没漏');
    const rv = await api('POST', '/api/image/reveal', { file: link });
    assert.equal(rv.status, 400, 't10: reveal 走同一道闸');
    // 正常图片不被这层误伤(SAVE_DIR 本身在 macOS 上就是 /var → /private/var 的软链)
    const okShot = await gen({ providerId: oa.json.id, prompt: '软链复核不误伤' });
    assert.equal((await fetch(`${BASE}${okShot.json.previewUrl}`)).status, 200, 't10: 真实图片仍可预览');
  }

  // ── 11. reveal 的路径闸(此前零覆盖)。只测拒绝路径:放行会真的弹出访达 ──
  {
    assert.equal((await api('POST', '/api/image/reveal', { file: `${SAVE_DIR}/../secret.png` })).status, 400, 't11: reveal 拒 `..` 穿透');
    assert.equal((await api('POST', '/api/image/reveal', { file: join(TMP_HOME, 'outside-secret.png') })).status, 400, 't11: reveal 拒 savePath 之外');
    assert.equal((await api('POST', '/api/image/reveal', { file: join(SAVE_DIR, 'x.txt') })).status, 400, 't11: reveal 拒非图片扩展名');
    assert.equal((await api('POST', '/api/image/reveal', {})).status, 400, 't11: reveal 空入参');
  }

  // ── 12. 并发原子性:读-改-写整段必须在队列里 ──
  // 修复前:5 个请求各自读到同一份旧 list、后写覆盖先写 → 只剩 1 条。
  {
    const before = (await api('GET', '/api/image-providers')).json.providers.length;
    await Promise.all([1, 2, 3, 4, 5].map((i) => mk(`并发-${i}`, 'openai', `${BASE}/fake/v1`)));
    const after = (await api('GET', '/api/image-providers')).json.providers;
    assert.equal(after.length, before + 5, 't12: 并发 5 次创建一条都不能丢');
    for (const i of [1, 2, 3, 4, 5]) assert.ok(after.some((p) => p.name === `并发-${i}`), `t12: 并发-${i} 在册`);
    // 落盘文件权限 0600(明文 apiKey 不能同机可读)
    assert.equal(statSync(cfgPath).mode & 0o777, 0o600, 't12: 配置文件 0600');
  }

  // ── 13. 落盘失败的错误分类:目录在"pre-check 之后、写盘之前"坏掉 ──
  // (ENOSPC 磁盘满没法在测试里造,只覆盖 ENOENT/EACCES 两支;分类本身由这两支钉住)
  {
    const rmP = await mk('目录会被删', 'openai', `${BASE}/rmdir/v1`);
    await api('PUT', `/api/image-providers/${rmP.json.id}`, {
      name: '目录会被删', protocol: 'openai', baseURL: `${BASE}/rmdir/v1`, model: 'm', savePath: RM_DIR,
    });
    const r1 = await gen({ providerId: rmP.json.id, prompt: 'x' });
    assert.equal(r1.status, 'error', 't13: 写盘时目录已消失 → 任务落 error');
    assert.match(r1.json.error, /保存目录不存在/, 't13: ENOENT 分类');

    const roP = await mk('目录会变只读', 'openai', `${BASE}/chmod/v1`);
    await api('PUT', `/api/image-providers/${roP.json.id}`, {
      name: '目录会变只读', protocol: 'openai', baseURL: `${BASE}/chmod/v1`, model: 'm', savePath: RO_DIR,
    });
    const r2 = await gen({ providerId: roP.json.id, prompt: 'x' });
    assert.equal(r2.status, 'error', 't13: 写盘时目录变只读 → 任务落 error');
    assert.match(r2.json.error, /没有写入权限/, 't13: EACCES 分类(不能笼统说"目录不存在",会误导用户去换目录)');
    assert.doesNotMatch(r2.json.error, /不存在/, 't13: 两类错误必须区分开');
  }
} catch (e) {
  failure = e;
} finally {
  // 撒谎的 content-length 那条会留下半开连接,close() 会一直等它 → 显式断连。
  server.closeAllConnections?.();
  server.close();
  await new Promise((r) => server.once('close', r));
  evilServer.closeAllConnections?.();
  evilServer.close();
  await new Promise((r) => evilServer.once('close', r));
  try { chmodSync(RO_DIR, 0o700); } catch {} // 改回可写才删得掉
  for (const d of [TMP_HOME, SAVE_DIR, RM_DIR, RO_DIR]) rmSync(d, { recursive: true, force: true });
}
if (failure) throw failure;

console.log('✓ check-image-gen: 三协议组装/取图 + 文件名 + 路径穿透 + key 不外泄 + 端到端 全部通过');
