import { readdir, stat, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { parseJsonl, readJsonlEdges } from '../utils/jsonl-parser.js';

const HOME = homedir();

// Directories that are claude/GUI infrastructure or transient scratch — not real
// user projects. They otherwise clutter the project list (e.g. ~/.claude/dispatcher
// agent state, ~/.claude/channels bots, ~/.claude-mem observer sessions, /tmp
// scratch dirs, and folders that were deleted/moved so their cwd no longer exists).
function isNonProjectPath(p) {
  if (!p) return true;
  if (!existsSync(p)) return true;                                       // deleted / moved (stale cwd)
  if (p === '/') return true;                                            // filesystem root
  if (p === '/tmp' || p.startsWith('/tmp/') || p.startsWith('/private/tmp')) return true;
  if (p === `${HOME}/.claude` || p.startsWith(`${HOME}/.claude/`)) return true;       // ~/.claude/* internals
  if (p === `${HOME}/.claude-mem` || p.startsWith(`${HOME}/.claude-mem/`)) return true; // claude-mem state
  return false;
}

/**
 * Read the real absolute cwd a GUI-registered project was created with, from
 * the `.cgui-meta.json` sidecar. Returns null when absent (legacy / CLI-made
 * dirs). The sidecar is the only reliable source for non-ASCII paths because
 * the CLI hash collapses Unicode to dashes (one-way, and possibly colliding).
 */
async function readSidecarCwd(projectDir) {
  try {
    const raw = await readFile(join(projectDir, '.cgui-meta.json'), 'utf-8');
    const meta = JSON.parse(raw);
    return typeof meta?.cwd === 'string' && meta.cwd ? meta.cwd : null;
  } catch {
    return null;
  }
}

/**
 * Extract the exact launch cwd from a session jsonl's head records.
 *
 * NOTE: the CLI does NOT put cwd on the `system` record — in real jsonl the
 * `cwd` field rides on `attachment` / `user` / `assistant` records (verified
 * against live data: first cwd appears around line 3 on an `attachment`). The
 * old `type === 'system'` filter therefore returned null on essentially every
 * real session, which silently disabled both the de-collision filter and the
 * Unicode-cwd recovery. Match ANY record that carries a string cwd — all
 * records in one session share the same launch cwd, so the first hit is right.
 */
function cwdFromHead(head) {
  return head.find((r) => typeof r?.cwd === 'string' && r.cwd)?.cwd || null;
}

const CLAUDE_DIR = join(homedir(), '.claude');
const PROJECTS_DIR = join(CLAUDE_DIR, 'projects');
const TRANSCRIPTS_DIR = join(CLAUDE_DIR, 'transcripts');
const SESSIONS_DIR = join(CLAUDE_DIR, 'sessions');

/**
 * Decode project hash back to a readable path.
 * -Users-wsxwj-Desktop-claude → /Users/wsxwj/Desktop/claude
 *
 * Some legacy project dirs in ~/.claude/projects/ have trailing dashes
 * (e.g. `-Users-wsxwj-Desktop-claude----`) — they were created when the CLI
 * was spawned with a cwd ending in extra slashes. Decoding them naively
 * produces `/Users/wsxwj/Desktop/claude////` which then breaks git status,
 * checkpoints, and CLI resume downstream. Collapse multiple slashes here.
 */
function decodeProjectHash(hash) {
  let path = hash.startsWith('-')
    ? '/' + hash.slice(1).replace(/-/g, '/')
    : hash;
  // Collapse runs of `/` and strip trailing `/` (but keep leading `/`).
  path = path.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');
  return path;
}

/**
 * List all projects with session counts.
 */
export async function listProjects() {
  const entries = await readdir(PROJECTS_DIR, { withFileTypes: true });
  const projects = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectPath = join(PROJECTS_DIR, entry.name);
    try {
      const files = await readdir(projectPath);
      const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'));

      // Empty dirs are usually projects that were just registered via
      // `_addProject` but have no chat sessions yet. We DO want to list
      // them — otherwise the user adds a folder and watches it disappear
      // until they send their first message. Use directory mtime as a
      // proxy for activity in that case.
      let lastModified = 0;
      let newestFile = null;
      if (jsonlFiles.length > 0) {
        for (const f of jsonlFiles) {
          const s = await stat(join(projectPath, f));
          if (s.mtimeMs > lastModified) { lastModified = s.mtimeMs; newestFile = f; }
        }
      } else {
        const ds = await stat(projectPath);
        lastModified = ds.mtimeMs;
      }

      // Resolve the project's real path. Priority:
      //   1. .cgui-meta.json sidecar (exact, Unicode-safe — set when GUI added it)
      //   2. newest session jsonl's launch cwd (exact, recovers Unicode)
      //   3. decodeProjectHash (lossy fallback for pure-ASCII dirs)
      const sidecarCwd = await readSidecarCwd(projectPath);
      let realPath = sidecarCwd;
      if (!realPath && newestFile) {
        try {
          const { head } = await readJsonlEdges(join(projectPath, newestFile), 10);
          realPath = cwdFromHead(head);
        } catch {}
      }
      if (!realPath) realPath = decodeProjectHash(entry.name);

      // Skip infrastructure/scratch/deleted dirs so the project list shows only
      // real user projects (filters ~/.claude internals, /tmp, deleted folders).
      if (isNonProjectPath(realPath)) continue;

      // sessionCount must match what listSessions will actually show. For a
      // sidecar project sharing a collapsed hash dir with another real path,
      // the raw jsonl count would over-report (it includes the sibling's
      // sessions), giving a non-zero badge over an empty list. Count only the
      // jsonl whose launch cwd matches the sidecar (cwd-less files are kept,
      // matching the filter in listSessions).
      let sessionCount = jsonlFiles.length;
      if (sidecarCwd && jsonlFiles.length > 0) {
        let matched = 0;
        for (const f of jsonlFiles) {
          try {
            const { head } = await readJsonlEdges(join(projectPath, f), 10);
            const c = cwdFromHead(head);
            if (!c || c === sidecarCwd) matched += 1;
          } catch { matched += 1; }
        }
        sessionCount = matched;
      }

      projects.push({
        hash: entry.name,
        path: realPath,
        sessionCount,
        lastActivity: new Date(lastModified).toISOString(),
      });
    } catch {
      // skip inaccessible dirs
    }
  }

  // Sort by last activity descending
  projects.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  return projects;
}

