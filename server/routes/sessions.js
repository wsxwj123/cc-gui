import { Router } from 'express';
import { readdir, stat, readFile, writeFile, rename, open, mkdir, unlink } from 'fs/promises';
import { join, dirname, isAbsolute, resolve } from 'path';
import { isLocalReq } from '../services/auth.js';
import { homedir, tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { closePersistentForSession } from './chat.js';
import { isRealUserQuestion } from './fork.js';
import { removeSessionFromPrefs } from './prefs.js';

// Guard against path traversal: projectHash / sessionId arrive from request
// bodies and queries, then get concatenated into fs paths. A crafted value
// like `../../foo` would escape ~/.claude/projects. Real projectHash is a
// dash-encoded path (no `/`, no `..`); real sessionId is a UUID. Reject
// anything else.
function safeId(s) {
  if (typeof s !== 'string' || !s) return false;
  if (s.includes('/') || s.includes('\\') || s.includes('..') || s.includes('\0')) return false;
  return true;
}
import {
  listProjects,
  listSessions,
  getSessionMessages,
  getSessionMeta,
  getActiveSessions,
  attachmentTextHash,
  findSessionFile,
} from '../services/session-reader.js';
import { claudeSpawn, cleanChildEnv, safeModelArg, getActiveChatProcesses } from './chat.js';
import { repairOfficialCompat } from '../utils/session-repair.js';
import { mkdirSync, rmSync } from 'fs';
import { resolveUnderHome, resolveWorkspacePath } from '../utils/safe-path.js';
import { broadcast } from '../broadcast.js';

// L4: 附件元数据 sidecar — 写入位置与 session-reader 一致。
const ATTACHMENTS_DIR = join(homedir(), '.claude-gui', 'attachments');

const router = Router();

function sessionFile(projectHash, sessionId) {
  return join(homedir(), '.claude', 'projects', projectHash, `${sessionId}.jsonl`);
}

// 打包版 Tauri 后端禁用 chokidar watcher(CGUI_DISABLE_FILE_WATCHER=1)→ 改写 jsonl
// 的端点自身不广播的话,其他客户端(手机/电脑多端)永远收不到"会话变了"的通知,停在
// 旧画面。修法:写入点自己合成与原 watcher 同型的 file-change 广播(0ms,快于 watcher
// 2.5s 轮询,且 dev/打包两形态都覆盖)。客户端判据只看字符串形态,不读文件——所以
// DELETE/archive 后文件不存在也照发原 jsonl 路径。反斜杠统一成正斜杠:useWebSocket
// 兼容 `\projects\`,但 SessionDetail 的 endsWith(`/${sid}.jsonl`) 只认正斜杠,原生
// watcher 在 Windows 发反斜杠命中不了(既有缺陷),合成广播不复刻它。
export function broadcastSessionFileChange(file, eventType = 'change') {
  try {
    broadcast({ type: 'file-change', eventType, path: String(file).replace(/\\/g, '/') });
  } catch {}
}

function hasRealConversationLine(lines) {
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'user' || obj.type === 'assistant') return true;
    } catch {}
  }
  return false;
}

// 同一 jsonl 的写操作串行化:trim/compact/strip 并发时,固定临时名会互相覆盖再 rename
// = 会话历史损坏。模块级 per-file Promise 链,新写挂到该文件队尾,finally 清 Map 项。
// 临时名再带 uuid 双保险(崩溃残留/未来漏走队列的调用点也不会互踩)。
const _jsonlWriteQueues = new Map(); // filePath -> 队尾 Promise
async function writeJsonlAtomic(file, text) {
  const prev = _jsonlWriteQueues.get(file) || Promise.resolve();
  const run = prev.catch(() => {}).then(async () => {
    const finalText = text.length && !text.endsWith('\n') ? text + '\n' : text;
    const tmp = `${file}.tmp-trim-${randomUUID()}`;
    try {
      await writeFile(tmp, finalText, 'utf-8');
      await rename(tmp, file);
    } catch (err) {
      // rename 前抛错会留 tmp-uuid 残留,兜底清掉(文件可能没写成,ENOENT 忽略)。
      try { await unlink(tmp); } catch {}
      throw err;
    }
  });
  _jsonlWriteQueues.set(file, run);
  const cleanup = () => { if (_jsonlWriteQueues.get(file) === run) _jsonlWriteQueues.delete(file); };
  run.then(cleanup, cleanup);
  return run;
}

export function trimJsonlBeforeTool(raw, toolUseId) {
  const lines = String(raw || '').split('\n');
  const keptLines = [];
  let found = false;
  let removedFromLine = -1;
  let keptAssistantBlocks = 0;
  // 追踪【所有保留记录】里已出现的 tool_use / tool_result id。实测 CLI 每条 assistant
  // 记录只含一个 tool_use(0/6051 含多个),并行工具是【跨记录】交错布局:
  //   asst(useA) / asst(useB) / user(resA) / user(resB)
  // 裁 useB 时 useA 所在记录在 cut 点之前被保留,但它的 resA 在 cut 点之后 → 被整体丢弃
  // → 孤儿 tool_use → resume 时 Anthropic API 400。所以要在 cut 后向后扫,救回【所有】
  // 保留 tool_use 但 result 尚未出现的配对(不只 cut 记录同条内的 beforeBlocks)。
  const seenToolUse = new Set();
  const seenToolResult = new Set();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      if (!found) keptLines.push(line);
      continue;
    }

    let obj;
    try { obj = JSON.parse(line); }
    catch {
      if (!found) keptLines.push(line);
      continue;
    }

    const content = Array.isArray(obj?.message?.content) ? obj.message.content : null;
    if (obj.type === 'assistant' && content) {
      const toolIdx = content.findIndex((block) => block?.type === 'tool_use' && block.id === toolUseId);
      if (toolIdx !== -1) {
        found = true;
        removedFromLine = i;
        const beforeBlocks = content.slice(0, toolIdx);
        if (beforeBlocks.length > 0) {
          obj.message = { ...obj.message, content: beforeBlocks };
          keptAssistantBlocks = beforeBlocks.length;
          keptLines.push(JSON.stringify(obj));
          beforeBlocks.forEach((b) => { if (b?.type === 'tool_use' && b.id) seenToolUse.add(b.id); });
        }
        // 所有保留 tool_use 中,result 还没在 cut 点之前出现的 → 需向后救回。
        const stillNeed = new Set([...seenToolUse].filter((id) => !seenToolResult.has(id)));
        stillNeed.delete(toolUseId); // 被裁工具本身的 result 不救(它连同 tool_use 一起被删)
        for (let j = i + 1; j < lines.length && stillNeed.size > 0; j++) {
          if (!lines[j].trim()) continue;
          let next;
          try { next = JSON.parse(lines[j]); } catch { continue; }
          const nc = Array.isArray(next?.message?.content) ? next.message.content : null;
          if (next.type === 'user' && nc && nc.some((b) => b?.type === 'tool_result' && stillNeed.has(b.tool_use_id))) {
            const filtered = nc.filter((b) => b?.type === 'tool_result' && stillNeed.has(b.tool_use_id));
            filtered.forEach((b) => stillNeed.delete(b.tool_use_id));
            next.message = { ...next.message, content: filtered };
            keptLines.push(JSON.stringify(next));
          }
        }
        break;
      }
      // 保留的 assistant 记录:记下其 tool_use id
      content.forEach((b) => { if (b?.type === 'tool_use' && b.id) seenToolUse.add(b.id); });
    } else if (obj.type === 'user' && content) {
      // 保留的 user 记录:记下已配对的 tool_result id
      content.forEach((b) => { if (b?.type === 'tool_result' && b.tool_use_id) seenToolResult.add(b.tool_use_id); });
    }

    keptLines.push(line);
  }

  return { found, keptLines, removedFromLine, totalLines: lines.length, keptAssistantBlocks };
}

