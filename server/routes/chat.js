import { Router } from 'express';
import { spawn, execFileSync } from 'child_process';
import { resolve as pathResolve, dirname, join as pathJoin, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { getDefaultModel } from '../services/model-resolver.js';
import { dropPendingForSession } from './permissions.js';
import { broadcast } from '../index.js';

// T2: 回合完成 WS 通知。前端切走会话时 SSE fetch 已被 abort(I4 渲染隔离的
// 切会话 effect),完成信号唯一可靠的来源是服务端。每个进程只广播一次;三条
// stdout 路径(spawn 早期缓冲 / attached 实时 / detached 缓冲)都喂到这里。
// 客户端(useWebSocket)收到后:非当前聚焦会话 → 顶部悬浮提醒。
function maybeBroadcastTurnComplete(slot, line) {
  if (slot.completeNotified) return;
  let obj;
  try { obj = JSON.parse(line); } catch { return; }
  if (obj.type !== 'result') return;
  slot.completeNotified = true;
  // W3②:stream-json 输入模式下 CLI 等 stdin 关闭才退出 —— 回合 result 一到就
  // 关闭 stdin,进程随即正常退出(实测 EXIT 0)。三条 stdout 路径都汇到这里,
  // 不会漏;万一漏了还有进程面板手动停止 + 应用退出杀树兜底。
  try { slot.proc?.stdin?.end(); } catch {}
  const text = typeof obj.result === 'string' ? obj.result : '';
  const cwd = String(slot.cwd || '');
  try {
    broadcast({
      type: 'turn-complete',
      sessionId: obj.session_id || slot.sessionId || null,
      // cc 的 projectHash 编码:路径中所有非字母数字字符(/ . 空格等)→ '-'
      projectHash: cwd ? cwd.replace(/[^A-Za-z0-9]/g, '-') : null,
      isError: !!obj.is_error,
      summary: text.replace(/[#*`>\s]+/g, ' ').trim().slice(0, 160),
    });
  } catch {}
}

const __dirname = dirname(fileURLToPath(import.meta.url));

const router = Router();

// 客户端断连后 detachedStdout 会持续把 stdout 推进 earlyLines。给它上限防止长
// 会话+长时间断连下无界增长 OOM。超限停止缓冲 —— 重连时 fetchMessages 从 jsonl
// 读完整历史兜底,不丢数据。
const MAX_EARLY_LINES = 5000;

// Windows:npm 装的 claude 是 claude.cmd,Node spawn 无法直接执行(.cmd 必须经
// cmd.exe;Node 出于安全也拒绝直接跑 .cmd)。这里解析真实路径并缓存:仅当它是
// .cmd/.bat 时用 cmd.exe /c 包一层,并把超长的 --settings inline JSON 落临时文件
// 传路径(避开 cmd.exe 对 JSON 引号的破坏)。非 Windows / native claude.exe 路径
// 完全不变(仍裸 'claude' + 原 args),对现有可用环境零回归。
let _winClaudePath; // undefined=未解析, null=失败, string=路径
function resolveWinClaude() {
  if (_winClaudePath !== undefined) return _winClaudePath;
  try {
    const out = execFileSync('where', ['claude'], { timeout: 5000 }).toString();
    _winClaudePath = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || null;
  } catch { _winClaudePath = null; }
  return _winClaudePath;
}
function settingsArgsToTempFile(args) {
  const idx = args.indexOf('--settings');
  if (idx === -1 || idx + 1 >= args.length) return args;
  const val = args[idx + 1];
  if (typeof val !== 'string' || !val.trim().startsWith('{')) return args; // 已是路径
  try {
    const f = pathJoin(tmpdir(), `cgui-settings-${process.pid}-${Math.round(process.hrtime()[1])}.json`);
    writeFileSync(f, val, 'utf8');
    const next = args.slice();
    next[idx + 1] = f;
    return next;
  } catch { return args; }
}
export function claudeSpawn(args, opts) {
  if (process.platform === 'win32') {
    const resolved = resolveWinClaude();
    if (resolved && /\.(cmd|bat)$/i.test(resolved)) {
      return spawn('cmd.exe', ['/c', resolved, ...settingsArgsToTempFile(args)], opts);
    }
  }
  return spawn('claude', args, opts);
}

// 跨平台杀进程树。Windows 不支持 POSIX signal,proc.kill('SIGTERM') 只杀直接子
// (claude CLI 本身),它派生的 node/MCP 子进程留在系统里继续吃 CPU。Windows 必
// 须用 `taskkill /F /T /PID` (/T = 杀整树,/F = 强制) 才能彻底清理。Bug #1。
function killProcessTree(proc) {
  if (!proc || proc.killed) return;
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore' }); } catch {}
  } else {
    proc.kill('SIGTERM');
    setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL'); }, 5000).unref();
  }
}

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
    appendSystemPrompt,
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
  // W3②:prompt 不再走 -p 位置参数,改 stream-json 从 stdin 写入 —— stdin 保持
  // 打开作为 control 通道,支持回合中途 set_permission_mode(进程内即时切模式,
  // plan 模式切出立即生效)。CLI 2.1.170 实测:协议返回 control_response success,
  // /compact 等斜杠命令经 stdin 消息同样生效,result 后 stdin.end() 进程干净退出。
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model', model,
  ];
  if (typeof appendSystemPrompt === 'string' && appendSystemPrompt.trim()) {
    args.push('--append-system-prompt', appendSystemPrompt.trim().slice(0, 8000));
  }
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
  // - 'bypassPermissions' REDEFINED:auto-allow all EXCEPT AskUserQuestion.
  //   原实现走 --dangerously-skip-permissions 彻底跳过 hook → AskUserQuestion
  //   在 -p mode 被 CLI reject(headless 禁用) → AI 直接用文本提问而不弹窗。
  //   现在仍注入 hook,只是用 CGUI_BYPASS_ALL_EXCEPT_ASK env 让 hook 对非 ask
  //   工具立即 auto-allow,AskUserQuestion 仍走 GUI 弹窗。(Bug #10)
  let cliMode = chosenMode;
  let autoAllowList = [];
  let bypassExceptAsk = false;
  if (chosenMode === 'acceptEdits') {
    cliMode = 'default';
    autoAllowList = ['Read', 'Glob', 'Grep', 'LS', 'TodoWrite', 'NotebookRead', 'Skill'];
  } else if (chosenMode === 'bypassPermissions') {
    // 放任模式 = cc 原生 --dangerously-skip-permissions:彻底跳过 hook + 文件沙箱,
    // 用户电脑上任何文件都能读/写、任何命令都放行(用户明确要求,纯壳子行为)。
    // 代价:AskUserQuestion 在 -p headless 下被 CLI 禁用 → AI 退化成文本提问(可接受)。
    // 之前为保 ask 弹窗改成 default+hook,反而让 cc 文件沙箱重新生效、Downloads 等
    // cwd 外文件读不了(用户报告 #8 回归)。放任就该无沙箱,这里恢复真 skip。
    cliMode = 'bypassPermissions';
  }
  if (cliMode === 'bypassPermissions') {
    args.push('--dangerously-skip-permissions');
  } else {
    args.push('--permission-mode', cliMode);
  }
  // GUI permission bridge — inject a PreToolUse hook that POSTs each tool
  // call to our server and waits for the user's Allow/Deny click. The hook
  // is passed inline via --settings, so we never touch the user's real
  // settings.json — and the hook only fires for this single GUI spawn.
  // (bypassPermissions 路径上面已 cliMode='default' + bypassExceptAsk,所以
  //  hook 仍然注入,这里恒真,留这层 if 是为日后真"完全跳过"逃生口预留)
  let permissionGateEnabled = false;
  if (cliMode !== 'bypassPermissions') {
    const hookScript = pathResolve(__dirname, '..', 'hooks', 'permission-bridge.js');
    // Hook 命令:用 server 自身的 node 绝对路径 + 正斜杠构造,避免两个 Windows 坑:
    //  ① 裸 `node` 依赖 PATH — claude 子进程(native claude.exe)的 PATH 里未必有
    //     node,hook 起不来 → 工具调用报错(用户报告的 Windows exit code 49)。
    //  ② `JSON.stringify(winPath)` 会把反斜杠转义成 `\\`,叠加 --settings 外层 JSON
    //     再转义 → 传到 node 的路径含双反斜杠。node 在 Windows 也接受正斜杠,改用
    //     正斜杠 + 简单引号最稳。Mac 上 execPath 无反斜杠,正斜杠替换是 no-op。
    const nodeBin = (process.execPath || 'node').replace(/\\/g, '/');
    const hookCommand = `"${nodeBin}" "${hookScript.replace(/\\/g, '/')}"`;
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
          { hooks: [{ type: 'command', command: hookCommand }] },
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
    // the live keychain (`Claude Code-credentials`) and auto-refresh via refreshToken.
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
      // 放任模式新语义:非 AskUserQuestion 一律 auto-allow,ask 仍走 GUI 弹窗。
      if (bypassExceptAsk) {
        childEnv.CGUI_BYPASS_ALL_EXCEPT_ASK = '1';
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
    proc = claudeSpawn(args, {
      cwd: workingDir,
      // W3②:stdin 改 pipe —— stream-json 输入模式下 CLI 等的是"消息行",不是
      // stdin 关闭(旧注释里"pipe 导致 CLI 卡等"是 -p <prompt> 位置参数时代的行为)。
      // spawn 后立刻写入 user 消息,之后 stdin 留作 control 通道。
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
    });
    // 立刻写入本回合的用户消息。失败(EPIPE 等)由 proc 'error'/'close' 兜底。
    try {
      proc.stdin.write(JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: prompt }] },
      }) + '\n');
    } catch {}
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
      if (slot.earlyLines.length < MAX_EARLY_LINES) slot.earlyLines.push(line);
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
      maybeBroadcastTurnComplete(slot, line);
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

