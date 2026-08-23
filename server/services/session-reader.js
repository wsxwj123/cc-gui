import { readdir, stat, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import {
  isApprovedPlanToolCall,
  mergeEquivalentPlanToolCall,
  planSignature,
} from '../../client/src/utils/plan.js';

export { isApprovedPlanToolCall };
import { parseJsonl, readJsonlEdges } from '../utils/jsonl-parser.js';

// L4: 附件元数据 sidecar。cc CLI 的 jsonl 由 CLI 写,GUI 无法注入 attachments 字段,
// 改用旁路文件按 textHash 索引,session-reader 读历史消息时 merge 回来。
const ATTACHMENTS_DIR = join(homedir(), '.claude-gui', 'attachments');
function attachmentsSidecarPath(sessionId) {
  return join(ATTACHMENTS_DIR, `${sessionId}.json`);
}
export function attachmentTextHash(text) {
  return createHash('sha1').update(String(text || '')).digest('hex').slice(0, 16);
}
async function readAttachmentsSidecar(sessionId) {
  try {
    const buf = await readFile(attachmentsSidecarPath(sessionId), 'utf-8');
    const d = JSON.parse(buf);
    return (d && typeof d === 'object' && !Array.isArray(d)) ? d : {};
  } catch { return {}; }
}

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
  // 反斜杠归一后再比:Windows 上 cwd 是 C:\Users\X\.claude\... 形态,直接拿 `${HOME}/.claude`
  // (含正斜杠)永远匹配不上 → 内部目录混进项目列表。归一为正斜杠统一判断。
  const n = p.replace(/\\/g, '/');
  const h = HOME.replace(/\\/g, '/');
  if (n === `${h}/.claude` || n.startsWith(`${h}/.claude/`)) return true;       // ~/.claude/* internals
  if (n === `${h}/.claude-mem` || n.startsWith(`${h}/.claude-mem/`)) return true; // claude-mem state
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
const SESSIONS_DIR = join(CLAUDE_DIR, 'sessions');

// ── 会话 jsonl 里的标题行 ────────────────────────────────────────────────────
// CLI/SDK 把标题作为独立记录追加进会话 jsonl(无 uuid/timestamp,同一文件可有多行,
// 后写胜出):
//   {"type":"custom-title","customTitle":"...","sessionId":"..."}  手动改名(renameSession)
//   {"type":"ai-title","aiTitle":"...","sessionId":"..."}          CLI 首轮后自动生成
// **两者必须分开取**:SDKSessionInfo.customTitle 把 ai-title 也塞进同一个字段,照抄它
// 会让自动标题覆盖用户手改。GUI 的优先级链靠区分两者(见 client/src/utils/sessionTitle.js)。
// customTitle 为空串 = 用户清空了自定义标题(SDK 的 renameSession 拒绝空标题,清空由
// prefs.js 自己追加空行表达),按"无"处理。
function takeTitleLine(raw, acc) {
  if (!raw.includes('"custom-title"') && !raw.includes('"ai-title"')) return;
  try {
    const r = JSON.parse(raw);
    if (r?.type === 'custom-title' && typeof r.customTitle === 'string') acc.customTitle = r.customTitle.trim();
    else if (r?.type === 'ai-title' && typeof r.aiTitle === 'string') acc.aiTitle = r.aiTitle.trim();
  } catch {}
}

/** 单个会话文件的标题行(不需要整份会话时用;edgeSize 0 = 只扫行不解析头尾)。 */
export async function readSessionTitles(filePath) {
  const acc = { customTitle: '', aiTitle: '' };
  try { await readJsonlEdges(filePath, 0, (raw) => takeTitleLine(raw, acc)); } catch {}
  return acc;
}

/**
 * sessionId → 会话 jsonl 绝对路径。与 SDK 省略 dir 时的行为同款:逐个项目目录探
 * `<sid>.jsonl`(sessionId 是 uuid,不可能跨项目撞名,首个命中即正解)。找不到返回 null
 * (未落盘的 draft 会话就是这种情况)。
 */
export async function findSessionFile(sessionId) {
  if (!/^[0-9a-fA-F-]{36}$/.test(String(sessionId || ''))) return null;
  let dirs;
  try { dirs = await readdir(PROJECTS_DIR); } catch { return null; }
  for (const d of dirs) {
    const p = join(PROJECTS_DIR, d, `${sessionId}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Decode project hash back to a readable path.
 * -Users-alice-Desktop-proj → /Users/alice/Desktop/proj
 *
 * Some legacy project dirs in ~/.claude/projects/ have trailing dashes
 * (e.g. `-Users-alice-Desktop-proj----`) — they were created when the CLI
 * was spawned with a cwd ending in extra slashes. Decoding them naively
 * produces `/Users/alice/Desktop/proj////` which then breaks git status,
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
 * r26-E3:projectsDir 参数仅供测试注入(单测用 /tmp 自建目录验证 EACCES 行为,
 * 严禁触碰真实 ~/.claude/projects);生产调用一律缺省。
 * 注意:顶层 readdir 的 EACCES/EPERM 不上捞兜住——原样抛给路由层,由 /projects
 * 路由经 isAccessDenied 分类成 403(sessions.js,与 r17-4 契约同构)。
 */
export async function listProjects(projectsDir = PROJECTS_DIR) {
  const entries = await readdir(projectsDir, { withFileTypes: true });
  const projects = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectPath = join(projectsDir, entry.name);
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
          // 只要头 10 条判 cwd:parseJsonl(limit) 读满即关流,不像 readJsonlEdges
          // 那样为了 tail/totalLines 走完整个文件(项目列表读盘量的大头就在这)。
          const head = await parseJsonl(join(projectPath, newestFile), { limit: 10 });
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
            const head = await parseJsonl(join(projectPath, f), { limit: 10 });
            const c = cwdFromHead(head);
            if (!c || c === sidecarCwd) matched += 1;
          } catch { matched += 1; }
        }
        sessionCount = matched;
      }

      // worktree 打标(纯字符串判据,零 git 调用):GUI 建的树在 <repo名>-worktrees/ 下,
      // CLI agent 自动建的在 <repo>/.claude/worktrees/ 下。归一化反斜杠兼容 Windows。
      const slashPath = realPath.replace(/\\/g, '/');
      projects.push({
        hash: entry.name,
        path: realPath,
        sessionCount,
        lastActivity: new Date(lastModified).toISOString(),
        isWorktree: /-worktrees\//.test(slashPath) || /\/\.claude\/worktrees\//.test(slashPath),
      });
    } catch {
      // skip inaccessible dirs
    }
  }

  // Sort by last activity descending
  projects.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  return projects;
}