// ── 定向压缩(summarize from/up to here)────────────────────────────────────
// 调研结论:CLI 交互式 /rewind 菜单的 "Summarize from/up to here" 是 local-jsx 组件,
// headless/SDK 均无法触发;SDK 控制通道的 rewind_conversation 只做纯裁剪(等价 trim,
// 且 SDK 未暴露方法)。故自实现:一次性 claude -p 生成段落摘要 → 改写 jsonl。
// 改写格式逐字段对齐 CLI 自身的 partial compact 落盘形态(实测样本
// ~/.claude/projects/**/14cb7804….jsonl:compact_boundary(parentUuid:null) →
// isCompactSummary user 记录 → 保留段首条被物理重挂到摘要 uuid 下):
//   resume 加载走 parentUuid 链(叶子=末行),链在 boundary(parent null)处终止,
//   被压缩的原始记录物理保留在文件里(GUI 仍完整显示 + compact 分隔线),但不再
//   进入上下文 —— 追加式改写,不删除任何历史记录,天然无孤儿 tool_use 风险。
//
// compactSegmentJsonl(raw, anchorUuid, direction, summaryContent) — 纯函数,可单测。
//   direction 'before':锚点(真实用户消息)之前的对话替换为摘要,锚点及之后保留。
//     布局 [prefix原样…, boundary, summary, 锚点(parentUuid→summary), suffix原样…]。
//   direction 'after':裁掉锚点及之后(同 trim),在余下叶子后追加摘要记录。
//     布局 [prefix原样…, summary(parentUuid→叶子)]。
// 返回 { ok, lines } 或 { ok:false, error }。
export function compactSegmentJsonl(raw, anchorUuid, direction, summaryContent) {
  const lines = String(raw || '').split('\n');
  let anchorIdx = -1;
  let anchorObj = null;
  const parsed = lines.map((line) => {
    if (!line.trim()) return null;
    try { return JSON.parse(line); } catch { return null; }
  });
  for (let i = 0; i < parsed.length; i++) {
    if (parsed[i]?.uuid === anchorUuid) { anchorIdx = i; anchorObj = parsed[i]; break; }
  }
  if (anchorIdx === -1) return { ok: false, error: '锚点消息不在会话记录中' };
  if (!isRealUserQuestion(anchorObj)) return { ok: false, error: '锚点必须是一条用户消息' };

  // 模板字段取自锚点记录,保证新记录与该会话的落盘形态一致。
  const now = new Date().toISOString();
  const base = {
    isSidechain: false,
    userType: anchorObj.userType || 'external',
    cwd: anchorObj.cwd,
    sessionId: anchorObj.sessionId,
    version: anchorObj.version,
    ...(anchorObj.gitBranch !== undefined ? { gitBranch: anchorObj.gitBranch } : {}),
  };
  const summaryUuid = randomUUID();

  const lastMsgUuid = (upto) => {
    for (let i = upto - 1; i >= 0; i--) {
      const o = parsed[i];
      if (o?.uuid && (o.type === 'user' || o.type === 'assistant')) return o.uuid;
    }
    return null;
  };

  if (direction === 'before') {
    const prefixLast = lastMsgUuid(anchorIdx);
    if (!prefixLast) return { ok: false, error: '锚点之前没有可压缩的对话内容' };
    // 边界安全检查:锚点及之后若引用了锚点之前的 tool_use(理论上不会——tool_result
    // 总在下一条真实用户消息之前落盘),压缩会造成孤儿 tool_result → resume 时 API 400。
    // 出现即拒绝,提示换锚点,绝不静默改写语义。
    const suffixToolUse = new Set();
    for (let i = anchorIdx; i < parsed.length; i++) {
      const c = parsed[i]?.message?.content;
      if (parsed[i]?.type === 'assistant' && Array.isArray(c)) {
        for (const b of c) if (b?.type === 'tool_use' && b.id) suffixToolUse.add(b.id);
      }
    }
    for (let i = anchorIdx; i < parsed.length; i++) {
      const c = parsed[i]?.message?.content;
      if (parsed[i]?.type === 'user' && Array.isArray(c)) {
        for (const b of c) {
          if (b?.type === 'tool_result' && b.tool_use_id && !suffixToolUse.has(b.tool_use_id)) {
            return { ok: false, error: '该位置存在跨越锚点的工具调用配对,请选择更晚的一条用户消息' };
          }
        }
      }
    }
    const boundaryUuid = randomUUID();
    const prefixChars = lines.slice(0, anchorIdx).join('\n').length;
    const boundary = {
      parentUuid: null,
      logicalParentUuid: prefixLast,
      ...base,
      type: 'system',
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
      isMeta: false,
      timestamp: now,
      uuid: boundaryUuid,
      level: 'info',
      // preTokens 粗估(chars/4)仅供展示;不写 preservedMessages 元数据——保留段
      // 首条已物理重挂到摘要下,parentUuid 链自洽,任何版本的加载器都能正确接续。
      compactMetadata: { trigger: 'manual', preTokens: Math.round(prefixChars / 4) },
    };
    const summary = {
      parentUuid: boundaryUuid,
      ...base,
      type: 'user',
      message: { role: 'user', content: summaryContent },
      isVisibleInTranscriptOnly: true,
      isCompactSummary: true,
      timestamp: now,
      uuid: summaryUuid,
    };
    const patchedAnchor = JSON.stringify({ ...anchorObj, parentUuid: summaryUuid });
    return {
      ok: true,
      summaryUuid,
      lines: [
        ...lines.slice(0, anchorIdx),
        JSON.stringify(boundary),
        JSON.stringify(summary),
        patchedAnchor,
        ...lines.slice(anchorIdx + 1),
      ],
    };
  }

  if (direction === 'after') {
    const keptLines = lines.slice(0, anchorIdx);
    if (!hasRealConversationLine(keptLines)) {
      return { ok: false, error: '锚点之前没有可保留的对话,请直接使用回滚' };
    }
    const leafUuid = lastMsgUuid(anchorIdx);
    const summary = {
      parentUuid: leafUuid,
      ...base,
      type: 'user',
      message: { role: 'user', content: summaryContent },
      isVisibleInTranscriptOnly: true,
      isCompactSummary: true,
      timestamp: now,
      uuid: summaryUuid,
    };
    return { ok: true, summaryUuid, lines: [...keptLines, JSON.stringify(summary)] };
  }

  return { ok: false, error: 'direction 必须是 before 或 after' };
}

