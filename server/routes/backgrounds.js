import { Router } from 'express';
import { mkdir, unlink, stat } from 'fs/promises';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { extname, join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { isPathInside } from '../utils/safe-path.js';

const router = Router();

// 对话区自定义背景的存储目录。文件名由服务端生成(uuid.ext),客户端只持有文件名。
const BG_DIR = join(homedir(), '.claude-gui', 'backgrounds');

// 扩展名白名单:图片 + 视频。上传与回源共用同一套判定。
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const VIDEO_EXTS = new Set(['mp4', 'webm']);
const MAX_BYTES = 50 * 1024 * 1024; // 50MB 上限

// 回源/删除时的文件名白名单:uuid 生成的名字只含 [A-Za-z0-9-],扩展名限白名单。
// 正则本身排除了路径分隔符与 `..`,isPathInside 再兜底一层防穿越。
const NAME_RE = /^[A-Za-z0-9-]+\.(png|jpe?g|gif|webp|mp4|webm)$/;

const CONTENT_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm',
};

// 校验并解析文件名 → 绝对路径;非法返回 null。
function resolveBgPath(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) return null;
  const full = join(BG_DIR, name);
  if (!isPathInside(full, BG_DIR)) return null;
  return full;
}

/**
 * POST /api/backgrounds
 * 原始字节流上传(同 upload.js 的流式路径):body 即文件内容,
 * 原始文件名经 x-upload-name 头传入,仅用于取扩展名。
 * 返回 { file, url, kind, bytes }。
 */
router.post('/backgrounds', async (req, res) => {
  try {
    const name = decodeURIComponent(String(req.headers['x-upload-name'] || ''));
    const ext = extname(name).slice(1).toLowerCase();
    if (!IMAGE_EXTS.has(ext) && !VIDEO_EXTS.has(ext)) {
      return res.status(400).json({ error: `不支持的文件类型:.${ext || '(无扩展名)'}。允许:png/jpg/jpeg/gif/webp/mp4/webm` });
    }
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_BYTES) {
      return res.status(413).json({ error: '文件超过 50MB 上限' });
    }
    await mkdir(BG_DIR, { recursive: true });
    const filename = `${randomUUID()}.${ext}`;
    const fullPath = join(BG_DIR, filename);
    // content-length 可伪造/缺失,流式写入过程中再实测一次字节数。
    let bytes = 0, aborted = false;
    req.on('data', (c) => {
      bytes += c.length;
      if (bytes > MAX_BYTES && !aborted) { aborted = true; req.destroy(new Error('文件超过 50MB 上限')); }
    });
    try {
      await pipeline(req, createWriteStream(fullPath));
    } catch (err) {
      await unlink(fullPath).catch(() => {}); // 半截文件清掉
      throw err;
    }
    res.json({
      file: filename,
      url: `/api/backgrounds/${filename}`,
      kind: VIDEO_EXTS.has(ext) ? 'video' : 'image',
      bytes,
    });
  } catch (err) {
    const tooBig = /50MB/.test(err.message || '');
    res.status(tooBig ? 413 : 500).json({ error: err.message || '上传失败' });
  }
});

/** GET /api/backgrounds/:name — 回源背景文件。文件名白名单 + isPathInside 防穿越。 */
router.get('/backgrounds/:name', async (req, res) => {
  const full = resolveBgPath(req.params.name);
  if (!full) return res.status(400).json({ error: 'invalid filename' });
  try {
    await stat(full);
  } catch {
    return res.status(404).json({ error: 'not found' });
  }
  const ext = extname(full).slice(1).toLowerCase();
  res.setHeader('Content-Type', CONTENT_TYPES[ext] || 'application/octet-stream');
  // 文件名是 uuid、内容不可变,允许长缓存。
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  // dotfiles:'allow' 必须显式给——路径里的 `.claude-gui` 目录段会命中 sendFile
  // 默认的 dotfiles:'ignore' 规则,整条路径被当点文件拒绝,明明存在也 404。
  res.sendFile(full, { dotfiles: 'allow' });
});

/** DELETE /api/backgrounds/:name — 删除背景文件(前端换背景/恢复默认时清理)。 */
router.delete('/backgrounds/:name', async (req, res) => {
  const full = resolveBgPath(req.params.name);
  if (!full) return res.status(400).json({ error: 'invalid filename' });
  try {
    await unlink(full);
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'ENOENT') return res.json({ ok: true }); // 已不存在视为删除成功
    res.status(500).json({ error: err.message });
  }
});

export default router;