// W3②:回合进行中切换权限模式 —— 向该会话所有存活 CLI 进程的 stdin 写
// control_request set_permission_mode,进程内立即生效(plan 模式切出后模型
// 当场停止规划行为)。GUI 模式语义映射:acceptEdits 在 GUI 里被重定义为
// "default + hook 分级放行",对 CLI 仍是 default;其余直传。best-effort:
// 老版本 CLI 不响应也无害(客户端还有 ExitPlanMode deny 止血双保险)。
router.post('/chat/permission-mode', (req, res) => {
  const { sessionId, mode } = req.body || {};
  if (!sessionId || !mode || !VALID_PERMISSION_MODES.has(mode)) {
    return res.status(400).json({ error: 'sessionId 与合法 mode 必填' });
  }
  const cliMode = mode === 'acceptEdits' ? 'default' : mode;
  let delivered = 0;
  for (const slot of activeProcesses.values()) {
    if (slot.sessionId !== sessionId) continue;
    if (slot.exitCode !== null) continue;
    try {
      if (slot.proc?.stdin?.writable) {
        slot.proc.stdin.write(JSON.stringify({
          type: 'control_request',
          request_id: 'cgui-mode-' + Date.now(),
          request: { subtype: 'set_permission_mode', mode: cliMode },
        }) + '\n');
        slot.permissionMode = mode;
        delivered++;
      }
    } catch {}
  }
  res.json({ ok: true, delivered });
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
  let keepAlive = null;
  const safeWrite = (data) => {
    if (closed || !res.writable) return false;
    try { res.write(data); return true; }
    catch { closed = true; return false; }
  };
  const safeEnd = () => {
    if (closed) return;
    closed = true;
    if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
    try { res.end(); } catch {}
  };

  // Flush early buffer first (lines that arrived before client attached)
  for (const line of slot.earlyLines) safeWrite('data: ' + line + '\n\n');
  for (const err of slot.earlyErrors) {
    safeWrite(`data: ${JSON.stringify({ type: 'error', error: err })}\n\n`);
  }
  slot.earlyLines.length = 0;
  slot.earlyErrors.length = 0;

  // SSE heartbeat. Big sessions can take 20s+ before the first token (the model
  // thinking over a multi-MB history). An idle SSE connection gets cut by the
  // network / OS / WebView in that window → the client's reader ends with NO
  // content → a false "provider 没有返回" warning, and the real reply only shows
  // after the jsonl refetch. A periodic comment line keeps the pipe warm until
  // real tokens flow. ': '-prefixed lines are ignored by the client (it only
  // parses 'data: ' lines), so they're invisible noise that just holds the wire.
  keepAlive = setInterval(() => {
    if (!safeWrite(': keep-alive\n\n')) { clearInterval(keepAlive); keepAlive = null; }
  }, 10000);

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
          maybeBroadcastTurnComplete(slot, line);
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
    // CLI stderr is NOT inherently fatal. With --verbose it carries diagnostics,
    // retry / rate-limit notices, /compact progress, Node deprecation warnings —
    // forwarding each line as type:'error' flashed a ❌ bubble and aborted the
    // turn mid-stream (the "/compact 报错后恢复" bug, plus spurious mid-turn
    // errors). Emit type:'stderr' instead: the streaming loop ignores unknown
    // event types, so it neither breaks nor renders. Genuine failures still
    // surface via result.is_error, the proc 'error' handler, or the empty-turn
    // fallback — none of which depend on stderr.
    const text = chunk.toString().trim();
    if (text) safeWrite(`data: ${JSON.stringify({ type: 'stderr', text })}\n\n`);
  };
  let streamFinished = false;
  const finish = (code) => {
    // 幂等:result 事件(completeTurn)和进程 close(onProcClose)都会调到这里,
    // 没有守卫会重复调度 setTimeout(activeProcesses.delete) → 多余 timer/闭包泄漏。
    if (streamFinished) return;
    streamFinished = true;
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
    setTimeout(() => killProcessTree(proc), 5000).unref();
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
    if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
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
      for (const l of lines) {
        if (!l.trim()) continue;
        if (slot.earlyLines.length < MAX_EARLY_LINES) slot.earlyLines.push(l);
        // T2: detached(用户在看别的会话)期间到达 result —— 正是悬浮提醒的主场景。
        maybeBroadcastTurnComplete(slot, l);
      }
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
  killProcessTree(slot.proc);
  res.json({ ok: true });
});

