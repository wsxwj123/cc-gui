import { Router } from 'express';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { execFileSync } from 'child_process';
import { getActiveChatProcesses } from './chat.js';

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

    // Index chat.js's in-memory map by pid so we can attach the actual prompt
    // / model / mode the GUI launched the process with.
    const chatByPid = {};
    for (const c of getActiveChatProcesses()) {
      chatByPid[String(c.pid)] = c;
    }

    const processes = [];
    for (const file of sessionFiles) {
      try {
        const raw = await readFile(join(SESSIONS_DIR, file), 'utf-8');
        const session = JSON.parse(raw);
        const pid = session.pid;
        const alive = pid ? isProcessAlive(pid) : false;
        const psInfo = alive ? getProcessInfo(pid) : null;
        const chat = chatByPid[String(pid)] || null;

        processes.push({
          sessionId: session.sessionId || file.replace('.json', ''),
          pid,
          alive,
          cwd: session.cwd || null,
          startedAt: session.startedAt || chat?.startedAt || null,
          kind: session.kind || (chat ? 'gui-chat' : null),
          entrypoint: session.entrypoint || null,
          // Rich metadata when GUI spawned this process
          promptPreview: chat?.promptPreview || null,
          model: chat?.model || null,
          permissionMode: chat?.permissionMode || null,
          status: chat ? (chat.attached ? 'streaming' : 'starting') : (alive ? 'running' : 'ended'),
          psInfo,
        });
      } catch {}
    }

    // Also find claude processes via ps — no shell, filter in JS to avoid a
    // shell pipe (`ps aux | grep`) spawning /bin/sh on every poll.
    let claudeProcesses = [];
    try {
      const psOutput = execFileSync('ps', ['aux'], { encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024 });
      claudeProcesses = psOutput.trim().split('\n').filter((line) => {
        return /\bclaude\b/.test(line) && !/claude-gui/.test(line) && !/\bgrep\b/.test(line);
      }).map((line) => {
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

// POST /api/processes/:pid/kill — SIGTERM then SIGKILL fallback.
// Only honored for PIDs that show up in our session registry OR are visibly
// claude/node children — refuses arbitrary PIDs to avoid being a kill-anything
// service when bound to 0.0.0.0.
router.post('/processes/:pid/kill', async (req, res) => {
  const pid = Number(req.params.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    return res.status(400).json({ error: 'invalid pid' });
  }
  // Whitelist check: must be in ~/.claude/sessions/*.json
  let allowed = false;
  try {
    const files = (await readdir(SESSIONS_DIR)).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      try {
        const raw = await readFile(join(SESSIONS_DIR, f), 'utf-8');
        const s = JSON.parse(raw);
        if (Number(s.pid) === pid) { allowed = true; break; }
      } catch {}
    }
  } catch {}
  if (!allowed) {
    return res.status(403).json({ error: 'pid not in claude session registry — refused' });
  }
  try {
    process.kill(pid, 'SIGTERM');
    setTimeout(() => { try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch {} }, 5000).unref();
    res.json({ ok: true, pid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