/**
 * Check if a first prompt is meaningful (not just "ok", "你好", "?" etc.)
 */
function isMeaningfulPrompt(prompt) {
  if (!prompt) return false;
  const clean = prompt.replace(/<[^>]+>/g, '').trim(); // strip HTML-like tags
  if (clean.length < 10) return false;
  const trivial = ['ok', 'okay', 'hello', 'hi', '你好', '嗨', '?', '？', 'test', '测试',
    'say ok', 'say hello', 'say hi', 'config', '/help', '/clear'];
  return !trivial.includes(clean.toLowerCase());
}

/**
 * List sessions for a project hash.
 * Filters out trivial sessions and groups subagent sessions under parents.
 */
export async function listSessions(projectHash) {
  const projectPath = join(PROJECTS_DIR, projectHash);
  const files = await readdir(projectPath);
  const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'));

  // If this project was GUI-registered, its sidecar holds the real path. The
  // CLI hash is lossy and can collapse several DIFFERENT real paths into one
  // dir (e.g. two CJK-named folders). When a sidecar exists we only surface
  // sessions whose launch cwd matches it — otherwise a freshly-added project
  // would show another project's old sessions (the "旧会话串入新项目" bug).
  const sidecarCwd = await readSidecarCwd(projectPath);

  const sessions = [];
  for (const file of jsonlFiles) {
    const filePath = join(projectPath, file);
    const sessionId = file.replace('.jsonl', '');

    try {
      const { head, tail, totalLines } = await readJsonlEdges(filePath, 10);

      // Extract metadata from first user message
      const firstUser = head.find((r) => r.type === 'user');
      const lastRecord = tail[tail.length - 1];
      // The session jsonl records carry the EXACT cwd (including any Unicode
      // characters) the CLI was launched with. We must pass this exact string
      // back to --resume; reconstructing from the hash dir name loses Unicode
      // (`肠骨轴` → `----` is one-way).
      const realCwd = cwdFromHead(head);

      // De-collision: drop sessions that belong to a different real path which
      // the CLI hash collapsed into this same dir. Sessions whose cwd can't be
      // determined (realCwd === null) are kept — they're rare and more likely
      // ours than a sibling's.
      if (sidecarCwd && realCwd && realCwd !== sidecarCwd) continue;

      let firstPrompt = '';
      if (firstUser?.message?.content) {
        const raw = firstUser.message.content;
        if (typeof raw === 'string') {
          firstPrompt = raw.slice(0, 200);
        } else if (Array.isArray(raw)) {
          const textContent = raw.find((c) => c.type === 'text');
          firstPrompt = textContent?.text?.slice(0, 200) || '';
        }
      }

      // Skip ONLY truly empty sessions. A brand-new session (just one prompt +
      // reply) is ~3-8 lines, which we want to show. The old `< 20 && !meaningful`
      // filter swallowed every new chat whose prompt didn't pass isMeaningfulPrompt
      // — the user's #1 complaint was new sessions never appearing in history.
      if (totalLines < 3) continue;

      const s = await stat(filePath);

      // Archive marker — sibling `<sid>.jsonl.archived` flips visibility.
      let archived = false;
      try {
        await stat(filePath + '.archived');
        archived = true;
      } catch {}

      // Check for subagent sessions
      const subagents = [];
      const subagentDir = join(projectPath, sessionId, 'subagents');
      try {
        const agentFiles = await readdir(subagentDir);
        for (const af of agentFiles) {
          if (!af.endsWith('.jsonl')) continue;
          const agentPath = join(subagentDir, af);
          try {
            const agentEdges = await readJsonlEdges(agentPath, 5);
            const agentFirstUser = agentEdges.head.find((r) => r.type === 'user');
            let agentPrompt = '';
            if (agentFirstUser?.message?.content) {
              const raw = agentFirstUser.message.content;
              if (typeof raw === 'string') agentPrompt = raw.slice(0, 100);
              else if (Array.isArray(raw)) {
                const t = raw.find((c) => c.type === 'text');
                agentPrompt = t?.text?.slice(0, 100) || '';
              }
            }
            const as = await stat(agentPath);
            subagents.push({
              sessionId: af.replace('.jsonl', ''),
              projectHash,
              filePath: agentPath,
              firstPrompt: agentPrompt || af.replace('.jsonl', '').replace('agent-', 'Agent '),
              messageCount: agentEdges.totalLines,
              lastActivity: agentEdges.tail[agentEdges.tail.length - 1]?.timestamp || new Date(as.mtimeMs).toISOString(),
              model: agentEdges.head.find((r) => r.type === 'assistant')?.message?.model || null,
              isSubagent: true,
            });
          } catch {}
        }
      } catch {}

      sessions.push({
        sessionId,
        projectHash,
        projectPath: realCwd || decodeProjectHash(projectHash),
        filePath,
        firstPrompt,
        messageCount: totalLines,
        startTime: firstUser?.timestamp || new Date(s.birthtimeMs).toISOString(),
        lastActivity: lastRecord?.timestamp || new Date(s.mtimeMs).toISOString(),
        model: head.find((r) => r.type === 'assistant')?.message?.model || null,
        fileSize: s.size,
        subagents: subagents.length > 0 ? subagents : undefined,
        archived,
      });
    } catch {
      // skip unreadable files
    }
  }

  sessions.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  return sessions;
}