// POST /api/chat/title  { firstUser, firstAssistant?, cwd? }
// One-shot, isolated `claude -p` call that summarizes the opening exchange into a
// short session title. Does NOT --resume any session (writes no session jsonl) and
// injects no permission hook. Env is stripped the same way as the main chat spawn so
// the user's configured provider (settings.json) is honoured, not inherited official
// ANTHROPIC_* vars. Best-effort: any failure → 200 with empty title so the client
// silently falls back to the first message.
router.post('/chat/title', async (req, res) => {
  const firstUser = String(req.body?.firstUser || '').slice(0, 2000).trim();
  const firstAssistant = String(req.body?.firstAssistant || '').slice(0, 1500).trim();
  // 会话当前模型:标题必须用和正文同一个 provider+模型,否则落到 settings.json 的
  // small/fast 默认(如不存在的 mimo-v2.5)→ 标题永远失败(用户报告)。剥掉 [1m] 后缀。
  const model = String(req.body?.model || '').replace(/\[1m\]/i, '').trim();
  if (!firstUser) return res.json({ title: '' });

  const prompt = `给下面这段对话起一个不超过 12 个字的简短中文标题,只输出标题本身,不要引号、不要标点结尾、不要解释。\n\n用户: ${firstUser}\n${firstAssistant ? `助手: ${firstAssistant}\n` : ''}`;

  const childEnv = { ...process.env };
  delete childEnv.ANTHROPIC_MODEL;
  delete childEnv.CLAUDE_MODEL;
  for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME', 'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME', 'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
    'ANTHROPIC_REASONING_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL',
    'ANTHROPIC_PERMISSION_MODE', 'CLAUDE_PERMISSION_MODE', 'CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS']) {
    delete childEnv[k];
  }

  let proc;
  try {
    // --no-session-persistence:标题生成是一次性调用,绝不能落盘成会话 jsonl,否则项目
    // 会话列表里会冒出"给下面这段对话起标题…"的空白会话(刷新后可见,用户报告 #5)。
    const titleArgs = ['-p', prompt, '--permission-mode', 'plan', '--no-session-persistence'];
    if (model) titleArgs.push('--model', model);
    proc = claudeSpawn(titleArgs, {
      cwd: typeof req.body?.cwd === 'string' && req.body.cwd ? req.body.cwd : homedir(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv,
    });
  } catch {
    return res.json({ title: '' });
  }
  if (!proc.pid) return res.json({ title: '' });

  let out = '';
  let done = false;
  const finish = (title) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try { killProcessTree(proc); } catch {}
    // 清洗:去引号/换行/常见前缀,截断到 ~20 字
    const clean = String(title || '')
      .replace(/[\r\n]+/g, ' ')
      .replace(/^["'「『]+|["'」』]+$/g, '')
      .replace(/^(标题|title)\s*[:：]\s*/i, '')
      .trim()
      .slice(0, 24);
    res.json({ title: clean });
  };
  const timer = setTimeout(() => finish(out), 30000);
  proc.stdout.on('data', (c) => { out += c.toString(); });
  proc.on('close', () => finish(out));
  proc.on('error', () => finish(''));
});

