import { Router } from 'express';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { broadcast } from '../index.js';

// Server-side preferences that must be SHARED across devices (phone + Mac).
// Today this is just the hidden-projects list: it used to live in each
// browser's localStorage, so a phone (empty localStorage) showed every project
// the user had hidden on the Mac. Persisting it here makes the project list
// identical on every device. Device-local prefs (font, theme, pane widths)
// intentionally stay in localStorage.
const router = Router();
const PREFS_PATH = join(homedir(), '.claude-gui', 'prefs.json');

async function loadPrefs() {
  try { return JSON.parse(await readFile(PREFS_PATH, 'utf-8')); }
  catch { return {}; }
}
async function savePrefs(obj) {
  await mkdir(dirname(PREFS_PATH), { recursive: true });
  await writeFile(PREFS_PATH, JSON.stringify(obj, null, 2));
}

// GET /api/prefs/hidden-projects → { hidden: string[] }
router.get('/prefs/hidden-projects', async (_req, res) => {
  const prefs = await loadPrefs();
  res.json({ hidden: Array.isArray(prefs.hiddenProjects) ? prefs.hiddenProjects : [] });
});

// PUT /api/prefs/hidden-projects { hidden: string[] } → persist the full list.
router.put('/prefs/hidden-projects', async (req, res) => {
  const { hidden } = req.body || {};
  if (!Array.isArray(hidden) || !hidden.every((h) => typeof h === 'string')) {
    return res.status(400).json({ error: 'hidden 必须是字符串数组' });
  }
  try {
    const prefs = await loadPrefs();
    prefs.hiddenProjects = hidden;
    await savePrefs(prefs);
    res.json({ ok: true, hidden });
  } catch (e) {
    res.status(500).json({ error: '写入偏好失败：' + e.message });
  }
});

// GET /api/prefs/hidden-providers → { hidden: string[] }
// Provider IDs the user "removed" from the GUI list. cc-switch providers can't
// be deleted from cc-switch.db (read-only), so hiding is how a delete sticks:
// the id is filtered out of GET /providers on the client. Custom providers are
// truly deleted; this is only for the cc-switch-imported ones.
router.get('/prefs/hidden-providers', async (_req, res) => {
  const prefs = await loadPrefs();
  res.json({ hidden: Array.isArray(prefs.hiddenProviders) ? prefs.hiddenProviders : [] });
});

// PUT /api/prefs/hidden-providers { hidden: string[] }
router.put('/prefs/hidden-providers', async (req, res) => {
  const { hidden } = req.body || {};
  if (!Array.isArray(hidden) || !hidden.every((h) => typeof h === 'string')) {
    return res.status(400).json({ error: 'hidden 必须是字符串数组' });
  }
  try {
    const prefs = await loadPrefs();
    prefs.hiddenProviders = hidden;
    await savePrefs(prefs);
    res.json({ ok: true, hidden });
  } catch (e) {
    res.status(500).json({ error: '写入偏好失败：' + e.message });
  }
});

// Custom session titles { [sessionId]: title }. Used to live ONLY in each
// browser's localStorage, so a rename on the phone never reached the Mac (and
// vice-versa). Now server-backed + ws-broadcast so every device converges.
// GET /api/prefs/custom-titles → { titles: { [sessionId]: string } }
router.get('/prefs/custom-titles', async (_req, res) => {
  const prefs = await loadPrefs();
  const titles = (prefs.customTitles && typeof prefs.customTitles === 'object') ? prefs.customTitles : {};
  res.json({ titles });
});

// PUT /api/prefs/custom-titles { sessionId, title } → per-key MERGE (not a full
// replace) so two devices renaming different sessions can't clobber each other.
// Empty/whitespace title deletes the override. Broadcasts the full map so all
// connected clients update live without a refresh.
router.put('/prefs/custom-titles', async (req, res) => {
  const { sessionId, title } = req.body || {};
  if (typeof sessionId !== 'string' || !sessionId) {
    return res.status(400).json({ error: 'sessionId 必须是非空字符串' });
  }
  if (title != null && typeof title !== 'string') {
    return res.status(400).json({ error: 'title 必须是字符串' });
  }
  try {
    const prefs = await loadPrefs();
    const map = (prefs.customTitles && typeof prefs.customTitles === 'object') ? prefs.customTitles : {};
    const trimmed = (title || '').trim();
    if (trimmed) map[sessionId] = trimmed;
    else delete map[sessionId];
    prefs.customTitles = map;
    await savePrefs(prefs);
    broadcast({ type: 'custom-titles', titles: map });
    res.json({ ok: true, titles: map });
  } catch (e) {
    res.status(500).json({ error: '写入标题失败：' + e.message });
  }
});

export default router;
