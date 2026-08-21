import { Router } from 'express';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

const router = Router();
const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const PREFS_PATH = join(homedir(), '.claude-gui', 'prefs.json');

const MAX_RESULTS = 60;
const SNIPPET_RADIUS = 80;

// r26-I3:全局搜索不过滤隐藏项目 = 隐藏项目的会话能被搜到、点进去,绕过侧栏的
// 隐藏语义。窄读 prefs.json 的 hiddenProjects(prefs.js 的 loadPrefs 未导出;
// 目录名即项目 hash,与 CLI 编码同规则)。读失败回落空集 = 不过滤,不阻断搜索。
async function loadHiddenProjects() {
  try {
    const prefs = JSON.parse(await readFile(PREFS_PATH, 'utf-8'));
    return new Set(Array.isArray(prefs.hiddenProjects) ? prefs.hiddenProjects.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function makeSnippet(text, idx, q) {
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(text.length, idx + q.length + SNIPPET_RADIUS);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return prefix + text.slice(start, end).replace(/\s+/g, ' ').trim() + suffix;
}

/**
 * GET /api/search?q=...
 * Cheap line-by-line search across ~/.claude/projects/**\/*.jsonl.
 * Returns up to MAX_RESULTS hits, newest project files first. No index —
 * relies on the OS page cache, which is plenty for typical user volumes.
 */
router.get('/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q || q.length < 2) return res.json({ q, hits: [], truncated: false });

  const qLower = q.toLowerCase();
  const hits = [];

  try {
    const hidden = await loadHiddenProjects(); // r26-I3:隐藏项目整目录跳过(省 IO 且与点击入口同口径)
    const projects = await readdir(PROJECTS_DIR, { withFileTypes: true });
    // Sort newest first to bias recency.
    const projectDirs = projects
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !hidden.has(e.name));

    outer: for (const dir of projectDirs) {
      const projectDir = join(PROJECTS_DIR, dir.name);
      let entries;
      try { entries = await readdir(projectDir); } catch { continue; }
      // Newest sessions first by lexicographic mtime — UUIDs aren't sortable,
      // so we just iterate; the cap is small enough this doesn't matter much.
      for (const file of entries) {
        if (!file.endsWith('.jsonl')) continue;
        const sessionId = file.replace(/\.jsonl$/, '');
        let raw;
        try { raw = await readFile(join(projectDir, file), 'utf-8'); }
        catch { continue; }
        const lines = raw.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line) continue;
          const lo = line.toLowerCase();
          const idx = lo.indexOf(qLower);
          if (idx === -1) continue;

          let obj;
          try { obj = JSON.parse(line); } catch { continue; }
          // Prefer matching real conversational text, not metadata blobs.
          const text =
            (typeof obj.text === 'string' && obj.text) ||
            (typeof obj.message?.content === 'string' && obj.message.content) ||
            (Array.isArray(obj.message?.content)
              ? obj.message.content
                  .map((b) => (typeof b === 'string' ? b : b?.text || ''))
                  .filter(Boolean)
                  .join(' ')
              : '');
          if (!text) continue;
          const tIdx = text.toLowerCase().indexOf(qLower);
          if (tIdx === -1) continue;

          hits.push({
            projectHash: dir.name,
            sessionId,
            role: obj.type || obj.role || 'unknown',
            timestamp: obj.timestamp || obj.created_at || null,
            snippet: makeSnippet(text, tIdx, q),
          });
          if (hits.length >= MAX_RESULTS) break outer;
        }
      }
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  res.json({ q, hits, truncated: hits.length >= MAX_RESULTS });
});

export default router;