// r29:已知无参控制命令的封闭集合(CLI 内置;内置解析优先于同名 skill,用户 skill
// 无法遮蔽,故按名判定安全)。这些命令是纯 CLI 簿记/本地面板,不产生会话内容,
// 作为会话【首条】出现 = 该会话是 /clear 轮换或误触发的空壳,不进列表。
// 刻意不收:会产生真实模型回合的内置命令(/init /review /security-review 等)——
// 它们裸开场也是真会话。比对口径:reconstructCommandPrompt 的 bareToName 返回
// 恰为命令名(带斜杠),有 args 时是 "name args" 不会命中本集合。
const BARE_CONTROL_COMMANDS = new Set([
  '/agents', '/autocompact', '/bug', '/clear', '/color', '/compact', '/config',
  '/context', '/cost', '/doctor', '/effort', '/exit', '/export', '/fast',
  '/heapdump', '/help', '/hooks', '/ide', '/insights', '/login', '/logout',
  '/mcp', '/memory', '/model', '/output-style', '/permissions',
  '/privacy-settings', '/quit', '/recap', '/release-notes', '/reload-skills',
  '/rename', '/resume', '/status', '/statusline', '/terminal-setup', '/theme',
  '/todos', '/upgrade', '/usage', '/vim',
]);

/**
 * Find the first user record that carries a REAL prompt — same criteria the
 * message view (getSessionMessages) uses to decide what counts as a user bubble.
 * A real session opens with metadata stacking (custom-title / mode /
 * permission-mode / queue-operation×N / system / attachment×N), so the textual
 * user record is often pushed past index 0; and isMeta records (e.g. "Continue
 * from where you left off.") or pure tool_result records are CLI/Desktop
 * bookkeeping, never a prompt. Skipping them prevents both the "会话凭空消失"
 * (real user pushed out of a too-small head) and "firstPrompt 取到空/伪内容" bugs.
 * Returns the record AND the resolved display text (so callers don't re-parse).
 */
function findFirstRealUser(head) {
  let compactRecord = null;
  for (const r of head) {
    if (r.type !== 'user') continue;
    // A /compact-continued session's head can contain NO fresh textual user
    // (the real prompt sits beyond head): its first user is the compact summary,
    // followed by assistant + tool_result records. Such sessions are real long
    // conversations and must NOT be dropped. Remember the compact record as a
    // fallback keep-signal, but keep scanning — a real prompt later in head wins.
    if (r.isCompactSummary) { compactRecord = compactRecord || r; continue; }
    if (r.isMeta) continue;
    const content = normalizeContent(r.message?.content);
    const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
    // CI-5:列表/标题判定用 bareToName —— 纯 `/skillname`(无 args)也算"真实首条",会话才进列表。
    const cmdPrompt = reconstructCommandPrompt(text, { bareToName: true });
    // Real prompt = a reconstructable /command, OR plain text that isn't a local
    // command echo. tool_result-only / empty-text records fall through.
    // r29:但裸无参【控制命令】(/clear /compact /context /cost /login /logout …,封闭集合
    // 见下)不是真实首条 —— CI-5 的 bareToName 放行本意是 /skillname 开场,控制命令也走
    // 同一分支被当真实,于是 CLI 2.1.x /clear 轮换出的新会话(头部唯一 user 记录就是
    // /clear 命令回声)在列表里冒成一个空的「/clear」会话。有 args 的命令(/compact 主题)
    // 与 /skillname 不在集合内,照旧放行。
    if (cmdPrompt && !BARE_CONTROL_COMMANDS.has(cmdPrompt.toLowerCase())) return { record: r, text: cmdPrompt };
    if (!cmdPrompt && text && !isLocalCommandEcho(text)) return { record: r, text };
  }
  // No real prompt in head, but a compact summary means this is a continued
  // conversation — keep it with a clean label instead of the verbose preamble.
  if (compactRecord) return { record: compactRecord, text: '（接续之前的对话）' };
  return null;
}

/**
 * 续段回退标题:compact 链的根文件缺失(被清理)时,从续段回放区取第一条真实
 * 用户消息当标题。与 findFirstRealUser 的差异:额外跳过每个续段头部固定出现的
 * "This session is being continued" 接续说明、/compact 命令回声、中断占位——
 * 它们都不是用户的原始请求,正是列表里一排 "/compact" 标题的来源。
 */
