// r16-3 生图面板的后端:自定义生图 provider 的 CRUD + 出图 + 预览回源。
//
// 与文本 provider 完全分开:配置独立落 ~/.claude-gui/image-providers.json,
// 【绝不写 ~/.claude/settings.json】(CLI 的 env 与生图无关,混进去只会污染会话)。
// 协议差异全在 utils/image-protocols.js 的纯函数里,本文件只做 fetch / 落盘 / 错误呈现。
import { Router } from 'express';
import { readFile, writeFile, mkdir, rename, unlink, stat, access } from 'fs/promises';
import { existsSync, constants } from 'fs';
import { join, isAbsolute } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { extname } from 'path';
import {
  IMAGE_PROTOCOLS, IMAGE_CONTENT_TYPES, buildImageRequest, extractImage,
  buildImageFileName, imageExtFromMime, resolvePreviewPath, redactKey,
} from '../utils/image-protocols.js';
import { assertPublicBaseURL } from './settings.js';

const router = Router();

// 路径按调用取(不在模块顶层固化):单测把 HOME 指向 mktemp 目录后再 import 也能生效,
// 真实 HOME 一个字节都不碰。
function imageProvidersPath() {
  return join(homedir(), '.claude-gui', 'image-providers.json');
}

const GENERATE_TIMEOUT_MS = 120_000; // 生图比文本慢得多
const DOWNLOAD_TIMEOUT_MS = 60_000; // 上游只回 URL 时下载原图
const MAX_UPSTREAM_ERR = 500; // 上游报错原文透传上限(剥 key 后)

