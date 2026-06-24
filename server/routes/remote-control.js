import { Router } from 'express';
import { realpath } from 'fs/promises';
import { resolve } from 'path';
import { homedir } from 'os';

// node-pty 是本 server 唯一的原生模块,其 .node 二进制按「构建时的 Node ABI」编译。
// 打包发布时(CI Node 20)编译进 bundle,但 app 运行时 spawn 的是用户机器上「任意版本」
// 的系统 node;大版本不一致时 require 会抛 NODE_MODULE_VERSION 不匹配。它只服务「手机
// 远程控制」这一个可选功能,绝不该让整个后端在启动(顶层静态 import)就被它带崩——这正是
// 「另一台 Windows 上后端起不来 / did not accept connections」的根因。改惰性加载:首次用到
// 才 import,失败只让本功能返回错误,server 照常启动。
let _ptyPromise;
function loadPty() {
  if (!_ptyPromise) {
    _ptyPromise = import('node-pty').then((m) => m.default?.spawn ? m.default : m).catch((e) => {
      _ptyPromise = undefined; // 不缓存失败,允许后续重试
      throw new Error(`node-pty 加载失败,手机远程控制不可用(其余功能正常):${e.message}`);
    });
  }
  return _ptyPromise;
}

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

// Kill every hosted RC pty. Without this, a server restart (Ctrl+C / crash)
// leaves the `claude --remote-control` children orphaned — they keep writing
// the session jsonl, and since the in-memory Map is gone, re-activating the
// same sessionId spawns a SECOND writer → corruption. Registered once.
function killAll() {
  for (const e of active.values()) { try { e.term.kill(); } catch {} }
  active.clear();
}
process.once('exit', killAll);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => { killAll(); process.exit(0); });
}

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
      // HOME itself or a path under it. Bare startsWith(HOME) is bypassable
      // ('/Users/alice2'.startsWith('/Users/alice') === true).
      if (!real || (real !== HOME && !real.startsWith(HOME + '/'))) throw new Error('cwd outside $HOME');
      dir = real;
    }

    // Run through a login shell so `claude` resolves via the user's full PATH
    // (Homebrew shim, version-manager shims, etc.) — spawning the bare name with
    // node-pty fails ("posix_spawnp failed") when the server's inherited PATH is
    // narrower than the login shell's. sessionId is UUID-validated, so it is
    // safe to interpolate; cwd is passed via the pty option (no interpolation).
    const shell = process.env.SHELL || '/bin/bash';
    // Same provider-routing hygiene as the chat spawn (see chat.js): strip
    // inherited official ANTHROPIC_* so the resumed session talks to the
    // provider in settings.json, not a Claude-Desktop-injected official
    // base/token. The login shell (-lc) won't re-add them — the user's profile
    // doesn't export them.
    const rcEnv = { ...process.env };
    for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) {
      delete rcEnv[k];
    }
    const pty = await loadPty();
    const term = pty.spawn(shell, ['-lc', `claude --remote-control --resume ${sessionId}`], {
      name: 'xterm-color',
      cols: 100,
      rows: 30,
      cwd: dir,
      env: rcEnv,
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
