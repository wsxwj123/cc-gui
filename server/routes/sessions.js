import { Router } from 'express';
import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import {
  listProjects,
  listSessions,
  getSessionMessages,
  getSessionMeta,
  getActiveSessions,
} from '../services/session-reader.js';

const router = Router();

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