/**
 * Normalize message content to always be an array.
 * Some messages have content as a plain string instead of an array of content blocks.
 */
function normalizeContent(content) {
  if (!content) return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) return content;
  return [];
}

/**
 * Classify a tool name into a category.
 * - 'skill': skill/knowledge reading (Read, Grep, Search, etc.)
 * - 'write': file modification (Edit, Write, Bash with file ops)
 * - 'call': other tool calls
 */
function classifyTool(name) {
  if (!name) return 'call';
  const lower = name.toLowerCase();
  // Skill/knowledge reading tools
  if (['read', 'grep', 'glob', 'search', 'websearch', 'webfetch',
       'listmcpresourcestool', 'readmcpresourcetool'].includes(lower)) return 'skill';
  // Write tools
  if (['edit', 'write', 'notebookedit', 'mcp__desktop-commander__write_file',
       'mcp__desktop-commander__edit_block'].includes(lower)) return 'write';
  // Bash is special — classify by command
  return 'call';
}

/**
 * Slash commands like /context, /clear, /compact write echo records into the
 * jsonl as `user` messages whose text is a synthetic `<local-command-caveat>`,
 * `<command-name>…`, `<command-message>`, `<command-args>` or
 * `<local-command-stdout>` block. These are CLI bookkeeping, not real user
 * prompts — rendering them as user bubbles is the "斜杠命令多出两条隐藏消息"
 * bug. Detect and drop them.
 */
