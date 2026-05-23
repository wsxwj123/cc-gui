import { readdir, stat } from 'fs/promises';
import { join, basename } from 'path';
import { homedir } from 'os';
import { parseJsonl, readJsonlEdges } from '../utils/jsonl-parser.js';

const CLAUDE_DIR = join(homedir(), '.claude');
const PROJECTS_DIR = join(CLAUDE_DIR, 'projects');
const TRANSCRIPTS_DIR = join(CLAUDE_DIR, 'transcripts');
const SESSIONS_DIR = join(CLAUDE_DIR, 'sessions');

/**
 * Decode project hash back to a readable path.
 * -Users-wsxwj-Desktop-claude → /Users/wsxwj/Desktop/claude
 */
function decodeProjectHash(hash) {
  if (hash.startsWith('-')) {
    return '/' + hash.slice(1).replace(/-/g, '/');
  }
  return hash;
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
      if (jsonlFiles.length === 0) continue;

      // Get last activity time
      let lastModified = 0;
      for (const f of jsonlFiles) {
        const s = await stat(join(projectPath, f));
        if (s.mtimeMs > lastModified) lastModified = s.mtimeMs;
      }

      projects.push({
        hash: entry.name,
        path: decodeProjectHash(entry.name),
        sessionCount: jsonlFiles.length,
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

  const sessions = [];
  for (const file of jsonlFiles) {
    const filePath = join(projectPath, file);
    const sessionId = file.replace('.jsonl', '');

    try {
      const { head, tail, totalLines } = await readJsonlEdges(filePath, 10);

      // Extract metadata from first user message
      const firstUser = head.find((r) => r.type === 'user');
      const lastRecord = tail[tail.length - 1];

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

      // Skip trivial sessions (< 20 lines AND meaningless first prompt)
      if (totalLines < 20 && !isMeaningfulPrompt(firstPrompt)) continue;

      const s = await stat(filePath);

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
        filePath,
        firstPrompt,
        messageCount: totalLines,
        startTime: firstUser?.timestamp || new Date(s.birthtimeMs).toISOString(),
        lastActivity: lastRecord?.timestamp || new Date(s.mtimeMs).toISOString(),
        model: head.find((r) => r.type === 'assistant')?.message?.model || null,
        fileSize: s.size,
        subagents: subagents.length > 0 ? subagents : undefined,
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
      const content = normalizeContent(record.message?.content);
      const textParts = content.filter((c) => c.type === 'text');
      const text = textParts.map((c) => c.text).join('\n').trim();

      if (text) {
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
          model: record.message?.model || null,
          usage: null,
          timestamp: record.timestamp,
          sessionId: record.sessionId,
        };
      }

      // Accumulate thinking
      for (const t of thinkingParts) {
        if (t.thinking) currentTurn.thinking.push(t.thinking);
      }

      // Accumulate text
      for (const t of textParts) {
        if (t.text) currentTurn.text.push(t.text);
      }

      // Accumulate tool calls with linked results
      for (const tu of toolUses) {
        currentTurn.toolCalls.push({
          id: tu.id,
          name: tu.name,
          input: tu.input,
          result: toolResultMap.get(tu.id) || null,
          category: classifyTool(tu.name),
        });
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

  return {
    sessionId,
    projectHash,
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
