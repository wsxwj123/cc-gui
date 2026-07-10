import { Router } from 'express';
import { readdir, stat, readFile, writeFile, rename, open, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { closePersistentForSession } from './chat.js';

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
  attachmentTextHash,
} from '../services/session-reader.js';
import { claudeSpawn, cleanChildEnv } from './chat.js';
import { resolveUnderHome } from '../utils/safe-path.js';

// L4: 附件元数据 sidecar — 写入位置与 session-reader 一致。
const ATTACHMENTS_DIR = join(homedir(), '.claude-gui', 'attachments');

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
          // 若 beforeBlocks 里仍有 tool_use(同一条 assistant 消息里、被裁工具之前的
          // 其它工具),它们的 tool_result 在紧跟的 user 行里。必须保留这些配对的
          // tool_result,否则留下孤儿 tool_use → resume 时 Anthropic API 400
          // (每个 tool_use 必须有对应 tool_result)。只过滤掉被裁工具的 result。
          const keptToolIds = new Set(
            beforeBlocks.filter((b) => b?.type === 'tool_use' && b.id).map((b) => b.id)
          );
          if (keptToolIds.size > 0) {
            for (let j = i + 1; j < lines.length; j++) {
              if (!lines[j].trim()) continue;
              let next;
              try { next = JSON.parse(lines[j]); } catch { break; }
              const nc = Array.isArray(next?.message?.content) ? next.message.content : null;
              if (next.type === 'user' && nc && nc.some((b) => b?.type === 'tool_result')) {
                const filtered = nc.filter((b) => b?.type !== 'tool_result' || keptToolIds.has(b.tool_use_id));
                if (filtered.length > 0) {
                  next.message = { ...next.message, content: filtered };
                  keptLines.push(JSON.stringify(next));
                }
              }
              break; // 只处理紧跟的那条
            }
          }
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
    // 响应形态 { messages, usageTotals }:usageTotals 是服务端解析 jsonl 时顺带算好的
    // 整会话用量聚合(按 message.id 去重逐条求和),前端直接取用,免去几千条消息的
    // 每帧全量 reduce。客户端(sessionStore.fetchMessages / App.jsx peek)已兼容两种形态。
    const { messages, usageTotals } = await getSessionMessages(req.params.sessionId, projectHash);
    res.json({ messages, usageTotals });
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
// L4: POST /sessions/:sessionId/attachments { text, attachments, displayText }
// 把附件卡片元数据写入 sidecar(按 textHash 索引,session-reader 重读消息时 merge)。
router.post('/sessions/:sessionId/attachments', async (req, res) => {
  try {
    const sid = req.params.sessionId;
    if (!safeId(sid)) return res.status(400).json({ error: 'bad sessionId' });
    const { text, attachments, displayText } = req.body || {};
    if (typeof text !== 'string' || !Array.isArray(attachments)) {
      return res.status(400).json({ error: 'text + attachments[] required' });
    }
    await mkdir(ATTACHMENTS_DIR, { recursive: true });
    const p = join(ATTACHMENTS_DIR, `${sid}.json`);
    let cur = {};
    try { cur = JSON.parse(await readFile(p, 'utf-8')) || {}; } catch {}
    const key = attachmentTextHash(text);
    cur[key] = {
      attachments: attachments.map((a) => ({
        kind: a.kind, name: a.name, path: a.path, preview: a.preview, bytes: a.bytes,
      })),
      displayText: typeof displayText === 'string' ? displayText : '',
    };
    await writeFile(p, JSON.stringify(cur, null, 2));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/sessions/:sessionId/trim', async (req, res) => {
  try {
    const { projectHash, uuid, fromTimestamp } = req.body || {};
    if (!projectHash || (!uuid && !fromTimestamp)) {
      return res.status(400).json({ error: 'projectHash + (uuid or fromTimestamp) required' });
    }
    if (!safeId(projectHash) || !safeId(req.params.sessionId)) {
      return res.status(400).json({ error: 'invalid projectHash or sessionId' });
    }
    // #26:改写历史前关掉常驻进程 —— 它的内存上下文与截断后的 jsonl 已分叉,复用会答非所问。
    closePersistentForSession(req.params.sessionId);
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
      // 不再物理删 jsonl。回退一条消息却把整个会话文件删掉(且 .bak 也常丢)是
      // "回退后所有消息消失、会话变僵尸"的根因:删后前端若没干净转 draft,下次仍
      // 拿旧 sessionId --resume → CLI 报 "No conversation found"。改为保留裁剪后
      // 的内容(可能只剩 meta),前端收到 sessionReset 转 draft、下次发消息新建会话。
      // 数据不丢、可在文件树找回,旧会话仍可手动删。
      await writeJsonlAtomic(file, keptLines.join('\n'));
      return res.json({
        trimmed: true,
        sessionReset: true,
        reason: 'no user/assistant lines would remain — kept meta, client starts fresh',
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
    closePersistentForSession(req.params.sessionId); // #26:改写历史前关常驻进程(同 trim)

    const file = sessionFile(projectHash, req.params.sessionId);
    let raw;
    try { raw = await readFile(file, 'utf-8'); }
    catch { return res.status(404).json({ error: 'session jsonl not found' }); }

    const { found, keptLines, removedFromLine, totalLines, keptAssistantBlocks } = trimJsonlBeforeTool(raw, toolUseId);
    if (!found) return res.status(404).json({ error: 'tool_use not found in session' });
    try { await writeFile(file + '.bak', raw, 'utf-8'); } catch {}

    if (!hasRealConversationLine(keptLines)) {
      // 和 /trim 一致:不再物理删 jsonl(删后若前端没干净转 draft,下次仍 --resume
      // 旧 sessionId → "No conversation found" 僵尸会话)。保留裁剪后的内容,回
      // sessionReset 让前端转 draft、下次发消息新建会话。
      await writeJsonlAtomic(file, keptLines.join('\n'));
      return res.json({
        trimmed: true,
        sessionReset: true,
        reason: 'no user/assistant lines would remain — kept meta, client starts fresh',
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
    closePersistentForSession(req.params.sessionId); // #26:改写历史前关常驻进程(同 trim)
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
          // (实测:独立的 thinking-only 行不会被上游做签名校验——只有与 tool_use/text
          //  同处一条 message 的 thinking 才校验,那种情况 filter 后仍非空、正常剥离。)
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
    // #26:删除前关掉该会话的常驻/在跑进程 —— 残余进程可能把刚删的 jsonl 写"复活"。
    // 客户端删除链路已先调 /stop,这里是服务端兜底(直连 API 删除也安全)。
    closePersistentForSession(req.params.sessionId);
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

// POST /api/project/purge { cwd } — 彻底清理某项目的 Claude 本地状态。
// 危险操作:调用 CLI `claude project purge -y <path>`,删除 ~/.claude/projects/<hash>
// 下的会话记录(.jsonl)与 memory/ 等 Claude 状态,不触碰项目源码(实测:-y 非交互,
// 退出码 0,源目录文件保留)。cwd 经 resolveUnderHome 校验(必须在 $HOME 内、拒绝 .. 段)。
router.post('/project/purge', async (req, res) => {
  let dir;
  try { dir = resolveUnderHome(String(req.body?.cwd || ''), { label: 'cwd', requireCanonical: true }); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  let proc;
  try {
    proc = claudeSpawn(['project', 'purge', '-y', dir], {
      cwd: homedir(), stdio: ['ignore', 'pipe', 'pipe'], env: cleanChildEnv(),
    });
  } catch (e) { return res.status(500).json({ error: 'spawn failed: ' + e.message }); }
  if (!proc.pid) { proc.on('error', () => {}); return res.status(500).json({ error: 'claude CLI not found' }); }

  let out = '', err = '', done = false;
  const finish = (status, data) => {
    if (done) return; done = true;
    clearTimeout(timer);
    try { proc.kill('SIGKILL'); } catch {}
    res.status(status).json(data);
  };
  const timer = setTimeout(() => finish(504, { error: 'purge 超时' }), 30_000);
  proc.stdout.on('data', (c) => { out += c.toString(); });
  proc.stderr.on('data', (c) => { err += c.toString(); });
  proc.on('close', (code) => {
    finish(code === 0 ? 200 : 500, { ok: code === 0, code, stdout: out.trim(), stderr: err.trim() });
  });
  proc.on('error', (e) => finish(500, { error: e.message }));
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

// POST /api/session-ref { sessionId, projectHash } — @ 引用会话:把指定会话渲染成
// 精简 Markdown(用户/Claude 文本 + 工具调用一行摘要)写入 ~/.claude-gui/session-refs/<sid>.md,
// 返回绝对路径。前端把 `@<path>` 插进输入框,CLI 原生 @ 语法读文件即获得该会话上下文
// ——比直接塞 jsonl 省 token 且可读。超长会话保留最近 200KB(最近内容最相关)。
const SESSION_REFS_DIR = join(homedir(), '.claude-gui', 'session-refs');
router.post('/session-ref', async (req, res) => {
  const sessionId = String(req.body?.sessionId || '');
  const projectHash = String(req.body?.projectHash || '');
  if (!safeId(sessionId) || !safeId(projectHash)) return res.status(400).json({ error: 'invalid id' });
  try {
    const { messages } = await getSessionMessages(sessionId, projectHash);
    const parts = [];
    for (const m of messages) {
      if (m.type === 'user' && m.text) parts.push(`## 用户\n\n${m.displayText || m.text}`);
      else if (m.type === 'turn') {
        const body = (m.text || []).join('\n\n');
        const tools = (m.toolCalls || []).length ? `\n\n> 工具调用 ×${m.toolCalls.length}:${[...new Set(m.toolCalls.map((t) => t.name))].join(', ')}` : '';
        if (body || tools) parts.push(`## Claude\n\n${body}${tools}`);
      }
    }
    if (!parts.length) return res.status(400).json({ error: '该会话没有可引用的内容' });
    let md = `# 引用会话 ${sessionId}\n\n${parts.join('\n\n---\n\n')}\n`;
    const CAP = 200 * 1024;
    if (Buffer.byteLength(md) > CAP) {
      const buf = Buffer.from(md);
      md = `# 引用会话 ${sessionId}(超长,仅保留最近内容)\n\n…\n${buf.slice(buf.length - CAP).toString().replace(/^[^\n]*\n/, '')}`;
    }
    await mkdir(SESSION_REFS_DIR, { recursive: true });
    const target = join(SESSION_REFS_DIR, `${sessionId}.md`);
    await writeFile(target, md);
    res.json({ path: target });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/export-session { md, fileName?, targetPath? } — 把会话 Markdown 落盘。
// Tauri WKWebView 拦 blob URL 的 a[download](静默失败,用户报"导出点击没反应"),
// 所以 Tauri 环境改走这里落盘;浏览器环境仍用前端 blob 下载。
// targetPath:前端经系统"保存"对话框(@tauri-apps/plugin-dialog save)选的绝对路径,
// 用户明确指定保存位置(用户要求);不传则回落旧行为写 ~/Downloads/<fileName>。
router.post('/export-session', async (req, res) => {
  const md = String(req.body?.md || '');
  if (!md) return res.status(400).json({ error: 'md 必填' });
  try {
    let target;
    const tp = typeof req.body?.targetPath === 'string' ? req.body.targetPath.trim() : '';
    if (tp) {
      // 绝对路径(mac /… 或 win C:\…);强制 .md 后缀,防 NUL 注入。
      if (!(/^\//.test(tp) || /^[A-Za-z]:[\\/]/.test(tp)) || tp.includes('\0')) {
        return res.status(400).json({ error: 'targetPath 必须是绝对路径' });
      }
      target = tp.toLowerCase().endsWith('.md') ? tp : tp + '.md';
      await mkdir(dirname(target), { recursive: true });
    } else {
      // 文件名白名单:去路径分隔符与危险字符,只留中英文数字点横杠空格,强制 .md
      let fileName = String(req.body?.fileName || '会话.md')
        .replace(/[/\\]/g, '_')
        .replace(/[^\w一-龥.\-\s]/g, '')
        .trim()
        .slice(0, 120) || '会话.md';
      if (!fileName.toLowerCase().endsWith('.md')) fileName += '.md';
      const dir = join(homedir(), 'Downloads');
      await mkdir(dir, { recursive: true });
      target = join(dir, fileName);
    }
    await writeFile(target, md, 'utf-8');
    res.json({ ok: true, path: target });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
