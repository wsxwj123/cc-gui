#!/usr/bin/env node
// 单测:r16-3 自定义生图 —— 三协议请求组装/取图(纯函数)+ 文件名 + 预览路径穿透防护
// + apiKey 不外泄 + CRUD/出图/预览的端到端(本地假上游,绝不打真实生图 API)。
// Run: node tests/unit/check-image-gen.mjs
//
// 隔离:HOME 指向 mktemp 目录(真实 ~/.claude-gui 一个字节不碰);端口只用 6702,退出即释放。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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
  assert.deepEqual(IMAGE_PROTOCOLS, ['openai', 'gemini', 'chat'], 't1: 第一版只做三种同步协议');

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
app.use('/api', imageRouter);

const server = app.listen(6702, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
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
    const g = await api('POST', '/api/image/generate', { providerId: id, prompt: `测试 ${label} 出图` });
    assert.equal(g.status, 200, `t6: ${label} 出图成功(${g.text})`);
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
  const a1 = await api('POST', '/api/image/generate', { providerId: oa.json.id, prompt: '同名' });
  const a2 = await api('POST', '/api/image/generate', { providerId: oa.json.id, prompt: '同名' });
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
  const bad = await api('POST', '/api/image/generate', { providerId: boom.json.id, prompt: '炸' });
  assert.equal(bad.status, 502, 't6: 上游 401 → 502');
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
  const noDir = await api('POST', '/api/image/generate', { providerId: gone.json.id, prompt: 'x' });
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
  assert.equal((await api('POST', '/api/image/generate', { providerId: 'nope', prompt: 'x' })).status, 404, 't6: 未知 provider 404');
} catch (e) {
  failure = e;
} finally {
  server.close();
  await new Promise((r) => server.once('close', r));
  rmSync(TMP_HOME, { recursive: true, force: true });
  rmSync(SAVE_DIR, { recursive: true, force: true });
}
if (failure) throw failure;

console.log('✓ check-image-gen: 三协议组装/取图 + 文件名 + 路径穿透 + key 不外泄 + 端到端 全部通过');
