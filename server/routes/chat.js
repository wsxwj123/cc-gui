import { Router } from 'express';
import { spawn } from 'child_process';
import { getDefaultModel } from '../services/model-resolver.js';

const router = Router();

// Each entry: { proc, earlyLines: string[], earlyTail: string, exitCode: number|null, attached: boolean }
const activeProcesses = new Map();

router.post('/chat', async (req, res) => {
  const { prompt, sessionId, cwd, model: requestedModel } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  const model = requestedModel || await getDefaultModel();
  const workingDir = cwd || process.env.HOME;

  const args = ['-p', prompt, '--output-format', 'stream-json', '--model', model];
  if (sessionId) args.push('--resume', sessionId);

  const proc = spawn('claude', args, {
    cwd: workingDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  const procId = proc.pid.toString();
  const slot = {
    proc,
    earlyLines: [],   // JSON-parsed complete lines buffered before /stream attaches
    earlyTail: '',    // incomplete trailing line not yet terminated by \n
    earlyErrors: [],
    exitCode: null,
    attached: false,
  };
  activeProcesses.set(procId, slot);

  // Buffer stdout/stderr from the moment of spawn so the first chunk isn't lost
  // if the client races between POST and GET /stream.
  proc.stdout.on('data', (chunk) => {
    if (slot.attached) return; // live handler takes over once attached
    slot.earlyTail += chunk.toString();
    const lines = slot.earlyTail.split('\n');
    slot.earlyTail = lines.pop() || '';
    for (const line of lines) {
      if (line.trim()) slot.earlyLines.push(line);
    }
  });
  proc.stderr.on('data', (chunk) => {
    if (slot.attached) return;
    const t = chunk.toString().trim();
    if (t) slot.earlyErrors.push(t);
  });

  proc.on('close', (code) => {
    slot.exitCode = code;
    // Only drop the slot once the client has consumed it (or after 60s grace)
    if (slot.attached) {
      // live handler decides when to delete
    } else {
      setTimeout(() => activeProcesses.delete(procId), 60_000);
    }
  });
  proc.on('error', (err) => {
    slot.earlyErrors.push(err.message);
    slot.exitCode = -1;
    if (!slot.attached) setTimeout(() => activeProcesses.delete(procId), 60_000);
  });

  res.json({ pid: procId, model });
});

router.get('/chat/:pid/stream', (req, res) => {
  const slot = activeProcesses.get(req.params.pid);
  if (!slot) return res.status(404).json({ error: 'Process not found' });
  if (slot.attached) return res.status(409).json({ error: 'Stream already attached' });
  slot.attached = true;
  const { proc } = slot;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Flush early buffer first (lines that arrived before client attached)
  for (const line of slot.earlyLines) res.write('data: ' + line + '\n\n');
  for (const err of slot.earlyErrors) {
    res.write(`data: ${JSON.stringify({ type: 'error', error: err })}\n\n`);
  }
  slot.earlyLines.length = 0;
  slot.earlyErrors.length = 0;

  // Live tail buffer continues from where early buffering stopped
  let buffer = slot.earlyTail;
  slot.earlyTail = '';

  const onStdout = (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        JSON.parse(line); // validate
        res.write('data: ' + line + '\n\n');
      } catch {
        // stream-json is one-object-per-line; a non-JSON complete line is junk.
        // Don't try to re-merge — that corrupts later chunks.
        res.write(`data: ${JSON.stringify({ type: 'error', error: 'bad-line', raw: line.slice(0, 200) })}\n\n`);
      }
    }
  };
  const onStderr = (chunk) => {
    const text = chunk.toString().trim();
    if (text) res.write(`data: ${JSON.stringify({ type: 'error', error: text })}\n\n`);
  };
  const finish = (code) => {
    if (buffer.trim()) {
      try { JSON.parse(buffer); res.write(`data: ${buffer}\n\n`); } catch {}
      buffer = '';
    }
    res.write(`data: ${JSON.stringify({ type: 'done', exitCode: code })}\n\n`);
    res.end();
    activeProcesses.delete(req.params.pid);
  };

  proc.stdout.on('data', onStdout);
  proc.stderr.on('data', onStderr);

  // If process already exited before client attached, emit done immediately after flushing.
  if (slot.exitCode !== null) {
    return finish(slot.exitCode);
  }

  proc.on('close', (code) => finish(code));
  proc.on('error', (err) => {
    res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
    res.end();
    activeProcesses.delete(req.params.pid);
  });

  req.on('close', () => {
    // Client disconnected — kill the process. proc.on('close') will delete the slot.
    if (!proc.killed) {
      proc.kill('SIGTERM');
      setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL'); }, 5000).unref();
    }
  });
});

router.post('/chat/:pid/stop', (req, res) => {
  const slot = activeProcesses.get(req.params.pid);
  if (!slot) return res.status(404).json({ error: 'Process not found' });
  if (!slot.proc.killed) {
    slot.proc.kill('SIGTERM');
    setTimeout(() => { if (!slot.proc.killed) slot.proc.kill('SIGKILL'); }, 5000).unref();
  }
  res.json({ ok: true });
});

export default router;
