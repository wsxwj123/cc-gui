import { Router } from 'express';
import { getUsageStats } from '../services/usage-stats.js';

const router = Router();

// GET /api/usage — aggregated usage statistics
router.get('/usage', async (req, res) => {
  try {
    const stats = await getUsageStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