function isLocalCommandEcho(text) {
  return /^\s*<(local-command-(caveat|stdout|stderr)|command-(name|message|args))\b/.test(text);
}

/**
 * Build turn-based message groups from a session's JSONL records.
 *
 * A "turn" = one user prompt + all assistant responses (thinking, text, tool calls)
 * until the next user prompt. Tool result-only messages are merged into the
 * preceding assistant turn.
 *
 * Returns array of:
 *   { type: 'user', uuid, text, timestamp }
 *   { type: 'turn', uuid, thinking: [], text: [], toolCalls: [], model, usage, timestamp }
 */
export async function getSessionMessages(sessionId, projectHash) {
  const filePath = join(PROJECTS_DIR, projectHash, `${sessionId}.jsonl`);
  const records = await parseJsonl(filePath);

  // Collect all tool results first, keyed by tool_use_id
  const toolResultMap = new Map();
  for (const record of records) {
    if (record.type === 'user') {
      const content = normalizeContent(record.message?.content);
      for (const item of content) {
        if (item.type === 'tool_result') {
          toolResultMap.set(item.tool_use_id, {
            toolUseId: item.tool_use_id,
            content: typeof item.content === 'string' ? item.content : JSON.stringify(item.content),
            isError: item.is_error || false,
          });
        }
      }
    }
  }

  const messages = [];
  let currentTurn = null;

  function flushTurn() {
    if (currentTurn && (currentTurn.text.length > 0 || currentTurn.thinking.length > 0 || currentTurn.toolCalls.length > 0)) {
      messages.push(currentTurn);
    }
    currentTurn = null;
  }

  for (const record of records) {
    if (record.type === 'user') {
      // After /compact the CLI stores the summary as a synthetic `user` message
      // flagged isCompactSummary. Render a collapsed "compacted" divider instead
      // of dumping the full summary as a user bubble (matches Claude Desktop /
      // the CLI terminal UI).
      if (record.isCompactSummary) {
        flushTurn();
        messages.push({ type: 'compact', uuid: record.uuid, timestamp: record.timestamp });
      } else {
        const content = normalizeContent(record.message?.content);
        const textParts = content.filter((c) => c.type === 'text');
        const text = textParts.map((c) => c.text).join('\n').trim();

        if (text && !isLocalCommandEcho(text)) {
          // This is a real user prompt — flush previous turn and start new user message
          flushTurn();
          messages.push({
            type: 'user',
            uuid: record.uuid,
            text,
            timestamp: record.timestamp,
            sessionId: record.sessionId,
            permissionMode: record.permissionMode,
          });
        }
        // tool_result-only messages are silently merged via toolResultMap
      }

    } else if (record.type === 'assistant') {
      const content = normalizeContent(record.message?.content);
      const textParts = content.filter((c) => c.type === 'text');
      const thinkingParts = content.filter((c) => c.type === 'thinking');
      const toolUses = content.filter((c) => c.type === 'tool_use');

      // If no current turn (e.g. assistant message before any user text), start one
      if (!currentTurn) {
        currentTurn = {
          type: 'turn',
          uuid: record.uuid,
          thinking: [],
          text: [],
          toolCalls: [],
          // `blocks` mirrors the live-stream's orderedBlocks shape so the
          // client's primary render path (chronological text/thinking/tool
          // interleaving) works for historical messages too. Without this,
          // legacy fallback put all text first and dumped all tools at the
          // bottom — exactly the symptom the user just reported.
          blocks: [],
          model: record.message?.model || null,
          usage: null,
          timestamp: record.timestamp,
          sessionId: record.sessionId,
        };
      }

      // Walk content in ORDER, appending to both the flat arrays AND blocks.
      for (const c of content) {
        if (c.type === 'thinking' && c.thinking) {
          currentTurn.thinking.push(c.thinking);
          currentTurn.blocks.push({ type: 'thinking', content: c.thinking });
        } else if (c.type === 'text' && c.text) {
          currentTurn.text.push(c.text);
          currentTurn.blocks.push({ type: 'text', content: c.text });
        } else if (c.type === 'tool_use') {
          const toolCall = {
            id: c.id,
            name: c.name,
            input: c.input,
            result: toolResultMap.get(c.id) || null,
            category: classifyTool(c.name),
          };
          currentTurn.toolCalls.push(toolCall);
          currentTurn.blocks.push({ type: 'tool_use', toolCall });
        }
      }

      // Update model and usage (last one wins)
      if (record.message?.model) currentTurn.model = record.message.model;
      if (record.message?.usage) currentTurn.usage = record.message.usage;
      if (record.timestamp) currentTurn.timestamp = record.timestamp;
    }
    // Skip attachment, queue-operation, last-prompt, permission-mode, etc.
  }

  flushTurn();
  return messages;
}

