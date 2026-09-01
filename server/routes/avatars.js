import { Router } from 'express';
import { mkdir, unlink, stat, writeFile } from 'fs/promises';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { extname, join } from 'path';
import { randomUUID } from 'crypto';
import { AVATAR_DIR, avatarFilePath, assertPublicBaseURL } from './settings.js';

// r78:provider 头像的图片落地。两种来源、同一个落点:
//   ① 本地文件:原始字节流 POST(同 backgrounds.js / upload.js 的路径,不引 multipart 依赖),
//      原始文件名经 x-upload-name 头传入,只用于取扩展名;
//   ② 图片 URL:后端抓取【一次】落地,存的是本地文件名。
// **绝不存 URL 本身**:热链 = 每条消息向第三方发一次请求(暴露使用行为、可被追踪)、
// 对方删图就裂、离线空白。用户要的是"粘 URL 的便利",不是"运行时依赖外站"。
const router = Router();

const MAX_BYTES = 1024 * 1024;      // 1MB。头像不是壁纸(backgrounds 的 50MB 不适用)
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 2;

// 允许的图片类型。刻意不含 svg —— SVG 可内嵌脚本,头像不需要矢量。
const TYPE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const EXT_TYPE = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

const httpError = (msg, status = 400) => Object.assign(new Error(msg), { status });

/** content-type → 扩展名;不在白名单返回 null。上传与抓取共用同一判据。 */
export function pickImageExt(contentType) {
  const t = String(contentType || '').split(';')[0].trim().toLowerCase();
  return TYPE_EXT[t] || null;
}

/**
 * 抓取前的地址校验。两道:
 *   ① 协议白名单 —— file: / data: / ftp: 一律拒(file: 能读本机任意文件);
 *   ② SSRF —— 复用 provider baseURL 那套判定(allowLoopback:false),主机名【解析后】
 *      落在 127./10./172.16-31./192.168./169.254/::1/fc00::/localhost 等私网一律拒,
 *      http 也拒(公网图片走 https)。每一次重定向跳转都要重跑本函数:跳进内网是
 *      SSRF 最经典的绕过手法。
 */
export async function assertFetchableImageUrl(raw) {
  let url;
  try { url = new URL(String(raw || '')); } catch { throw httpError('图片地址非法'); }
  if (!/^https?:$/.test(url.protocol)) throw httpError(`地址被拒绝:不支持的协议 ${url.protocol}（仅允许 https）`);
  // http 在这里就断掉,不落到下游那条以"防明文密钥外泄"为由的文案(对图片不成立)。
  // 本机/内网地址通常正是以 http 出现,这条同时是 SSRF 防线的第一段。
  if (url.protocol !== 'https:') throw httpError('地址被拒绝:图片必须走 https（http 不抓,本机与内网地址一律拒绝)');
  try {
    await assertPublicBaseURL(url.href, { allowLoopback: false });
  } catch (e) {
    throw httpError(`地址被拒绝:${String(e.message || '').replace(/baseURL\s*/g, '')}`, e.status || 400);
  }
  return url;
}

