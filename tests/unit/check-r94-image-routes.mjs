#!/usr/bin/env node
// r94-A:HTTP 端点契约(INTERFACE §5)。三个协议形态的假上游全在本机 listen(0) 临时口上,
// 零真实网络、零真实配置(HOME 指向 mkdtemp 目录,真实 ~/.claude-gui 一个字节不碰)、零费用。
//
// 本文件是【黑盒验收测试】:只依据 .devflow/INTERFACE-r94.md 的 §5 写,不看 server/routes/image.js。
// 断言名带 INTERFACE 编号(§5.x / R* / M*)。
//
// 假上游三形态(§5 全部场景都在这三条上跑):
//   /am  apimart(protocol 'mj'):POST /v1/midjourney/generations、GET /v1/tasks/{id}、
//        POST /v1/uploads/images(【本文件断言它在 inline 档下零请求】)
//   /pp  midjourney-proxy plus(protocol 'mj-proxy'):/mj/submit/imagine、/mj/task/{id}/fetch(带 buttons)、
//        /mj/submit/action
//   /po  midjourney-proxy 原版(protocol 'mj-proxy'):同上但 fetch 【不带 buttons】、只有 /mj/submit/change
//
//   /am2 apimart 形态但父任务 buttons 里【有】真放大命令 —— apimart 自己没有(真机实测),
//        这条用来验 §5.3「customId 形态打同一个 upscale 端点」的机制对别的站成立。
//
// 假上游响应体一律抄真机实测形态(VERIFY-r94-live.md):apimart 单图子任务详情【连 buttons 键都没有】、
// 上传响应恰为 {bytes,content_type,created_at,filename,url} 且落在第三方域、父任务 15 项按钮无 upsample_v*。
//
// Run: node tests/unit/check-r94-image-routes.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 必须在 import 路由之前:真实 HOME 一个字节不碰;轮询提速让端到端秒级跑完。
const TMP_HOME = mkdtempSync(join(tmpdir(), 'cgui-r94-home-'));
const SAVE_DIR = mkdtempSync(join(tmpdir(), 'cgui-r94-save-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
process.env.CGUI_IMAGE_TASK_POLL_INTERVAL_MS = '150';
mkdirSync(join(TMP_HOME, '.claude-gui'), { recursive: true });

const KEY = 'sk-r94-route-secret-zzz9';           // 含可识别子串,用来全程搜密钥泄漏
const MJ_SECRET_PROBE = 'mjsecret-r94-probe-yyy8'; // mj-api-secret 同等敏感
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_BUF = Buffer.from(PNG_B64, 'base64');
const REF_IN_SAVE = join(SAVE_DIR, 'seed.png');
writeFileSync(REF_IN_SAVE, PNG_BUF);

let PASS = 0;
let FAILS = 0;
const failed = [];
const check = async (name, fn) => {
  try {
    await fn();
    PASS++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    FAILS++;
    failed.push(name);
    const msg = String((e && e.message) || e).split('\n').slice(0, 4).join('\n      ');
    console.log(`  ✗ ${name}\n      ${msg}`);
  }
};

const express = (await import('express')).default;
let imageRouter = null;
let ROUTER_ERR = '';
try {
  imageRouter = (await import('../../server/routes/image.js')).default;
} catch (e) {
  ROUTER_ERR = String((e && e.message) || e);
}

const app = express();
app.use(express.json({ limit: '25mb' }));

// ── 请求记录本(每条断言前自行清空需要的字段) ──
const seen = {
  amGen: [], amTask: [], amButtons: [], amUpload: [], amAction: [],
  ppImagine: [], ppFetch: [], ppAction: [], ppChange: [],
  poImagine: [], poFetch: [], poChange: [], poAction: [],
};
let server = null;
const imgUrl = (n) => `http://127.0.0.1:${server.address().port}/img/${n}.png`;

// ── /am:apimart 形态 ──
app.post('/am/v1/midjourney/generations', (req, res) => {
  seen.amGen.push({ body: req.body, auth: req.headers.authorization });
  res.json({ code: 200, data: [{ status: 'submitted', task_id: 'task_am' }] });
});
app.post('/am/v1/midjourney/generations/:action', (req, res) => {
  seen.amAction.push({ action: req.params.action, body: req.body, auth: req.headers.authorization });
  res.json({ code: 200, data: [{ status: 'submitted', task_id: 'task_am_child' }] });
});
app.get('/am/v1/tasks/:id', (req, res) => {
  seen.amTask.push(req.params.id);
  const n = req.params.id === 'task_am' ? 4 : 1;
  res.json({ code: 200, data: { id: req.params.id, status: 'completed', progress: 100,
    result: { images: [{ url: Array.from({ length: n }, (_, i) => imgUrl(i)) }] } } });
});
// §4.9:任务落终态后拉一次 Discord 按钮。
// 【真机实测形态,抄自 VERIFY-r94-live.md】四宫格父任务 15 项、无任何 upsample_v*_2x_*;
// 元素字段恰为 {customId,label,style,type}(无 emoji 键);pan/reroll 的 label 是纯 emoji。
const AM_PARENT_BUTTONS = [
  ...[1, 2, 3, 4].map((i) => ({ customId: `MJ::JOB::upsample::${i}::hAM`, label: `U${i}`, style: 2, type: 2 })),
  { customId: 'MJ::JOB::reroll::0::hAM::SOLO', label: '🔄', style: 2, type: 2 },
  ...[1, 2, 3, 4].map((i) => ({ customId: `MJ::JOB::variation::${i}::hAM`, label: `V${i}`, style: 2, type: 2 })),
  { customId: 'MJ::JOB::pan_left::0::hAM::SOLO', label: '⬅', style: 2, type: 2 },
  { customId: 'MJ::JOB::pan_right::0::hAM::SOLO', label: '➡', style: 2, type: 2 },
  { customId: 'MJ::JOB::pan_up::0::hAM::SOLO', label: '⬆', style: 2, type: 2 },
  { customId: 'MJ::JOB::pan_down::0::hAM::SOLO', label: '⬇', style: 2, type: 2 },
  { customId: 'MJ::Outpaint::1::hAM::SOLO', label: 'Zoom Out 1.5×', style: 2, type: 2 },
  { customId: 'MJ::Inpaint::1::hAM::SOLO', label: 'Vary (Region)', style: 2, type: 2 },
];
let amButtonsMode = 'parent';   // parent(15 项)/ none(无 buttons 键,= 单图子任务真机形态)/ 500 / notjson / dup / many
app.get('/am/v1/midjourney/:id', (req, res) => {
  seen.amButtons.push(req.params.id);
  if (amButtonsMode === '500') return res.status(500).json({ error: 'upstream boom' });
  if (amButtonsMode === 'notjson') return res.type('text/plain').send('not json at all');
  if (amButtonsMode === 'dup') {
    return res.json({ buttons: [
      { customId: 'MJ::JOB::upsample::1::hAM', label: 'U1', style: 2, type: 2 },
      { customId: 'MJ::JOB::upsample::1::hAM', label: '第二次', style: 2, type: 2 },
      { customId: '', label: '空 customId', style: 2, type: 2 },
      { customId: 42, label: '非字符串 customId', style: 2, type: 2 },
      { customId: 'MJ::JOB::variation::1::hAM', label: 'V1', style: 2, type: 2 },
    ] });
  }
  if (amButtonsMode === 'many') {
    return res.json({ buttons: Array.from({ length: 40 }, (_, i) => ({ customId: `MJ::JOB::upsample::1::h${i}`, label: `U${i}`, style: 2, type: 2 })) });
  }
  // 单图子任务:真机实测【连 buttons 键都没有】,键集恰为下面这些。
  if (amButtonsMode === 'none' || req.params.id !== 'task_am') {
    return res.json({ action: 'UPSCALE', created_at: 1, finished_at: 2, id: req.params.id,
      image_urls: [imgUrl(0)], progress: '100%', prompt_en: 'a cat', status: 'SUCCESS' });
  }
  return res.json({ buttons: AM_PARENT_BUTTONS });
});
// §5.4 + §5.2 inline 档的【零请求】证据。真机实测响应体恰为 {bytes,content_type,created_at,filename,url}
// —— 没有任何 expires 字段,且 url 落在第三方域(这里用另一个本机路径模拟"不是 baseURL 那个域")。
let amUploadMode = 'ok';   // ok / 4xx / 5xx
app.post('/am/v1/uploads/images', (req, res) => {
  seen.amUpload.push({ body: req.body, auth: req.headers.authorization });
  if (amUploadMode === '4xx') return res.status(400).json({ error: `bad image (key=${KEY})` });
  if (amUploadMode === '5xx') return res.status(500).json({ error: 'upstream down' });
  res.json({ bytes: PNG_BUF.length, content_type: 'image/png', created_at: 1756800000,
    filename: 'a.png', url: 'https://cdn-3rd-party.example.org/image/abc.png' });
});

// ── /am2:同样是 apimart 形态,但父任务 buttons 里【有】真放大命令(给别的站用的机制) ──
app.post('/am2/v1/midjourney/generations', (req, res) => {
  seen.amGen.push({ body: req.body, auth: req.headers.authorization });
  res.json({ code: 200, data: [{ status: 'submitted', task_id: 'task_am2' }] });
});
app.post('/am2/v1/midjourney/generations/:action', (req, res) => {
  seen.amAction.push({ action: req.params.action, body: req.body, auth: req.headers.authorization });
  res.json({ code: 200, data: [{ status: 'submitted', task_id: 'task_am2_child' }] });
});
app.get('/am2/v1/tasks/:id', (req, res) => {
  seen.amTask.push(req.params.id);
  const n = req.params.id === 'task_am2' ? 4 : 1;
  res.json({ code: 200, data: { id: req.params.id, status: 'completed', progress: 100,
    result: { images: [{ url: Array.from({ length: n }, (_, i) => imgUrl(i)) }] } } });
});
app.get('/am2/v1/midjourney/:id', (req, res) => {
  seen.amButtons.push(req.params.id);
  res.json({ buttons: [
    { customId: 'MJ::JOB::upsample::1::hA2', label: 'U1', style: 2, type: 2 },
    { customId: 'MJ::JOB::variation::2::hA2', label: 'V2', style: 2, type: 2 },
    { customId: 'MJ::JOB::upsample_v7_2x_subtle::1::hA2', label: 'Upscale (Subtle)', style: 2, type: 2 },
  ] });
});

// ── /pp:midjourney-proxy plus(fetch 带 buttons) ──
app.post('/pp/mj/submit/imagine', (req, res) => {
  seen.ppImagine.push({ body: req.body, secret: req.headers['mj-api-secret'], auth: req.headers.authorization });
  res.json({ code: 1, description: 'Submit success', result: '1712' });
});
app.get('/pp/mj/task/:id/fetch', (req, res) => {
  seen.ppFetch.push(req.params.id);
  res.json({ id: req.params.id, status: 'SUCCESS', progress: '100%', imageUrl: imgUrl(0),
    buttons: [
      { customId: 'MJ::JOB::upsample::1::hPP', label: 'U1', style: 2, type: 2 },
      { customId: 'MJ::JOB::variation::1::hPP', label: 'V1', style: 2, type: 2 },
      { customId: 'MJ::JOB::upsample_v7_2x_subtle::1::hPP', label: 'Upscale (Subtle)', style: 2, type: 2 },
      { customId: 'MJ::JOB::pan_left::1::hPP', label: '左移', style: 2, type: 2 },
    ] });
});
app.post('/pp/mj/submit/action', (req, res) => {
  seen.ppAction.push({ body: req.body, secret: req.headers['mj-api-secret'] });
  res.json({ code: 1, result: '1713' });
});
app.post('/pp/mj/submit/change', (req, res) => {
  seen.ppChange.push({ body: req.body });
  res.json({ code: 1, result: '1714' });
});

// ── /po:midjourney-proxy 原版(fetch 无 buttons) ──
app.post('/po/mj/submit/imagine', (req, res) => {
  seen.poImagine.push({ body: req.body, secret: req.headers['mj-api-secret'], auth: req.headers.authorization });
  res.json({ code: 1, description: 'Submit success', result: '9001' });
});
app.get('/po/mj/task/:id/fetch', (req, res) => {
  seen.poFetch.push(req.params.id);
  res.json({ id: req.params.id, status: 'SUCCESS', progress: '100%', imageUrl: imgUrl(0) });
});
app.post('/po/mj/submit/change', (req, res) => {
  seen.poChange.push({ body: req.body });
  res.json({ code: 1, result: '9002' });
});
app.post('/po/mj/submit/action', (req, res) => {
  seen.poAction.push({ body: req.body });
  res.status(404).json({ code: 4, description: '原版没有这个端点' });
});

// 永不响应的上游:占满并发名额用(§5.4 的 429 闸)。
app.post('/hang/v1/midjourney/generations', () => { /* 故意不响应 */ });
app.get('/img/:n.png', (_req, res) => res.type('image/png').send(PNG_BUF));
app.get('/uploaded/a.png', (_req, res) => res.type('image/png').send(PNG_BUF));
if (imageRouter) app.use('/api', imageRouter);

server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const BASE = `http://127.0.0.1:${server.address().port}`;

const api = async (method, path, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* 非 JSON 留 text */ }
  return { status: r.status, text, json };
};
const mkProvider = async (patch) => api('POST', '/api/image-providers', {
  name: 'r94', protocol: 'mj', baseURL: `${BASE}/am/v1`, apiKey: KEY, model: 'midjourney', savePath: SAVE_DIR, ...patch,
});
const providersOf = async () => api('GET', '/api/image-providers');
const historyOf = async (id) => {
  const r = await api('GET', '/api/image/history');
  const list = r.json?.history || [];
  return { list, text: r.text, entry: id ? list.find((e) => e.id === id) : null };
};
const settle = async (id, ms = 15000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const h = await historyOf(id);
    if (h.entry && h.entry.status !== 'running') return h.entry;
    if (Date.now() > deadline) throw new Error(`等 ${id} 落终态超时:${JSON.stringify(h.entry)}`);
    await new Promise((r) => setTimeout(r, 80));
  }
};
const upRef = (over = {}) => ({ kind: 'upload', name: 'a.png', mime: 'image/png', dataB64: PNG_B64, ...over });