// ── Context breakdown (#1) ────────────────────────────────────────────────
// Run the CLI's `/context` slash command against a FORKED copy of the session
// (--fork-session → new session id, original jsonl untouched) and parse the
// markdown table it emits. /context is a local command (no model call), so it
// returns in ~3s. We delete the forked jsonl afterwards so it doesn't litter.
export function cleanChildEnv() {
  const env = { ...process.env };
  for (const k of [
    'ANTHROPIC_MODEL', 'CLAUDE_MODEL',
    'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME', 'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME', 'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
    'ANTHROPIC_REASONING_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL',
    'ANTHROPIC_PERMISSION_MODE', 'CLAUDE_PERMISSION_MODE', 'CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS',
  ]) delete env[k];
  return env;
}

function parseTokNum(s) {
  s = String(s).trim().replace(/,/g, '');
  const m = s.match(/^([\d.]+)\s*([kKmM]?)/);
  if (!m) return 0;
  let n = parseFloat(m[1]);
  if (/k/i.test(m[2])) n *= 1000;
  else if (/m/i.test(m[2])) n *= 1_000_000;
  return Math.round(n);
}

function parseContextMarkdown(md) {
  const out = { model: null, totalTokens: 0, windowTokens: 0, pct: 0, categories: [], mcpServers: [] };
  const mm = md.match(/\*\*Model:\*\*\s*(.+)/);
  if (mm) out.model = mm[1].trim();
  const tk = md.match(/\*\*Tokens:\*\*\s*([\d.,kKmM]+)\s*\/\s*([\d.,kKmM]+)\s*\((\d+)%\)/);
  if (tk) { out.totalTokens = parseTokNum(tk[1]); out.windowTokens = parseTokNum(tk[2]); out.pct = parseInt(tk[3], 10); }
  // Category table is everything before the "### MCP Tools" per-tool section.
  const [catSection, mcpSection = ''] = md.split(/###\s*MCP Tools/i);
  for (const line of catSection.split('\n')) {
    const m = line.match(/^\|\s*([^|]+?)\s*\|\s*([\d.,kKmM]+)\s*\|\s*([\d.]+)%\s*\|/);
    if (!m) continue;
    const name = m[1].trim();
    if (/^category$/i.test(name) || /^-+$/.test(name)) continue;
    out.categories.push({ name, tokens: parseTokNum(m[2]), pct: parseFloat(m[3]) });
  }
  // Aggregate per-tool MCP rows into per-server totals.
  const byServer = {};
  for (const line of mcpSection.split('\n')) {
    const m = line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([\d.,kKmM]+)\s*\|/);
    if (!m) continue;
    const tool = m[1].trim();
    const server = m[2].trim();
    if (/^tool$/i.test(tool) || /^-+$/.test(tool)) continue;
    byServer[server] = (byServer[server] || 0) + parseTokNum(m[3]);
  }
  out.mcpServers = Object.entries(byServer)
    .map(([server, tokens]) => ({ server, tokens }))
    .sort((a, b) => b.tokens - a.tokens);
  return out;
}