/** 抓取一张图片,返回 { buf, ext }。超时/超限/类型不符/重定向过多都抛 httpError。 */
async function fetchImage(rawUrl) {
  let url = await assertFetchableImageUrl(rawUrl);
  let resp;
  for (let hop = 0; ; hop++) {
    resp = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'image/png,image/jpeg,image/webp' },
    }).catch((e) => { throw httpError(e.name === 'TimeoutError' ? '抓取超时（10 秒）' : `抓取失败:${e.message}`); });
    const loc = resp.status >= 300 && resp.status < 400 ? resp.headers.get('location') : null;
    if (!loc) break;
    await resp.body?.cancel().catch(() => {});
    if (hop >= MAX_REDIRECTS) throw httpError(`重定向超过 ${MAX_REDIRECTS} 次`);
    url = await assertFetchableImageUrl(new URL(loc, url).href);
  }
  if (!resp.ok) { await resp.body?.cancel().catch(() => {}); throw httpError(`抓取失败:HTTP ${resp.status}`); }
  const ct = resp.headers.get('content-type');
  const ext = pickImageExt(ct);
  if (!ext) { await resp.body?.cancel().catch(() => {}); throw httpError(`不支持的图片类型:${ct || '(未声明)'}（允许 png / jpeg / webp）`); }
  if (Number(resp.headers.get('content-length') || 0) > MAX_BYTES) {
    await resp.body?.cancel().catch(() => {});
    throw httpError('图片超过 1MB 上限', 413);
  }
  // content-length 可伪造/缺失,边读边数。1MB 封顶,整块进内存无风险。
  const chunks = [];
  let bytes = 0;
  for await (const c of resp.body) {
    bytes += c.length;
    if (bytes > MAX_BYTES) throw httpError('图片超过 1MB 上限', 413);
    chunks.push(c);
  }
  return { buf: Buffer.concat(chunks), ext };
}

/**
 * POST /api/provider-avatar
 *   · Content-Type: application/json + { url } → 后端抓取一次落地
 *   · 其余                                    → 原始字节流上传(x-upload-name 取扩展名)
 * 返回 { file, url }。file 就是存进 custom-providers.json 的 avatar 值。
 */
router.post('/provider-avatar', async (req, res) => {
  try {
    await mkdir(AVATAR_DIR, { recursive: true });
    if (/^application\/json/i.test(req.headers['content-type'] || '')) {
      const { buf, ext } = await fetchImage(req.body?.url);
      const filename = `${randomUUID()}.${ext}`;
      await writeFile(join(AVATAR_DIR, filename), buf);
      return res.json({ file: filename, url: `/api/provider-avatars/${filename}`, bytes: buf.length });
    }
    const upName = decodeURIComponent(String(req.headers['x-upload-name'] || ''));
    const rawExt = extname(upName).slice(1).toLowerCase();
    const ext = rawExt === 'jpeg' ? 'jpg' : rawExt;
    if (!EXT_TYPE[ext]) throw httpError(`不支持的文件类型:.${rawExt || '(无扩展名)'}（允许 png / jpg / jpeg / webp）`);
    if (Number(req.headers['content-length'] || 0) > MAX_BYTES) throw httpError('图片超过 1MB 上限', 413);
    const filename = `${randomUUID()}.${ext}`;
    const fullPath = join(AVATAR_DIR, filename);
    // content-length 可伪造/缺失,流式写入过程中再实测一次字节数(同 backgrounds.js)。
    let bytes = 0, aborted = false;
    req.on('data', (c) => {
      bytes += c.length;
      if (bytes > MAX_BYTES && !aborted) { aborted = true; req.destroy(httpError('图片超过 1MB 上限', 413)); }
    });
    try {
      await pipeline(req, createWriteStream(fullPath));
    } catch (err) {
      await unlink(fullPath).catch(() => {}); // 半截文件清掉
      throw err;
    }
    res.json({ file: filename, url: `/api/provider-avatars/${filename}`, bytes });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || '保存失败' });
  }
});

/** GET /api/provider-avatars/:name — 回源头像文件。文件名白名单 + isPathInside 防穿越。 */
router.get('/provider-avatars/:name', async (req, res) => {
  const full = avatarFilePath(req.params.name);
  if (!full) return res.status(400).json({ error: 'invalid filename' });
  try { await stat(full); } catch { return res.status(404).json({ error: 'not found' }); }
  res.setHeader('Content-Type', EXT_TYPE[extname(full).slice(1).toLowerCase()] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); // 名字是 uuid,内容不可变
  // dotfiles:'allow' 必须显式给 —— 路径里的 `.claude-gui` 段会命中 sendFile 默认的
  // dotfiles:'ignore',明明存在也 404(backgrounds.js 踩过)。
  res.sendFile(full, { dotfiles: 'allow' });
});

export default router;
