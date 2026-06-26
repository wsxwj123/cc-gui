import { Router } from 'express';
import { writeFile, mkdir, readdir, stat, unlink } from 'fs/promises';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { extname, join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const router = Router();

// C5:上传附件落 tmp/cgui-attachments 后从无清理,长期反复拖图会无限堆积。
// 定期清掉 7 天前的旧附件(够久,不会误删当前会话仍在引用的缩略图),启动跑一次 + 每 6h。
const UPLOAD_TTL_MS = 7 * 24 * 3600 * 1000;
async function sweepOldUploads() {
  try {
    const dir = join(tmpdir(), 'cgui-attachments');
    const files = await readdir(dir);
    const now = Date.now();
    for (const f of files) {
      const p = join(dir, f);
      try { const s = await stat(p); if (now - s.mtimeMs > UPLOAD_TTL_MS) await unlink(p); } catch {}
    }
  } catch {}
}
sweepOldUploads();
setInterval(sweepOldUploads, 6 * 3600 * 1000).unref();

const MIME_TYPES = {
  'image/png': { ext: 'png', kind: 'image' },
  'image/jpeg': { ext: 'jpg', kind: 'image' },
  'image/gif': { ext: 'gif', kind: 'image' },
  'image/webp': { ext: 'webp', kind: 'image' },
  'image/heic': { ext: 'heic', kind: 'image' },
  'text/plain': { ext: 'txt', kind: 'text' },
  'text/markdown': { ext: 'md', kind: 'text' },
  'text/csv': { ext: 'csv', kind: 'text' },
  'text/tab-separated-values': { ext: 'tsv', kind: 'text' },
  'text/html': { ext: 'html', kind: 'text' },
  'text/css': { ext: 'css', kind: 'text' },
  'text/xml': { ext: 'xml', kind: 'text' },
  'application/json': { ext: 'json', kind: 'text' },
  'application/x-ndjson': { ext: 'jsonl', kind: 'text' },
  'application/xml': { ext: 'xml', kind: 'text' },
  'application/javascript': { ext: 'js', kind: 'text' },
  'application/yaml': { ext: 'yaml', kind: 'text' },
  'application/x-yaml': { ext: 'yaml', kind: 'text' },
  'application/pdf': { ext: 'pdf', kind: 'file' },
  'application/msword': { ext: 'doc', kind: 'file' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { ext: 'docx', kind: 'file' },
  'application/vnd.ms-excel': { ext: 'xls', kind: 'file' },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { ext: 'xlsx', kind: 'file' },
  'application/vnd.ms-powerpoint': { ext: 'ppt', kind: 'file' },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': { ext: 'pptx', kind: 'file' },
};

const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'log', 'json', 'jsonl',
  'js', 'jsx', 'ts', 'tsx', 'css', 'html', 'htm', 'xml',
  'yaml', 'yml', 'toml', 'ini', 'env', 'sh', 'bash', 'zsh',
  'py', 'rb', 'go', 'rs', 'java', 'c', 'cc', 'cpp', 'h', 'hpp',
  'sql',
]);
const FILE_EXTS = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx']);

function resolveUploadType(mime, name) {
  const ext = extname(name || '').slice(1).toLowerCase();
  const mapped = MIME_TYPES[mime];
  if (mapped) {
    if (mapped.kind === 'text' && TEXT_EXTS.has(ext)) return { ...mapped, ext };
    return mapped;
  }
  if (mime && mime.startsWith('text/')) {
    return { ext: TEXT_EXTS.has(ext) ? ext : 'txt', kind: 'text' };
  }
  if ((mime === 'application/octet-stream' || !mime) && TEXT_EXTS.has(ext)) {
    return { ext, kind: 'text' };
  }
  if ((mime === 'application/octet-stream' || !mime) && FILE_EXTS.has(ext)) {
    return { ext, kind: 'file' };
  }
  return null;
};

// Per-process upload root. tmpdir() is /tmp on macOS — Claude CLI can read it
// (project cwd is unrelated; absolute paths in prompts work fine).
const UPLOAD_DIR = join(tmpdir(), 'cgui-attachments');

/**
 * POST /api/upload
 * Body: { dataUrl: "data:image/png;base64,...", name?: "screenshot.png" }
 * Returns: { path: "/tmp/cgui-attachments/<uuid>.png", url: same, bytes }
 *
 * Express's default JSON limit is 100kb — bumped to 25mb on the route below.
 */
// CN-3:大文件上传报 "entity too large" 根因——前端把文件转 base64 dataUrl 塞进 JSON,
// base64 膨胀 ~33%,撞上全局 `express.json({limit:'25mb'})`(且全量进内存)。修:非 JSON 请求
// 走**原始字节流式上传**——前端直接把 File 当 body 发(Content-Type 非 json),express.json 不解析、
// 不受 25mb 限,这里流式写盘(低内存),仅设一个宽松硬上限防撑爆磁盘。JSON dataUrl 老路保留兼容粘贴。
const RAW_MAX = 500 * 1024 * 1024; // 500MB 硬上限
router.post('/upload', async (req, res) => {
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  if (!ct.includes('application/json')) {
    try {
      const name = decodeURIComponent(String(req.headers['x-upload-name'] || 'file'));
      const mime = (ct.split(';')[0] || '').trim() || 'application/octet-stream';
      const uploadType = resolveUploadType(mime, name);
      if (!uploadType) return res.status(415).json({ error: `unsupported mime: ${mime || '(none)'}` });
      await mkdir(UPLOAD_DIR, { recursive: true });
      const filename = `${randomUUID()}.${uploadType.ext}`;
      const fullPath = join(UPLOAD_DIR, filename);
      let bytes = 0, aborted = false;
      req.on('data', (c) => {
        bytes += c.length;
        if (bytes > RAW_MAX && !aborted) { aborted = true; req.destroy(new Error('file too large (>500MB)')); }
      });
      await pipeline(req, createWriteStream(fullPath));
      return res.json({ path: fullPath, url: fullPath, bytes, mime, kind: uploadType.kind });
    } catch (err) {
      const tooBig = /too large/i.test(err.message || '');
      return res.status(tooBig ? 413 : 500).json({ error: err.message || '上传失败' });
    }
  }
  try {
    const dataUrl = req.body?.dataUrl;
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
      return res.status(400).json({ error: 'dataUrl (base64) required' });
    }
    // Header can carry params (`text/plain;charset=utf-8;base64`) or be empty
    // (`data:;base64,...` for unknown-type files), so split on the first comma
    // and parse the header rather than demand a strict shape.
    const match = dataUrl.match(/^data:([^,]*),(.+)$/);
    if (!match) return res.status(400).json({ error: 'invalid data URL' });
    const header = match[1];
    const isBase64 = /;base64$/i.test(header);
    const mime = header.replace(/;base64$/i, '').split(';')[0].trim().toLowerCase();
    const uploadType = resolveUploadType(mime, req.body?.name);
    if (!uploadType) return res.status(415).json({ error: `unsupported mime: ${mime || '(none)'}` });
    const buf = isBase64
      ? Buffer.from(match[2], 'base64')
      : Buffer.from(decodeURIComponent(match[2]), 'utf8');
    if (buf.length > 24 * 1024 * 1024) {
      return res.status(413).json({ error: 'file too large (>24MB)' });
    }
    await mkdir(UPLOAD_DIR, { recursive: true });
    const filename = `${randomUUID()}.${uploadType.ext}`;
    const fullPath = join(UPLOAD_DIR, filename);
    await writeFile(fullPath, buf);
    res.json({ path: fullPath, url: fullPath, bytes: buf.length, mime, kind: uploadType.kind });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
