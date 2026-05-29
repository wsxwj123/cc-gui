import { Router } from 'express';
import { realpath } from 'fs/promises';
import { resolve } from 'path';
import { homedir } from 'os';
import * as pty from 'node-pty';

const router = Router();
const HOME = homedir();
// Claude session ids are UUIDs.
const UUID_RE = /^[0-9a-fA-F-]{36}$/;

/**
 * Active remote-control sessions, keyed by sessionId.
 * Each entry: { term, startedAt, cwd }
 *
 * We host `claude --remote-control --resume <id>` on a hidden pseudo-terminal
 * (node-pty) — exactly how Claude Desktop does it: the process needs isatty()
 * to be true to enter interactive mode and register with Anthropic's relay, but
 * it does NOT need a visible terminal window. Control is relayed through
 * Anthropic (no tunnel/auth exposed from this machine); the GUI keeps showing
 * the session by watching the same on-disk jsonl.
 *
 * IMPORTANT: while an RC session is live, the GUI must NOT spawn `-p` turns for
 * the same sessionId (both would write the same jsonl → corruption). The client
 * locks the composer and shows a "reclaim control" banner.
 */
const active = new Map();

function statusOf(sessionId) {
  const e = active.get(sessionId);
  return e ? { active: true, startedAt: e.startedAt, cwd: e.cwd } : { active: false };
}

// POST /api/remote-control  { sessionId, cwd } — start (or return existing) RC session.
router.post('/remote-control', async (req, res) => {
  try {
    const { sessionId, cwd } = req.body || {};
    if (!UUID_RE.test(String(sessionId || ''))) throw new Error('invalid sessionId');

    if (active.has(sessionId)) {
      return res.json({ ok: true, sessionId, ...statusOf(sessionId), reused: true });
    }

    let dir = HOME;
    if (cwd) {
      const real = await realpath(resolve(cwd)).catch(() => null);
      if (!real || !real.startsWith(HOME)) throw new Error('cwd outside $HOME');
      dir = real;
    }

    // Run through a login shell so `claude` resolves via the user's full PATH
    // (Homebrew shim, version-manager shims, etc.) — spawning the bare name with
    // node-pty fails ("posix_spawnp failed") when the server's inherited PATH is
    // narrower than the login shell's. sessionId is UUID-validated, so it is
    // safe to interpolate; cwd is passed via the pty option (no interpolation).
    const shell = process.env.SHELL || '/bin/bash';
    const term = pty.spawn(shell, ['-lc', `claude --remote-control --resume ${sessionId}`], {
      name: 'xterm-color',
      cols: 100,
      rows: 30,
      cwd: dir,
      env: process.env,
    });

    const entry = { term, startedAt: Date.now(), cwd: dir };
    active.set(sessionId, entry);

    // Drain output so the pty buffer never blocks; we don't render it anywhere.
    term.onData(() => {});
    term.onExit(() => { active.delete(sessionId); });

    res.json({ ok: true, sessionId, ...statusOf(sessionId) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/remote-control/stop  { sessionId } — reclaim control (kill RC pty).
router.post('/remote-control/stop', (req, res) => {
  try {
    const { sessionId } = req.body || {};
    if (!UUID_RE.test(String(sessionId || ''))) throw new Error('invalid sessionId');
    const e = active.get(sessionId);
    if (e) {
      try { e.term.kill(); } catch {}
      active.delete(sessionId);
    }
    res.json({ ok: true, sessionId, active: false });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/remote-control?sessionId=...  — single status; or list all active ids.
router.get('/remote-control', (req, res) => {
  const { sessionId } = req.query || {};
  if (sessionId) return res.json({ sessionId, ...statusOf(String(sessionId)) });
  res.json({ active: [...active.keys()] });
});

export default router;