async function readImageProviders() {
  try {
    const d = JSON.parse(await readFile(imageProvidersPath(), 'utf-8'));
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}

// 原子写 + 串行队列(照抄 settings.js writeCustomProviders):并发 create/edit/delete
// 各自读-改-写,半截 writeFile 或互相覆盖会丢条目。tmp 名带 uuid + rename 落地。
let _imageProvidersQueue = Promise.resolve();
function writeImageProviders(list) {
  const wire = Array.isArray(list) ? list : [];
  const run = _imageProvidersQueue.catch(() => {}).then(async () => {
    const target = imageProvidersPath();
    await mkdir(join(homedir(), '.claude-gui'), { recursive: true });
    const tmp = `${target}.tmp-${randomUUID()}`;
    try {
      await writeFile(tmp, JSON.stringify(wire, null, 2));
      await rename(tmp, target);
    } catch (err) {
      try { await unlink(tmp); } catch {}
      throw err;
    }
  });
  _imageProvidersQueue = run;
  return run;
}

// 出参永远不含 apiKey —— 只回 hasKey(与文本 provider 同口径)。
function publicView(p) {
  return {
    id: p.id, name: p.name, protocol: p.protocol, baseURL: p.baseURL,
    model: p.model || '', size: p.size || '', savePath: p.savePath || '',
    extra: p.extra || null, hasKey: !!p.apiKey,
  };
}

// 保存目录:必须是绝对路径 + 存在 + 可写。人话错误,不抛栈。
async function checkSavePath(savePath) {
  if (typeof savePath !== 'string' || !savePath.trim()) return '保存路径必填，请选择一个保存目录';
  if (!isAbsolute(savePath.trim())) return '保存路径必须是绝对路径';
  try {
    const st = await stat(savePath.trim());
    if (!st.isDirectory()) return '保存路径不是一个目录，请重新选择';
    await access(savePath.trim(), constants.W_OK);
  } catch { return '保存目录不存在或不可写，请重新选择'; }
  return null;
}

function sanitizeExtra(extra) {
  if (extra === null || extra === undefined || extra === '') return null;
  if (typeof extra === 'object' && !Array.isArray(extra)) return Object.keys(extra).length ? extra : null;
  return undefined; // 非法形态:调用方转 400
}

// 表单入参校验(POST/PUT 共用)。返回 { error } 或 { value }。
async function validateBody(body) {
  const { name, protocol, baseURL, model, size, savePath } = body || {};
  if (!name || typeof name !== 'string' || !name.trim()) return { error: '名称必填' };
  if (!IMAGE_PROTOCOLS.includes(protocol)) return { error: `协议必须是 ${IMAGE_PROTOCOLS.join(' / ')}` };
  let url; try { url = new URL(baseURL); } catch { return { error: 'baseURL 非法' }; }
  if (!/^https?:$/.test(url.protocol)) return { error: 'baseURL 必须是 http(s)' };
  // SSRF 守卫(与文本 provider 同口径):server 会带存储的 apiKey 主动请求这个地址。
  try { await assertPublicBaseURL(baseURL); } catch (e) { return { error: e.message }; }
  if (!model || typeof model !== 'string' || !model.trim()) return { error: '模型必填' };
  const pathErr = await checkSavePath(savePath);
  if (pathErr) return { error: pathErr };
  const extra = sanitizeExtra(body?.extra);
  if (extra === undefined) return { error: '附加参数必须是 JSON 对象' };
  return {
    value: {
      name: name.trim(),
      protocol,
      baseURL: baseURL.trim().replace(/\/+$/, ''),
      model: model.trim(),
      size: typeof size === 'string' ? size.trim() : '',
      savePath: savePath.trim(),
      extra,
    },
  };
}

/** GET /api/image-providers — 列表(绝不含 apiKey)。 */
router.get('/image-providers', async (_req, res) => {
  res.json({ providers: (await readImageProviders()).map(publicView) });
});

/** POST /api/image-providers — 新增。 */
router.post('/image-providers', async (req, res) => {
  try {
    const { error, value } = await validateBody(req.body);
    if (error) return res.status(400).json({ error });
    const entry = {
      id: randomUUID(),
      ...value,
      apiKey: typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '',
    };
    const list = await readImageProviders();
    list.push(entry);
    await writeImageProviders(list);
    res.json({ ok: true, id: entry.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** PUT /api/image-providers/:id — 编辑。apiKey 留空 = 保留原 key(前端从不持有 key)。 */
router.put('/image-providers/:id', async (req, res) => {
  try {
    const list = await readImageProviders();
    const idx = list.findIndex((p) => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });
    const { error, value } = await validateBody(req.body);
    if (error) return res.status(400).json({ error });
    const apiKey = req.body?.apiKey;
    list[idx] = {
      ...list[idx],
      ...value,
      id: list[idx].id,
      apiKey: (typeof apiKey === 'string' && apiKey.trim()) ? apiKey.trim() : list[idx].apiKey,
    };
    await writeImageProviders(list);
    res.json({ ok: true, id: list[idx].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** DELETE /api/image-providers/:id — 删除(只删配置,不动已出的图)。 */
router.delete('/image-providers/:id', async (req, res) => {
  try {
    const list = await readImageProviders();
    const next = list.filter((p) => p.id !== req.params.id);
    if (next.length === list.length) return res.status(404).json({ error: 'not found' });
    await writeImageProviders(next);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 落盘:重名加序号(-1、-2……),不覆盖已有图。
async function saveImage(dir, baseName, buf) {
  const ext = extname(baseName);
  const stem = baseName.slice(0, baseName.length - ext.length);
  let name = baseName;
  for (let i = 1; existsSync(join(dir, name)); i++) name = `${stem}-${i}${ext}`;
  const full = join(dir, name);
  await writeFile(full, buf);
  return full;
}

/**
 * POST /api/image/generate { providerId, prompt } → 组请求 → 取图 → 落盘 → 预览。
 * 上游报错原文透传,但先经 redactKey 剥掉可能回显的密钥。
 */
router.post('/image/generate', async (req, res) => {
  const started = Date.now();
  try {
    const { providerId, prompt } = req.body || {};
    const provider = (await readImageProviders()).find((p) => p.id === providerId);
    if (!provider) return res.status(404).json({ error: '未找到该生图 provider' });
    const pathErr = await checkSavePath(provider.savePath);
    if (pathErr) return res.status(400).json({ error: pathErr });

    let spec;
    try { spec = buildImageRequest(provider, prompt); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    try { await assertPublicBaseURL(provider.baseURL); }
    catch (e) { return res.status(e.status || 400).json({ error: e.message }); }

    const post = (headers) => fetch(spec.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(spec.body),
      signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
    });
    let r;
    try { r = await post(spec.headers); }
    catch (e) {
      const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      return res.status(timedOut ? 504 : 502).json({
        error: timedOut ? '生成超时（120 秒），上游没有返回' : `连接上游失败：${redactKey(e.message, provider.apiKey)}`,
      });
    }
    // gemini 认证头按端点形态选(官方 x-goog-api-key / 中转站 Bearer),选错就 401/403
    // → 用另一种原样重试一次,而不是一刀切押一种。
    if (!r.ok && spec.altHeaders && (r.status === 401 || r.status === 403)) {
      try { r = await post(spec.altHeaders); } catch { /* 保留首次响应 */ }
    }
    const raw = await r.text().catch(() => '');
    const safeRaw = redactKey(raw, provider.apiKey).slice(0, MAX_UPSTREAM_ERR);
    if (!r.ok) return res.status(502).json({ error: `上游返回 ${r.status}：${safeRaw || '(空响应)'}` });

    let data;
    try { data = JSON.parse(raw); }
    catch { return res.status(502).json({ error: `上游响应不是 JSON：${safeRaw || '(空响应)'}` }); }
    const picked = extractImage(provider.protocol, data);
    if (!picked) return res.status(502).json({ error: `上游响应里没有找到图片：${safeRaw.slice(0, 300)}` });

    let buf; let mime = picked.mime || '';
    if (picked.base64) {
      buf = Buffer.from(picked.base64, 'base64');
    } else {
      let img;
      try { img = await fetch(picked.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) }); }
      catch (e) { return res.status(502).json({ error: `下载生成的图片失败：${redactKey(e.message, provider.apiKey)}` }); }
      if (!img.ok) return res.status(502).json({ error: `下载生成的图片失败：HTTP ${img.status}` });
      const ct = img.headers.get('content-type') || '';
      // 上游可能回一个网页/错误页而不是图 —— 落盘成 .png 只会让用户看到坏图。
      if (!/^image\//i.test(ct) && !IMAGE_CONTENT_TYPES[extname(new URL(picked.url).pathname).slice(1).toLowerCase()]) {
        return res.status(502).json({ error: `上游返回的链接不是图片（Content-Type: ${ct || '未知'}）` });
      }
      mime = /^image\//i.test(ct) ? ct : `image/${extname(new URL(picked.url).pathname).slice(1).toLowerCase()}`;
      buf = Buffer.from(await img.arrayBuffer());
    }
    if (!buf.length) return res.status(502).json({ error: '上游返回了空图片' });

    let file;
    try { file = await saveImage(provider.savePath, buildImageFileName(prompt, imageExtFromMime(mime)), buf); }
    catch { return res.status(400).json({ error: '保存目录不存在或不可写，请重新选择' }); }
    res.json({
      ok: true,
      file,
      previewUrl: `/api/image/preview?file=${encodeURIComponent(file)}`,
      bytes: buf.length,
      tookMs: Date.now() - started,
    });
  } catch (err) {
    // 兜底也要剥 key:异常消息可能带上 URL/头部回显。
    res.status(500).json({ error: redactKey(err.message, null) });
  }
});

/**
 * GET /api/image/preview?file=<abs> — 回源图片给前端预览。
 * 只允许读【已配置 provider 的 savePath 之下】的图片:拒 `..` 段 + resolve 后前缀比对
 * + 扩展名白名单(见 resolvePreviewPath),防路径穿透读到 ~/.ssh 之类。
 */
router.get('/image/preview', async (req, res) => {
  const list = await readImageProviders();
  const full = resolvePreviewPath(String(req.query.file || ''), list.map((p) => p.savePath));
  if (!full) return res.status(400).json({ error: '非法的预览路径' });
  try { await stat(full); } catch { return res.status(404).json({ error: '文件不存在（可能已被移动或删除）' }); }
  const ext = extname(full).slice(1).toLowerCase();
  res.setHeader('Content-Type', IMAGE_CONTENT_TYPES[ext] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  // dotfiles:'allow' —— 保存目录路径里可能有点开头的目录段(sendFile 默认整条拒)。
  res.sendFile(full, { dotfiles: 'allow' });
});

/**
 * POST /api/image/reveal { file } — 在访达/资源管理器里定位刚出的图。
 * 与预览同一道闸(resolvePreviewPath):只认 savePath 之下的图片,不接受任意路径。
 * 远程/手机访问时作用在【跑 server 的那台机器】(同 /api/reveal-path 的既有预期)。
 */
router.post('/image/reveal', async (req, res) => {
  const list = await readImageProviders();
  const full = resolvePreviewPath(String(req.body?.file || ''), list.map((p) => p.savePath));
  if (!full) return res.status(400).json({ error: '非法的文件路径' });
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileP = promisify(execFile);
    let cmd, args;
    if (process.platform === 'darwin') { cmd = 'open'; args = ['-R', full]; }
    else if (process.platform === 'win32') { cmd = 'explorer'; args = [`/select,${full}`]; }
    else { cmd = 'xdg-open'; args = [full.slice(0, full.lastIndexOf('/'))]; }
    // explorer 成功也常以非零码退出(Windows 三坑),不当失败。
    try { await execFileP(cmd, args, { timeout: 10000 }); }
    catch (e) { if (process.platform !== 'win32') throw e; }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
