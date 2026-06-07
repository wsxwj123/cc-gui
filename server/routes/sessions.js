import { Router } from 'express';
import { readdir, stat, readFile, writeFile, rename, open } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

// Guard against path traversal: projectHash / sessionId arrive from request
// bodies and queries, then get concatenated into fs paths. A crafted value
// like `../../foo` would escape ~/.claude/projects. Real projectHash is a
// dash-encoded path (no `/`, no `..`); real sessionId is a UUID. Reject
// anything else.
function safeId(s) {
  if (typeof s !== 'string' || !s) return false;
  if (s.includes('/') || s.includes('\\') || s.includes('..') || s.includes('\0')) return false;
  return true;
}
import {
  listProjects,
  listSessions,
  getSessionMessages,
  getSessionMeta,
  getActiveSessions,
} from '../services/session-reader.js';

const router = Router();

function sessionFile(projectHash, sessionId) {
  return join(homedir(), '.claude', 'projects', projectHash, `${sessionId}.jsonl`);
}

function hasRealConversationLine(lines) {
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'user' || obj.type === 'assistant') return true;
    } catch {}
  }
  return false;
}

async function writeJsonlAtomic(file, text) {
  const finalText = text.length && !text.endsWith('\n') ? text + '\n' : text;
  const tmp = `${file}.tmp-trim`;
  await writeFile(tmp, finalText, 'utf-8');
  await rename(tmp, file);
}

async function deleteSessionFile(file) {
  const { unlink } = await import('fs/promises');
  try { await unlink(file); } catch {}
}

export function trimJsonlBeforeTool(raw, toolUseId) {
  const lines = String(raw || '').split('\n');
  const keptLines = [];
  let found = false;
  let removedFromLine = -1;
  let keptAssistantBlocks = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      if (!found) keptLines.push(line);
      continue;
    }

    let obj;
    try { obj = JSON.parse(line); }
    catch {
      if (!found) keptLines.push(line);
      continue;
    }

    const content = Array.isArray(obj?.message?.content) ? obj.message.content : null;
    if (obj.type === 'assistant' && content) {
      const toolIdx = content.findIndex((block) => block?.type === 'tool_use' && block.id === toolUseId);
      if (toolIdx !== -1) {
        found = true;
        removedFromLine = i;
        const beforeBlocks = content.slice(0, toolIdx);
        if (beforeBlocks.length > 0) {
          obj.message = { ...obj.message, content: beforeBlocks };
          keptAssistantBlocks = beforeBlocks.length;
          keptLines.push(JSON.stringify(obj));
        }
        break;
      }
    }

    keptLines.push(line);
  }

  return { found, keptLines, removedFromLine, totalLines: lines.length, keptAssistantBlocks };
}

