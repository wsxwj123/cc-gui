import { Router } from 'express';
import { spawn } from 'child_process';
import { resolve as pathResolve, dirname, join as pathJoin, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, statSync } from 'node:fs';
import { getDefaultModel } from '../services/model-resolver.js';
import { dropPendingForSession } from './permissions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const router = Router();

// procId → {
//   proc, earlyLines, earlyTail, earlyErrors, exitCode, attached,
//   sessionId, cwd, model, promptPreview, permissionMode, startedAt
// }
// Exported via getActiveChatProcesses() so the agents/processes routes can
// surface the live list to the GUI's Subagent monitor panel.
const activeProcesses = new Map();

export function getActiveChatProcesses() {
  const out = [];
  for (const [procId, slot] of activeProcesses) {
    out.push({
      pid: procId,
      sessionId: slot.sessionId || null,
      cwd: slot.cwd || null,
      model: slot.model || null,
      promptPreview: slot.promptPreview || '',
      permissionMode: slot.permissionMode || 'default',
      startedAt: slot.startedAt || null,
      finishedAt: slot.finishedAt || null,
      exitCode: slot.exitCode,
      attached: slot.attached,
    });
  }
  return out;
}

const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const VALID_PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'bypassPermissions']);

router.post('/chat', async (req, res) => {
  const {
    prompt, sessionId, cwd,
    model: requestedModel,
    effort, addDirs,
    permissionMode,
    globalRead,
  } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  const model = requestedModel || await getDefaultModel();
  // DO NOT normalize cwd here. Claude CLI hashes the EXACT cwd string to
  // locate the session jsonl under ~/.claude/projects/<hash>/. Sessions
  // created with a malformed cwd (e.g. `/Users/foo/bar////`) live in
  // `-Users-foo-bar----` dirs. If we normalize cwd before spawning,
  // CLI computes a different hash and resume fails with "No conversation
  // found with session ID". The client sends the cwd that matches each
  // session's original storage; we trust it as-is for CLI spawn.
  const workingDir = cwd || process.env.HOME;

  // Validate the working dir exists and is a directory. A session whose project
  // folder was deleted or moved (e.g. a stale cwd like /Desktop/gui) otherwise
  // makes the CLI sit ~3min in an invalid dir before exiting 1 — surfacing in
  // the UI as a stuck "connecting" with no reply. Fail fast with a clear message.
  try {
    if (!statSync(workingDir).isDirectory()) throw new Error('not a directory');
  } catch {
    return res.status(400).json({
      error: `工作目录不存在或无法访问：${workingDir}\n该项目可能已被删除或移动，请在左侧选择一个有效的项目后重试。`,
    });
  }

  // `--print` + `--output-format=stream-json` requires `--verbose` on recent CLI versions,
  // otherwise the CLI refuses to start and exits with code 1 before any stream data.
  // `--include-partial-messages` switches the CLI from per-message snapshots to
  // token-level `stream_event` deltas (content_block_delta etc.), letting the GUI
  // render text/thinking/tool input as it streams in, matching the CLI terminal UX.
  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model', model,
  ];
  if (sessionId) args.push('--resume', sessionId);
  if (effort && VALID_EFFORTS.has(effort)) args.push('--effort', effort);
  // Permission mode: default | acceptEdits | plan | bypassPermissions.
  // bypassPermissions needs the `--dangerously-skip-permissions` flag instead
  // (CLI rejects `--permission-mode bypassPermissions` directly without it).
  //
  // IMPORTANT: we always pass --permission-mode explicitly (including 'default')
  // so that any settings.json default (`skipDangerousModePermissionPrompt: true`,
  // a saved permissionMode, etc.) does NOT silently win. Previously, picking
  // 'default' in the GUI sent no flag, and the CLI fell back to the user's
  // settings, which is why every mode "felt like bypass".
  const chosenMode = (permissionMode && VALID_PERMISSION_MODES.has(permissionMode))
    ? permissionMode
    : 'default';
  // GUI semantics override:
  // - GUI's "acceptEdits" is REDEFINED to mean "read-class auto, write-class
  //   prompt" (CLI's own acceptEdits is the opposite: writes auto). We pass
  //   --permission-mode default to the CLI so everything routes through our
  //   PreToolUse hook, then the hook auto-allows tools in the safe list and
  //   prompts for the rest.
  // - 'default' / 'plan' pass through unchanged.
  // - 'bypassPermissions' skips the hook entirely.
  let cliMode = chosenMode;
  let autoAllowList = [];
  if (chosenMode === 'acceptEdits') {
    cliMode = 'default';
    autoAllowList = ['Read', 'Glob', 'Grep', 'LS', 'TodoWrite', 'NotebookRead', 'Skill'];
  }
  if (cliMode === 'bypassPermissions') {
    args.push('--dangerously-skip-permissions');
  } else {
    args.push('--permission-mode', cliMode);
  }
  // GUI permission bridge — inject a PreToolUse hook that POSTs each tool
  // call to our server and waits for the user's Allow/Deny click. Only when
  // NOT bypassing (bypass means user opted out of all gating anyway). The
  // hook is passed inline via --settings, so we never touch the user's real
  // settings.json — and the hook only fires for this single GUI spawn.
  let permissionGateEnabled = false;
  if (cliMode !== 'bypassPermissions') {
    const hookScript = pathResolve(__dirname, '..', 'hooks', 'permission-bridge.js');
    // Merge user's existing PreToolUse hooks so any external observers the user
    // configured keep firing alongside our permission bridge. `--settings`
    // OVERRIDES same-event arrays from user scope (not union), so without this
    // merge any tool that relies on PreToolUse silently dies under GUI spawn.
    // Our bridge runs FIRST in the array; user hooks tail along. They're
    // expected to be best-effort (`|| true`) anyway.
    let userPreToolUse = [];
    try {
      const userSettingsPath = pathJoin(process.env.HOME || '', '.claude', 'settings.json');
      const userSettings = JSON.parse(readFileSync(userSettingsPath, 'utf8'));
      if (Array.isArray(userSettings?.hooks?.PreToolUse)) {
        userPreToolUse = userSettings.hooks.PreToolUse;
      }
    } catch { /* no user settings or unparseable — skip */ }

    const inlineSettings = {
      hooks: {
        PreToolUse: [
          { hooks: [{ type: 'command', command: `node ${JSON.stringify(hookScript)}` }] },
          ...userPreToolUse,
        ],
      },
    };
    args.push('--settings', JSON.stringify(inlineSettings));
    permissionGateEnabled = true;
  }
  // "Global read" — let Claude reach any file under $HOME by default. Writes
  // and edits still go through the normal permission flow (unless the user
  // picked acceptEdits / bypassPermissions). De-duped against explicit addDirs.
  const dirSet = new Set();
  if (globalRead && process.env.HOME) dirSet.add(process.env.HOME);
  if (Array.isArray(addDirs)) {
    for (const dir of addDirs) {
      if (typeof dir === 'string' && isAbsolute(dir)) dirSet.add(dir);
    }
  }
  for (const d of dirSet) args.push('--add-dir', d);

  let proc;
  try {
    // Strip ANTHROPIC_MODEL / CLAUDE_MODEL from the child env so they don't
    // override the explicit `--model` arg the user just picked in the GUI.
    // (settings.json is the source of truth; env was overriding it.)
    const childEnv = { ...process.env };
    delete childEnv.ANTHROPIC_MODEL;
    delete childEnv.CLAUDE_MODEL;
    // Provider ROUTING + AUTH must come solely from settings.json (cc switch and
    // the GUI rewrite it on every provider switch) or the local OAuth login —
    // NOT from inherited process env. This server is typically launched from a
    // Claude-Desktop shell that injects official ANTHROPIC_BASE_URL +
    // ANTHROPIC_API_KEY + ANTHROPIC_AUTH_TOKEN. Those inherited vars take
    // precedence in the CLI, so they silently override the mimo/deepseek/proxy
    // provider the user just switched to: the CLI hits the OFFICIAL endpoint with
    // a third-party model id and dies with "model may not exist" (and would bill
    // an official subscription to API credits). Drop all inherited routing/auth
    // vars so settings.json (or OAuth) wins. Failure mode: a user who relied on a
    // pure-shell ANTHROPIC_API_KEY with no settings.json provider now gets 401 —
    // they must configure the provider in the GUI, which is the intended source.
    // Also drop CLAUDE_CODE_OAUTH_TOKEN: an inherited (stale) value pins the CLI to
    // an old subscription token and blocks it from refreshing the keychain OAuth on
    // its own, causing 401 once that token expires. Removing it lets the CLI read
    // the live keychain (`Claude Code-credentials`) and auto-refresh via refreshToken
    // — the same reason restart-bots.sh `unset`s it before nudging a refresh.
    for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) {
      delete childEnv[k];
    }
    // Strip inherited tier-alias overrides. When this server is launched from a
    // Claude-Desktop shell that had a third-party provider active (deepseek/mimo),
    // it inherits ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL pointing at that
    // provider's models. These env vars OUTRANK settings.json, so picking the
    // `opus`/`sonnet`/`haiku` alias (here or in the terminal) silently resolves to
    // the stale third-party model instead of the official tier — e.g. `opus` →
    // `deepseek-v4-pro`, which is why the real Opus never appears. The legitimate
    // per-provider values live in settings.json and still apply after this strip.
    for (const k of [
      'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME', 'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME', 'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
      'ANTHROPIC_REASONING_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL',
    ]) {
      delete childEnv[k];
    }
    // Strip permission-related env so the CLI honours our --permission-mode
    // flag instead of an inherited override that could force bypass.
    delete childEnv.ANTHROPIC_PERMISSION_MODE;
    delete childEnv.CLAUDE_PERMISSION_MODE;
    delete childEnv.CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS;
    // Tell the bridge script it's running for a GUI-spawned CLI. Without
    // this, the script silently allows everything (defensive fallback in
    // case the hook leaks into user's global settings.json somehow).
    if (permissionGateEnabled) {
      childEnv.CGUI_PERMISSION_GATE = '1';
      childEnv.CGUI_SERVER_PORT = String(process.env.PORT || 6677);
      if (autoAllowList.length > 0) {
        childEnv.CGUI_AUTO_ALLOW_TOOLS = autoAllowList.join(',');
      }
      // Plan mode: Claude must be free to EXPLORE (read files, spawn Explore
      // subagents) before it can produce a plan. The CLI's own --permission-mode
      // plan already blocks writes and emits ExitPlanMode at the end, so the
      // bridge should pass everything EXCEPT ExitPlanMode straight through —
      // otherwise the very first exploration tool (often an `Agent` spawn) sits
      // gated forever and the turn looks frozen. Only ExitPlanMode pops the
      // plan-review card.
      if (chosenMode === 'plan') {
        childEnv.CGUI_PLAN_MODE = '1';
      }
    }
    console.log('[chat] spawn', JSON.stringify({
      cwd: workingDir,
      sessionId: sessionId || null,
      model,
      permissionMode: chosenMode,
      promptPreview: String(prompt).slice(0, 60),
    }));
    proc = spawn('claude', args, {
      cwd: workingDir,
      // stdin = 'ignore' is the equivalent of shell `< /dev/null`. With pipe()
      // the CLI sat waiting for stdin to close before producing stream-json,
      // which made the GUI look frozen on the very first tool-using prompt.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv,
    });
  } catch (err) {
    console.log('[chat] spawn FAILED', err.message);
    return res.status(500).json({ error: 'spawn claude failed: ' + err.message });
  }
  // spawn() with ENOENT returns a ChildProcess with no pid and fires 'error'
  // asynchronously. Without a pid we have no slot key — surface it now.
  if (!proc.pid) {
    proc.on('error', () => {});
    return res.status(500).json({ error: 'claude CLI not found in PATH (or failed to spawn)' });
  }
  const procId = proc.pid.toString();
  const slot = {
    proc,
    earlyLines: [],   // JSON-parsed complete lines buffered before /stream attaches
    earlyTail: '',    // incomplete trailing line not yet terminated by \n
    earlyErrors: [],
    exitCode: null,
    attached: false,
    // Metadata for the agent monitor panel
    sessionId: sessionId || null,
    cwd: workingDir,
    model,
    promptPreview: String(prompt).slice(0, 80),
    permissionMode: permissionMode || 'default',
    startedAt: Date.now(),
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
      if (!line.trim()) continue;
      slot.earlyLines.push(line);
      // Capture the runtime sessionId from the CLI's init event so the close
      // handler can clean up pending permission requests even for fresh
      // drafts (where spawn-time sessionId was null).
      if (!slot.sessionId) {
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'system' && obj.subtype === 'init' && obj.session_id) {
            slot.sessionId = obj.session_id;
          }
        } catch {}
      }
    }
  });
  proc.stderr.on('data', (chunk) => {
    if (slot.attached) return;
    const t = chunk.toString().trim();
    if (t) slot.earlyErrors.push(t);
  });

  proc.on('close', (code) => {
    slot.exitCode = code;
    slot.finishedAt = Date.now();
    const dur = Date.now() - slot.startedAt;
    // Drop any pending permission requests for this session — otherwise the
    // hook bridge process stays blocked forever waiting on the held HTTP
    // response. We resolve them as denied so the bridge exits cleanly.
    const effectiveSid = slot.sessionId || sessionId;
    if (effectiveSid) {
      try { dropPendingForSession(effectiveSid); } catch {}
    }
    console.log(`[chat] proc ${procId} exit code=${code} after ${dur}ms attached=${slot.attached} stdoutLines=${slot.earlyLines.length} stderrLines=${slot.earlyErrors.length}`);
    if (slot.earlyErrors.length > 0) {
      console.log(`[chat] proc ${procId} stderr:`, slot.earlyErrors.join(' | ').slice(0, 500));
    }
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

  // Remove the detached re-buffer listeners left by a previous disconnect.
  // Without this, every disconnect→reattach cycle leaks a stdout/stderr pair
  // (they're inert while attached but accumulate → MaxListenersExceededWarning).
  if (slot.detachedStdout) { try { proc.stdout.removeListener('data', slot.detachedStdout); } catch {} slot.detachedStdout = null; }
  if (slot.detachedStderr) { try { proc.stderr.removeListener('data', slot.detachedStderr); } catch {} slot.detachedStderr = null; }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Safe write — never let a write-after-end EPIPE crash the server.
  // If the client disconnects mid-stream, res becomes !writable; subsequent
  // writes throw synchronously inside stdout/stderr listeners, and without a
  // try/catch the error bubbles up to the EventEmitter and kills the process.
  let closed = false;
  const safeWrite = (data) => {
    if (closed || !res.writable) return false;
    try { res.write(data); return true; }
    catch { closed = true; return false; }
  };
  const safeEnd = () => {
    if (closed) return;
    closed = true;
    try { res.end(); } catch {}
  };

  // Flush early buffer first (lines that arrived before client attached)
  for (const line of slot.earlyLines) safeWrite('data: ' + line + '\n\n');
  for (const err of slot.earlyErrors) {
    safeWrite(`data: ${JSON.stringify({ type: 'error', error: err })}\n\n`);
  }
  slot.earlyLines.length = 0;
  slot.earlyErrors.length = 0;

  // Live tail buffer continues from where early buffering stopped
  let buffer = slot.earlyTail;
  slot.earlyTail = '';

  // Turn-completion guards. The CLI's `result` event is the terminal signal of a
  // -p turn; normally the process exits right after and proc.on('close') → finish().
  // But /compact leaves the process ALIVE in -p mode, so without these the SSE
  // stream (and the GUI "connecting" state) would hang forever. See completeTurn.
  let turnDone = false;
  let compactTimer = null;
  const onStdout = (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line); // validate
        // Capture runtime sessionId for close-handler cleanup (same as the
        // early-buffer path — needed when init arrives AFTER /stream attaches).
        if (!slot.sessionId && obj.type === 'system' && obj.subtype === 'init' && obj.session_id) {
          slot.sessionId = obj.session_id;
        }
        safeWrite('data: ' + line + '\n\n');
        // Finish as soon as the turn's terminal signal arrives — don't wait for the
        // process to exit (it may not, e.g. after /compact).
        if (obj.type === 'result') {
          completeTurn(obj.is_error ? (typeof obj.exitCode === 'number' ? obj.exitCode : 1) : 0);
        } else if (obj.type === 'system' && obj.subtype === 'compact_boundary' && !compactTimer && !turnDone) {
          // /compact wrote its summary. A `result` normally follows; if the process
          // hangs instead (no result, no exit), finish anyway after a short grace.
          compactTimer = setTimeout(() => completeTurn(0), 8000);
        }
      } catch {
        // stream-json is one-object-per-line; a non-JSON complete line is junk.
        // Don't try to re-merge — that corrupts later chunks.
        safeWrite(`data: ${JSON.stringify({ type: 'error', error: 'bad-line', raw: line.slice(0, 200) })}\n\n`);
      }
    }
  };
  const onStderr = (chunk) => {
    const text = chunk.toString().trim();
    if (text) safeWrite(`data: ${JSON.stringify({ type: 'error', error: text })}\n\n`);
  };
  const finish = (code) => {
    if (buffer.trim()) {
      try { JSON.parse(buffer); safeWrite(`data: ${buffer}\n\n`); } catch {}
      buffer = '';
    }
    safeWrite(`data: ${JSON.stringify({ type: 'done', exitCode: code })}\n\n`);
    safeEnd();
    // Keep the finished slot around for a grace window so the subagent monitor
    // can show recently-completed turns (状态 已完成/错误 = 会话在等待用户回复),
    // instead of the slot vanishing the instant the stream ends.
    slot.exitCode = code;
    slot.finishedAt = Date.now();
    setTimeout(() => activeProcesses.delete(req.params.pid), 60_000);
  };
  // Finish the stream on the turn's terminal signal (runs once). Then SIGTERM the
  // child after a short grace: a normal turn exits on its own within that window
  // (kill = no-op), but a lingering /compact process gets reaped instead of leaking.
  // Safe to kill here — the turn is over and its jsonl is already fully written.
  const completeTurn = (code) => {
    if (turnDone) return;
    turnDone = true;
    if (compactTimer) { clearTimeout(compactTimer); compactTimer = null; }
    finish(code);
    setTimeout(() => { try { if (!proc.killed) proc.kill('SIGTERM'); } catch {} }, 5000).unref();
  };

  proc.stdout.on('data', onStdout);
  proc.stderr.on('data', onStderr);
  // Attach error listeners on the child streams themselves — without these,
  // a stream error (e.g. pipe broken after SIGTERM) becomes uncaught.
  proc.stdout.on('error', () => {});
  proc.stderr.on('error', () => {});

  // If process already exited before client attached, emit done immediately after flushing.
  if (slot.exitCode !== null) {
    return finish(slot.exitCode);
  }

  // Named (not anonymous) so req.on('close') can remove them on detach — a
  // session reconnected N times would otherwise accumulate N close/error
  // listeners (MaxListenersExceededWarning past 10 + retained closures).
  const onProcClose = (code) => finish(code);
  const onProcError = (err) => {
    safeWrite(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
    safeEnd();
    activeProcesses.delete(req.params.pid);
  };
  proc.on('close', onProcClose);
  proc.on('error', onProcError);

  req.on('close', () => {
    // Client disconnected — STOP WRITING to the SSE response but DO NOT kill
    // the child process. The CLI keeps streaming to its jsonl independently;
    // when the user navigates back to this session, fetchMessages will read
    // whatever has been persisted so far. This implements "detach, don't
    // abort" so a long-running session keeps producing output while the
    // user looks at other sessions.
    closed = true;
    // Remove the close/error listeners registered for THIS attach so repeated
    // reconnects don't pile up listeners on the long-lived child process.
    try { proc.removeListener('close', onProcClose); } catch {}
    try { proc.removeListener('error', onProcError); } catch {}
    // Detach our stdout/stderr listeners so the proc isn't blocked on a
    // backpressured stream and so a future re-attach gets fresh listeners.
    try { proc.stdout.removeListener('data', onStdout); } catch {}
    try { proc.stderr.removeListener('data', onStderr); } catch {}
    // Re-buffer subsequent stdout into earlyLines so a future /stream
    // re-attach can replay anything that arrived while detached.
    slot.attached = false;
    // Name these listeners and stash them on the slot so the next /stream
    // re-attach can remove them (see top of GET /stream) — otherwise they leak.
    slot.detachedStdout = (chunk) => {
      if (slot.attached) return;
      slot.earlyTail += chunk.toString();
      const lines = slot.earlyTail.split('\n');
      slot.earlyTail = lines.pop() || '';
      for (const l of lines) if (l.trim()) slot.earlyLines.push(l);
    };
    slot.detachedStderr = (chunk) => {
      if (slot.attached) return;
      const t = chunk.toString().trim();
      if (t) slot.earlyErrors.push(t);
    };
    proc.stdout.on('data', slot.detachedStdout);
    proc.stderr.on('data', slot.detachedStderr);
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
