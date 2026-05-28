#!/usr/bin/env node
/**
 * GUI permission bridge — PreToolUse hook script.
 *
 * Flow:
 *   1. Claude CLI invokes this script before every tool call, piping the tool
 *      info as JSON to stdin.
 *   2. If env var CGUI_PERMISSION_GATE is unset, allow silently. This guards
 *      against the hook accidentally landing in user's global settings.json
 *      and gating non-GUI claude invocations.
 *   3. POST the request to the GUI server, which holds the response open
 *      until the user clicks Allow / Deny in the browser.
 *   4. Emit the CLI-format decision JSON on stdout. `{"continue":true}` to
 *      allow, `{"decision":"block","reason":"..."}` to deny.
 *
 * Stdin shape (best-effort — Claude's hook schema evolves):
 *   { tool_name, tool_input, session_id, hook_event_name, ... }
 *
 * The hook MUST exit 0 even on error — exit-non-zero is interpreted as a hard
 * failure by the CLI. On any internal error we fail-open (allow) so the GUI
 * bug doesn't break the user's CLI.
 */

import http from 'node:http';

const FAIL_OPEN_TIMEOUT_MS = 10 * 60 * 1000; // 10min — user has time to click

function allow(reason) {
  process.stdout.write(JSON.stringify({ continue: true }));
  if (reason) process.stderr.write(`[cgui-permission] allow: ${reason}\n`);
  process.exit(0);
}
function deny(reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason: reason || '用户拒绝该工具调用' }));
  process.exit(0);
}

// 1. Read all of stdin
let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', main);

async function main() {
  let payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch {}

  // 2. Gate by env var — non-GUI invocations are allowed silently
  if (!process.env.CGUI_PERMISSION_GATE) {
    allow('not GUI-spawned');
  }
  const port = process.env.CGUI_SERVER_PORT || '6677';

  // 2.5 Auto-allow read-class tools when the GUI is in "接受编辑" mode. Set
  // by chat.js as CGUI_AUTO_ALLOW_TOOLS=Read,Glob,Grep,... Skips the POST →
  // popup → response round-trip for safe tools, so the user only sees
  // popups for actually-risky operations (writes, network, subagent spawn).
  const autoAllowList = (process.env.CGUI_AUTO_ALLOW_TOOLS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const toolName = payload.tool_name || payload.toolName || '';
  if (autoAllowList.length > 0 && autoAllowList.includes(toolName)) {
    allow(`auto-allow ${toolName} (read-class)`);
  }

  // Plan mode: let EXPLORATION flow (Read, Grep, Bash, Agent/Task subagents…)
  // so the turn doesn't freeze on the first exploration tool, while still
  // gating ExitPlanMode (→ plan-review card) and, as defense-in-depth, any
  // write-class tool (a plan-mode turn shouldn't be editing files; if it tries,
  // make the user confirm rather than silently allowing it).
  const PLAN_GATED = ['ExitPlanMode', 'Edit', 'Write', 'NotebookEdit'];
  if (process.env.CGUI_PLAN_MODE && !PLAN_GATED.includes(toolName)) {
    allow(`plan-mode passthrough ${toolName}`);
  }

  // 3. POST to server and wait for user decision
  const body = JSON.stringify({
    toolName: payload.tool_name || payload.toolName || 'unknown',
    toolInput: payload.tool_input || payload.toolInput || {},
    sessionId: payload.session_id || payload.sessionId || null,
    cwd: payload.cwd || process.cwd(),
    hookEvent: payload.hook_event_name || 'PreToolUse',
  });

  let result;
  try {
    result = await postJson(`http://127.0.0.1:${port}/api/permissions/request`, body, FAIL_OPEN_TIMEOUT_MS);
  } catch (err) {
    // Server unreachable — fail OPEN. The user's CLI shouldn't be paralyzed
    // because the GUI server died. They can still see/manage permissions in
    // the GUI when it's back up.
    allow(`bridge error: ${err.message}`);
  }

  if (result && result.decision === 'allow') allow('user approved');
  else deny(result?.reason || '用户拒绝');
}

function postJson(url, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: timeoutMs,
    }, (res) => {
      let chunks = '';
      res.setEncoding('utf-8');
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(chunks)); }
        catch (e) { reject(new Error(`bad response: ${chunks.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}