// GET /api/projects — list all projects
router.get('/projects', async (req, res) => {
  try {
    const projects = await listProjects();
    res.json(projects);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/projects/:hash/sessions — list sessions for a project
router.get('/projects/:hash/sessions', async (req, res) => {
  try {
    if (!safeId(req.params.hash)) {
      return res.status(400).json({ error: 'invalid hash' });
    }
    const sessions = await listSessions(req.params.hash);
    res.json(sessions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sessions/:sessionId — session metadata
router.get('/sessions/:sessionId', async (req, res) => {
  try {
    const { projectHash } = req.query;
    if (!projectHash) {
      return res.status(400).json({ error: 'projectHash query param required' });
    }
    if (!safeId(projectHash) || !safeId(req.params.sessionId)) {
      return res.status(400).json({ error: 'invalid projectHash or sessionId' });
    }
    const meta = await getSessionMeta(req.params.sessionId, projectHash);
    res.json(meta);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sessions/:sessionId/messages — full message history
router.get('/sessions/:sessionId/messages', async (req, res) => {
  try {
    const { projectHash } = req.query;
    if (!projectHash) {
      return res.status(400).json({ error: 'projectHash query param required' });
    }
    if (!safeId(projectHash) || !safeId(req.params.sessionId)) {
      return res.status(400).json({ error: 'invalid projectHash or sessionId' });
    }
    const messages = await getSessionMessages(req.params.sessionId, projectHash);
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/recent-session?projectHash=...
 * Returns the most-recently-modified session jsonl for a project (mirrors
 * `claude --continue` semantics). If projectHash is omitted, scans every
 * project and returns the globally newest session.
 */
router.get('/recent-session', async (req, res) => {
  try {
    const { projectHash } = req.query;
    if (projectHash && !safeId(projectHash)) {
      return res.status(400).json({ error: 'invalid projectHash' });
    }
    const projectsDir = join(homedir(), '.claude', 'projects');
    const dirs = projectHash
      ? [projectHash]
      : (await readdir(projectsDir, { withFileTypes: true }))
          .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
          .map((e) => e.name);

    let best = null;
    for (const hash of dirs) {
      const projectDir = join(projectsDir, hash);
      let files;
      try { files = await readdir(projectDir); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const full = join(projectDir, f);
        let st;
        try { st = await stat(full); } catch { continue; }
        if (!best || st.mtimeMs > best.mtimeMs) {
          best = { projectHash: hash, sessionId: f.replace(/\.jsonl$/, ''), mtimeMs: st.mtimeMs };
        }
      }
    }
    if (!best) return res.status(404).json({ error: 'no sessions found' });
    res.json(best);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/sessions/:sessionId/trim  { projectHash, uuid?, fromTimestamp? }
 * Rollback support: truncate the on-disk jsonl so that the matched line AND
 * everything after it is removed. Match strategy:
 *   - if `uuid` provided: cut at the first record whose `uuid` equals it
 *   - else if `fromTimestamp` provided (ISO): cut at the first record whose
 *     `timestamp >= fromTimestamp`
 * The timestamp variant covers freshly-sent messages whose client-side uuid
 * (`chat-user-<ts>`) never made it into the jsonl — the CLI assigns its own
 * uuid on persist, but the timestamp is preserved.
 *
 * Writes a backup copy at `<sid>.jsonl.bak` before rewriting (best-effort).
 */
router.post('/sessions/:sessionId/trim', async (req, res) => {
  try {
    const { projectHash, uuid, fromTimestamp } = req.body || {};
    if (!projectHash || (!uuid && !fromTimestamp)) {
      return res.status(400).json({ error: 'projectHash + (uuid or fromTimestamp) required' });
    }
    if (!safeId(projectHash) || !safeId(req.params.sessionId)) {
      return res.status(400).json({ error: 'invalid projectHash or sessionId' });
    }
    const file = sessionFile(projectHash, req.params.sessionId);
    let raw;
    try { raw = await readFile(file, 'utf-8'); }
    catch { return res.status(404).json({ error: 'session jsonl not found' }); }
    const lines = raw.split('\n');
    const cutoffMs = fromTimestamp ? Date.parse(fromTimestamp) : null;
    let cutIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (uuid && obj.uuid === uuid) { cutIdx = i; break; }
        if (cutoffMs && obj.timestamp) {
          const tMs = Date.parse(obj.timestamp);
          if (!Number.isNaN(tMs) && tMs >= cutoffMs) { cutIdx = i; break; }
        }
      } catch {}
    }
    if (cutIdx === -1) {
      return res.status(404).json({ error: 'match not found in session' });
    }
    try { await writeFile(file + '.bak', raw, 'utf-8'); } catch {}

    // Check the kept-lines: does it still contain at least one real user or
    // assistant message? If not, the CLI will refuse to --resume this sid
    // ("No conversation found with session ID") — the user-visible symptom
    // is "send/rollback/re-edit silently does nothing". In that case wipe
    // the jsonl entirely and tell the client to forget the sessionId so
    // the next send spawns a fresh session.
    const keptLines = lines.slice(0, cutIdx);
    if (!hasRealConversationLine(keptLines)) {
      // Delete the jsonl outright — client returns sessionReset:true and
      // should drop sessionId so next /api/chat omits --resume.
      await deleteSessionFile(file);
      return res.json({
        trimmed: true,
        sessionReset: true,
        reason: 'no user/assistant lines would remain — session deleted, next send creates fresh',
        removedFromLine: cutIdx,
        totalLines: lines.length,
      });
    }

    // Atomic write (#12): a plain writeFile truncates-then-writes, so the
    // polling file-watcher can read a half-written/empty jsonl mid-trim and
    // momentarily blank the conversation until the next stream. Write to a
    // same-dir temp and rename (POSIX-atomic on one filesystem) so no reader
    // ever sees a truncated file.
    await writeJsonlAtomic(file, keptLines.join('\n'));
    res.json({ trimmed: true, removedFromLine: cutIdx, totalLines: lines.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/sessions/:sessionId/trim-before-tool  { projectHash, toolUseId }
 * Tool retry support: keep the conversation exactly up to the content block
 * before the selected assistant tool_use, then remove that tool call, its
 * tool_result, and everything after it. The next hidden continuation prompt
 * resumes from that partial assistant turn, so earlier text / earlier tools in
 * the same reply stay visible instead of replaying the whole turn.
 */
router.post('/sessions/:sessionId/trim-before-tool', async (req, res) => {
  try {
    const { projectHash, toolUseId } = req.body || {};
    if (!projectHash || !toolUseId) {
      return res.status(400).json({ error: 'projectHash + toolUseId required' });
    }
    if (!safeId(projectHash) || !safeId(req.params.sessionId)) {
      return res.status(400).json({ error: 'invalid projectHash or sessionId' });
    }

    const file = sessionFile(projectHash, req.params.sessionId);
    let raw;
    try { raw = await readFile(file, 'utf-8'); }
    catch { return res.status(404).json({ error: 'session jsonl not found' }); }

    const { found, keptLines, removedFromLine, totalLines, keptAssistantBlocks } = trimJsonlBeforeTool(raw, toolUseId);
    if (!found) return res.status(404).json({ error: 'tool_use not found in session' });
    try { await writeFile(file + '.bak', raw, 'utf-8'); } catch {}

    if (!hasRealConversationLine(keptLines)) {
      await deleteSessionFile(file);
      return res.json({
        trimmed: true,
        sessionReset: true,
        reason: 'no user/assistant lines would remain — session deleted, next send creates fresh',
        removedFromLine,
        totalLines,
      });
    }

    await writeJsonlAtomic(file, keptLines.join('\n'));
    res.json({
      trimmed: true,
      toolUseId,
      removedFromLine,
      totalLines,
      keptAssistantBlocks,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/sessions/:sessionId/strip-thinking  { projectHash }
 * Remove all `thinking` content blocks from assistant lines in the jsonl.
 * Reason: cc switch routes Claude → DeepSeek/MiMo etc. The previous turns'
 * thinking blocks carry Anthropic-issued signatures that the new backend
 * rejects with `400 messages.X.content.0: Invalid signature in thinking
 * block`. Stripping them before `--resume` keeps the conversation flowing
 * across provider switches. Backup is written to `<sid>.jsonl.bak` first.
 */
router.post('/sessions/:sessionId/strip-thinking', async (req, res) => {
  try {
    const { projectHash } = req.body || {};
    if (!projectHash) return res.status(400).json({ error: 'projectHash required' });
    if (!safeId(projectHash) || !safeId(req.params.sessionId)) {
      return res.status(400).json({ error: 'invalid projectHash or sessionId' });
    }
    const file = join(homedir(), '.claude', 'projects', projectHash, `${req.params.sessionId}.jsonl`);
    let raw;
    try { raw = await readFile(file, 'utf-8'); }
    catch { return res.status(404).json({ error: 'session jsonl not found' }); }
    // Best-effort .bak before rewrite.
    try { await writeFile(file + '.bak', raw, 'utf-8'); } catch {}

    const lines = raw.split('\n');
    let strippedBlocks = 0;
    let touchedLines = 0;
    const out = lines.map((line) => {
      if (!line.trim()) return line;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
          const before = obj.message.content.length;
          const filtered = obj.message.content.filter((c) => c?.type !== 'thinking');
          // 纯 thinking 轮次:剥离后 content 变 [],Anthropic API 拒绝空 content 的
          // assistant 记录(400)导致 resume 失败。这种行保留原样不剥离。
          if (filtered.length === 0) return line;
          obj.message.content = filtered;
          const removed = before - filtered.length;
          if (removed > 0) {
            strippedBlocks += removed;
            touchedLines += 1;
            return JSON.stringify(obj);
          }
        }
      } catch {}
      return line;
    });
    // 原子写(tmp+rename),和 trim 一致 —— 避免裸 writeFile 截断后、写完前被文件
    // 监听器读到空内容,导致前端会话瞬间清空。
    await writeJsonlAtomic(file, out.join('\n'));
    res.json({ strippedBlocks, touchedLines });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/sessions/:sessionId?projectHash=...
 * Permanently removes the session jsonl + sidecar metadata.
 */
router.delete('/sessions/:sessionId', async (req, res) => {
  try {
    const { projectHash } = req.query;
    if (!projectHash) return res.status(400).json({ error: 'projectHash required' });
    if (!safeId(projectHash) || !safeId(req.params.sessionId)) {
      return res.status(400).json({ error: 'invalid projectHash or sessionId' });
    }
    const file = join(homedir(), '.claude', 'projects', projectHash, `${req.params.sessionId}.jsonl`);
    const { unlink } = await import('fs/promises');
    let deletedJsonl = false;
    try {
      await unlink(file);
      deletedJsonl = true;
    } catch (e) {
      if (e.code === 'ENOENT') {
        return res.status(404).json({ error: 'session not found' });
      }
      return res.status(500).json({ error: e.message });
    }
    // Best-effort: remove the .archived marker and the registry sidecar if present.
    try { await unlink(file + '.archived'); } catch {}
    try { await unlink(join(homedir(), '.claude', 'sessions', `${req.params.sessionId}.json`)); } catch {}
    res.json({ deleted: deletedJsonl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/sessions/:sessionId/archive  { projectHash, archived: boolean }
 * Hide-from-default-list / restore. Implemented as a sibling marker file
 * `<sid>.jsonl.archived` so it survives across restarts and doesn't pollute
 * the jsonl itself. Empty file = archived; absence = active.
 */
router.post('/sessions/:sessionId/archive', async (req, res) => {
  try {
    const { projectHash, archived } = req.body || {};
    if (!projectHash) return res.status(400).json({ error: 'projectHash required' });
    if (!safeId(projectHash) || !safeId(req.params.sessionId)) {
      return res.status(400).json({ error: 'invalid projectHash or sessionId' });
    }
    const projectDir = join(homedir(), '.claude', 'projects', projectHash);
    const jsonl = join(projectDir, `${req.params.sessionId}.jsonl`);
    const marker = `${jsonl}.archived`;
    const { writeFile: wf, unlink, stat: st } = await import('fs/promises');
    // Verify the session jsonl actually exists before flipping its archive
    // state — otherwise a bad client could create stray `.archived` files
    // anywhere we have write access, and a missing project dir would leak
    // an ENOENT to the response.
    try { await st(jsonl); }
    catch { return res.status(404).json({ error: 'session not found' }); }
    if (archived) {
      await wf(marker, String(Date.now()), 'utf-8');
    } else {
      try { await unlink(marker); } catch {}
    }
    res.json({ archived: !!archived });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/bak-files
 * Scan ~/.claude/projects for *.jsonl.bak (created by trim & strip-thinking),
 * pair each with its session title (first user prompt) and stats so the UI
 * can show a manual cleanup table. Orphan .bak (parent .jsonl missing) get
 * marked so the user knows they're safe to clean.
 */
router.get('/bak-files', async (req, res) => {
  try {
    const projectsDir = join(homedir(), '.claude', 'projects');
    let projectDirs;
    try {
      projectDirs = (await readdir(projectsDir, { withFileTypes: true }))
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name);
    } catch { return res.json({ items: [], totalBytes: 0 }); }

    const items = [];
    let totalBytes = 0;
    for (const hash of projectDirs) {
      const dir = join(projectsDir, hash);
      let files;
      try { files = await readdir(dir); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl.bak')) continue;
        const sessionId = f.replace(/\.jsonl\.bak$/, '');
        const full = join(dir, f);
        let st;
        try { st = await stat(full); } catch { continue; }
        // Orphan check + title lookup (read first ~50 lines of the .bak;
        // first record with type === 'user' carries the human prompt).
        const jsonlPath = join(dir, `${sessionId}.jsonl`);
        let orphan = false;
        try { await stat(jsonlPath); } catch { orphan = true; }
        let title = '';
        try {
          // Read only the head (8KB) — enough for system + first user line.
          // Avoids loading multi-MB backups in full just to extract a title.
          const fd = await open(full, 'r');
          const buf = Buffer.alloc(8192);
          const { bytesRead } = await fd.read(buf, 0, 8192, 0);
          await fd.close();
          const lines = buf.subarray(0, bytesRead).toString('utf-8').split('\n').slice(0, 50);
          for (const ln of lines) {
            if (!ln.trim()) continue;
            try {
              const obj = JSON.parse(ln);
              if (obj.type === 'user' && obj.message?.content) {
                const c = obj.message.content;
                const text = typeof c === 'string'
                  ? c
                  : Array.isArray(c) ? c.find((x) => x.type === 'text')?.text || '' : '';
                if (text) { title = text.slice(0, 80); break; }
              }
            } catch {}
          }
        } catch {}
        totalBytes += st.size;
        items.push({
          projectHash: hash,
          sessionId,
          size: st.size,
          mtimeMs: st.mtimeMs,
          orphan,
          title: title || '(无标题)',
        });
      }
    }
    items.sort((a, b) => b.mtimeMs - a.mtimeMs);
    res.json({ items, totalBytes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/bak-files
 * Body: { items: [{ projectHash, sessionId }, ...] } OR { all: true }
 * Removes the matching `<sid>.jsonl.bak` files. Returns count + freed bytes.
 */
router.delete('/bak-files', async (req, res) => {
  try {
    const { items, all } = req.body || {};
    const { unlink } = await import('fs/promises');
    let targets = [];
    if (all) {
      const projectsDir = join(homedir(), '.claude', 'projects');
      let dirs;
      try {
        dirs = (await readdir(projectsDir, { withFileTypes: true }))
          .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
          .map((e) => e.name);
      } catch { dirs = []; }
      for (const hash of dirs) {
        const dir = join(projectsDir, hash);
        let files;
        try { files = await readdir(dir); } catch { continue; }
        for (const f of files) {
          if (f.endsWith('.jsonl.bak')) {
            targets.push({ projectHash: hash, sessionId: f.replace(/\.jsonl\.bak$/, '') });
          }
        }
      }
    } else if (Array.isArray(items)) {
      targets = items.filter((x) => safeId(x?.projectHash) && safeId(x?.sessionId));
    } else {
      return res.status(400).json({ error: 'items[] or all required' });
    }

    let deleted = 0;
    let freedBytes = 0;
    for (const t of targets) {
      const file = join(homedir(), '.claude', 'projects', t.projectHash, `${t.sessionId}.jsonl.bak`);
      try {
        const st = await stat(file);
        await unlink(file);
        deleted += 1;
        freedBytes += st.size;
      } catch {}
    }
    res.json({ deleted, freedBytes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/active-sessions — currently running Claude processes
router.get('/active-sessions', async (req, res) => {
  try {
    const sessions = await getActiveSessions();
    res.json(sessions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
