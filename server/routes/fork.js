import { Router } from 'express';
import { homedir } from 'os';
import { join, sep } from 'path';
import { createReadStream, createWriteStream, existsSync } from 'fs';
import { realpath } from 'fs/promises';
import { randomUUID } from 'crypto';
import readline from 'readline';

const router = Router();

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// projectHash 是 Claude Code 把路径里的 '/' 换成 '-' 形成的目录名，只允许这些字符。
const PROJECT_HASH_RE = /^-?[A-Za-z0-9._-]{1,300}$/;

/**
 * Fork a session by COPYING its jsonl file under a fresh session id, rewriting
 * only the top-level `sessionId` field on each line. The Claude CLI stores a
 * session as a single <sessionId>.jsonl; `--resume <newId>` reads that file
 * directly, so a faithful copy = a true fork that keeps the ENTIRE context with
 * no model turn and no token cost.
 *
 * We deliberately do NOT use `claude --fork-session` headless: stream-json
 * output requires --print, and an empty-stdin print run never materializes the
 * forked file (the fork is only written on a real turn). The filesystem copy is
 * deterministic and instant.
 */
router.post('/fork', async (req, res) => {
  const { sessionId, projectHash } = req.body;
  if (!sessionId || !projectHash) {
    return res.status(400).json({ error: 'sessionId and projectHash required' });
  }
  if (!UUID_RE.test(String(sessionId))) {
    return res.status(400).json({ error: 'invalid sessionId' });
  }
  if (!PROJECT_HASH_RE.test(String(projectHash))) {
    return res.status(400).json({ error: 'invalid projectHash' });
  }

  const dir = join(PROJECTS_DIR, String(projectHash));
  // Containment check — block '..' traversal escaping the projects dir.
  const realDir = await realpath(dir).catch(() => null);
  if (!realDir || !(realDir === PROJECTS_DIR || realDir.startsWith(PROJECTS_DIR + sep))) {
    return res.status(400).json({ error: 'invalid projectHash' });
  }

  const src = join(realDir, `${sessionId}.jsonl`);
  if (!existsSync(src)) {
    return res.status(404).json({ error: 'session file not found' });
  }

  const newId = randomUUID();
  const dest = join(realDir, `${newId}.jsonl`);

  try {
    await forkJsonl(src, dest, String(sessionId), newId);
    res.json({ newSessionId: newId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stream src → dest line by line, rewriting only the top-level sessionId so we
// never touch ids embedded inside message content.
function forkJsonl(src, dest, oldId, newId) {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(dest, { encoding: 'utf8' });
    const rl = readline.createInterface({
      input: createReadStream(src, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    rl.on('line', (line) => {
      if (!line.trim()) { out.write('\n'); return; }
      let obj;
      try { obj = JSON.parse(line); }
      catch { out.write(line + '\n'); return; } // pass through unparseable lines verbatim
      if (obj.sessionId === oldId) obj.sessionId = newId;
      out.write(JSON.stringify(obj) + '\n');
    });
    rl.on('error', reject);
    out.on('error', reject);
    rl.on('close', () => out.end(resolve));
  });
}

export default router;
