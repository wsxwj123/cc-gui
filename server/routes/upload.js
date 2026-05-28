import { Router } from 'express';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const router = Router();

// Match common image MIMEs we accept from drag/paste. Restrict to images for now —
// the goal is "drop a screenshot for Claude to see", not arbitrary file upload.
const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
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
    const match = dataUrl.match(/^data:([^;,]+)(?:;base64)?,(.+)$/);
    if (!match) return res.status(400).json({ error: 'invalid data URL' });
    const mime = match[1];
    const ext = MIME_EXT[mime];
    if (!ext) return res.status(415).json({ error: `unsupported mime: ${mime}` });
    const buf = Buffer.from(match[2], 'base64');
    if (buf.length > 24 * 1024 * 1024) {
      return res.status(413).json({ error: 'file too large (>24MB)' });
    }
    await mkdir(UPLOAD_DIR, { recursive: true });
    const filename = `${randomUUID()}.${ext}`;
    const fullPath = join(UPLOAD_DIR, filename);
    await writeFile(fullPath, buf);
    res.json({ path: fullPath, url: fullPath, bytes: buf.length, mime });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
