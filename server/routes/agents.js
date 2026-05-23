import { Router } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile, readdir, writeFile, mkdir, stat } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

const execFileP = promisify(execFile);
const router = Router();
const AGENTS_DIR = join(homedir(), '.claude', 'agents');

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
function assertName(name) {
  if (!NAME_RE.test(String(name || ''))) throw new Error('invalid agent name (lowercase letters/digits/dash)');
}

/**
 * GET /api/agents
 * Lists agent presets from ~/.claude/agents/<name>.{md,json}. Falls back to
 * `claude agents` if the directory doesn't exist (some installs use a
 * different storage). We never invent agents — only echo what's on disk.
 */
router.get('/agents', async (req, res) => {
  try {
    const agents = [];
    try {
      const files = await readdir(AGENTS_DIR);
      for (const f of files) {
        if (!/\.(md|json)$/.test(f)) continue;
        const full = join(AGENTS_DIR, f);
        const name = f.replace(/\.(md|json)$/, '');
        let content;
        try { content = await readFile(full, 'utf-8'); } catch { continue; }
        let description = '';
        const m = content.match(/^---[\s\S]*?description:\s*(.+?)[\n\r]/);
        if (m) description = m[1].trim();
        agents.push({ name, file: full, description, format: f.endsWith('.md') ? 'md' : 'json' });
      }
    } catch {}

    // Always try the CLI as a secondary source — some installs register agents
    // elsewhere. If both succeed we merge by name.
    try {
      const out = await execFileP('claude', ['agents', 'list'], { timeout: 6000 });
      const lines = out.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      for (const line of lines) {
        const m = line.match(/^([a-z0-9-]+)\b/);
        if (m && !agents.some((a) => a.name === m[1])) {
          agents.push({ name: m[1], file: null, description: '(via claude CLI)', format: 'cli' });
        }
      }
    } catch {}

    res.json({ agents });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/agents/:name — raw file content (md or json) */
router.get('/agents/:name', async (req, res) => {
  try {
    assertName(req.params.name);
    const candidates = [join(AGENTS_DIR, req.params.name + '.md'), join(AGENTS_DIR, req.params.name + '.json')];
    for (const path of candidates) {
      try {
        const content = await readFile(path, 'utf-8');
        return res.json({ name: req.params.name, path, content });
      } catch {}
    }
    res.status(404).json({ error: 'agent not found' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** PUT /api/agents/:name  { content } */
router.put('/agents/:name', async (req, res) => {
  try {
    assertName(req.params.name);
    const { content } = req.body || {};
    if (typeof content !== 'string') throw new Error('content must be a string');
    await mkdir(AGENTS_DIR, { recursive: true });
    const path = join(AGENTS_DIR, req.params.name + '.md');
    await writeFile(path, content);
    res.json({ ok: true, path });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
