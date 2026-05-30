import { Router } from 'express';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { homedir } from 'os';

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

export default router;
