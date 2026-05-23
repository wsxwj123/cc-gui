import { Router } from 'express';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

const router = Router();
const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');

// GET /api/settings — read current settings
router.get('/settings', async (req, res) => {
  try {
    const raw = await readFile(SETTINGS_PATH, 'utf-8');
    res.json(JSON.parse(raw));
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.json({});
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

// PUT /api/settings — update settings
router.put('/settings', async (req, res) => {
  try {
    const current = JSON.parse(await readFile(SETTINGS_PATH, 'utf-8'));
    const updated = { ...current, ...req.body };
    await writeFile(SETTINGS_PATH, JSON.stringify(updated, null, 2) + '\n');
    res.json(updated);
  } catch (err) {
    if (err.code === 'ENOENT') {
      await writeFile(SETTINGS_PATH, JSON.stringify(req.body, null, 2) + '\n');
      res.json(req.body);
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

export default router;
