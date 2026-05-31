import { Router } from 'express';
import { writeFile, mkdir } from 'fs/promises';
import { extname, join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const router = Router();

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
};

const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'log', 'json', 'jsonl',
  'js', 'jsx', 'ts', 'tsx', 'css', 'html', 'htm', 'xml',
  'yaml', 'yml', 'toml', 'ini', 'env', 'sh', 'bash', 'zsh',
  'py', 'rb', 'go', 'rs', 'java', 'c', 'cc', 'cpp', 'h', 'hpp',
  'sql',
]);

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
router.post('/upload', async (req, res) => {
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
