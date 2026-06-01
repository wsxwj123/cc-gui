import { Router } from 'express';
import { readdir, stat, readFile, realpath, writeFile } from 'fs/promises';
import { createReadStream } from 'fs';
import { join, resolve, relative, extname, isAbsolute } from 'path';
import { homedir, platform } from 'os';
import { execFile } from 'child_process';
import { isPathInside } from '../utils/safe-path.js';

const router = Router();

const HOME = homedir();
const MAX_PREVIEW_BYTES = 256 * 1024; // 256KB cap for the read endpoint

// Extension → MIME for the raw byte endpoint (image/video/audio/pdf preview).
const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/x-m4v',
  ogg: 'video/ogg', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4',
  pdf: 'application/pdf',
};

// Skip patterns — directories/files that explode the tree or just add noise.
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.cache', '__pycache__', '.venv', 'venv', '.idea', '.vscode']);
const SKIP_EXACT = new Set(['.DS_Store']);

/**
 * Resolve+validate a user-provided path. Must be ABSOLUTE and resolve
 * (after realpath) under HOME — anything else is rejected. Returns the
 * realpath on success, throws on rejection.
 */
async function safePath(p) {
  // isAbsolute is platform-aware (accepts /unix and C:\windows).
  if (typeof p !== 'string' || !isAbsolute(p)) {
    const err = new Error('absolute path required'); err.status = 400; throw err;
  }
  const real = await realpath(resolve(p)).catch(() => null);
  if (!real) { const err = new Error('not found'); err.status = 404; throw err; }
  // Must be HOME itself or a path UNDER it. isPathInside uses path.relative so it
  // handles the separator per-OS and isn't fooled by '/Users/alice2'.startsWith(
  // '/Users/alice').
  if (!isPathInside(real, HOME)) {
    const err = new Error('outside $HOME'); err.status = 403; throw err;
  }
  return real;
}

/**
 * GET /api/files/list?path=<absolute-dir>
 * Returns immediate-children entries with stat info. Directories first,
 * then files alphabetically. Skip-list applied.
 */
router.get('/files/list', async (req, res) => {
  try {
    const real = await safePath(req.query.path);
    const st = await stat(real);
    if (!st.isDirectory()) return res.status(400).json({ error: 'not a directory' });

    const raw = await readdir(real, { withFileTypes: true });
    const entries = [];
    for (const e of raw) {
      if (SKIP_EXACT.has(e.name)) continue;
      if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
      const full = join(real, e.name);
      let s;
      try { s = await stat(full); } catch { continue; }
      entries.push({
        name: e.name,
        path: full,
        isDir: s.isDirectory(),
        size: s.size,
        mtimeMs: s.mtimeMs,
      });
    }
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    res.json({ path: real, entries });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * GET /api/files/read?path=<absolute-file>
 * Returns up to 256KB of the file as utf-8, plus stat metadata. Binary
 * detection (NUL byte in first 4KB) → returns { binary: true } without body.
 */
router.get('/files/read', async (req, res) => {
  try {
    const real = await safePath(req.query.path);
    const st = await stat(real);
    if (st.isDirectory()) return res.status(400).json({ error: 'not a file' });

    // raw=1 → stream the actual bytes (images/video/audio/pdf preview), not JSON.
    if (req.query.raw === '1') {
      const e = extname(real).slice(1).toLowerCase();
      res.setHeader('Content-Type', MIME[e] || 'application/octet-stream');
      res.setHeader('Content-Length', st.size);
      res.setHeader('Cache-Control', 'no-cache');
      const stream = createReadStream(real);
      // Content-Length/200 are already flushed, so we can't switch to 500 mid-
      // stream. Destroy the socket instead — the client sees a truncated body +
      // aborted connection rather than a silently-incomplete 200.
      stream.on('error', () => { res.headersSent ? res.destroy() : res.status(500).end(); });
      return stream.pipe(res);
    }

    if (st.size === 0) {
      return res.json({ path: real, size: 0, content: '', truncated: false, binary: false });
    }

    // Read first MAX_PREVIEW_BYTES; sniff for binary by NUL byte.
    const buf = Buffer.alloc(Math.min(st.size, MAX_PREVIEW_BYTES));
    const fd = await (await import('node:fs/promises')).open(real, 'r');
    let bytesRead = 0;
    try {
      const r = await fd.read(buf, 0, buf.length, 0);
      bytesRead = r.bytesRead;
    } finally {
      await fd.close();
    }
    const head = buf.subarray(0, Math.min(bytesRead, 4096));
    const isBinary = head.includes(0);
    if (isBinary) {
      return res.json({ path: real, size: st.size, binary: true, truncated: bytesRead < st.size });
    }
    const content = buf.subarray(0, bytesRead).toString('utf-8');
    res.json({
      path: real,
      size: st.size,
      content,
      truncated: bytesRead < st.size,
      binary: false,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * POST /api/files/open  { path }
 * Open a file/dir with the OS default application (Finder/Explorer's
 * double-click behaviour). On macOS/Linux the path is a plain argv element to
 * `open`/`xdg-open` (no shell). On Windows `cmd /c start` IS parsed by cmd.exe,
 * so a HOME-internal filename containing cmd metachars (& | < > ^ ") could
 * inject — reject those before launching.
 */
router.post('/files/open', async (req, res) => {
  try {
    const real = await safePath(req.body?.path);
    const os = platform();
    let cmd, args;
    if (os === 'darwin') { cmd = 'open'; args = [real]; }
    else if (os === 'win32') {
      if (/[&|<>^"]/.test(real)) { const e = new Error('unsafe path for Windows open'); e.status = 400; throw e; }
      cmd = 'cmd'; args = ['/c', 'start', '', real];
    }
    else { cmd = 'xdg-open'; args = [real]; }
    execFile(cmd, args, (err) => {
      // execFile already returned to the event loop; the response was sent
      // optimistically below. Log failures only.
      if (err) console.error('[files/open]', err.message);
    });
    res.json({ ok: true, path: real });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * PUT /api/files/write  { path, content }
 * Overwrite an EXISTING text file under $HOME. safePath() requires the path to
 * already resolve (realpath), so this never creates new files or follows a
 * symlink outside $HOME. Size-capped to match the read endpoint's intent.
 */
const MAX_WRITE_BYTES = 5 * 1024 * 1024; // 5MB
router.put('/files/write', async (req, res) => {
  try {
    const { path: p, content } = req.body || {};
    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'content (string) required' });
    }
    if (Buffer.byteLength(content, 'utf-8') > MAX_WRITE_BYTES) {
      return res.status(413).json({ error: 'file too large to save (>5MB)' });
    }
    const real = await safePath(p);
    const st = await stat(real);
    if (st.isDirectory()) return res.status(400).json({ error: 'not a file' });
    await writeFile(real, content, 'utf-8');
    const after = await stat(real);
    res.json({ ok: true, path: real, size: after.size });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;
