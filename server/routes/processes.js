import { Router } from 'express';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { execSync, execFileSync } from 'child_process';

const router = Router();
const SESSIONS_DIR = join(homedir(), '.claude', 'sessions');

function isProcessAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

function getProcessInfo(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return null;
  try {
    const output = execFileSync('ps', ['-p', String(n), '-o', 'pid,ppid,%cpu,%mem,etime,command'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    const lines = output.trim().split('\n');
    if (lines.length < 2) return null;
    const parts = lines[1].trim().split(/\s+/);
    return {
      pid: parseInt(parts[0]),
      ppid: parseInt(parts[1]),
      cpu: parts[2],
      mem: parts[3],
      elapsed: parts[4],
      command: parts.slice(5).join(' '),
    };
  } catch {
    return null;
  }
}

// GET /api/processes — list all Claude Code processes
router.get('/processes', async (req, res) => {
  try {
    let sessionFiles = [];
    try {
      sessionFiles = (await readdir(SESSIONS_DIR)).filter((f) => f.endsWith('.json'));
    } catch {}

    const processes = [];
    for (const file of sessionFiles) {
      try {
        const raw = await readFile(join(SESSIONS_DIR, file), 'utf-8');
        const session = JSON.parse(raw);
        const pid = session.pid;
        const alive = pid ? isProcessAlive(pid) : false;
        const psInfo = alive ? getProcessInfo(pid) : null;

        processes.push({
          sessionId: session.sessionId || file.replace('.json', ''),
          pid,
          alive,
          cwd: session.cwd || null,
          startedAt: session.startedAt || null,
          psInfo,
        });
      } catch {}
    }

    // Also find claude processes via ps
    let claudeProcesses = [];
    try {
      const psOutput = execSync("ps aux | grep -E 'claude' | grep -v grep | grep -v 'claude-gui'", { encoding: 'utf-8' });
      claudeProcesses = psOutput.trim().split('\n').filter(Boolean).map((line) => {
        const parts = line.trim().split(/\s+/);
        return {
          pid: parseInt(parts[1]),
          cpu: parts[2],
          mem: parts[3],
          elapsed: parts[9],
          command: parts.slice(10).join(' '),
        };
      });
    } catch {}

    res.json({ sessionProcesses: processes, claudeProcesses });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