router.get('/context/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const cwd = req.query.cwd || process.env.HOME;
  const projectHash = req.query.projectHash || '';
  // V2:不带 --model 时 CLI 按 settings.json 默认模型(如 haiku)计算窗口与显示,
  // 与会话实际模型不符(用户报告:点徽章显示 haiku)。前端把会话当前模型传进来。
  const model = String(req.query.model || '').trim();
  try { if (!statSync(cwd).isDirectory()) throw new Error('nd'); }
  catch { return res.status(400).json({ error: '工作目录无效' }); }

  const args = [
    '-p', '/context',
    '--output-format', 'stream-json',
    '--verbose',
    '--resume', sessionId,
    '--fork-session',
    // 不落盘:/context 只是读当前上下文,fork 副本不该留在磁盘(否则也会冒出空白会话)。
    '--no-session-persistence',
  ];
  if (model) args.push('--model', model);
  let proc;
  try {
    proc = claudeSpawn(args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: cleanChildEnv() });
  } catch (e) { return res.status(500).json({ error: 'spawn claude failed: ' + e.message }); }
  if (!proc.pid) { proc.on('error', () => {}); return res.status(500).json({ error: 'claude CLI not found' }); }

  let out = '';
  let forkedSid = null;
  let done = false;
  const cleanupFork = () => {
    if (forkedSid && projectHash && forkedSid !== sessionId) {
      try { unlinkSync(pathJoin(homedir(), '.claude', 'projects', projectHash, `${forkedSid}.jsonl`)); } catch {}
    }
  };
  const finish = (payload, code = 200) => {
    if (done) return; done = true;
    clearTimeout(timer);
    try { killProcessTree(proc); } catch {}
    cleanupFork();
    if (!res.headersSent) res.status(code).json(payload);
  };
  const timer = setTimeout(() => finish({ error: '/context 超时' }, 504), 30000);

  proc.stdout.on('data', (c) => {
    out += c.toString();
    if (!forkedSid) {
      for (const ln of out.split('\n')) {
        if (!ln.trim()) continue;
        try { const o = JSON.parse(ln); if (o.type === 'system' && o.subtype === 'init' && o.session_id) { forkedSid = o.session_id; break; } } catch {}
      }
    }
  });
  proc.on('close', () => {
    let md = '';
    for (const ln of out.split('\n')) {
      if (!ln.trim()) continue;
      try {
        const o = JSON.parse(ln);
        if (o.type === 'result' && typeof o.result === 'string' && o.result.includes('Context Usage')) md = o.result;
      } catch {}
    }
    if (!md) return finish({ error: '未获取到 /context 输出' }, 502);
    finish({ raw: md, ...parseContextMarkdown(md) });
  });
  proc.on('error', (e) => finish({ error: e.message }, 500));
});

export default router;
