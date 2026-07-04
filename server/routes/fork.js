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
  const { sessionId, projectHash, upToUuid } = req.body;
  if (!sessionId || !projectHash) {
    return res.status(400).json({ error: 'sessionId and projectHash required' });
  }
  if (!UUID_RE.test(String(sessionId))) {
    return res.status(400).json({ error: 'invalid sessionId' });
  }
  if (upToUuid != null && !UUID_RE.test(String(upToUuid))) {
    return res.status(400).json({ error: 'invalid upToUuid' });
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
    const kept = await forkJsonl(src, dest, String(sessionId), newId, upToUuid ? String(upToUuid) : null);
    if (upToUuid && kept === 0) {
      // Anchor not found → the .jsonl copy we started is meaningless. Best-effort remove.
      try { const { unlink } = await import('fs/promises'); await unlink(dest); } catch {}
      return res.status(404).json({ error: 'upToUuid not found in session' });
    }
    res.json({ newSessionId: newId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 是否"真·用户提问"(=回合边界)。tool_result 载体也是 type:'user',但内容是 tool_result
// 块;isMeta/isCompactSummary 是 CLI 记账。只有带文本、非纯 tool_result 的 user 记录才是
// 新提问 → 分叉截断点应停在【锚点之后的下一个真·提问】之前,以纳入锚点回合的全部
// tool_result + 末条 assistant,避免留悬空 tool_use 让 --resume 报错。
function isRealUserQuestion(obj) {
  if (!obj || obj.type !== 'user' || obj.isMeta || obj.isCompactSummary) return false;
  const content = obj.message?.content;
  if (typeof content === 'string') return content.trim().length > 0;
  if (Array.isArray(content)) {
    const hasToolResult = content.some((c) => c && c.type === 'tool_result');
    const hasText = content.some((c) => c && (c.type === 'text' || typeof c === 'string'));
    return hasText && !hasToolResult;
  }
  return false;
}

// Stream src → dest line by line, rewriting only the top-level sessionId so we
// never touch ids embedded inside message content. When upToUuid is given, copy
// only up to (and including) the anchor's whole turn — stop before the next real
// user question. Returns the number of lines written (0 = anchor never matched).
function forkJsonl(src, dest, oldId, newId, upToUuid) {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(dest, { encoding: 'utf8' });
    const rl = readline.createInterface({
      input: createReadStream(src, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    let matched = !upToUuid;   // no anchor → copy everything (matched from the start)
    let stopped = false;
    let written = 0;
    const emit = (s) => { out.write(s); };
    rl.on('line', (line) => {
      if (stopped) return;
      if (!line.trim()) { emit('\n'); return; }
      let obj;
      try { obj = JSON.parse(line); }
      catch { emit(line + '\n'); written++; return; } // pass through unparseable lines verbatim
      // Anchor mode: once matched, keep copying until the NEXT real user question.
      if (upToUuid && matched && isRealUserQuestion(obj)) { stopped = true; rl.close(); return; }
      if (obj.sessionId === oldId) obj.sessionId = newId;
      emit(JSON.stringify(obj) + '\n');
      written++;
      if (upToUuid && !matched && obj.uuid === upToUuid) matched = true;
    });
    rl.on('error', reject);
    out.on('error', reject);
    rl.on('close', () => out.end(() => resolve(matched ? written : 0)));
  });
}

export default router;
export { forkJsonl, isRealUserQuestion }; // for tests
