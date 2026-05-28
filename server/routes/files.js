import { Router } from 'express';
import { readdir, stat, readFile, realpath } from 'fs/promises';
import { join, resolve, relative } from 'path';
import { homedir } from 'os';

const router = Router();

const HOME = homedir();
const MAX_PREVIEW_BYTES = 256 * 1024; // 256KB cap for the read endpoint

// Skip patterns — directories/files that explode the tree or just add noise.
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.cache', '__pycache__', '.venv', 'venv', '.idea', '.vscode']);
const SKIP_EXACT = new Set(['.DS_Store']);

/**
 * Resolve+validate a user-provided path. Must be ABSOLUTE and resolve
 * (after realpath) under HOME — anything else is rejected. Returns the
 * realpath on success, throws on rejection.
 */
async function safePath(p) {
  if (typeof p !== 'string' || !p.startsWith('/')) {
    const err = new Error('absolute path required'); err.status = 400; throw err;
  }
  const real = await realpath(resolve(p)).catch(() => null);
  if (!real) { const err = new Error('not found'); err.status = 404; throw err; }
  if (!real.startsWith(HOME)) {
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

export default router;