function findContinuationPrompt(head) {
  for (const r of head) {
    if (r.type !== 'user' || r.isMeta || r.isCompactSummary) continue;
    const content = normalizeContent(r.message?.content);
    const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
    if (!text) continue;
    if (/^This session is being continued/.test(text)) continue;
    if (/^\[Request interrupted/.test(text)) continue;
    const cmdPrompt = reconstructCommandPrompt(text, { bareToName: true });
    if (cmdPrompt) {
      if (/^\/compact\b/.test(cmdPrompt)) continue;
      return cmdPrompt;
    }
    if (!isLocalCommandEcho(text)) return text;
  }
  return null;
}

/**
 * List sessions for a project hash.
 * Filters out trivial sessions and groups subagent sessions under parents.
 */
// ── r13-p2-6:会话列表的文件级解析缓存(展开项目卡顿根治)──────────────
// listSessions 对项目下每个 jsonl 都整文件读一遍(收集 compact_boundary 与标题行);
// 48 个会话实测 1.8-2.1s,每次展开项目都付一次。绝大多数文件在两次调用之间根本
// 没变 → 按 (mtimeMs, size) 缓存解析结果,只有变化/新增的文件才重读。
// 键=绝对路径;上限 800 条,超了按插入序淘汰(Map 天然有序)。
const EDGES_CACHE = new Map();
const EDGES_CACHE_MAX = 800;

async function readEdgesCached(filePath, st, edgeSize, onRaw = null) {
  const key = `${filePath}#${edgeSize}`;
  const hit = EDGES_CACHE.get(key);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.val;
  const boundaryUuids = [];
  const titles = { customTitle: '', aiTitle: '' };
  const edges = onRaw
    ? await readJsonlEdges(filePath, edgeSize, (raw) => onRaw(raw, boundaryUuids, titles))
    : await readJsonlEdges(filePath, edgeSize);
  const val = { ...edges, boundaryUuids, titles };
  if (EDGES_CACHE.size >= EDGES_CACHE_MAX) {
    const oldest = EDGES_CACHE.keys().next().value;
    EDGES_CACHE.delete(oldest);
  }
  EDGES_CACHE.set(key, { mtimeMs: st.mtimeMs, size: st.size, val });
  return val;
}

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
  // compact/resume 链折叠的侧表:sessionId → { boundaryUuids, isContinuation, fallbackPrompt }。
  // 不进响应体,只在循环后做链分组用。
  const chainMeta = new Map();
  const isBoundaryRecord = (r) =>
    r?.type === 'system' && r?.subtype === 'compact_boundary' && typeof r.uuid === 'string';
  for (const file of jsonlFiles) {
    const filePath = join(projectPath, file);
    const sessionId = file.replace('.jsonl', '');

    try {
      // r13-p2-6:stat 提到读文件之前 —— 缓存键要用 mtime/size(下方原 stat 复用它)。
      const st0 = await stat(filePath);
      // edgeSize 40 (was 10): real sessions stack custom-title / mode /
      // permission-mode / queue-operation×N / system / attachment×N before the
      // first textual user record (observed at index 27). A 10-line head pushed
      // that user out → the whole session vanished from the list. 40 covers the
      // metadata pile; the cost is reading a few dozen extra lines per file.
      //
      // 顺路收集全文件的 compact_boundary uuid(readJsonlEdges 本就逐行读完整个
      // 文件,零额外 I/O)。回调收到的是**原始行字符串**:先用子串命中率极低的
      // includes 预筛,再对极少数命中行 JSON.parse —— 中部行不再逐条解析。
      // 注意 boundary 不止在头部:/compact 是先写进原文件继续
      // 对话,--resume 才新开文件并把 boundary 起的历史(uuid 原样)回放进新文件,
      // 所以"共享任一 boundary uuid"= 同一条对话链,这是唯一可靠的跨文件链接信号
      // (实测 logicalParentUuid 指向的记录在父文件中部而非尾部,尾部映射法 0 命中)。
      // 标题行同路收集(见 takeTitleLine):追加位置不定(手改在尾、ai-title 在头),
      // 走整文件回调比 head/tail 40 行窗口可靠,且零额外 I/O。
      const { head, tail, totalLines, boundaryUuids, titles } = await readEdgesCached(
        filePath, st0, 40,
        (raw, bUuids, tt) => {
          takeTitleLine(raw, tt);
          if (!raw.includes('"compact_boundary"')) return;
          try {
            const r = JSON.parse(raw);
            if (isBoundaryRecord(r)) bUuids.push(r.uuid);
          } catch {}
        },
      );

      // Extract metadata from first REAL user message (skips isMeta / pure
      // tool_result / local-command-echo records, aligned with getSessionMessages).
      const firstRealUser = findFirstRealUser(head);
      const firstUser = firstRealUser?.record || null;
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

      // findFirstRealUser already resolved the display text (plain prompt or a
      // reconstructed `/name args` for skill/slash-started sessions), so we just
      // slice it — no re-parsing of raw content / command blobs needed.
      let firstPrompt = firstRealUser?.text?.slice(0, 200) || '';

      // 防御:标题生成是一次性隔离调用(POST /api/chat/title),正常带
      // --no-session-persistence 不落盘;万一某版本/某 provider 仍写了 jsonl,
      // 它会以"给下面这段对话起一个标题…"开头污染列表。无论如何都不显示。
      if (/^给下面这段对话起一个/.test(firstPrompt)) continue;

      // security-guidance 官方插件在 Stop/commit/push 时用 Agent SDK 起一次性安全审查会话,
      // cwd=用户项目 → jsonl 落进项目目录被当真实会话列出(无标题,首句=审查 prompt)。
      // 不能按 promptSource/entrypoint 字段过滤(会误杀真会话);prompt 是固定机器串,
      // 真人对话不会这样开头 → 按前缀跳过(与上面标题生成同套防御)。
      if (/^Review this change for security vulnerabilities\./.test(firstPrompt)) continue;

      // BG9:某些外部 agent-teams/orchestration 工具会在项目目录写出名字像 sessionId
      // 的辅助 jsonl,内容是 agent-setting/queue-operation/ai-title 等非对话 type,
      // 没有任何 user/assistant 记录。session-reader 此前不识别 → 当成真实会话列出 →
      // 用户点进去是空白。**没有 user 类型 = 不是 Claude Code 会话,跳过**。
      if (!firstUser) continue;

      // 保险:sidechain(子代理)transcript 不进主列表。当前 Desktop/CLI 都把子代理
      // 写在 <sessionId>/subagents/ 子目录(顶层扫不到),但形态若变(写到顶层),
      // 记录里的 isSidechain:true 仍是可靠标记——头部任一记录带真值即跳过。
      if (head.some((r) => r?.isSidechain === true)) continue;

      // Skip ONLY truly empty sessions. A brand-new session (just one prompt +
      // reply) is ~3-8 lines, which we want to show. The old `< 20 && !meaningful`
      // filter swallowed every new chat whose prompt didn't pass isMeaningfulPrompt
      // — the user's #1 complaint was new sessions never appearing in history.
      if (totalLines < 3) continue;

      const s = st0; // r13-p2-6:复用缓存判据用的 stat,免第二次系统调用

      // Archive marker — sibling `<sid>.jsonl.archived` flips visibility.
      let archived = false;
      try {
        await stat(filePath + '.archived');
        archived = true;
      } catch {}

      // Check for subagent sessions
      const subagents = [];
      const subagentDir = join(projectPath, sessionId, 'subagents');
      // 构建单条子代理条目(扁平 Task 子代理 与 workflow 起的 agent 共用)。extra 里带
      // workflowId(workflow agent 特有)等额外字段。
      const buildAgentEntry = async (agentPath, metaPath, extra = {}) => {
        const as = await stat(agentPath); // r13-p2-6:提前 stat 供缓存判据(下方复用)
        const agentEdges = await readEdgesCached(agentPath, as, 5);
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
        // R1: sibling meta.json 带 toolUseId(=父会话 Task tool_use 的 id)。workflow agent 的
        // meta 没有 toolUseId(它不对应父流任何 Task 卡片),留空即可。
        let agentMeta = {};
        try { agentMeta = JSON.parse(await readFile(metaPath, 'utf-8')); } catch {}
        const base = agentPath.split(/[/\\]/).pop().replace('.jsonl', '');
        // #2/#11 子代理视图数据:上下文占用取 tail 最后一条 assistant 的 usage(单次调用口径,
        // 与主会话徽章同算法:input+cache_read+cache_creation);cwd 取任一记录顶层 cwd —— 子代理
        // 在 worktree 隔离时它与主项目路径不同,前端据此显示 worktree 徽标。
        const lastAsst = [...agentEdges.tail].reverse().find((r) => r.type === 'assistant' && r.message?.usage);
        const au = lastAsst?.message?.usage || null;
        const agentCtxTokens = au
          ? (au.input_tokens || 0) + (au.cache_read_input_tokens || 0) + (au.cache_creation_input_tokens || 0)
          : null;
        const agentCwd = agentEdges.head.find((r) => r?.cwd)?.cwd || agentEdges.tail.find((r) => r?.cwd)?.cwd || null;
        const agentBranch = agentEdges.head.find((r) => r?.gitBranch)?.gitBranch || null;
        return {
          sessionId: base,
          projectHash,
          filePath: agentPath,
          firstPrompt: agentPrompt || base.replace('agent-', 'Agent '),
          messageCount: agentEdges.totalLines,
          lastActivity: agentEdges.tail[agentEdges.tail.length - 1]?.timestamp || new Date(as.mtimeMs).toISOString(),
          model: agentEdges.head.find((r) => r.type === 'assistant')?.message?.model || null,
          toolUseId: agentMeta.toolUseId || null,
          agentType: agentMeta.agentType || null,
          contextTokens: agentCtxTokens,
          cwd: agentCwd,
          gitBranch: agentBranch,
          isSubagent: true,
          ...extra,
        };
      };
      try {
        const agentFiles = await readdir(subagentDir);
        for (const af of agentFiles) {
          if (!af.endsWith('.jsonl')) continue;
          const agentPath = join(subagentDir, af);
          try {
            subagents.push(await buildAgentEntry(agentPath, join(subagentDir, af.replace('.jsonl', '.meta.json'))));
          } catch {}
        }
        // Workflow(动态工作流)起的 agent 埋在 subagents/workflows/wf_*/agent-*.jsonl(深两层),
        // 上面的一层扫描收不到 → 监控面板看不到 workflow 的 agent(用户报"用了 workflow 就看不到")。
        // 递归进去补上,标 workflowId 供前端区分。实时面板另说(workflow 不走父流 Task 事件)。
        try {
          const wfRoot = join(subagentDir, 'workflows');
          for (const wf of await readdir(wfRoot)) {
            if (!wf.startsWith('wf_')) continue;
            const wfDir = join(wfRoot, wf);
            let wfFiles;
            try { wfFiles = await readdir(wfDir); } catch { continue; }
            for (const af of wfFiles) {
              if (!af.startsWith('agent-') || !af.endsWith('.jsonl')) continue; // 跳过 journal.jsonl 等
              try {
                subagents.push(await buildAgentEntry(
                  join(wfDir, af),
                  join(wfDir, af.replace('.jsonl', '.meta.json')),
                  { workflowId: wf },
                ));
              } catch {}
            }
          }
        } catch {}
      } catch {}

      // 续段 = 头部带 compact_boundary(resume 回放写在最前面几条杂项之后,40 行
      // head 必然覆盖)。回退标题只对续段有意义,顺手在这里算好。
      const isContinuation = head.some(isBoundaryRecord);
      chainMeta.set(sessionId, {
        boundaryUuids,
        isContinuation,
        fallbackPrompt: isContinuation ? findContinuationPrompt(head) : null,
      });

      sessions.push({
        sessionId,
        projectHash,
        projectPath: realCwd || decodeProjectHash(projectHash),
        filePath,
        firstPrompt,
        // jsonl 里的两种标题,各自独立(不合并,理由见 takeTitleLine)。空串=没有。
        customTitle: titles.customTitle,
        aiTitle: titles.aiTitle,
        messageCount: totalLines,
        startTime: firstUser?.timestamp || new Date(s.birthtimeMs).toISOString(),
        lastActivity: lastRecord?.timestamp || new Date(s.mtimeMs).toISOString(),
        // #14:模型徽章取【最后一条】assistant 的 model —— 用户切 provider/model 后列表
        // 跟随最新使用的模型;原取 head 首条=创建时初始模型,永不更新(用户实报)。
        // 逆序扫 tail,跳过 <synthetic> 等伪模型 id(compact 摘要/错误占位,同 turn.model
        // 过滤规则);tail 无 assistant(极短/纯用户消息尾)回落 head 原逻辑。
        model: [...tail].reverse().find((r) => r.type === 'assistant' && r.message?.model && !/^</.test(r.message.model))?.message?.model
          || head.find((r) => r.type === 'assistant')?.message?.model || null,
        fileSize: s.size,
        subagents: subagents.length > 0 ? subagents : undefined,
        archived,
      });
    } catch {
      // skip unreadable files
    }
  }

  // —— compact/resume 链折叠 ——
  // 每次 /compact 后 --resume 都会新开一个 jsonl 续写同一场对话,列表里同一场
  // 对话被拆成 N 行、续段标题常是 "/compact"。按共享 boundary uuid 并查集分组,
  // 每链只留 lastActivity 最新的续段(sessionId 用它的,--resume 才接得上),
  // 标题继承链首;计数/时间保持该续段自身的,不跨链累加。
  const visible = collapseCompactChains(sessions, chainMeta);

  visible.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  return visible;
}

