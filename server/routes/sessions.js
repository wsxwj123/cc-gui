import { Router } from 'express';
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