// 把一段 jsonl 记录渲染成给摘要模型看的纯文本转写(用户/助手文本 + 工具调用一行摘要)。
// 超长截断保留最近内容(与 /session-ref 的 200KB 尾部保留同思路)。
export function renderSegmentTranscript(parsedRecords, cap = 150 * 1024) {
  const parts = [];
  for (const o of parsedRecords) {
    if (!o) continue;
    if (o.type === 'user' && isRealUserQuestion(o)) {
      const c = o.message?.content;
      const text = typeof c === 'string'
        ? c
        : (Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '');
      if (text.trim()) parts.push(`用户: ${text.trim().slice(0, 6000)}`);
    } else if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
      for (const b of o.message.content) {
        if (b?.type === 'text' && b.text?.trim()) parts.push(`助手: ${b.text.trim().slice(0, 6000)}`);
        else if (b?.type === 'tool_use') {
          let inp = '';
          try { inp = JSON.stringify(b.input).slice(0, 300); } catch {}
          parts.push(`[工具 ${b.name}] ${inp}`);
        }
      }
    }
  }
  let text = parts.join('\n\n');
  if (text.length > cap) text = '(更早内容因超长被截断)\n\n…' + text.slice(text.length - cap);
  return text;
}

// GET /api/projects — list all projects
router.get('/projects', async (req, res) => {
  try {
    const projects = await listProjects();
    res.json(projects);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/reveal-path { path } — r11-①:在系统文件管理器中定位项目文件夹。
 * 校验 path ∈ 已知项目集(listProjects 的 path,含 worktree 项目),不接受任意路径;
 * mac `open -R` 高亮该文件夹,win `explorer /select,`(成功也常以非零码退出,不当失败
 * —— memory Win 三坑),其余平台 xdg-open 打开该目录。数组传参不拼命令串。
 * 远程/手机访问时作用在服务器本机(与 /worktree/reveal 同预期)。
 */
router.post('/reveal-path', async (req, res) => {
  try {
    const p = String(req.body?.path || '');
    if (!p) return res.status(400).json({ error: 'path required' });
    const projects = await listProjects();
    if (!projects.some((x) => x && x.path === p)) {
      return res.status(400).json({ error: 'path is not a known project' });
    }
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileP = promisify(execFile);
    let cmd, args;
    if (process.platform === 'darwin') { cmd = 'open'; args = ['-R', p]; }
    else if (process.platform === 'win32') { cmd = 'explorer'; args = [`/select,${p}`]; }
    else { cmd = 'xdg-open'; args = [p]; }
    try {
      await execFileP(cmd, args, { timeout: 10000 });
    } catch (err) {
      if (process.platform !== 'win32') throw err;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/projects/:hash/sessions — list sessions for a project
router.get('/projects/:hash/sessions', async (req, res) => {
  try {
    if (!safeId(req.params.hash)) {
      return res.status(400).json({ error: 'invalid hash' });
    }
    const sessions = await listSessions(req.params.hash);
    res.json(sessions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sessions/:sessionId — session metadata
router.get('/sessions/:sessionId', async (req, res) => {
  try {
    const { projectHash } = req.query;
    if (!projectHash) {
      return res.status(400).json({ error: 'projectHash query param required' });
    }
    if (!safeId(projectHash) || !safeId(req.params.sessionId)) {
      return res.status(400).json({ error: 'invalid projectHash or sessionId' });
    }
    const meta = await getSessionMeta(req.params.sessionId, projectHash);
    res.json(meta);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sessions/:sessionId/messages — full message history
router.get('/sessions/:sessionId/messages', async (req, res) => {
  try {
    const { projectHash } = req.query;
    if (!projectHash) {
      return res.status(400).json({ error: 'projectHash query param required' });
    }
    if (!safeId(projectHash) || !safeId(req.params.sessionId)) {
      return res.status(400).json({ error: 'invalid projectHash or sessionId' });
    }
    // 响应形态 { messages, usageTotals }:usageTotals 是服务端解析 jsonl 时顺带算好的
    // 整会话用量聚合(按 message.id 去重逐条求和),前端直接取用,免去几千条消息的
    // 每帧全量 reduce。客户端(sessionStore.fetchMessages / App.jsx peek)已兼容两种形态。
    const { messages, usageTotals } = await getSessionMessages(req.params.sessionId, projectHash);
    res.json({ messages, usageTotals });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/recent-session?projectHash=...
 * Returns the most-recently-modified session jsonl for a project (mirrors
 * `claude --continue` semantics). If projectHash is omitted, scans every
 * project and returns the globally newest session.
 */
router.get('/recent-session', async (req, res) => {
  try {
    const { projectHash } = req.query;
    if (projectHash && !safeId(projectHash)) {
      return res.status(400).json({ error: 'invalid projectHash' });
    }
    const projectsDir = join(homedir(), '.claude', 'projects');
    const dirs = projectHash
      ? [projectHash]
      : (await readdir(projectsDir, { withFileTypes: true }))
          .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
          .map((e) => e.name);

    let best = null;
    for (const hash of dirs) {
      const projectDir = join(projectsDir, hash);
      let files;
      try { files = await readdir(projectDir); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const full = join(projectDir, f);
        let st;
        try { st = await stat(full); } catch { continue; }
        if (!best || st.mtimeMs > best.mtimeMs) {
          best = { projectHash: hash, sessionId: f.replace(/\.jsonl$/, ''), mtimeMs: st.mtimeMs };
        }
      }
    }
    if (!best) return res.status(404).json({ error: 'no sessions found' });
    res.json(best);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/sessions/:sessionId/trim  { projectHash, uuid?, fromTimestamp? }
 * Rollback support: truncate the on-disk jsonl so that the matched line AND
 * everything after it is removed. Match strategy:
 *   - if `uuid` provided: cut at the first record whose `uuid` equals it
 *   - else if `fromTimestamp` provided (ISO): cut at the first record whose
 *     `timestamp >= fromTimestamp`
 * The timestamp variant covers freshly-sent messages whose client-side uuid
 * (`chat-user-<ts>`) never made it into the jsonl — the CLI assigns its own
 * uuid on persist, but the timestamp is preserved.
 *
 * Writes a backup copy at `<sid>.jsonl.bak` before rewriting (best-effort).
 */
// L4: POST /sessions/:sessionId/attachments { text, attachments, displayText }
// 把附件卡片元数据写入 sidecar(按 textHash 索引,session-reader 重读消息时 merge)。
router.post('/sessions/:sessionId/attachments', async (req, res) => {
  try {
    const sid = req.params.sessionId;
    if (!safeId(sid)) return res.status(400).json({ error: 'bad sessionId' });
    const { text, attachments, displayText } = req.body || {};
    if (typeof text !== 'string' || !Array.isArray(attachments)) {
      return res.status(400).json({ error: 'text + attachments[] required' });
    }
    await mkdir(ATTACHMENTS_DIR, { recursive: true });
    const p = join(ATTACHMENTS_DIR, `${sid}.json`);
    let cur = {};
    try { cur = JSON.parse(await readFile(p, 'utf-8')) || {}; } catch {}
    const key = attachmentTextHash(text);
    cur[key] = {
      attachments: attachments.map((a) => ({
        kind: a.kind, name: a.name, path: a.path, preview: a.preview, bytes: a.bytes,
      })),
      displayText: typeof displayText === 'string' ? displayText : '',
    };
    await writeFile(p, JSON.stringify(cur, null, 2));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/sessions/:sessionId/trim', async (req, res) => {
  try {
    const { projectHash, uuid, fromTimestamp } = req.body || {};
    if (!projectHash || (!uuid && !fromTimestamp)) {
      return res.status(400).json({ error: 'projectHash + (uuid or fromTimestamp) required' });
    }
    if (!safeId(projectHash) || !safeId(req.params.sessionId)) {
      return res.status(400).json({ error: 'invalid projectHash or sessionId' });
    }
    // #26:改写历史前关掉常驻进程 —— 它的内存上下文与截断后的 jsonl 已分叉,复用会答非所问。
    // await 等进程真退出再读 jsonl,否则可能读到进程退出前的旧写入。
    await closePersistentForSession(req.params.sessionId);
    const file = sessionFile(projectHash, req.params.sessionId);
    let raw;
    try { raw = await readFile(file, 'utf-8'); }
    catch { return res.status(404).json({ error: 'session jsonl not found' }); }
    const lines = raw.split('\n');
    const cutoffMs = fromTimestamp ? Date.parse(fromTimestamp) : null;
    let cutIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (uuid && obj.uuid === uuid) { cutIdx = i; break; }
        if (cutoffMs && obj.timestamp) {
          const tMs = Date.parse(obj.timestamp);
          if (!Number.isNaN(tMs) && tMs >= cutoffMs) { cutIdx = i; break; }
        }
      } catch {}
    }
    if (cutIdx === -1) {
      return res.status(404).json({ error: 'match not found in session' });
    }
    try { await writeFile(file + '.bak', raw, 'utf-8'); } catch {}

    // Check the kept-lines: does it still contain at least one real user or
    // assistant message? If not, the CLI will refuse to --resume this sid
    // ("No conversation found with session ID") — the user-visible symptom
    // is "send/rollback/re-edit silently does nothing". In that case wipe
    // the jsonl entirely and tell the client to forget the sessionId so
    // the next send spawns a fresh session.
    const keptLines = lines.slice(0, cutIdx);
    if (!hasRealConversationLine(keptLines)) {
      // 不再物理删 jsonl。回退一条消息却把整个会话文件删掉(且 .bak 也常丢)是
      // "回退后所有消息消失、会话变僵尸"的根因:删后前端若没干净转 draft,下次仍
      // 拿旧 sessionId --resume → CLI 报 "No conversation found"。改为保留裁剪后
      // 的内容(可能只剩 meta),前端收到 sessionReset 转 draft、下次发消息新建会话。
      // 数据不丢、可在文件树找回,旧会话仍可手动删。
      await writeJsonlAtomic(file, keptLines.join('\n'));
      broadcastSessionFileChange(file);
      return res.json({
        trimmed: true,
        sessionReset: true,
        reason: 'no user/assistant lines would remain — kept meta, client starts fresh',
        removedFromLine: cutIdx,
        totalLines: lines.length,
      });
    }

    // Atomic write (#12): a plain writeFile truncates-then-writes, so the
    // polling file-watcher can read a half-written/empty jsonl mid-trim and
    // momentarily blank the conversation until the next stream. Write to a
    // same-dir temp and rename (POSIX-atomic on one filesystem) so no reader
    // ever sees a truncated file.
    await writeJsonlAtomic(file, keptLines.join('\n'));
    broadcastSessionFileChange(file);
    res.json({ trimmed: true, removedFromLine: cutIdx, totalLines: lines.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/sessions/:sessionId/compact-segment  { projectHash, uuid, direction, model? }
 * 定向压缩(见 compactSegmentJsonl 顶部调研注释)。流程:
 *   1. 读 jsonl,定位锚点,把待压缩段渲染成转写文本;
 *   2. 一次性 claude -p 生成该段摘要(隔离 cwd、不落盘,复用标题生成的 spawn 形态);
 *   3. 关常驻进程 → 重读 jsonl(摘要期间可能有变)→ .bak 备份 → 原子改写。
 */
router.post('/sessions/:sessionId/compact-segment', async (req, res) => {
  try {
    const { projectHash, uuid, direction } = req.body || {};
    if (!projectHash || !uuid || (direction !== 'before' && direction !== 'after')) {
      return res.status(400).json({ error: 'projectHash + uuid + direction(before|after) required' });
    }
    if (!safeId(projectHash) || !safeId(req.params.sessionId)) {
      return res.status(400).json({ error: 'invalid projectHash or sessionId' });
    }
    const file = sessionFile(projectHash, req.params.sessionId);
    let raw;
    try { raw = await readFile(file, 'utf-8'); }
    catch { return res.status(404).json({ error: 'session jsonl not found' }); }

    // 定位锚点 + 组段。先干跑一次 compactSegmentJsonl 校验锚点合法(不是用户消息 /
    // 跨锚点工具配对等),避免白跑一次昂贵的摘要生成。
    const dry = compactSegmentJsonl(raw, uuid, direction, '(dry-run)');
    if (!dry.ok) return res.status(400).json({ error: dry.error });

    const lines = raw.split('\n');
    const parsed = lines.map((l) => { if (!l.trim()) return null; try { return JSON.parse(l); } catch { return null; } });
    const anchorIdx = parsed.findIndex((o) => o?.uuid === uuid);
    const segment = direction === 'before' ? parsed.slice(0, anchorIdx) : parsed.slice(anchorIdx);
    const transcript = renderSegmentTranscript(segment);
    if (!transcript.trim()) return res.status(400).json({ error: '待压缩段没有可总结的内容' });

    // 摘要生成:与 /chat/title 同形态(stdin 喂 prompt 绕开 Windows cmd 元字符;
    // plan 模式只读;--no-session-persistence 不落盘;隔离 tmp cwd 不污染项目)。
    const model = safeModelArg(String(req.body?.model || '').replace(/\[1m\]/i, ''));
    const prompt = `请把下面 <对话></对话> 标签内的一段开发对话压缩成一份信息保全的中文摘要。要求:\n- 保留:任务目标、关键决策与理由、涉及的文件路径与函数名、已完成/未完成事项、重要结论与数据、用户明确的要求与偏好。\n- 省略:寒暄、重复内容、工具调用的过程细节。\n- 用条目式陈述,直接输出摘要本身,不加任何前言或解释。\n\n<对话>\n${transcript}\n</对话>`;
    const summaryText = await new Promise((resolve) => {
      let proc;
      // 每次请求用唯一子目录(同 /chat/title):并发的两个压缩请求共用固定 cwd 会互相
      // 污染;用完只删自己建的这个子目录,父目录 cgui-compact 保留。
      const compactCwd = join(tmpdir(), 'cgui-compact', `${process.pid}-${randomUUID()}`);
      const cleanupCompactCwd = () => { try { rmSync(compactCwd, { recursive: true, force: true }); } catch {} };
      try {
        const args = ['-p', '--permission-mode', 'plan', '--no-session-persistence'];
        if (model) args.push('--model', model);
        // 必须同步建目录:异步 mkdir 未 await 就 spawn(cwd:compactCwd),首次目录不存在
        // → spawn cwd 无效直接失败,用户首次用定向压缩必得 502(第二次才成)。同 title 用 mkdirSync。
        try { mkdirSync(compactCwd, { recursive: true }); } catch {}
        proc = claudeSpawn(args, { cwd: compactCwd, stdio: ['pipe', 'pipe', 'pipe'], env: cleanChildEnv() });
        proc.stdin.write(prompt); proc.stdin.end();
      } catch { cleanupCompactCwd(); return resolve(''); }
      if (!proc.pid) { cleanupCompactCwd(); return resolve(''); }
      proc.stderr?.resume(); // 不排空 stderr 超 64KB 会把子进程写死(同 /chat/title)
      let out = '';
      let done = false;
      const finish = () => {
        if (done) return; done = true;
        clearTimeout(timer);
        try { proc.kill('SIGKILL'); } catch {}
        cleanupCompactCwd();
        resolve(out.trim());
      };
      const timer = setTimeout(finish, 180000);
      proc.stdout.on('data', (c) => { out += c.toString(); });
      proc.on('close', finish);
      proc.on('error', () => { if (!done) { done = true; clearTimeout(timer); cleanupCompactCwd(); resolve(''); } });
    });
    // 失败/错误文本兜底:未登录、限流等 CLI 会把英文错误吐到 stdout,不能当摘要写进会话。
    if (!summaryText || summaryText.length < 20
      || /not logged in|please run|api key|unauthor|rate limit|error:|usage:/i.test(summaryText.slice(0, 200))) {
      return res.status(502).json({ error: '摘要生成失败(模型无输出或返回错误),会话未改动' });
    }

    const summaryContent = direction === 'before'
      ? `此前的对话内容已被压缩为以下摘要(原始记录保留在会话文件中,不再计入上下文):\n\n${summaryText}`
      : `以下是本会话中已被回退移除的一段后续对话的摘要,供参考:\n\n${summaryText}`;

    // 改写前关常驻进程(内存上下文与改写后的 jsonl 分叉,复用会答非所问,同 trim)。
    // await 等进程真退出再重读 jsonl(同 trim)。
    await closePersistentForSession(req.params.sessionId);
    // 摘要生成耗时分钟级,期间会话可能有新回合落盘 → 重读最新内容再改写。
    let freshRaw;
    try { freshRaw = await readFile(file, 'utf-8'); }
    catch { return res.status(404).json({ error: 'session jsonl not found' }); }
    const result = compactSegmentJsonl(freshRaw, uuid, direction, summaryContent);
    if (!result.ok) return res.status(409).json({ error: result.error });

    try { await writeFile(file + '.bak', freshRaw, 'utf-8'); } catch {}
    await writeJsonlAtomic(file, result.lines.join('\n'));
    broadcastSessionFileChange(file);
    res.json({ ok: true, direction, summaryChars: summaryText.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/sessions/:sessionId/trim-before-tool  { projectHash, toolUseId }
 * Tool retry support: keep the conversation exactly up to the content block
 * before the selected assistant tool_use, then remove that tool call, its
 * tool_result, and everything after it. The next hidden continuation prompt
 * resumes from that partial assistant turn, so earlier text / earlier tools in
 * the same reply stay visible instead of replaying the whole turn.
 */
router.post('/sessions/:sessionId/trim-before-tool', async (req, res) => {
  try {
    const { projectHash, toolUseId } = req.body || {};
    if (!projectHash || !toolUseId) {
      return res.status(400).json({ error: 'projectHash + toolUseId required' });
    }
    if (!safeId(projectHash) || !safeId(req.params.sessionId)) {
      return res.status(400).json({ error: 'invalid projectHash or sessionId' });
    }
    await closePersistentForSession(req.params.sessionId); // #26:改写历史前关常驻进程(同 trim);await 等进程真退出再读 jsonl

    const file = sessionFile(projectHash, req.params.sessionId);
    let raw;
    try { raw = await readFile(file, 'utf-8'); }
    catch { return res.status(404).json({ error: 'session jsonl not found' }); }

    const { found, keptLines, removedFromLine, totalLines, keptAssistantBlocks } = trimJsonlBeforeTool(raw, toolUseId);
    if (!found) return res.status(404).json({ error: 'tool_use not found in session' });
    try { await writeFile(file + '.bak', raw, 'utf-8'); } catch {}

    if (!hasRealConversationLine(keptLines)) {
      // 和 /trim 一致:不再物理删 jsonl(删后若前端没干净转 draft,下次仍 --resume
      // 旧 sessionId → "No conversation found" 僵尸会话)。保留裁剪后的内容,回
      // sessionReset 让前端转 draft、下次发消息新建会话。
      await writeJsonlAtomic(file, keptLines.join('\n'));
      broadcastSessionFileChange(file);
      return res.json({
        trimmed: true,
        sessionReset: true,
        reason: 'no user/assistant lines would remain — kept meta, client starts fresh',
        removedFromLine,
        totalLines,
      });
    }

    await writeJsonlAtomic(file, keptLines.join('\n'));
    broadcastSessionFileChange(file);
    res.json({
      trimmed: true,
      toolUseId,
      removedFromLine,
      totalLines,
      keptAssistantBlocks,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/sessions/:sessionId/strip-thinking  { projectHash }
 * Remove all `thinking` content blocks from assistant lines in the jsonl.
 * Reason: cc switch routes Claude → DeepSeek/MiMo etc. The previous turns'
 * thinking blocks carry Anthropic-issued signatures that the new backend
 * rejects with `400 messages.X.content.0: Invalid signature in thinking
 * block`. Stripping them before `--resume` keeps the conversation flowing
 * across provider switches. Backup is written to `<sid>.jsonl.bak` first.
 */
router.post('/sessions/:sessionId/strip-thinking', async (req, res) => {
  try {
    const { projectHash } = req.body || {};
    if (!projectHash) return res.status(400).json({ error: 'projectHash required' });
    if (!safeId(projectHash) || !safeId(req.params.sessionId)) {
      return res.status(400).json({ error: 'invalid projectHash or sessionId' });
    }
    await closePersistentForSession(req.params.sessionId); // #26:改写历史前关常驻进程(同 trim);await 等进程真退出再读 jsonl
    const file = join(homedir(), '.claude', 'projects', projectHash, `${req.params.sessionId}.jsonl`);
    let raw;
    try { raw = await readFile(file, 'utf-8'); }
    catch { return res.status(404).json({ error: 'session jsonl not found' }); }
    // Best-effort .bak before rewrite.
    try { await writeFile(file + '.bak', raw, 'utf-8'); } catch {}

    const lines = raw.split('\n');
    let strippedBlocks = 0;
    let touchedLines = 0;
    const out = lines.map((line) => {
      if (!line.trim()) return line;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
          const before = obj.message.content.length;
          const filtered = obj.message.content.filter((c) => c?.type !== 'thinking');
          // 纯 thinking 轮次:剥离后 content 变 [],Anthropic API 拒绝空 content 的
          // assistant 记录(400)导致 resume 失败。这种行保留原样不剥离。
          // (实测:独立的 thinking-only 行不会被上游做签名校验——只有与 tool_use/text
          //  同处一条 message 的 thinking 才校验,那种情况 filter 后仍非空、正常剥离。)
          if (filtered.length === 0) return line;
          obj.message.content = filtered;
          const removed = before - filtered.length;
          if (removed > 0) {
            strippedBlocks += removed;
            touchedLines += 1;
            return JSON.stringify(obj);
          }
        }
      } catch {}
      return line;
    });
    // 原子写(tmp+rename),和 trim 一致 —— 避免裸 writeFile 截断后、写完前被文件
    // 监听器读到空内容,导致前端会话瞬间清空。
    await writeJsonlAtomic(file, out.join('\n'));
    broadcastSessionFileChange(file);
    res.json({ strippedBlocks, touchedLines });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/sessions/:sessionId/repair-official-compat
 * r10-12:旧会话(第三方历史)切官方 400 "text content blocks must be non-empty"。
 * 定位复用 findSessionFile(逐项目目录探 sid.jsonl,无需 projectHash)→ 备份
 * `<file>.bak-<ts>` → repairOfficialCompat(只删空块/空行,parentUuid 链接骨)→
 * 原子写 → 返回 report → 广播 file-change(前端转 cgui:sessions-changed)。
 * 会话有在跑进程 → 409(先停再修,防修完被旧进程写回分叉);idle 常驻保活按
 * trim/strip-thinking 先例 closePersistentForSession 自动关闭再修。
 */
/**
 * GET /api/sessions/:sessionId/repair-official-compat — r11-⑤ 只读体检(dry-run)。
 * 复用 repairOfficialCompat 纯函数但不落地:不备份、不写盘、不关常驻进程,
 * 运行中也允许查(只读)。常驻入口「官方兼容体检与清理」随时可查靠它。
 */
router.get('/sessions/:sessionId/repair-official-compat', async (req, res) => {
  try {
    const sid = req.params.sessionId;
    if (!safeId(sid)) return res.status(400).json({ error: 'invalid sessionId' });
    const file = await findSessionFile(sid);
    if (!file) return res.status(404).json({ error: 'session jsonl not found' });
    const raw = await readFile(file, 'utf-8');
    const { report } = repairOfficialCompat(raw.split('\n'));
    const wouldChange = !!(report.emptyText || report.emptyThinking || report.droppedLines || report.relinked);
    res.json({ report, wouldChange });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sessions/:sessionId/repair-official-compat', async (req, res) => {
  try {
    const sid = req.params.sessionId;
    if (!safeId(sid)) return res.status(400).json({ error: 'invalid sessionId' });
    const running = getActiveChatProcesses().some(
      (p) => p.sessionId === sid && p.exitCode === null && !p.idle,
    );
    if (running) return res.status(409).json({ error: '会话正在运行,请先停止再清理' });
    await closePersistentForSession(sid); // idle 常驻:关掉再改写(同 trim/strip-thinking)
    const file = await findSessionFile(sid);
    if (!file) return res.status(404).json({ error: 'session jsonl not found' });
    const raw = await readFile(file, 'utf-8');
    const { lines, report } = repairOfficialCompat(raw.split('\n'));
    const changed = report.emptyText || report.emptyThinking || report.droppedLines || report.relinked;
    if (changed) {
      await writeFile(`${file}.bak-${Date.now()}`, raw, 'utf-8'); // 备份必须成功才动原文件
      await writeJsonlAtomic(file, lines.join('\n'));
      broadcastSessionFileChange(file);
    }
    res.json({ report, changed: !!changed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/sessions/:sessionId?projectHash=...
 * Permanently removes the session jsonl + sidecar metadata.
 */
router.delete('/sessions/:sessionId', async (req, res) => {
  try {
    const { projectHash } = req.query;
    if (!projectHash) return res.status(400).json({ error: 'projectHash required' });
    if (!safeId(projectHash) || !safeId(req.params.sessionId)) {
      return res.status(400).json({ error: 'invalid projectHash or sessionId' });
    }
    const file = join(homedir(), '.claude', 'projects', projectHash, `${req.params.sessionId}.jsonl`);
    // #26:删除前关掉该会话的常驻/在跑进程 —— 残余进程可能把刚删的 jsonl 写"复活"。
    // 客户端删除链路已先调 /stop,这里是服务端兜底(直连 API 删除也安全)。
    // await 等进程真退出再 unlink,彻底排除退出前旧写入复活文件。
    await closePersistentForSession(req.params.sessionId);
    const { unlink } = await import('fs/promises');
    let deletedJsonl = false;
    try {
      await unlink(file);
      deletedJsonl = true;
    } catch (e) {
      if (e.code === 'ENOENT') {
        return res.status(404).json({ error: 'session not found' });
      }
      return res.status(500).json({ error: e.message });
    }
    // Best-effort: remove the .archived marker and the registry sidecar if present.
    try { await unlink(file + '.archived'); } catch {}
    try { await unlink(join(homedir(), '.claude', 'sessions', `${req.params.sessionId}.json`)); } catch {}
    // Best-effort prefs GC(1M 标记/双份标题/置顶),失败不阻断删除响应。
    try { await removeSessionFromPrefs(req.params.sessionId); } catch {}
    broadcastSessionFileChange(file, 'unlink'); // 文件已删,path 仍发原 jsonl 路径(客户端判据纯字符串)
    res.json({ deleted: deletedJsonl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/sessions/:sessionId/archive  { projectHash, archived: boolean }
 * Hide-from-default-list / restore. Implemented as a sibling marker file
 * `<sid>.jsonl.archived` so it survives across restarts and doesn't pollute
 * the jsonl itself. Empty file = archived; absence = active.
 */
router.post('/sessions/:sessionId/archive', async (req, res) => {
  try {
    const { projectHash, archived } = req.body || {};
    if (!projectHash) return res.status(400).json({ error: 'projectHash required' });
    if (!safeId(projectHash) || !safeId(req.params.sessionId)) {
      return res.status(400).json({ error: 'invalid projectHash or sessionId' });
    }
    const projectDir = join(homedir(), '.claude', 'projects', projectHash);
    const jsonl = join(projectDir, `${req.params.sessionId}.jsonl`);
    const marker = `${jsonl}.archived`;
    const { writeFile: wf, unlink, stat: st } = await import('fs/promises');
    // Verify the session jsonl actually exists before flipping its archive
    // state — otherwise a bad client could create stray `.archived` files
    // anywhere we have write access, and a missing project dir would leak
    // an ENOENT to the response.
    try { await st(jsonl); }
    catch { return res.status(404).json({ error: 'session not found' }); }
    if (archived) {
      await wf(marker, String(Date.now()), 'utf-8');
    } else {
      try { await unlink(marker); } catch {}
    }
    broadcastSessionFileChange(jsonl); // 归档只写 sidecar,但他端侧栏要感知 → 仍按 jsonl 路径发
    res.json({ archived: !!archived });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/bak-files
 * Scan ~/.claude/projects for *.jsonl.bak (created by trim & strip-thinking),
 * pair each with its session title (first user prompt) and stats so the UI
 * can show a manual cleanup table. Orphan .bak (parent .jsonl missing) get
 * marked so the user knows they're safe to clean.
 */
router.get('/bak-files', async (req, res) => {
  try {
    const projectsDir = join(homedir(), '.claude', 'projects');
    let projectDirs;
    try {
      projectDirs = (await readdir(projectsDir, { withFileTypes: true }))
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name);
    } catch { return res.json({ items: [], totalBytes: 0 }); }

    const items = [];
    let totalBytes = 0;
    for (const hash of projectDirs) {
      const dir = join(projectsDir, hash);
      let files;
      try { files = await readdir(dir); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl.bak')) continue;
        const sessionId = f.replace(/\.jsonl\.bak$/, '');
        const full = join(dir, f);
        let st;
        try { st = await stat(full); } catch { continue; }
        // Orphan check + title lookup (read first ~50 lines of the .bak;
        // first record with type === 'user' carries the human prompt).
        const jsonlPath = join(dir, `${sessionId}.jsonl`);
        let orphan = false;
        try { await stat(jsonlPath); } catch { orphan = true; }
        let title = '';
        try {
          // Read only the head (8KB) — enough for system + first user line.
          // Avoids loading multi-MB backups in full just to extract a title.
          const fd = await open(full, 'r');
          const buf = Buffer.alloc(8192);
          const { bytesRead } = await fd.read(buf, 0, 8192, 0);
          await fd.close();
          const lines = buf.subarray(0, bytesRead).toString('utf-8').split('\n').slice(0, 50);
          for (const ln of lines) {
            if (!ln.trim()) continue;
            try {
              const obj = JSON.parse(ln);
              if (obj.type === 'user' && obj.message?.content) {
                const c = obj.message.content;
                const text = typeof c === 'string'
                  ? c
                  : Array.isArray(c) ? c.find((x) => x.type === 'text')?.text || '' : '';
                if (text) { title = text.slice(0, 80); break; }
              }
            } catch {}
          }
        } catch {}
        totalBytes += st.size;
        items.push({
          projectHash: hash,
          sessionId,
          size: st.size,
          mtimeMs: st.mtimeMs,
          orphan,
          title: title || '(无标题)',
        });
      }
    }
    items.sort((a, b) => b.mtimeMs - a.mtimeMs);
    res.json({ items, totalBytes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/bak-files
 * Body: { items: [{ projectHash, sessionId }, ...] } OR { all: true }
 * Removes the matching `<sid>.jsonl.bak` files. Returns count + freed bytes.
 */
router.delete('/bak-files', async (req, res) => {
  try {
    const { items, all } = req.body || {};
    const { unlink } = await import('fs/promises');
    let targets = [];
    if (all) {
      const projectsDir = join(homedir(), '.claude', 'projects');
      let dirs;
      try {
        dirs = (await readdir(projectsDir, { withFileTypes: true }))
          .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
          .map((e) => e.name);
      } catch { dirs = []; }
      for (const hash of dirs) {
        const dir = join(projectsDir, hash);
        let files;
        try { files = await readdir(dir); } catch { continue; }
        for (const f of files) {
          if (f.endsWith('.jsonl.bak')) {
            targets.push({ projectHash: hash, sessionId: f.replace(/\.jsonl\.bak$/, '') });
          }
        }
      }
    } else if (Array.isArray(items)) {
      targets = items.filter((x) => safeId(x?.projectHash) && safeId(x?.sessionId));
    } else {
      return res.status(400).json({ error: 'items[] or all required' });
    }

    let deleted = 0;
    let freedBytes = 0;
    for (const t of targets) {
      const file = join(homedir(), '.claude', 'projects', t.projectHash, `${t.sessionId}.jsonl.bak`);
      try {
        const st = await stat(file);
        await unlink(file);
        deleted += 1;
        freedBytes += st.size;
      } catch {}
    }
    res.json({ deleted, freedBytes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/project/purge { cwd } — 彻底清理某项目的 Claude 本地状态。
// 危险操作:调用 CLI `claude project purge -y <path>`,删除 ~/.claude/projects/<hash>
// 下的会话记录(.jsonl)与 memory/ 等 Claude 状态,不触碰项目源码(实测:-y 非交互,
// 退出码 0,源目录文件保留)。cwd 经 resolveWorkspacePath 校验:$HOME 内直接放行;$HOME 外
// 但属于"已知 claude 工作区"(~/.claude/projects 有对应 hash)也放行——Windows 项目常在
// D:\ 等其他盘,纯 $HOME 门禁让删除项目报"清理失败:outside $HOME"(用户实报);能出现在
// 项目列表里的路径必然有 hash 目录,恰好被工作区例外覆盖。.. 段仍一律拒绝。
router.post('/project/purge', async (req, res) => {
  // 校验不改写(fable 审计 #4):resolveWorkspacePath 可能返回 realpath/normalize 后的
  // 形态(mac /tmp→/private/tmp、Win junction/OneDrive),而 CLI 按【记录时的原始 cwd
  // 字符串】hash 匹配项目——传改写形态可能对不上 hash 清不掉。门禁用解析结果,CLI 用原串
  // (原串即项目列表反解出的记录形态)。
  const rawCwd = String(req.body?.cwd || '');
  let dir;
  try { resolveWorkspacePath(rawCwd, { label: 'cwd', requireCanonical: true }); dir = rawCwd; }
  catch (e) { return res.status(400).json({ error: e.message }); }

  let proc;
  try {
    proc = claudeSpawn(['project', 'purge', '-y', dir], {
      cwd: homedir(), stdio: ['ignore', 'pipe', 'pipe'], env: cleanChildEnv(),
    });
  } catch (e) { return res.status(500).json({ error: 'spawn failed: ' + e.message }); }
  if (!proc.pid) { proc.on('error', () => {}); return res.status(500).json({ error: 'claude CLI not found' }); }

  let out = '', err = '', done = false;
  const finish = (status, data) => {
    if (done) return; done = true;
    clearTimeout(timer);
    try { proc.kill('SIGKILL'); } catch {}
    res.status(status).json(data);
  };
  const timer = setTimeout(() => finish(504, { error: 'purge 超时' }), 30_000);
  proc.stdout.on('data', (c) => { out += c.toString(); });
  proc.stderr.on('data', (c) => { err += c.toString(); });
  proc.on('close', (code) => {
    finish(code === 0 ? 200 : 500, { ok: code === 0, code, stdout: out.trim(), stderr: err.trim() });
  });
  proc.on('error', (e) => finish(500, { error: e.message }));
});

// GET /api/active-sessions — currently running Claude processes
router.get('/active-sessions', async (req, res) => {
  try {
    const sessions = await getActiveSessions();
    res.json(sessions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/session-ref { sessionId, projectHash } — @ 引用会话:把指定会话渲染成
// 精简 Markdown(用户/Claude 文本 + 工具调用一行摘要)写入 ~/.claude-gui/session-refs/<sid>.md,
// 返回绝对路径。前端把 `@<path>` 插进输入框,CLI 原生 @ 语法读文件即获得该会话上下文
// ——比直接塞 jsonl 省 token 且可读。超长会话保留最近 200KB(最近内容最相关)。
const SESSION_REFS_DIR = join(homedir(), '.claude-gui', 'session-refs');
router.post('/session-ref', async (req, res) => {
  const sessionId = String(req.body?.sessionId || '');
  const projectHash = String(req.body?.projectHash || '');
  if (!safeId(sessionId) || !safeId(projectHash)) return res.status(400).json({ error: 'invalid id' });
  try {
    const { messages } = await getSessionMessages(sessionId, projectHash);
    const parts = [];
    for (const m of messages) {
      if (m.type === 'user' && m.text) parts.push(`## 用户\n\n${m.displayText || m.text}`);
      else if (m.type === 'turn') {
        const body = (m.text || []).join('\n\n');
        const tools = (m.toolCalls || []).length ? `\n\n> 工具调用 ×${m.toolCalls.length}:${[...new Set(m.toolCalls.map((t) => t.name))].join(', ')}` : '';
        if (body || tools) parts.push(`## Claude\n\n${body}${tools}`);
      }
    }
    if (!parts.length) return res.status(400).json({ error: '该会话没有可引用的内容' });
    let md = `# 引用会话 ${sessionId}\n\n${parts.join('\n\n---\n\n')}\n`;
    const CAP = 200 * 1024;
    if (Buffer.byteLength(md) > CAP) {
      const buf = Buffer.from(md);
      md = `# 引用会话 ${sessionId}(超长,仅保留最近内容)\n\n…\n${buf.slice(buf.length - CAP).toString().replace(/^[^\n]*\n/, '')}`;
    }
    await mkdir(SESSION_REFS_DIR, { recursive: true });
    const target = join(SESSION_REFS_DIR, `${sessionId}.md`);
    await writeFile(target, md);
    res.json({ path: target });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/export-session { md, fileName?, targetPath? } — 把会话 Markdown 落盘。
// Tauri WKWebView 拦 blob URL 的 a[download](静默失败,用户报"导出点击没反应"),
// 所以 Tauri 环境改走这里落盘;浏览器环境仍用前端 blob 下载。
// targetPath:前端经系统"保存"对话框(@tauri-apps/plugin-dialog save)选的绝对路径,
// 用户明确指定保存位置(用户要求);不传则回落旧行为写 ~/Downloads/<fileName>。
router.post('/export-session', async (req, res) => {
  const md = String(req.body?.md || '');
  if (!md) return res.status(400).json({ error: 'md 必填' });
  try {
    let target;
    const tp = typeof req.body?.targetPath === 'string' ? req.body.targetPath.trim() : '';
    if (tp) {
      if (tp.includes('\0')) return res.status(400).json({ error: 'targetPath 非法' });
      // 分层门禁(用户拍板:导出要能存任意位置含 D 盘,Mac/Win 同):
      //  - 本机请求(桌面 app 原生保存对话框,isLocalReq)→ 任意绝对路径放行,仍拒 ../.
      //    段 + 强制 .md(防写成可执行/配置);
      //  - 局域网客户端 → 维持 $HOME 门禁(端点不设防时 authed 远端可覆盖别处 .md 的
      //    任意写防护,原威胁模型只针对远端)。
      if (isLocalReq(req)) {
        const segs = tp.split(/[\\/]+/);
        if (!isAbsolute(tp) || segs.some((s) => s === '.' || s === '..')) {
          return res.status(400).json({ error: 'targetPath 非法' });
        }
        target = resolve(tp);
      } else {
        try {
          target = resolveUnderHome(tp, { label: 'targetPath', requireCanonical: true });
        } catch (e) { return res.status(400).json({ error: e.message }); }
      }
      target = target.toLowerCase().endsWith('.md') ? target : target + '.md';
      await mkdir(dirname(target), { recursive: true });
    } else {
      // 文件名白名单:去路径分隔符与危险字符,只留中英文数字点横杠空格,强制 .md
      let fileName = String(req.body?.fileName || '会话.md')
        .replace(/[/\\]/g, '_')
        .replace(/[^\w一-龥.\-\s]/g, '')
        .trim()
        .slice(0, 120) || '会话.md';
      if (!fileName.toLowerCase().endsWith('.md')) fileName += '.md';
      const dir = join(homedir(), 'Downloads');
      await mkdir(dir, { recursive: true });
      target = join(dir, fileName);
    }
    await writeFile(target, md, 'utf-8');
    res.json({ ok: true, path: target });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