/**
 * 按共享 compact_boundary uuid 把会话分组成链,每链折叠为最新续段一条。
 * 同一 compact 事件的 boundary 记录会被 resume 原样(同 uuid)回放进所有后代
 * 文件,而 boundary uuid 全局唯一,不可能把两条无关对话并到一起。
 */
function collapseCompactChains(sessions, chainMeta) {
  if (!sessions.some((s) => chainMeta.get(s.sessionId)?.isContinuation)) return sessions;

  // 并查集(路径减半)
  const parent = new Map(sessions.map((s) => [s.sessionId, s.sessionId]));
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const byBoundary = new Map(); // boundaryUuid → 首个见到的 sessionId
  for (const s of sessions) {
    for (const u of chainMeta.get(s.sessionId)?.boundaryUuids || []) {
      const first = byBoundary.get(u);
      if (first === undefined) byBoundary.set(u, s.sessionId);
      else {
        const ra = find(first);
        const rb = find(s.sessionId);
        if (ra !== rb) parent.set(ra, rb);
      }
    }
  }

  const groups = new Map(); // 根 sessionId → members
  for (const s of sessions) {
    const r = find(s.sessionId);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(s);
  }

  const visible = [];
  for (const members of groups.values()) {
    if (members.length === 1) {
      const s = members[0];
      const m = chainMeta.get(s.sessionId);
      // 孤儿续段(父文件已被清理,链上只剩自己):标题同样不能是 "/compact",
      // 用回退标题顶上。
      if (m?.isContinuation && m.fallbackPrompt) s.firstPrompt = m.fallbackPrompt.slice(0, 200);
      visible.push(s);
      continue;
    }
    // 链内取最新续段展示;标题沿链向根走——链首(头部无 boundary 的原始文件)的
    // 正常标题优先;原始文件缺失时退到最早成员的回退标题(离对话起点最近)。
    let leaf = members[0];
    let earliest = members[0];
    let root = null;
    for (const s of members) {
      if (s.lastActivity > leaf.lastActivity) leaf = s;
      if (s.startTime < earliest.startTime) earliest = s;
      const cont = chainMeta.get(s.sessionId)?.isContinuation;
      if (!cont && (!root || s.startTime < root.startTime)) root = s;
    }
    const inherited = root
      ? root.firstPrompt
      : (chainMeta.get(earliest.sessionId)?.fallbackPrompt
         || chainMeta.get(leaf.sessionId)?.fallbackPrompt);
    if (inherited) leaf.firstPrompt = inherited.slice(0, 200);
    // 标题同理沿链继承:手改/自动标题写在链首文件里,续段自己的 jsonl 没有 ——
    // 不继承等于 compact 之后标题凭空消失。续段自己有的(CLI 会给续段另生成
    // ai-title)优先,不被链首盖掉。
    if (root) {
      leaf.customTitle = leaf.customTitle || root.customTitle;
      leaf.aiTitle = leaf.aiTitle || root.aiTitle;
    }
    visible.push(leaf);
  }
  return visible;
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
 *
 * `<task-notification>` is the harness's "background task completed" envelope
 * fed back to the model (task-id / output-file / status / summary). Same shape:
 * never a real user prompt — drop so it stops appearing as 16:30 你 「...killed」.
 */
function isLocalCommandEcho(text) {
  return /^\s*<(local-command-(caveat|stdout|stderr)|command-(name|message|args)|task-notification|cgui-tool-retry)\b/.test(text);
}

/**
 * A slash-command invocation (e.g. `/general-sci-writing 看看进度`) is stored as a
 * `user` record whose text bundles `<command-message>` + `<command-name>` +
 * (optionally) `<command-args>`. The args ARE the user's real opening prompt.
 * Dropping the whole record (isLocalCommandEcho) made skill-started sessions lose
 * their first message — the user scrolls to the top and their original request is
 * gone ("看不见最开始的消息"). Reconstruct a single `/name args` user bubble (matches
 * Claude Desktop). Returns the prompt string, or null when there are no args — a
 * bare control command (/clear, /compact, /context) stays hidden so we don't
 * reintroduce the old "斜杠命令多出两条隐藏消息" noise.
 */
function reconstructCommandPrompt(text, { bareToName = false } = {}) {
  const nameM = text.match(/<command-name>\s*([^<]*?)\s*<\/command-name>/);
  if (!nameM) return null;
  const argsM = text.match(/<command-args>\s*([\s\S]*?)\s*<\/command-args>/);
  const args = argsM ? argsM[1].trim() : '';
  const name = nameM[1].trim();
  if (!args) {
    // CI-5:无 args 的纯命令(如首条只发 `/skillname`)。
    //  - 渲染路径(默认 bareToName=false)仍返回 null —— 保持控制命令(/clear /compact /context)
    //    不冒充用户气泡的既有行为。
    //  - 列表路径(bareToName=true,findFirstRealUser)返回命令名,让纯 `/skillname` 起的会话
    //    也能进左侧列表(否则 findFirstRealUser→null→listSessions `if(!firstUser)continue` 整条
    //    丢弃,用户报告"首条只发斜杠命令的会话不出现在列表")。
    return bareToName ? (name || null) : null;
  }
  return name ? `${name} ${args}` : args;
}

/**
 * Build turn-based message groups from a session's JSONL records.
 *
 * A "turn" = one user prompt + all assistant responses (thinking, text, tool calls)
 * until the next user prompt. Tool result-only messages are merged into the
 * preceding assistant turn.
 *
 * Returns { messages, usageTotals }:
 *   messages — array of
 *     { type: 'user', uuid, text, timestamp }
 *     { type: 'turn', uuid, thinking: [], text: [], toolCalls: [], model, usage, timestamp }
 *   usageTotals — 整会话用量聚合(见下方 sessionUsageById 注释)
 *     { input, output, cacheRead, cacheCreation, apiCalls }
 */
/**
 * 去掉 CLI resume 重放追加的重复记录。两类重放:
 *
 * CJ-1(1086be6):停止/排队场景 CLI 把一段历史【原样重放】追加进同一 jsonl,
 * 连 uuid 都逐字节相同(实测 1157/1848 条与前文 uuid 完全一致,重放段从旧
 * compact_boundary 开始)。按 record.uuid 去重、保留首次出现即可;无 uuid 的
 * 记录(queue-operation 等)不参与。
 *
 * CJ-1 变体(本次):停止→--resume 时重放段带的是【新的 record.uuid】,uuid 去重
 * 认不出 → 同一条 AI 回复渲染两遍(用户实报,内容一字不差、时间戳相同)。这类重放
 * message.id 与内容仍逐字节不变,故对 assistant 记录额外按 (message.id + 内容签名)
 * 去重。为何是"内容签名"而非只按 message.id:CLI 把一次 API 调用(一个 message.id)
 * 的每个内容块【拆成多条记录】写入(thinking / text / tool_use 各一条,uuid 各异),
 * 只按 message.id 去重会吞掉同一次调用的其余块(丢正文/工具调用)。内容签名既能区分
 * 同一 message.id 下的不同块、又能认出重放的同一个块。实测 8 个真实会话此键零误删。
 * user 记录不参与 message.id 去重(可能无/共享 message.id,按 uuid 已足够)。
 */
export function dedupReplayedRecords(rawRecords) {
  const seenRecordUuids = new Set();
  const seenAssistantBlocks = new Set();
  return rawRecords.filter((r) => {
    const u = r?.uuid;
    if (u) {
      if (seenRecordUuids.has(u)) return false;
      seenRecordUuids.add(u);
    }
    if (r?.type === 'assistant') {
      const mid = r?.message?.id;
      if (mid) {
        const sig = mid + '\u0000' + JSON.stringify(r?.message?.content ?? null);
        if (seenAssistantBlocks.has(sig)) return false;
        seenAssistantBlocks.add(sig);
      }
    }
    return true;
  });
}

/**
 * 判断 ExitPlanMode 的 toolCall 是否携带“已批准”结果。
 * 实现在前后端共用的 plan.js；这里保留导出以兼容 reader 调用方。
 *   - SDK 引擎批准 = allow, tool_result 非错误;
 *   - 旧 hook 路径批准 = deny 收尾, 但 result 文案含“用户已批准此计划”。
 */
/**
 * 同计划卡折叠(r32-plan-flood,根因见 getSessionMessages 顶部说明):/goal 的会话级
 * Stop 钩子每轮强制续跑,CLI 每轮把同一份【已批准计划】以 ExitPlanMode 重提一次
 * (input.plan 逐字相同)。这条条都是各自独立的 message.id/uuid,dedupReplayedRecords
 * 按 uuid/message.id 认不出 → 消息流冒出 N 张相同计划卡。这里对【已构建的 messages】拍平:
 * 同一会话历史里 ExitPlanMode.input.plan 逐字相同的,只保留第一条,后续重复块去掉;
 * 若去掉后该 turn 无其余可渲染内容(text/thinking/其余 toolCalls),整条 turn 省去。
 *   · 折叠粒度 = 只去掉重复的计划块,不误伤同一条 assistant 记录里的其他内容块
 *     (该 turn 的 text/thinking/非 ExitPlanMode toolCalls 全部保留);
 *   · 保留第一条而非最后一条:计划卡应在它最初被提出的位置出现(批准/驳回动作紧邻其后),
 *     后续强制续跑重提的是同一份已批准计划的机械重复,保留最后一条会把卡挪到最近一次
 *     重复处,语义上是错的;
 *   · 若首张卡尚未批准/被驳回,而后续重提的同一份计划带有【已批准】结果,则把批准结果
 *     合并到保留卡上,避免折叠后 currentPlan/TurnBubble 只看到一张未批准卡、用户批准后
 *     “已批准的计划”常驻块缺失;
 *   · 不同计划绝不动:input.plan 不同 → 签名不同 → 各自成卡,互不影响。
 */
export function foldRepeatedPlanCards(messages) {
  const seenPlan = new Map(); // plan 签名 -> 当前保留的 ExitPlanMode toolCall
  const out = [];
  for (const m of messages) {
    if (m?.type !== 'turn') { out.push(m); continue; }
    const toolCalls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
    const isPlan = (tc) => !!planSignature(tc);
    let anyDropped = false;
    const keptToolCalls = [];
    const droppedIds = new Set();
    for (const tc of toolCalls) {
      if (isPlan(tc)) {
        const sig = planSignature(tc);
        const kept = seenPlan.get(sig);
        if (kept) {
          anyDropped = true; droppedIds.add(tc.id);
          // 后来的重复卡若带有批准结果而保留卡没有,把批准结果补到保留卡上。
          const merged = mergeEquivalentPlanToolCall(kept, tc);
          if (merged !== kept) kept.result = merged.result;
          continue;
        }
        seenPlan.set(sig, tc);
      }
      keptToolCalls.push(tc);
    }
    if (!anyDropped) { out.push(m); continue; }
    // 同步去掉 blocks 里对应的 tool_use 块,保留其余内容块
    const blocks = (Array.isArray(m.blocks) ? m.blocks : []).filter(
      (b) => !(b?.type === 'tool_use' && b?.toolCall && droppedIds.has(b.toolCall.id))
    );
    // 若去掉重复计划卡后无任何可渲染内容,整条省去(普通工具回合无其余可渲染内容时同理)。
    const hasRenderable = keptToolCalls.length > 0
      || (Array.isArray(m.text) && m.text.length > 0)
      || (Array.isArray(m.thinking) && m.thinking.length > 0);
    if (hasRenderable) out.push({ ...m, toolCalls: keptToolCalls, blocks });
    // else: 整条 turn 直接省略
  }
  return out;
}

/**
 * goal 未达成提示折叠(r32-plan-flood):Stop 钩子每轮判定未达成就写一条 goal_status
 * (met:false 无 sentinel,带 reason),消息流原本 N 条「目标未达成，已自动继续」。
 * 把同一段"未达成就"(同一 condition、中间无 met:true/sentinel 段界)里的这类记录折叠成
 * 一条 + 次数徽标;达成的最后一条(met:true)永远保留单显。中间的普通 turn 是真实工作
 * 回合(模型被强制续跑期间的实际输出),不打断这段、也不被折叠 —— 只折冗余的目标状态
 * 提示,不动对话内容。
 *   · 实现位置(reader 而非前端):goal_status 只进 transcript 不进 stream-json,折叠发生
 *     在历史消息构建处,历史列表与流式列表的 goal 分支共用同一消息,一处折叠两处生效,
 *     无需在客户端再造一套折叠逻辑(且前端折叠无法被 getSessionMessages 级单测覆盖)。
 *   · "reason 相同或相近":同一目标追读期的 condition 恒同,reason 差异只是钩子反馈文案的
 *     细节,归并到一条(带 ×N)不再连画 N 行;避免把不同目标(condition 不同 / 被
 *     met:true 或 sentinel 隔断)合并。
 * 为不破坏 activeGoal 状态机:折叠后仍保留第一条记录的 met/met/condition/reason,
 * 仅追加 count(单条不折叠、保持原样)。
 */
export function foldRepeatedGoalNotices(messages) {
  // 逐 goal 消息定段:同 condition 的未达成记录归同一段(中间的非 goal 消息不断段);
  // met:true 或 sentinel(设置/清除)记录 = 段界,本身永不折叠。
  const segOf = new Map();    // message index -> segment id(仅未达成记录)
  const condOf = new Map();   // segment id -> condition
  let segNext = 0;
  let open = null;            // { seg }
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m?.type !== 'goal') { continue; }
    const isNotMet = !m.met && !m.sentinel;
    if (!isNotMet) { open = null; continue; }
    const cond = m.condition || '';
    if (open && condOf.get(open.seg) === cond) {
      segOf.set(i, open.seg);
    } else {
      segNext++;
      open = { seg: segNext };
      condOf.set(segNext, cond);
      segOf.set(i, segNext);
    }
  }
  // 统计每段条数 + 段首 index
  const countOf = new Map();
  const firstOf = new Map();
  for (const [i, seg] of segOf) {
    countOf.set(seg, (countOf.get(seg) || 0) + 1);
    if (!firstOf.has(seg)) firstOf.set(seg, i);
  }
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const seg = segOf.get(i);
    if (seg != null) {
      if (firstOf.get(seg) !== i) continue;             // 折叠重复,去掉
      const c = countOf.get(seg) || 1;
      out.push(c > 1 ? { ...m, count: c } : m);          // 单条未达成保持原样
    } else {
      out.push(m);
    }
  }
  return out;
}