let fatal = null;
try {
  await check('A0 server/routes/image.js 可 import 并挂载', () => {
    assert.ok(imageRouter, `import 失败:${ROUTER_ERR}`);
  });

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[A] §5.1 provider 字段');
  // ══════════════════════════════════════════════════════════════════════

  await check('§5.1 protocol 增加 mj-proxy:建得起来', async () => {
    const r = await mkProvider({ protocol: 'mj-proxy', baseURL: `${BASE}/pp`, apiKey: MJ_SECRET_PROBE });
    assert.equal(r.status, 200, `实得 ${r.status} ${r.text}`);
  });
  await check('§5.1 非法 protocol → 400 且文案列出全部协议(含 mj-proxy)', async () => {
    const r = await mkProvider({ protocol: 'mj-wat' });
    assert.equal(r.status, 400, `实得 ${r.status} ${r.text}`);
    assert.ok(String(r.json?.error || '').includes('mj-proxy'), `文案要列出 mj-proxy(实得 ${r.text})`);
  });
  await check('§5.1 mjParams 非对象 / 数组 → 400', async () => {
    for (const bad of ['x', 42, ['stylize'], true]) {
      const r = await mkProvider({ mjParams: bad });
      assert.equal(r.status, 400, `mjParams=${JSON.stringify(bad)} 实得 ${r.status} ${r.text}`);
    }
  });
  await check('M32/§5.1 mjParams 未知键(含 cref/sref/oref/iw/cw/sw/ow)静默丢弃:不落盘、不 400', async () => {
    const r = await mkProvider({ mjParams: { stylize: 250, cref: 'https://x/a.png', sref: 'https://x/b.png', iw: 2, wat: 1 } });
    assert.equal(r.status, 200, `不该 400(实得 ${r.status} ${r.text})`);
    const stored = (await providersOf()).json.providers.find((p) => p.id === r.json.id);
    assert.deepEqual(stored.mjParams, { stylize: 250 }, `只该留白名单键(实得 ${JSON.stringify(stored.mjParams)})`);
  });
  await check('M34e/§5.1 mjRefMode 非法值 → 400,文案列出三个合法值', async () => {
    for (const bad of ['UPLOAD', 'base64', 42, { a: 1 }]) {
      const r = await mkProvider({ mjRefMode: bad });
      assert.equal(r.status, 400, `mjRefMode=${JSON.stringify(bad)} 必须 400(实得 ${r.status} ${r.text})`);
      const msg = String(r.json?.error || '');
      for (const v of ['upload', 'inline', 'url']) {
        assert.ok(msg.includes(v), `文案要列出 ${v}(实得 ${r.text})`);
      }
    }
  });
  await check('§5.1 mjRefMode 三个合法值与空串都能存,且【原样回显】(不因协议改写)', async () => {
    for (const v of ['upload', 'inline', 'url', '']) {
      const r = await mkProvider({ mjRefMode: v });
      assert.equal(r.status, 200, `mjRefMode=${JSON.stringify(v)} 实得 ${r.text}`);
      const stored = (await providersOf()).json.providers.find((p) => p.id === r.json.id);
      assert.strictEqual(stored.mjRefMode, v, `回显必须原样(实得 ${JSON.stringify(stored.mjRefMode)})`);
    }
  });
  await check('§5.1 mj-proxy 存了 inline 也照样原样回显(忽略只发生在下发侧)', async () => {
    const r = await mkProvider({ protocol: 'mj-proxy', baseURL: `${BASE}/pp`, mjRefMode: 'inline' });
    assert.equal(r.status, 200, r.text);
    const stored = (await providersOf()).json.providers.find((p) => p.id === r.json.id);
    assert.strictEqual(stored.mjRefMode, 'inline');
  });
  await check('§5.1 存量 provider(没填过 mjRefMode)回显空串、mjParams 回显空对象', async () => {
    const r = await mkProvider({});
    const stored = (await providersOf()).json.providers.find((p) => p.id === r.json.id);
    assert.strictEqual(stored.mjRefMode, '', `实得 ${JSON.stringify(stored.mjRefMode)}`);
    assert.deepEqual(stored.mjParams, {});
  });
  await check('M23/§5.1 mj-proxy 的 baseURL 保存前规范化(剥末尾 /mj 与斜杠),GET 回显规范化后的值', async () => {
    const r = await mkProvider({ protocol: 'mj-proxy', baseURL: `${BASE}/pp/mj/` });
    assert.equal(r.status, 200, r.text);
    const stored = (await providersOf()).json.providers.find((p) => p.id === r.json.id);
    assert.strictEqual(stored.baseURL, `${BASE}/pp`, `实得 ${stored.baseURL}`);
  });
  await check('§5.1 mj-proxy 的 size 非宽高比 → 与 mj 同样 400', async () => {
    const r = await mkProvider({ protocol: 'mj-proxy', baseURL: `${BASE}/pp`, size: '1024x1024' });
    assert.equal(r.status, 400, `实得 ${r.status} ${r.text}`);
  });
  await check('M11b/§5.1 8.1/8.2 + turbo 允许保存,磁盘与 GET 回显都仍是 turbo(不改写用户配置)', async () => {
    for (const v of ['8.1', '8.2']) {
      const r = await mkProvider({ mjVersion: v, mjSpeed: 'turbo' });
      assert.equal(r.status, 200, `version=${v} 应允许保存(实得 ${r.text})`);
      const stored = (await providersOf()).json.providers.find((p) => p.id === r.json.id);
      assert.strictEqual(stored.mjSpeed, 'turbo', `GET 回显必须仍是 turbo(version=${v},实得 ${stored.mjSpeed})`);
      const disk = readFileSync(join(TMP_HOME, '.claude-gui', 'image-providers.json'), 'utf8');
      const onDisk = JSON.parse(disk).find((p) => p.id === r.json.id);
      assert.strictEqual(onDisk.mjSpeed, 'turbo', `磁盘上必须仍是 turbo(version=${v})`);
    }
  });
  await check('§5.1 GET 每条都含 mjParams 且不含 apiKey 明文,hasKey 语义不变', async () => {
    const list = (await providersOf()).json.providers;
    assert.ok(list.length > 0, '前面已建过 provider');
    for (const p of list) {
      assert.ok(p.mjParams && typeof p.mjParams === 'object', `${p.id} 缺 mjParams`);
      assert.ok(!('apiKey' in p) || !String(p.apiKey).includes(KEY), `${p.id} 回显了 apiKey 明文`);
      assert.strictEqual(typeof p.hasKey, 'boolean', `${p.id} 的 hasKey 语义变了`);
    }
  });
  await check('§5.5 密钥不回显:遍历本节全部响应体,不得出现假 key / 假 mj-api-secret 子串', async () => {
    const bodies = [(await providersOf()).text, (await historyOf()).text,
      (await mkProvider({ mjRefMode: 'nope' })).text, (await api('POST', '/api/image/generate', { providerId: 'nope', prompt: 'x' })).text];
    for (const b of bodies) {
      assert.ok(!b.includes(KEY), `响应体里出现了 apiKey 子串:${b.slice(0, 160)}`);
      assert.ok(!b.includes(MJ_SECRET_PROBE), `响应体里出现了 mj-api-secret 子串:${b.slice(0, 160)}`);
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[A] §5.2 POST /api/image/generate');
  // ══════════════════════════════════════════════════════════════════════

  const genBad = async (body, why, wantStatus = 400) => {
    const before = (await historyOf()).list.length;
    const r = await api('POST', '/api/image/generate', body);
    assert.equal(r.status, wantStatus, `${why} 应 ${wantStatus}(实得 ${r.status} ${r.text})`);
    assert.ok(r.json?.error, `${why} 要给人话`);
    assert.equal((await historyOf()).list.length, before, `${why} 不该写历史条目`);
    return r;
  };

  await check('§5.2 不带 mjParams 与 refs:apimart 照旧出图,body 与 r84 逐字相同', async () => {
    seen.amGen.length = 0;
    const p = await mkProvider({ size: '16:9', mjVersion: 'niji7', mjSpeed: 'fast' });
    const g = await api('POST', '/api/image/generate', { providerId: p.json.id, prompt: '一只猫' });
    assert.equal(g.status, 200, g.text);
    const e = await settle(g.json.jobId);
    assert.equal(e.status, 'done', `应出图(${e.error || ''})`);
    assert.deepEqual(seen.amGen[0].body, { prompt: '一只猫', size: '16:9', niji: true, version: '7', speed: 'fast' });
  });
  await check('M33/§5.2 请求体 mjParams 与 provider 默认值【浅合并,本次值优先】', async () => {
    seen.amGen.length = 0;
    const p = await mkProvider({ mjVersion: '7', mjParams: { stylize: 100, chaos: 20 } });
    const g = await api('POST', '/api/image/generate', { providerId: p.json.id, prompt: '猫', mjParams: { stylize: 700 } });
    assert.equal(g.status, 200, g.text);
    await settle(g.json.jobId);
    const sent = seen.amGen[0].body.prompt;
    assert.ok(sent.includes('--s 700'), `本次值应覆盖默认值(实得 ${JSON.stringify(sent)})`);
    assert.ok(!sent.includes('--s 100'), '默认值不该同时出现');
    assert.ok(sent.includes('--c 20'), `未覆盖的默认值应保留(实得 ${JSON.stringify(sent)})`);
  });
  await check('§5.2 请求体 mjParams 未知键静默丢弃;非对象 → 400', async () => {
    seen.amGen.length = 0;
    const p = await mkProvider({ mjVersion: '7' });
    const g = await api('POST', '/api/image/generate', { providerId: p.json.id, prompt: '猫', mjParams: { stylize: 300, cref: 'https://x/a.png', wat: 1 } });
    assert.equal(g.status, 200, `未知键不该 400(实得 ${g.status} ${g.text})`);
    await settle(g.json.jobId);
    assert.ok(seen.amGen[0].body.prompt.includes('--s 300'));
    assert.ok(!seen.amGen[0].body.prompt.includes('--cref'), 'mjParams 里的 cref 属未知键,必须丢掉');
    await genBad({ providerId: p.json.id, prompt: '猫', mjParams: 'x' }, 'mjParams 非对象');
    await genBad({ providerId: p.json.id, prompt: '猫', mjParams: [1] }, 'mjParams 是数组');
  });
  await check('§5.2 refs 的 role 缺省是 image;role 不在四值内 → 400', async () => {
    const p = await mkProvider({ mjRefMode: 'inline' });
    const g = await api('POST', '/api/image/generate', { providerId: p.json.id, prompt: '猫', refs: [upRef()] });
    assert.equal(g.status, 200, `role 缺省应按 image 受理(实得 ${g.status} ${g.text})`);
    await settle(g.json.jobId);
    await genBad({ providerId: p.json.id, prompt: '猫', refs: [upRef({ role: 'wat' })] }, 'role 不在四值内');
  });
  await check('§5.2 refs 的 kind 不在三值内 → 400(文案与 r54 既有一致)', async () => {
    const p = await mkProvider({ mjRefMode: 'inline' });
    await genBad({ providerId: p.json.id, prompt: '猫', refs: [{ kind: 'unknown', file: REF_IN_SAVE }] }, 'kind unknown');
  });
  await check('M37/§5.2 MAX_REFS 数【全部条目】:1 张垫图 + 6 张 cref 共 7 条 → 400', async () => {
    const p = await mkProvider({ mjRefMode: 'inline', mjVersion: '6.1' });
    const refs = [upRef(), ...Array.from({ length: 6 }, (_, i) => ({ kind: 'url', role: 'cref', url: `https://x/${i}.png` }))];
    const r = await genBad({ providerId: p.json.id, prompt: '猫', refs }, '总条数超 6');
    assert.ok(/6|张/.test(String(r.json.error)), `文案要点出上限(实得 ${r.text})`);
  });
  await check('§5.2 同一非 image role 出现多条 → 400,文案指出只能有一条', async () => {
    const p = await mkProvider({ mjVersion: '6.1' });
    const r = await genBad({ providerId: p.json.id, prompt: '猫', refs: [
      { kind: 'url', role: 'cref', url: 'https://x/a.png' },
      { kind: 'url', role: 'cref', url: 'https://x/b.png' },
    ] }, '两条 cref');
    assert.ok(/一条|只能/.test(String(r.json.error)), `文案要说清只能一条(实得 ${r.text})`);
  });
  await check('M41/§5.5 kind url 必须 https 公网:http / 私网 / 回环 / 含空白一律 400,文案是图片语境', async () => {
    const p = await mkProvider({});
    for (const u of ['http://example.com/a.png', 'http://127.0.0.1/x.png', 'http://10.0.0.1/x.png',
      'http://169.254.169.254/x', 'https://192.168.1.1/x.png', 'https://x.com/a b.png']) {
      const r = await genBad({ providerId: p.json.id, prompt: '猫', refs: [{ kind: 'url', url: u }] }, `参考图 URL ${u}`);
      assert.ok(/图片|参考图/.test(String(r.json.error)), `文案要在图片语境(url=${u},实得 ${r.text})`);
    }
  });
  await check('M42/§5.5 GUI 不下载参考图 URL:假上游的该地址零请求', async () => {
    seen.amGen.length = 0;
    const marker = [];
    app.get('/refimg/probe.png', (_q, s) => { marker.push(1); s.type('image/png').send(PNG_BUF); });
    const p = await mkProvider({});
    const g = await api('POST', '/api/image/generate', { providerId: p.json.id, prompt: '猫',
      refs: [{ kind: 'url', url: `${BASE}/refimg/probe.png` }] });
    // 该 URL 是 http 回环 → 按 §5.5 必须 400;无论受理与否,服务端都不许去下载它。
    if (g.status === 200) await settle(g.json.jobId).catch(() => {});
    assert.equal(marker.length, 0, `参考图 URL 被服务端下载了 ${marker.length} 次`);
  });
  await check('M35/B27/§5.2 mj + upload 档 + role image 且 kind upload/history → 400,文案指引先上传', async () => {
    seen.amUpload.length = 0;
    const p = await mkProvider({ mjRefMode: 'upload' });
    for (const ref of [upRef(), { kind: 'history', file: REF_IN_SAVE }]) {
      const r = await genBad({ providerId: p.json.id, prompt: '猫', refs: [ref] }, `upload 档 + ${ref.kind}`);
      assert.ok(/上传/.test(String(r.json.error)), `文案要指引"请先上传该参考图换取链接"(实得 ${r.text})`);
    }
    assert.equal(seen.amUpload.length, 0, 'generate 永不隐式上传');
  });
  await check('M34c/R11/B32/§5.2 mj + inline 档 + kind upload:200 受理,image_urls 是 dataURI 且 uploads 端点零请求', async () => {
    seen.amGen.length = 0; seen.amUpload.length = 0;
    const p = await mkProvider({ mjRefMode: 'inline' });
    const g = await api('POST', '/api/image/generate', { providerId: p.json.id, prompt: '猫', refs: [upRef()] });
    assert.equal(g.status, 200, `inline 档必须正常受理(实得 ${g.status} ${g.text})`);
    await settle(g.json.jobId);
    const urls = seen.amGen[0].body.image_urls;
    assert.ok(Array.isArray(urls) && urls.length === 1, `image_urls 应有一条(实得 ${JSON.stringify(urls)})`);
    assert.ok(String(urls[0]).startsWith('data:image/'), `应是 dataURI(实得 ${String(urls[0]).slice(0, 32)})`);
    assert.equal(seen.amUpload.length, 0, 'inline 档【零上传费用】:uploads 端点必须一次都没被请求');
  });
  await check('M34d/B31/§5.2 mj + url 档 + kind upload/history → 400,文案说明只接受公网链接且可改传法', async () => {
    const p = await mkProvider({ mjRefMode: 'url' });
    const r = await genBad({ providerId: p.json.id, prompt: '猫', refs: [upRef()] }, 'url 档 + 本地文件');
    const msg = String(r.json.error);
    assert.ok(/链接/.test(msg), `文案要说明只接受公网图片链接(实得 ${r.text})`);
    assert.ok(/传法|方式|inline|上传/.test(msg), `文案要给出"可改成其它传法"的出路(实得 ${r.text})`);
  });
  await check('§5.2 mj + 任意档 + role image 且 kind url:三档都受理,URL 原样进 image_urls', async () => {
    for (const mode of ['upload', 'inline', 'url']) {
      seen.amGen.length = 0;
      const p = await mkProvider({ mjRefMode: mode });
      const g = await api('POST', '/api/image/generate', { providerId: p.json.id, prompt: '猫',
        refs: [{ kind: 'url', url: 'https://cdn.example.com/a.png' }] });
      assert.equal(g.status, 200, `mode=${mode} 应受理(实得 ${g.status} ${g.text})`);
      await settle(g.json.jobId);
      assert.deepEqual(seen.amGen[0].body.image_urls, ['https://cdn.example.com/a.png'], `mode=${mode}`);
    }
  });
  await check('§5.2 mj + 非 image role(cref/sref/oref)且 kind upload/history:与传法无关一律 400', async () => {
    for (const mode of ['upload', 'inline', 'url']) {
      const p = await mkProvider({ mjRefMode: mode, mjVersion: '6.1' });
      await genBad({ providerId: p.json.id, prompt: '猫', refs: [upRef({ role: 'cref' })] }, `mode=${mode} 的 cref 本地文件`);
      await genBad({ providerId: p.json.id, prompt: '猫', refs: [{ kind: 'history', role: 'sref', file: REF_IN_SAVE }] }, `mode=${mode} 的 sref 本地文件`);
    }
  });
  await check('§5.2 mj-proxy + role image + kind upload/history:正常受理并进 base64Array', async () => {
    seen.ppImagine.length = 0;
    const p = await mkProvider({ protocol: 'mj-proxy', baseURL: `${BASE}/pp`, mjRefMode: 'upload' });
    const g = await api('POST', '/api/image/generate', { providerId: p.json.id, prompt: '猫', refs: [upRef()] });
    assert.equal(g.status, 200, `实得 ${g.status} ${g.text}`);
    await settle(g.json.jobId);
    const arr = seen.ppImagine[0].body.base64Array;
    assert.ok(Array.isArray(arr) && arr.length === 1, `base64Array 应有一条(实得 ${JSON.stringify(arr)})`);
    assert.ok(String(arr[0]).startsWith('data:image/'), `应是 dataURI(实得 ${String(arr[0]).slice(0, 32)})`);
  });
  await check('§5.2 mj-proxy + 非 image role + kind upload/history → 400', async () => {
    const p = await mkProvider({ protocol: 'mj-proxy', baseURL: `${BASE}/pp`, mjVersion: '6.1' });
    await genBad({ providerId: p.json.id, prompt: '猫', refs: [upRef({ role: 'cref' })] }, 'mj-proxy 的 cref 本地文件');
  });
  await check('§5.2 weight 越界时该 flag 不发,整单不失败', async () => {
    seen.amGen.length = 0;
    const p = await mkProvider({ mjVersion: '7' });
    const g = await api('POST', '/api/image/generate', { providerId: p.json.id, prompt: '猫',
      refs: [{ kind: 'url', url: 'https://cdn.example.com/a.png', weight: 99 }] });
    assert.equal(g.status, 200, `越界权重不该让整单失败(实得 ${g.status} ${g.text})`);
    const e = await settle(g.json.jobId);
    assert.equal(e.status, 'done', `仍应出图(${e.error || ''})`);
    assert.ok(!seen.amGen[0].body.prompt.includes('--iw'), `越界的 --iw 不该发出去(实得 ${JSON.stringify(seen.amGen[0].body.prompt)})`);
  });
  await check('M36/§5.2 历史条目的 refs 摘要仍只含 kind 与 name/file 两键(不落 role/weight)', async () => {
    const p = await mkProvider({ mjRefMode: 'inline', mjVersion: '6.1' });
    const g = await api('POST', '/api/image/generate', { providerId: p.json.id, prompt: '猫', refs: [
      upRef({ role: 'image', weight: 2 }),
      { kind: 'history', file: REF_IN_SAVE, role: 'image', weight: 1 },
    ] });
    assert.equal(g.status, 200, g.text);
    const e = await settle(g.json.jobId);
    assert.deepEqual(e.refs, [{ kind: 'upload', name: 'a.png' }, { kind: 'history', file: REF_IN_SAVE }],
      `摘要只许两键(实得 ${JSON.stringify(e.refs)})`);
  });
  await check('R9/§5.2 mj-proxy 受理:200 + jobId;完成后有 file 与 previewUrl,【不写 files】', async () => {
    const p = await mkProvider({ protocol: 'mj-proxy', baseURL: `${BASE}/pp` });
    const g = await api('POST', '/api/image/generate', { providerId: p.json.id, prompt: '猫' });
    assert.equal(g.status, 200, g.text);
    assert.ok(g.json.ok && g.json.jobId, `实得 ${g.text}`);
    const e = await settle(g.json.jobId);
    assert.equal(e.status, 'done', `应出图(${e.error || ''})`);
    assert.ok(e.file && e.previewUrl, `应有 file 与 previewUrl(实得 ${JSON.stringify(e)})`);
    assert.ok(!e.files, 'proxy 单张四宫格不写 files 字段');
  });
  await check('R9/§5.2 mj-proxy(plus)完成后条目带 mjButtons(来自 fetch 响应,[{customId,label}])', async () => {
    const p = await mkProvider({ protocol: 'mj-proxy', baseURL: `${BASE}/pp` });
    const g = await api('POST', '/api/image/generate', { providerId: p.json.id, prompt: '猫' });
    const e = await settle(g.json.jobId);
    assert.ok(Array.isArray(e.mjButtons) && e.mjButtons.length > 0, `mjButtons 应非空(实得 ${JSON.stringify(e.mjButtons)})`);
    assert.ok(e.mjButtons.length <= 32, 'mjButtons 上限 32');
    for (const b of e.mjButtons) {
      assert.deepEqual(Object.keys(b).sort(), ['customId', 'label'], `按钮只许两键(实得 ${JSON.stringify(b)})`);
    }
  });
  await check('B13/§5.2 mj-proxy(原版,fetch 无 buttons)完成后 mjButtons 是空数组且状态仍 done', async () => {
    const p = await mkProvider({ protocol: 'mj-proxy', baseURL: `${BASE}/po` });
    const g = await api('POST', '/api/image/generate', { providerId: p.json.id, prompt: '猫' });
    const e = await settle(g.json.jobId);
    assert.equal(e.status, 'done', `原版也要能出图(${e.error || ''})`);
    assert.deepEqual(e.mjButtons, [], `无 buttons 时应是空数组(实得 ${JSON.stringify(e.mjButtons)})`);
  });
  await check('§5.2 mj / mj-proxy 受理后条目带 mjPromptSent(实际发上游的完整 prompt)', async () => {
    seen.amGen.length = 0;
    const p = await mkProvider({ mjVersion: '7', mjParams: { stylize: 250 } });
    const g = await api('POST', '/api/image/generate', { providerId: p.json.id, prompt: '猫' });
    const e = await settle(g.json.jobId);
    assert.equal(typeof e.mjPromptSent, 'string', `应有 mjPromptSent(实得 ${JSON.stringify(e.mjPromptSent)})`);
    assert.strictEqual(e.mjPromptSent, seen.amGen[0].body.prompt, 'mjPromptSent 必须与真正发上游的 prompt 逐字相同');
  });
  await check('M11a/B28/§5.2 provider 存 8.2+turbo:上游收到 fast、条目有 speedNote、provider 仍是 turbo', async () => {
    seen.amGen.length = 0;
    const p = await mkProvider({ mjVersion: '8.2', mjSpeed: 'turbo' });
    const g = await api('POST', '/api/image/generate', { providerId: p.json.id, prompt: '猫' });
    const e = await settle(g.json.jobId);
    assert.strictEqual(seen.amGen[0].body.speed, 'fast', `上游必须收到 fast(实得 ${JSON.stringify(seen.amGen[0].body.speed)})`);
    assert.ok(!JSON.stringify(seen.amGen[0].body).includes('turbo'), '上游永不收到 turbo');
    assert.ok(typeof e.speedNote === 'string' && e.speedNote.length > 0, `条目要带降级说明(实得 ${JSON.stringify(e.speedNote)})`);
    const stored = (await providersOf()).json.providers.find((x) => x.id === p.json.id);
    assert.strictEqual(stored.mjSpeed, 'turbo', '同一时刻 provider 仍是 turbo');
  });
  await check('M4/B8a/§5.2 carrier mj 且 prompt 手写 --ar:上游 body 不含 size 键', async () => {
    seen.amGen.length = 0;
    const p = await mkProvider({ size: '16:9' });
    const g = await api('POST', '/api/image/generate', { providerId: p.json.id, prompt: '一只猫 --ar 1:1' });
    assert.equal(g.status, 200, g.text);
    await settle(g.json.jobId);
    assert.ok(!('size' in seen.amGen[0].body), `手写 --ar 时不许再发 size(实得 ${JSON.stringify(seen.amGen[0].body)})`);
    assert.ok(seen.amGen[0].body.prompt.includes('--ar 1:1'), '以提示词为准');
    assert.equal((seen.amGen[0].body.prompt.match(/--ar/g) || []).length, 1, '--ar 只许出现一次');
  });
  await check('B8b/§5.2 mj-proxy 手写 --ar:flag 串里 --ar 只出现一次且为 1:1', async () => {
    seen.ppImagine.length = 0;
    const p = await mkProvider({ protocol: 'mj-proxy', baseURL: `${BASE}/pp`, size: '16:9' });
    const g = await api('POST', '/api/image/generate', { providerId: p.json.id, prompt: '一只猫 --ar 1:1' });
    assert.equal(g.status, 200, g.text);
    await settle(g.json.jobId);
    const sent = seen.ppImagine[0].body.prompt;
    assert.equal((sent.match(/--ar/g) || []).length, 1, `--ar 只许一次(实得 ${JSON.stringify(sent)})`);
    assert.ok(sent.includes('--ar 1:1'), '以提示词为准');
  });
  await check('§5.2 三同步协议既有路径逐字不变(openai 仍打 /images/generations 且 body 三键)', async () => {
    const hits = [];
    app.post('/oa/v1/images/generations', (q, s) => { hits.push(q.body); s.json({ data: [{ b64_json: PNG_B64 }] }); });
    const p = await mkProvider({ protocol: 'openai', baseURL: `${BASE}/oa/v1`, model: 'gpt-image-2' });
    const g = await api('POST', '/api/image/generate', { providerId: p.json.id, prompt: '一只猫' });
    assert.equal(g.status, 200, g.text);
    const e = await settle(g.json.jobId);
    assert.equal(e.status, 'done', `openai 路径应照常出图(${e.error || ''})`);
    assert.deepEqual(hits[0], { model: 'gpt-image-2', prompt: '一只猫', n: 1 });
  });

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[A] §5.3 POST /api/image/actions');
  // ══════════════════════════════════════════════════════════════════════

  // 父任务准备:实现落地前这些会失败(mj-proxy 建不出来),必须【不中断整段】——
  // 每条依赖它的断言各自红,才看得出到底缺哪几件。
  const mkParent = async (patch, prompt) => {
    try {
      const p = await mkProvider(patch);
      if (p.status !== 200) return { ok: false, why: `建 provider 失败:${p.status} ${p.text}` };
      const g = await api('POST', '/api/image/generate', { providerId: p.json.id, prompt });
      if (g.status !== 200) return { ok: false, why: `提交失败:${g.status} ${g.text}` };
      const e = await settle(g.json.jobId);
      return { ok: true, providerId: p.json.id, jobId: g.json.jobId, entry: e };
    } catch (e) {
      return { ok: false, why: String((e && e.message) || e) };
    }
  };
  const needParent = (x, label) => assert.ok(x.ok, `前置的${label}没准备好:${x.why}`);

  const amParent = await mkParent({ mjSpeed: 'fast' }, '父任务');
  const ppParent = await mkParent({ protocol: 'mj-proxy', baseURL: `${BASE}/pp` }, 'plus 父任务');
  const poParent = await mkParent({ protocol: 'mj-proxy', baseURL: `${BASE}/po` }, '原版父任务');

  await check('M31/§5.3 r84 老形态({jobId, action, index})上游 URL 与 body 逐字不变', async () => {
    needParent(amParent, 'apimart 父任务');
    seen.amAction.length = 0;
    const r = await api('POST', '/api/image/actions', { jobId: amParent.jobId, action: 'upscale', index: 2 });
    assert.equal(r.status, 200, `实得 ${r.status} ${r.text}`);
    await settle(r.json.jobId);
    assert.equal(seen.amAction[0].action, 'upscale', '打 /generations/upscale');
    assert.deepEqual(seen.amAction[0].body, { task_id: 'task_am', index: 2, speed: 'fast' });
  });
  // apimart 自己的 buttons 里没有 upsample_v*(真机实测),所以「customId 形态」的端点映射
  // 用 /am2 这个"同协议但有真放大按钮"的站来验 —— 契约要对所有 mj 协议的站成立。
  const am2Parent = await mkParent({ baseURL: `${BASE}/am2/v1`, mjSpeed: 'fast' }, 'am2 父任务');
  await check('M19/§5.3 apimart 形态 + customId(真放大):打 upscale 端点,body {task_id, custom_id} 无 index', async () => {
    needParent(am2Parent, 'am2 父任务');
    seen.amAction.length = 0;
    const r = await api('POST', '/api/image/actions', { jobId: am2Parent.jobId, customId: 'MJ::JOB::upsample_v7_2x_subtle::1::hA2' });
    assert.equal(r.status, 200, `实得 ${r.status} ${r.text}`);
    await settle(r.json.jobId);
    assert.equal(seen.amAction[0].action, 'upscale');
    assert.deepEqual(seen.amAction[0].body, { task_id: 'task_am2', custom_id: 'MJ::JOB::upsample_v7_2x_subtle::1::hA2', speed: 'fast' });
    assert.ok(!('index' in seen.amAction[0].body), 'customId 形态不许带 index');
  });
  await check('§5.3 apimart 形态 + variation 的 customId:打 variation 端点', async () => {
    needParent(am2Parent, 'am2 父任务');
    seen.amAction.length = 0;
    const r = await api('POST', '/api/image/actions', { jobId: am2Parent.jobId, customId: 'MJ::JOB::variation::2::hA2' });
    assert.equal(r.status, 200, `实得 ${r.status} ${r.text}`);
    await settle(r.json.jobId);
    assert.equal(seen.amAction[0].action, 'variation');
    assert.deepEqual(seen.amAction[0].body, { task_id: 'task_am2', custom_id: 'MJ::JOB::variation::2::hA2', speed: 'fast' });
  });
  await check('§5.3 apimart(真机形态)+ 父任务 buttons 里的 pick customId:同样走 upscale 端点且无 index', async () => {
    needParent(amParent, 'apimart 父任务');
    seen.amAction.length = 0;
    const r = await api('POST', '/api/image/actions', { jobId: amParent.jobId, customId: 'MJ::JOB::upsample::1::hAM' });
    assert.equal(r.status, 200, `实得 ${r.status} ${r.text}`);
    await settle(r.json.jobId);
    assert.equal(seen.amAction[0].action, 'upscale');
    assert.deepEqual(seen.amAction[0].body, { task_id: 'task_am', custom_id: 'MJ::JOB::upsample::1::hAM', speed: 'fast' });
  });
  await check('§5.3 mj-proxy plus + customId:打 /mj/submit/action,body {taskId, customId}', async () => {
    needParent(ppParent, 'proxy plus 父任务');
    seen.ppAction.length = 0;
    const r = await api('POST', '/api/image/actions', { jobId: ppParent.jobId, customId: 'MJ::JOB::upsample_v7_2x_subtle::1::hPP' });
    assert.equal(r.status, 200, `实得 ${r.status} ${r.text}`);
    await settle(r.json.jobId);
    assert.equal(seen.ppAction.length, 1, `应恰一次(实得 ${seen.ppAction.length})`);
    assert.deepEqual(seen.ppAction[0].body, { taskId: '1712', customId: 'MJ::JOB::upsample_v7_2x_subtle::1::hPP' });
  });
  await check('§5.3 mj-proxy 原版(无 buttons)+ index 形态:打 /mj/submit/change,body {taskId, action, index}', async () => {
    needParent(poParent, 'proxy 原版父任务');
    seen.poChange.length = 0; seen.poAction.length = 0;
    const r = await api('POST', '/api/image/actions', { jobId: poParent.jobId, action: 'upscale', index: 1 });
    assert.equal(r.status, 200, `实得 ${r.status} ${r.text}`);
    await settle(r.json.jobId);
    assert.equal(seen.poChange.length, 1, `应打 change(实得 change ${seen.poChange.length} / action ${seen.poAction.length})`);
    assert.deepEqual(seen.poChange[0].body, { taskId: '9001', action: 'UPSCALE', index: 1 });
    assert.equal(seen.poAction.length, 0, '原版没有 /mj/submit/action,不许去试');
  });
  await check('M30/§5.3 customId 不在父条目 mjButtons 内 → 400,文案含「按钮」或「已失效」,上游零请求', async () => {
    needParent(ppParent, 'proxy plus 父任务');
    seen.ppAction.length = 0;
    const r = await api('POST', '/api/image/actions', { jobId: ppParent.jobId, customId: 'MJ::JOB::upsample::1::伪造hash' });
    assert.equal(r.status, 400, `实得 ${r.status} ${r.text}`);
    assert.ok(/按钮|已失效/.test(String(r.json?.error || '')), `文案不合(实得 ${r.text})`);
    assert.equal(seen.ppAction.length, 0, '上游必须零请求(自拼的 hash 打过去只会 400 且可能计费)');
  });
  await check('M16/§5.3 customId 分类不在 MJ_RENDERED_KINDS 内(pan_left)→ 400 含「本版本暂不支持」,上游零请求', async () => {
    needParent(ppParent, 'proxy plus 父任务');
    seen.ppAction.length = 0;
    const r = await api('POST', '/api/image/actions', { jobId: ppParent.jobId, customId: 'MJ::JOB::pan_left::1::hPP' });
    assert.equal(r.status, 400, `实得 ${r.status} ${r.text}`);
    assert.ok(String(r.json?.error || '').includes('本版本暂不支持'), `文案不合(实得 ${r.text})`);
    assert.equal(seen.ppAction.length, 0, '上游零请求');
  });
  await check('§5.3 缺参与不存在的任务:{jobId} → 400;{jobId:nope} → 404', async () => {
    needParent(ppParent, 'proxy plus 父任务');
    const a = await api('POST', '/api/image/actions', { jobId: ppParent.jobId });
    assert.equal(a.status, 400, `只给 jobId 应 400(实得 ${a.status} ${a.text})`);
    const b = await api('POST', '/api/image/actions', { jobId: 'nope', action: 'upscale', index: 1 });
    assert.equal(b.status, 404, `不存在的任务应 404(实得 ${b.status} ${b.text})`);
  });
  await check('§5.3 父条目 status 非 done 或无 taskId → 400(文案与 r84 逐字相同)', async () => {
    const p = await mkProvider({ protocol: 'openai', baseURL: `${BASE}/oa/v1`, model: 'gpt-image-2' });
    const g = await api('POST', '/api/image/generate', { providerId: p.json.id, prompt: '同步协议没有 taskId' });
    await settle(g.json.jobId);
    const r = await api('POST', '/api/image/actions', { jobId: g.json.jobId, action: 'upscale', index: 1 });
    assert.equal(r.status, 400, `实得 ${r.status} ${r.text}`);
  });
  await check('E4/§5.3 provider 协议既非 mj 也非 mj-proxy → 400', async () => {
    const p = await mkProvider({ protocol: 'openai', baseURL: `${BASE}/oa/v1`, model: 'gpt-image-2' });
    const g = await api('POST', '/api/image/generate', { providerId: p.json.id, prompt: '猫' });
    await settle(g.json.jobId);
    const r = await api('POST', '/api/image/actions', { jobId: g.json.jobId, action: 'upscale', index: 1 });
    assert.equal(r.status, 400, `实得 ${r.status} ${r.text}`);
  });
  await check('§5.3 新条目含 parentId 与 mjAction;index 形态含 mjIndex、customId 形态含 mjCustomId', async () => {
    needParent(ppParent, 'proxy plus 父任务');
    const byIndex = await api('POST', '/api/image/actions', { jobId: ppParent.jobId, action: 'upscale', index: 2 });
    assert.equal(byIndex.status, 200, byIndex.text);
    const e1 = await settle(byIndex.json.jobId);
    assert.strictEqual(e1.parentId, ppParent.jobId, 'index 形态要记父任务');
    assert.strictEqual(e1.mjAction, 'pick', `mjAction 记 kind(实得 ${JSON.stringify(e1.mjAction)})`);
    assert.strictEqual(e1.mjIndex, 2);
    assert.ok(!e1.mjCustomId, 'index 形态不该有 mjCustomId');

    const byCustom = await api('POST', '/api/image/actions', { jobId: ppParent.jobId, customId: 'MJ::JOB::variation::1::hPP' });
    assert.equal(byCustom.status, 200, byCustom.text);
    const e2 = await settle(byCustom.json.jobId);
    assert.strictEqual(e2.parentId, ppParent.jobId);
    assert.strictEqual(e2.mjAction, 'variation');
    assert.strictEqual(e2.mjCustomId, 'MJ::JOB::variation::1::hPP');
  });
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[A] §4.9 apimart 侧 buttons 拉取');
  // ══════════════════════════════════════════════════════════════════════

  const amRun = async (patch = {}) => {
    const p = await mkProvider(patch);
    const g = await api('POST', '/api/image/generate', { providerId: p.json.id, prompt: 'buttons 用例' });
    assert.equal(g.status, 200, g.text);
    const e = await settle(g.json.jobId);
    return { providerId: p.json.id, jobId: g.json.jobId, entry: e };
  };

  await check('R9b/§4.9 一次任务完成后该 GET 恰被请求 1 次(不重复拉),且 task_id 出现在 URL 里', async () => {
    seen.amButtons.length = 0;
    amButtonsMode = 'parent';
    await amRun();
    assert.equal(seen.amButtons.length, 1, `应恰 1 次(实得 ${seen.amButtons.length}:${JSON.stringify(seen.amButtons)})`);
    assert.strictEqual(seen.amButtons[0], 'task_am');
  });
  await check('R9b/§4.9 映射为 [{customId,label}] 只取两键,顺序与上游一致', async () => {
    amButtonsMode = 'parent';
    const { entry } = await amRun();
    assert.ok(Array.isArray(entry.mjButtons), `mjButtons 应是数组(实得 ${JSON.stringify(entry.mjButtons)})`);
    assert.equal(entry.mjButtons.length, AM_PARENT_BUTTONS.length, `真机形态 15 项(实得 ${entry.mjButtons.length})`);
    assert.deepEqual(entry.mjButtons.map((b) => b.customId), AM_PARENT_BUTTONS.map((b) => b.customId), '顺序必须与上游一致');
    for (const b of entry.mjButtons) {
      assert.deepEqual(Object.keys(b).sort(), ['customId', 'label'], `只许两键(实得 ${JSON.stringify(b)})`);
    }
  });
  await check('§4.9 真机形态:apimart 父任务 buttons 里没有任何 upsample_v*_2x_*(该站不提供真放大)', async () => {
    amButtonsMode = 'parent';
    const { entry } = await amRun();
    for (const b of entry.mjButtons) {
      assert.ok(!/upsample_v\d+_\d+x/.test(b.customId), `不该出现真放大命令:${b.customId}`);
    }
  });
  await check('§4.9 customId 为空 / 非字符串的项跳过;重复 customId 去重保留首个', async () => {
    amButtonsMode = 'dup';
    const { entry } = await amRun();
    amButtonsMode = 'parent';
    assert.deepEqual(entry.mjButtons.map((b) => b.customId),
      ['MJ::JOB::upsample::1::hAM', 'MJ::JOB::variation::1::hAM'], `实得 ${JSON.stringify(entry.mjButtons)}`);
    assert.strictEqual(entry.mjButtons[0].label, 'U1', '重复项保留首个');
  });
  await check('§4.9 上游给出 40 项时截断为前 32 项', async () => {
    amButtonsMode = 'many';
    const { entry } = await amRun();
    amButtonsMode = 'parent';
    assert.equal(entry.mjButtons.length, 32, `实得 ${entry.mjButtons.length}`);
    assert.strictEqual(entry.mjButtons[31].customId, 'MJ::JOB::upsample::1::h31');
  });
  await check('M48d/R12/§4.9【主路径】响应无 buttons 键 → mjButtons 空数组,status 仍 done、file 不受影响、不写 error', async () => {
    amButtonsMode = 'none';
    const { entry } = await amRun();
    amButtonsMode = 'parent';
    assert.deepEqual(entry.mjButtons, [], `实得 ${JSON.stringify(entry.mjButtons)}`);
    assert.equal(entry.status, 'done', '这是 apimart 的常态,绝不许因此判失败');
    assert.ok(entry.file, '出图结果不受影响');
    assert.ok(!entry.error, `不许写 error(实得 ${JSON.stringify(entry.error)})`);
  });
  await check('M48d/§4.9 响应非 JSON → mjButtons 空数组且 status 仍 done', async () => {
    amButtonsMode = 'notjson';
    const { entry } = await amRun();
    amButtonsMode = 'parent';
    assert.deepEqual(entry.mjButtons, []);
    assert.equal(entry.status, 'done');
  });
  await check('R9b/§4.9 该 GET 回 500 时条目仍为 done 且 mjButtons 为空数组', async () => {
    amButtonsMode = '500';
    const { entry } = await amRun();
    amButtonsMode = 'parent';
    assert.equal(entry.status, 'done', `实得 ${entry.status} / ${entry.error || ''}`);
    assert.deepEqual(entry.mjButtons, []);
    assert.ok(!entry.error, '不许把 buttons 拉取失败写成任务错误');
  });
  await check('§4.9 mj-proxy 侧不走这条(proxy 任务不请求 apimart 的 buttons 端点)', async () => {
    seen.amButtons.length = 0;
    const p = await mkProvider({ protocol: 'mj-proxy', baseURL: `${BASE}/pp` });
    const g = await api('POST', '/api/image/generate', { providerId: p.json.id, prompt: 'proxy 不拉 buttons' });
    await settle(g.json.jobId);
    assert.equal(seen.amButtons.length, 0, `proxy 的 buttons 来自 fetch 响应(实得多打了 ${seen.amButtons.length} 次)`);
  });

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[A] §5.4 POST /api/image/upload-ref');
  // ══════════════════════════════════════════════════════════════════════

  await check('B21/§5.4 合法 upload + apimart 形态的 mj provider → 200 {ok,url,expiresAt}', async () => {
    amUploadMode = 'ok'; seen.amUpload.length = 0;
    const p = await mkProvider({ mjRefMode: 'upload' });
    const r = await api('POST', '/api/image/upload-ref', { providerId: p.json.id, ref: upRef() });
    assert.equal(r.status, 200, `实得 ${r.status} ${r.text}`);
    assert.strictEqual(r.json.ok, true);
    assert.ok(/^https?:\/\//.test(String(r.json.url)), `url 应是 http(s)(实得 ${JSON.stringify(r.json.url)})`);
    assert.equal(seen.amUpload.length, 1, '恰上传一次');
  });
  await check('M48e/§5.4 上游回的是第三方域时也原样采用(不硬编码任何上传域名)', async () => {
    amUploadMode = 'ok';
    const p = await mkProvider({ mjRefMode: 'upload' });
    const r = await api('POST', '/api/image/upload-ref', { providerId: p.json.id, ref: upRef() });
    assert.equal(r.status, 200, r.text);
    assert.strictEqual(r.json.url, 'https://cdn-3rd-party.example.org/image/abc.png',
      '上游给什么用什么,不许改写、不许按域名过滤');
  });
  await check('M40/M48f/§5.4 expiresAt 晚于当前时间,且标明是 GUI 自算(expiresAtSource 为 local)', async () => {
    amUploadMode = 'ok';
    const p = await mkProvider({ mjRefMode: 'upload' });
    const before = Date.now();
    const r = await api('POST', '/api/image/upload-ref', { providerId: p.json.id, ref: upRef() });
    assert.equal(r.status, 200, r.text);
    const at = typeof r.json.expiresAt === 'number' ? r.json.expiresAt : Date.parse(r.json.expiresAt);
    assert.ok(Number.isFinite(at), `expiresAt 要能解析(实得 ${JSON.stringify(r.json.expiresAt)})`);
    assert.ok(at > before, 'expiresAt 必须晚于当前时间');
    assert.strictEqual(r.json.expiresAtSource, 'local',
      '上游响应里根本没有 expires 字段,必须标明这是本地按 72h 自算的值');
  });
  await check('§5.4 provider 协议非 mj → 400', async () => {
    for (const patch of [{ protocol: 'openai', baseURL: `${BASE}/oa/v1`, model: 'gpt-image-2' },
      { protocol: 'mj-proxy', baseURL: `${BASE}/pp` }]) {
      const p = await mkProvider(patch);
      const r = await api('POST', '/api/image/upload-ref', { providerId: p.json.id, ref: upRef() });
      assert.equal(r.status, 400, `protocol=${patch.protocol} 实得 ${r.status} ${r.text}`);
    }
  });
  await check('M38/§5.4 出站前 SSRF 闸:私网 baseURL → 400 且上游零请求', async () => {
    seen.amUpload.length = 0;
    const mk = await api('POST', '/api/image-providers', { name: 'ssrf', protocol: 'mj',
      baseURL: 'http://10.0.0.1/v1', apiKey: KEY, model: 'midjourney', savePath: SAVE_DIR });
    if (mk.status === 200) {
      const r = await api('POST', '/api/image/upload-ref', { providerId: mk.json.id, ref: upRef() });
      assert.equal(r.status, 400, `实得 ${r.status} ${r.text}`);
    } else {
      assert.equal(mk.status, 400, `私网 baseURL 在保存时就被拒也算过(实得 ${mk.status})`);
    }
    assert.equal(seen.amUpload.length, 0, '上游必须零请求');
  });
  await check('§5.4 单张超 15MB 或 MIME 不在 png/jpeg/webp → 400', async () => {
    const p = await mkProvider({ mjRefMode: 'upload' });
    const huge = Buffer.alloc(16 * 1024 * 1024, 7).toString('base64');
    const a = await api('POST', '/api/image/upload-ref', { providerId: p.json.id, ref: upRef({ dataB64: huge }) });
    assert.equal(a.status, 400, `超大图应 400(实得 ${a.status})`);
    const b = await api('POST', '/api/image/upload-ref', { providerId: p.json.id, ref: upRef({ name: 'x.svg', mime: 'image/svg+xml' }) });
    assert.equal(b.status, 400, `白名单外 mime 应 400(实得 ${b.status} ${b.text})`);
  });
  await check('§5.4 kind history 的路径穿透与外链软链 → 400', async () => {
    const p = await mkProvider({ mjRefMode: 'upload' });
    for (const file of [join(SAVE_DIR, '..', 'etc', 'passwd.png'), '/etc/hosts', 'seed.png', join(SAVE_DIR, '不存在.png')]) {
      const r = await api('POST', '/api/image/upload-ref', { providerId: p.json.id, ref: { kind: 'history', file } });
      assert.equal(r.status, 400, `file=${file} 实得 ${r.status} ${r.text}`);
    }
  });
  await check('§5.4 kind history 且在 savePath 之下 → 200', async () => {
    amUploadMode = 'ok';
    const p = await mkProvider({ mjRefMode: 'upload' });
    const r = await api('POST', '/api/image/upload-ref', { providerId: p.json.id, ref: { kind: 'history', file: REF_IN_SAVE } });
    assert.equal(r.status, 200, `实得 ${r.status} ${r.text}`);
  });
  await check('§5.4 上游 4xx / 5xx → 502,原文经剥 key 后透传', async () => {
    const p = await mkProvider({ mjRefMode: 'upload' });
    for (const mode of ['4xx', '5xx']) {
      amUploadMode = mode;
      const r = await api('POST', '/api/image/upload-ref', { providerId: p.json.id, ref: upRef() });
      assert.equal(r.status, 502, `mode=${mode} 实得 ${r.status} ${r.text}`);
      assert.ok(!r.text.includes(KEY), `mode=${mode} 的透传原文必须剥掉 key`);
    }
    amUploadMode = 'ok';
  });
  await check('M39/§5.4 频次闸:与出图共用 MAX_CONCURRENT_JOBS(3),满时 429 且名额在响应前归还', async () => {
    amUploadMode = 'ok';
    // 先占满 3 个名额:三条打向"永不响应"的上游。
    const hangP = await mkProvider({ baseURL: `${BASE}/hang/v1` });
    const jobs = [];
    for (let i = 0; i < 3; i++) {
      jobs.push(await api('POST', '/api/image/generate', { providerId: hangP.json.id, prompt: `占位 ${i}` }));
    }
    assert.ok(jobs.every((j) => j.status === 200), `三个占位任务应受理(实得 ${jobs.map((j) => j.status)})`);
    const p = await mkProvider({ mjRefMode: 'upload' });
    const r = await api('POST', '/api/image/upload-ref', { providerId: p.json.id, ref: upRef() });
    assert.equal(r.status, 429, `并发满时应 429(实得 ${r.status} ${r.text})`);
    for (const j of jobs) await api('POST', `/api/image/jobs/${j.json.jobId}/cancel`).catch(() => {});
  });
  await check('§5.4 任何响应路径都不含 apiKey 子串与 mj-api-secret 值', async () => {
    const p = await mkProvider({ mjRefMode: 'upload' });
    const texts = [];
    amUploadMode = 'ok';
    texts.push((await api('POST', '/api/image/upload-ref', { providerId: p.json.id, ref: upRef() })).text);
    amUploadMode = '4xx';
    texts.push((await api('POST', '/api/image/upload-ref', { providerId: p.json.id, ref: upRef() })).text);
    amUploadMode = 'ok';
    texts.push((await api('POST', '/api/image/upload-ref', { providerId: 'nope', ref: upRef() })).text);
    texts.push((await api('POST', '/api/image/upload-ref', { providerId: p.json.id, ref: { kind: 'history', file: '/etc/hosts' } })).text);
    for (const t of texts) {
      assert.ok(!t.includes(KEY), `出现 apiKey 子串:${t.slice(0, 160)}`);
      assert.ok(!t.includes(MJ_SECRET_PROBE), `出现 mj-api-secret 子串:${t.slice(0, 160)}`);
    }
  });
  await check('§5.5 结果图 URL 不当长期地址:条目 previewUrl 走本地预览端点,不是上游 URL', async () => {
    amButtonsMode = 'parent';
    const { entry } = await amRun();
    assert.ok(String(entry.previewUrl).startsWith('/api/image/preview?file='),
      `预览必须走本地文件(实得 ${JSON.stringify(entry.previewUrl)})`);
    assert.ok(!String(entry.previewUrl).includes('127.0.0.1'), '不许把上游 URL 当预览地址(它 24 小时后就失效)');
  });

  await check('§5.5 失败路径的错误体不含假 key / 假 mj-api-secret 子串', async () => {
    const bodies = [];
    bodies.push((await api('POST', '/api/image/actions', { jobId: 'nope', action: 'upscale', index: 1 })).text);
    bodies.push((await api('POST', '/api/image/actions', { jobId: ppParent.jobId || 'nope', customId: 'MJ::JOB::pan_left::1::hPP' })).text);
    bodies.push((await api('POST', '/api/image/generate', { providerId: 'nope', prompt: 'x' })).text);
    bodies.push((await historyOf()).text);
    for (const b of bodies) {
      assert.ok(!b.includes(KEY), `出现 apiKey 子串:${b.slice(0, 160)}`);
      assert.ok(!b.includes(MJ_SECRET_PROBE), `出现 mj-api-secret 子串:${b.slice(0, 160)}`);
    }
  });
} catch (e) {
  fatal = e;
} finally {
  server.closeAllConnections?.();
  server.close();
  await new Promise((r) => server.once('close', r));
  rmSync(TMP_HOME, { recursive: true, force: true });
  rmSync(SAVE_DIR, { recursive: true, force: true });
}

if (fatal) {
  console.log(`\n  ✗ 【整段中断】${String(fatal && fatal.message || fatal).split('\n').slice(0, 6).join('\n      ')}`);
  FAILS++;
  failed.push('整段中断(见上)');
}
console.log(`\n—— check-r94-image-routes: ${PASS} 绿 / ${FAILS} 红(共 ${PASS + FAILS} 条)——`);
if (FAILS) {
  console.log('红的条目:');
  for (const n of failed) console.log(`  ✗ ${n}`);
  process.exit(1);
}
console.log('✓ check-r94-image-routes: provider 字段 + generate 三档垫图与降级 + actions 两形态 全绿');