/**
 * Get session metadata (lightweight, for sidebar preview).
 */
export async function getSessionMeta(sessionId, projectHash) {
  const filePath = join(PROJECTS_DIR, projectHash, `${sessionId}.jsonl`);
  const { head, tail, totalLines } = await readJsonlEdges(filePath, 10);
  const s = await stat(filePath);

  const firstUser = head.find((r) => r.type === 'user');
  const models = [...new Set(
    head.concat(tail)
      .filter((r) => r.type === 'assistant' && r.message?.model)
      .map((r) => r.message.model)
  )];
  // EXACT cwd the CLI was launched with (Unicode-safe). Same logic as
  // listSessions — clients use this for --resume.
  const realCwd = cwdFromHead(head);

  return {
    sessionId,
    projectHash,
    projectPath: realCwd || decodeProjectHash(projectHash),
    messageCount: totalLines,
    fileSize: s.size,
    startTime: firstUser?.timestamp,
    lastActivity: tail[tail.length - 1]?.timestamp,
    models,
  };
}

/**
 * Get all active sessions from ~/.claude/sessions/
 */
export async function getActiveSessions() {
  try {
    const files = await readdir(SESSIONS_DIR);
    const sessions = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const data = await parseJsonl(join(SESSIONS_DIR, file));
        // Session files might be single JSON objects, not JSONL
        const sessionData = Array.isArray(data) ? data[0] : data;
        if (sessionData) {
          sessions.push(sessionData);
        }
      } catch {
        // try reading as regular JSON
        try {
          const { readFile } = await import('fs/promises');
          const raw = await readFile(join(SESSIONS_DIR, file), 'utf-8');
          sessions.push(JSON.parse(raw));
        } catch {}
      }
    }

    return sessions;
  } catch {
    return [];
  }
}