export async function getSessionMessages(sessionId, projectHash) {
  let filePath = join(PROJECTS_DIR, projectHash, `${sessionId}.jsonl`);
  if (!existsSync(filePath)) {
    // 子代理转写不在 <hash>/<sid>.jsonl,真身在 <hash>/<父sid>/subagents/<sid>.jsonl。
    // 侧栏"+N 子任务"点开与放大视图水合都走本端点,此前直接 ENOENT 500(用户看到
    // 标题换了正文还是旧会话)。回退扫一层父会话目录找到真身。
    try {
      const entries = await readdir(join(PROJECTS_DIR, projectHash), { withFileTypes: true });
      outer:
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const subDir = join(PROJECTS_DIR, projectHash, e.name, 'subagents');
        const cand = join(subDir, `${sessionId}.jsonl`);
        if (existsSync(cand)) { filePath = cand; break; }
        // workflow 起的 agent 深埋 subagents/workflows/wf_*/<sid>.jsonl(点开列表里的 workflow agent
        // 要能找到真身,否则 404)。多探一层 workflows/。
        try {
          for (const wf of await readdir(join(subDir, 'workflows'))) {
            const wfCand = join(subDir, 'workflows', wf, `${sessionId}.jsonl`);
            if (existsSync(wfCand)) { filePath = wfCand; break outer; }
          }
        } catch {}
      }
    } catch {}
  }
  const rawRecords = await parseJsonl(filePath);
  const records = dedupReplayedRecords(rawRecords);
  // L4: 加载附件 sidecar,在 user 消息 push 时按 textHash 注入 attachments/displayText
  const attachmentsByHash = await readAttachmentsSidecar(sessionId);

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
  // CI-6:是否已渲染过真实用户消息。用于放开"开场 bare 斜杠命令"的重建(见下)。
  let sawRealUser = false;
  // 会话级用量汇总(地面真值口径):对全文件 assistant 记录的 message.usage 按
  // message.id 去重后逐条求和 —— 每个 id 对应一次真实底层 API 调用,同一调用的
  // 多条流式分片只记一次。含 sidechain/子代理记录(它们也是本会话的真实消耗;
  // 与上面 per-turn 的 usage 口径不同,后者只归集主回合)。绝不能用 result 事件
  // 的整轮累加 usage 替代(cache_read 会被加 N 遍)。
  const sessionUsageById = new Map();

  function flushTurn() {
    if (currentTurn && (currentTurn.text.length > 0 || currentTurn.thinking.length > 0 || currentTurn.toolCalls.length > 0)) {
      // W8(R1/R2):一轮可含 N 次 API 调用(工具循环),usage 此前 last-one-wins →
      // output 系统性少算(只剩最后一次调用的)。改为按 message.id 去重后四字段分别
      // 累加 → `usage`(消耗口径,供气泡输入/输出/缓存与成本)。
      // 同时保留最后一次调用的原始 usage → `ctxUsage`(上下文口径,供顶部徽章:
      // input+cache_read+cache_creation=当前上下文占用;若用累加值,N 次调用的
      // cache_read 会被加 N 遍,徽章直接爆表)。
      if (currentTurn._usageById && currentTurn._usageById.size > 0) {
        const agg = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
        let last = null;
        for (const u of currentTurn._usageById.values()) {
          agg.input_tokens += u.input_tokens || 0;
          agg.output_tokens += u.output_tokens || 0;
          agg.cache_read_input_tokens += u.cache_read_input_tokens || 0;
          agg.cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
          last = u;
        }
        currentTurn.usage = agg;
        currentTurn.ctxUsage = last;
      }
      delete currentTurn._usageById;
      messages.push(currentTurn);
    }
    currentTurn = null;
  }

  for (const record of records) {
    if (record.type === 'user') {
      // Claude Desktop injects a synthetic user message ("Continue from where
      // you left off.") flagged isMeta when it resumes a session. isMeta records
      // are CLI/Desktop bookkeeping, never a real prompt — Desktop itself never
      // renders them. Skip so they don't surface as a stray user bubble in the
      // GUI when switching into such a session.
      if (record.isMeta) continue;
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

        // CI-6:开场 bare 斜杠命令(首条只发 `/skillname`,无 args)也要渲染成用户气泡。
        // 渲染路径此前恒 bareToName=false → 无 args 命令重建为 null → 整条被
        // isLocalCommandEcho 吞掉 → 刷新后首条 /xxx 消失、且"重做"因找不到对应用户
        // 消息而报错(用户实报)。只对"会话尚未出现任何真实用户消息"的开场记录放开
        // bareToName(与列表路径 findFirstRealUser 的口径一致),会话中途的 /clear
        // /compact 等控制命令保持隐藏,不回归"斜杠命令多出隐藏消息"旧 bug。
        const cmdPrompt = reconstructCommandPrompt(text, { bareToName: !sawRealUser });
        const shownText = cmdPrompt || text;
        if (shownText && (cmdPrompt || !isLocalCommandEcho(text))) {
          // This is a real user prompt — flush previous turn and start new user message
          flushTurn();
          sawRealUser = true;
          const meta = attachmentsByHash[attachmentTextHash(text)];
          messages.push({
            type: 'user',
            uuid: record.uuid,
            text: shownText,
            timestamp: record.timestamp,
            sessionId: record.sessionId,
            permissionMode: record.permissionMode,
            ...(meta?.attachments ? { attachments: meta.attachments } : {}),
            ...(meta?.displayText !== undefined ? { displayText: meta.displayText } : {}),
          });
        }
        // tool_result-only messages are silently merged via toolResultMap
      }

    } else if (record.type === 'assistant') {
      // 会话级用量收集(供 usageTotals)。跳过 `<synthetic>` 伪模型记录(错误占位/
      // compact 摘要,不是真实 API 调用)。首见即记,与 per-turn 去重规则一致。
      if (record.message?.usage && !/^</.test(record.message?.model || '')) {
        const sid = record.message?.id || record.uuid;
        if (sid && !sessionUsageById.has(sid)) sessionUsageById.set(sid, record.message.usage);
      }
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

      // Update model (last one wins)。跳过 `<synthetic>` 等伪模型 id —— CLI 给
      // /compact 摘要、错误占位写的不是真实模型,污染 turn.model 会被前端的
      // 历史模型回退当成可发送的模型(U1 家族 bug 的源头之一)。
      if (record.message?.model && !/^</.test(record.message.model)) currentTurn.model = record.message.model;
      // W8:usage 按 message.id 去重收集(同一调用的流式分片只记一次),flush 时聚合。
      // 排除 sidechain / 子代理记录(parentToolUseId)——它们的 usage 不属于主回合。
      if (record.message?.usage && !record.isSidechain && !record.parentToolUseId) {
        // X2:排除全零 usage —— CLI 在 "Continue from where you left off" meta 后
        // 写入的 synthetic stop_sequence 记录 usage 全零,且因 meta 不触发 flush
        // 被并进上一回合、恰好是 Map 里最后一条 → ctxUsage 全零中毒,徽章恒 0。
        const u0 = record.message.usage;
        const nonZero = (u0.input_tokens || 0) + (u0.output_tokens || 0)
          + (u0.cache_read_input_tokens || 0) + (u0.cache_creation_input_tokens || 0) > 0;
        if (nonZero) {
          if (!currentTurn._usageById) currentTurn._usageById = new Map();
          const mid = record.message?.id || record.uuid || String(currentTurn._usageById.size);
          if (!currentTurn._usageById.has(mid)) currentTurn._usageById.set(mid, u0);
        }
      }
      if (record.timestamp) currentTurn.timestamp = record.timestamp;
    } else if (record.type === 'attachment' && record.attachment?.type === 'goal_status') {
      // /goal(会话级 Stop 钩子)的唯一可见信号。实测 CLI 2.1.220:goal_status 只写进
      // transcript,stream-json 一条都不发,所以历史侧不放行 = 目标在 GUI 里完全不可见
      // (用户报"修了 loop 怎么没修 goal")。四种形态(取自 CLI 自身的写入函数):
      //   met:false + sentinel  → 刚设目标
      //   met:false 无 sentinel → 钩子判定未达成(带 reason),模型被强制续跑
      //   met:true  无 sentinel → 达成(带 reason/iterations/durationMs/tokens),目标自动清除
      //   met:true  + sentinel  → 用户 `/goal clear` 手动清除
      // 前端据"最后一条"判当前是否有活动目标,故四种都要放行(少放一种就会有残留徽章)。
      // isLocalCommandEcho 不开口子:`/goal X` 紧邻的 `<local-command-stdout>Goal set: X`
      // 与上面 sentinel 记录的 condition 逐字相同(见 check-goal-visible 的等价断言),
      // 再放行一条就是同一句话连画两行(用户气泡里的 `/goal X` 已是第三遍)。回显整体
      // 过滤是从前修过的功能,不为一条冗余信息破例。
      const g = record.attachment;
      flushTurn();
      messages.push({
        type: 'goal',
        uuid: record.uuid,
        timestamp: record.timestamp,
        met: !!g.met,
        sentinel: !!g.sentinel,
        condition: typeof g.condition === 'string' ? g.condition : '',
        reason: typeof g.reason === 'string' ? g.reason : '',
        iterations: typeof g.iterations === 'number' ? g.iterations : null,
      });
    } else if (record.type === 'attachment' && record.attachment?.type === 'queued_command') {
      // 「⚡ 并入」注入的消息,在【本回合还有工具边界】时被 CLI 折叠进同一回合:磁盘上
      // 没有 user 行,原文只存在于这条 attachment —— 写在折叠位置(紧跟 queue-operation
      // {operation:'remove'}、在 AI 后续回应之前),即真实的并入点。实测对该会话 --resume
      // 后模型能一字不差复述这条消息 → CLI 在 resume 时把它重建回上下文,它是一等历史。
      // 不合成的后果:AI 行为变了,但 GUI 对话里永远看不到用户说过什么(0.2.285 的真 bug)。
      // 只认 queued_command:queue-operation 的 dequeue 之后必跟一条真 user 行,给它合成
      // 就是同一句话画两遍。record 自带 uuid,天然参与上面的 uuid 去重(resume 重放安全)。
      const a = record.attachment;
      const prompt = typeof a.prompt === 'string' ? a.prompt : '';
      if (prompt.trim()) {
        // flushTurn 把在飞回合从折叠点切开 → 历史天然渲染成「回合A → 引导气泡 → 回合B」,
        // 与 Claude Desktop 一致。
        flushTurn();
        messages.push({
          type: 'user',
          uuid: record.uuid,
          steered: true,
          steerUuid: a.source_uuid || null,
          text: prompt,
          timestamp: record.timestamp || a.timestamp,
        });
      }
    }
    // Skip 其余 attachment、queue-operation、last-prompt、permission-mode 等
  }

  flushTurn();
  // r32-plan-flood:同计划卡折叠(见 foldRepeatedPlanCards 注释)。放在消息构建之后、
  // usageTotals 之前:折叠只影响 messages 的呈现,不影响按 record 汇总的真实用量
  // (每次底层 API 调用都是真实消耗,不能因计划卡冗余而少算)。
  const foldedMessages = foldRepeatedPlanCards(messages);
  // r32-plan-flood:goal 未达成提示折叠(见 foldRepeatedGoalNotices 注释)—— 在计划卡折叠
  // 之后串接,两者只影响 messages 的呈现,不影响按 record 汇总的真实用量。
  const finalMessages = foldRepeatedGoalNotices(foldedMessages);
  // 聚合四字段。apiCalls = 去重后的底层 API 调用次数,供前端明细展示/排查。
  const usageTotals = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, apiCalls: sessionUsageById.size };
  for (const u of sessionUsageById.values()) {
    usageTotals.input += u.input_tokens || 0;
    usageTotals.output += u.output_tokens || 0;
    usageTotals.cacheRead += u.cache_read_input_tokens || 0;
    usageTotals.cacheCreation += u.cache_creation_input_tokens || 0;
  }
  return { messages: finalMessages, usageTotals };
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
        // try reading as regular JSON(readFile 已在文件顶部静态导入,无需动态 import)
        try {
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
