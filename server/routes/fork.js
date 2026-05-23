import { Router } from 'express';
import { spawn } from 'child_process';
import { resolve as pathResolve, sep } from 'path';
import { homedir } from 'os';
import { statSync } from 'fs';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// projectHash 是 Claude Code 把路径里的 '/' 换成 '-' 形成的，因此只允许这些字符。
// 显式禁止 '..' 出现：路径段不能为空。
const PROJECT_HASH_RE = /^-?[A-Za-z0-9._-]{1,300}$/;

function resolveProjectCwd(projectHash) {
  if (!PROJECT_HASH_RE.test(projectHash)) return null;
  if (!projectHash.startsWith('-')) return homedir();
  // Reverse the path-mangling: '-' becomes '/'. This produces tokens separated by '/',
  // and the regex above already forbids unsafe characters, so '..' segments cannot occur.
  const candidate = '/' + projectHash.slice(1).replace(/-/g, '/');
  const resolved = pathResolve(candidate);
  // Belt-and-suspenders: reject if pathResolve changed anything (shouldn't, but a stray
  // double slash or trailing '..' would be caught here).
  if (resolved !== candidate && resolved + sep !== candidate) return null;
  try {
    if (!statSync(resolved).isDirectory()) return null;
  } catch { return null; }
  return resolved;
}

router.post('/fork', async (req, res) => {
  const { sessionId, projectHash, prompt } = req.body;
  if (!sessionId || !projectHash) {
    return res.status(400).json({ error: 'sessionId and projectHash required' });
  }
  if (!UUID_RE.test(String(sessionId))) {
    return res.status(400).json({ error: 'invalid sessionId' });
  }

  const cwd = resolveProjectCwd(String(projectHash));
  if (!cwd) return res.status(400).json({ error: 'invalid projectHash' });

  const args = ['--resume', sessionId, '--fork-session'];
  if (prompt) args.push('-p', String(prompt));
  args.push('--output-format', 'stream-json');

  const proc = spawn('claude', args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  const pid = proc.pid.toString();

  let responded = false;
  const respond = (payload, status = 200) => {
    if (responded || res.headersSent) return;
    responded = true;
    res.status(status).json(payload);
  };

  // Don't kill on a fixed timer — wait until we see the sessionId on stdout, then kill.
  // Fall back to a generous 15s safety net so we don't leak a forked process if the CLI
  // never emits the expected event.
  const safety = setTimeout(() => {
    if (!proc.killed) proc.kill('SIGTERM');
  }, 15000);
  safety.unref();

  let buffer = '';
  proc.stdout.on('data', (chunk) => {
    if (responded) return;
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const data = JSON.parse(line);
        const newId = data.sessionId || data.session_id || data.session?.id;
        if (newId) {
          respond({ newSessionId: newId, pid });
          clearTimeout(safety);
          if (!proc.killed) proc.kill('SIGTERM');
          return;
        }
      } catch {}
    }
  });

  proc.on('close', () => {
    clearTimeout(safety);
    respond({ pid, message: 'Fork initiated. Check sessions list for the new session.' });
  });

  proc.on('error', (err) => {
    clearTimeout(safety);
    respond({ error: err.message }, 500);
  });
});

export default router;
