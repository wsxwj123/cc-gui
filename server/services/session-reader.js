import { readdir, stat, readFile } from 'fs/promises';
import { accumulateUsage } from '../utils/usage-normalize.js';
import { attachUsageIssues } from './usage-issue-log.js';
import { existsSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import {
  isApprovedPlanToolCall,
  mergeEquivalentPlanToolCall,
  planSignature,
} from '../utils/plan.js';

export { isApprovedPlanToolCall };
import { parseJsonl, readJsonlEdges, streamJsonl } from '../utils/jsonl-parser.js';
import { parseWorkflowLaunchText, parseWorkflowTranscriptDir } from '../utils/workflow-progress.js';
import { scanProfile, PROFILE_VERSION } from './session-profile.js';
import { getEntry, getRawEntry, putEntry, ensureProjectLoaded, noteScan } from './session-index.js';

// r114:Workflow 工具的 tool_result 上附一份 workflowRun —— 前端拉磁盘快照(重建历史
// 工作流视图)的唯一依据。两个来源:
//   ①结构化 toolUseResult(taskType === 'local_workflow',新会话都有,实证键集合:
//     status/taskId/taskType/workflowName/runId/summary/transcriptDir/scriptPath);
//   ②老会话没有 toolUseResult(或缺 runId)时,从 tool_result 正文里捞。
// 两条都不成 → 返回 null,调用方不加这个键(其余 tool_result 形状一字不变)。
// 【绝不】把 transcriptDir / 脚本路径这类本机绝对路径透给前端:只回从中解析出的
// projectHash / sid(解析不出就是 null,其余字段照给)。
function workflowRunOf(toolUseResult, content) {
  const tur = toolUseResult && typeof toolUseResult === 'object' ? toolUseResult : null;
  const isWorkflow = tur?.taskType === 'local_workflow';
  // 正文兜底只在正文里真有 workflows 路径段时才跑正则:runId 必须来自 `workflows/wf_…`
  // (契约也要求"正文能解析出 runId"才兜底),这个前置判据不改变结果,但省掉了对每条
  // 普通 Bash/Read 结果的三遍白扫(大会话几千条 tool_result)。
  // 正文先归一为字符串:缺 content 的 tool_result 传进来的是 undefined(上游 JSON.stringify
  // 对 undefined 返回 undefined),直接调字符串方法会抛 TypeError,且这条路径外层没有
  // try/catch → 一条坏块让整个会话历史 500。归一后它与"正文里没有 workflows"同路,
  // 不加 workflowRun、其余字段照给(与本轮改动前对同一记录的行为一致)。
  const text = typeof content === 'string' ? content : '';
  const fromText = (!isWorkflow || !tur.runId) && text.includes('workflows')
    ? parseWorkflowLaunchText(text) : null;
  if (!isWorkflow && !fromText?.runId) return null;
  const dir = tur?.transcriptDir || fromText?.transcriptDir || null;
  const loc = parseWorkflowTranscriptDir(dir);
  return {
    taskId: tur?.taskId ?? fromText?.taskId ?? null,
    runId: tur?.runId ?? fromText?.runId ?? null,
    workflowName: tur?.workflowName ?? null,
    projectHash: loc?.projectHash ?? null,
    sid: loc?.sid ?? null,
  };
}

// r116:tool_result 的内容块数组拆成「可读文字 + 图片列表」,与前端 client/src/utils/toolResult.js
// 的 extractToolResultText / extractToolResultImages 逐条同口径(流式与读历史同形)。此前数组一律
// JSON.stringify:图片进不了卡片,几十万字符的 base64 当正文塞进 <pre><Linkify> → 界面卡死。
// 字符串原样;数组/字符串以外的形态保持原逻辑(JSON.stringify,缺 content 仍是 undefined)。
// 不含图片不加 images 键(其余 tool_result 形状一字不变)。
function toolResultBody(content) {
  if (typeof content === 'string') return { content };
  if (!Array.isArray(content)) return { content: JSON.stringify(content) };
  const text = content
    .filter((b) => b && (b.type === 'text' || typeof b.text === 'string'))
    .map((b) => b.text || '')
    .join('\n');
  const images = content
    .filter((b) => b && (b.type === 'image' || typeof b.data === 'string'))
    .map((b) => ({ mime: b.source?.media_type || b.mimeType || 'image/png', data: b.source?.data || b.data || '' }))
    .filter((b) => b.data);
  return images.length ? { content: text, images } : { content: text };
}

// L4: 附件元数据 sidecar。cc CLI 的 jsonl 由 CLI 写,GUI 无法注入 attachments 字段,
// 改用旁路文件按 textHash 索引,session-reader 读历史消息时 merge 回来。
const ATTACHMENTS_DIR = join(homedir(), '.claude-gui', 'attachments');
function attachmentsSidecarPath(sessionId) {
  return join(ATTACHMENTS_DIR, `${sessionId}.json`);
}
export function attachmentTextHash(text) {
  return createHash('sha1').update(String(text || '')).digest('hex').slice(0, 16);
}
// R07 起 sidecar 有两套索引：新写入按 sessionId+messageId(sidecar.messages)，旧条目按正文哈希
// (顶层其余键)。两者都读，身份索引优先 —— 相同正文的两次独立提交才不会互相串附件。
async function readAttachmentsSidecar(sessionId) {
  try {
    const buf = await readFile(attachmentsSidecarPath(sessionId), 'utf-8');
    const d = JSON.parse(buf);
    if (!d || typeof d !== 'object' || Array.isArray(d)) return { byHash: {}, byMessageId: {} };
    const { messages, ...byHash } = d;
    const byMessageId = (messages && typeof messages === 'object' && !Array.isArray(messages)) ? messages : {};
    return { byHash, byMessageId };
  } catch { return { byHash: {}, byMessageId: {} }; }
}

// 消息视觉身份优先：该人工提交的 uuid / steerUuid 命中新索引就直接用它；
// 命中不了才退回旧的 textHash 条目(无 messageId 的历史数据与客户端尚未拿到 CLI uuid 的普通发送)。
export function attachmentMetaForIdentities(sidecar, identities, text) {
  for (const identity of Array.isArray(identities) ? identities : []) {
    if (typeof identity === 'string' && identity && sidecar?.byMessageId?.[identity]) {
      return sidecar.byMessageId[identity];
    }
  }
  return sidecar?.byHash?.[attachmentTextHash(text)] || null;
}

// 元数据 → 消息字段。空附件数组(合法的「无附件」写入)不注入 attachments/displayText，
// 否则气泡会把 displayText 当成正文渲染成空壳。
export function attachmentMessageFields(sidecar, identities, text) {
  const meta = attachmentMetaForIdentities(sidecar, identities, text);
  if (!meta) return {};
  const attachments = Array.isArray(meta.attachments) ? meta.attachments : [];
  if (!attachments.length) return {};
  return {
    attachments,
    ...(typeof meta.displayText === 'string' ? { displayText: meta.displayText } : {}),
  };
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
 * r31:判一个项目路径是否该按 worktree 处理——即「别的会话/子代理在某个项目内部开出的
 * 临时工作目录」。这类目录(如 <repo>/.scratch/m6-check/ws-A-…、<repo>/.tmp/…)一跑会话
 * 就会在 ~/.claude/projects 里留一格,但它们不是用户的项目;用户选定:按 worktree 处理,
 * 默认不显示,打开「显示 worktree」才出现。纯字符串判据,零磁盘 IO。
 *
 * 判据(满足其一):
 *   1. 命中既有 worktree 形态:路径含 `-worktrees/` 或 `/.claude/worktrees/`
 *      (GUI 建的树在 <repo名>-worktrees/ 下,CLI agent 自动建的在 <repo>/.claude/worktrees/ 下);
 *   2. 严格位于【另一个已列项目】路径之内,且相对路径里含以 "." 开头的路径段。
 * 反斜杠归一兼容 Windows;比较前各自去尾部斜杠;大小写不敏感(macOS/Windows 文件系统
 * 本身不区分大小写,同一目录的两种写法必须判成同一条)。O(n²) 只是字符串比较,项目
 * 列表量级(百级)可忽略,不做任何额外读盘。
 */
export function isInternalWorktreePath(realPath, listedPaths) {
  const p = String(realPath ?? '').replace(/\\/g, '/');
  if (!p) return false;
  if (/-worktrees\//.test(p) || /\/\.claude\/worktrees\//.test(p)) return true;
  const target = p.toLowerCase().replace(/\/+$/, '');
  for (const other of listedPaths ?? []) {
    const parent = String(other ?? '').replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
    if (!parent || parent === target || !target.startsWith(`${parent}/`)) continue;
    if (target.slice(parent.length + 1).split('/').some((seg) => seg.startsWith('.'))) return true;
  }
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
 * 会话 id 的形状白名单 —— 所有"把外部字符串拼进文件路径"的地方共用这一份判据。
 * 只放行 36 位 uuid 字符(0-9a-fA-F 与连字符):`../`、路径分隔符、绝对路径、`\0` 一律过不了,
 * 拼接结果永远落在项目目录内的 `<sid>.jsonl` 一个普通文件名上。
 */
export const SESSION_ID_SHAPE = /^[0-9a-fA-F-]{36}$/;
export function isSessionIdShape(value) {
  return SESSION_ID_SHAPE.test(String(value ?? ''));
}

/**
 * sessionId → 会话 jsonl 绝对路径。与 SDK 省略 dir 时的行为同款:逐个项目目录探
 * `<sid>.jsonl`(sessionId 是 uuid,不可能跨项目撞名,首个命中即正解)。找不到返回 null
 * (未落盘的 draft 会话就是这种情况)。这里是唯一的路径拼接闸门,校验不过连 fs 都不碰。
 */
export async function findSessionFile(sessionId) {
  if (!isSessionIdShape(sessionId)) return null;
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
 * 上限 3 的并发闸门(p-limit 式手写,不引依赖)。**只给 listProjects 的冷读小用**
 * (每个文件前 10 条记录,单次 ≤ 几十 KB 的纯 I/O):libuv 默认线程池只有 4 槽,
 * 放开跑会把用户正在等的请求堵在池子外面。listSessions 的整文件扫描是 CPU 受限,
 * 保持串行(多开流只是交叉调度,总 CPU 不变)。
 */
const SMALL_READ_LIMIT = 3;
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try { out[i] = await fn(items[i], i); } catch { out[i] = undefined; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
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
    // 自定义 projectsDir(单测注入临时目录)不接落盘索引:索引按真实 HOME 算目录,
    // 拿测试目录的同名 hash 去读真实索引只会白读。内存缓存与判据不受影响。
    const idxHash = projectsDir === PROJECTS_DIR ? entry.name : null;
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
      const stats = new Map(); // 文件 → stat:下面判 cwd 与画像校验复用同一份,不再重复系统调用
      if (jsonlFiles.length > 0) {
        for (const f of jsonlFiles) {
          const s = await stat(join(projectPath, f));
          stats.set(f, s);
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
          // 只要头 10 条判 cwd:head10 级画像读满 10 条可解析记录即收工(不至于为一行
          // cwd 走完整个文件),与 parseJsonl({limit:10})+cwdFromHead 等价(INTERFACE §A.5),
          // 且结果按 (ino,mtimeMs,size) 落盘 —— 冷启动的 /api/projects 因此不必再逐文件头读。
          realPath = (await loadProfile(join(projectPath, newestFile), stats.get(newestFile), 'head10', idxHash)).cwd10;
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
      // 判据逐字不变(c === sidecarCwd 计数;cwd 取不到 / 读失败都算 matched),
      // 变的只是「每文件读一遍头」→「读画像」,并给冷读封上限 3 的并发
      // (libuv 默认只有 4 个线程池槽,不封顶会把用户正在等的请求堵在后面)。
      let sessionCount = jsonlFiles.length;
      if (sidecarCwd && jsonlFiles.length > 0) {
        const cwds = await mapLimit(jsonlFiles, SMALL_READ_LIMIT, async (f) => {
          const st = stats.get(f) || await stat(join(projectPath, f));
          try { return (await loadProfile(join(projectPath, f), st, 'head10', idxHash)).cwd10; } catch { return null; }
        });
        let matched = 0;
        for (const c of cwds) if (!c || c === sidecarCwd) matched += 1;
        sessionCount = matched;
      }

      // isWorktree 循环后统一打:r31 的判据要对照【全部已列项目路径】(见 isInternalWorktreePath)。
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

  // worktree 打标(纯字符串判据,零 git 调用)。
  const listedPaths = projects.map((p) => p.path);
  for (const p of projects) p.isWorktree = isInternalWorktreePath(p.path, listedPaths);

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
// ── 会话画像(profile):取代 r13-p2-6 的 EDGES_CACHE ─────────────────────────
// 旧缓存的值是 head40+tail40 的**原始记录**(实测中位 289 KB/条、3475 条合计 1123 MB),
// 提容量等于把后端内存推到 1 GB 级;新结构每个 jsonl 只留一份常数大小(≈0.4 KB)的
// **派生摘要**,判据从 (mtimeMs,size) 扩到 (ino,mtimeMs,size),并按项目落盘
// (~/.claude-gui/session-index/<hash>.json)→ 重启进程后不必从零重扫。
//
// 关键正确性论证(I1):画像的每个字段都不是「重新实现一遍」,而是把今天 listSessions /
// buildAgentEntry 里的表达式**原样搬进 deriveProfile 执行一次**、只存结果。同一份输入
// (head40/tailRaw40) + 同一个函数调用 ⇒ 逐字段可证相等。
//
// 派生逻辑**留在本文件**(下面的 deriveProfile/applyIncremental + 既有的 findFirstRealUser /
// cwdFromHead / takeTitleLine / findContinuationPrompt 等),新模块 session-profile.js 只做
// I/O 与计数 —— 结构上堵死「两份实现慢慢跑偏」。
const isBoundaryRecord = (r) =>
  r?.type === 'system' && r?.subtype === 'compact_boundary' && typeof r.uuid === 'string';

// 整文件行回调(原样从 readEdgesCached 的调用点搬来,语义一字不变):先子串预筛再 parse,
// 顺路收标题行。扫描器对读到的每一行原样调用它,自己不认识 boundary/title。
const onRawLine = (raw, bUuids, tt) => {
  takeTitleLine(raw, tt);
  if (!raw.includes('"compact_boundary"')) return;
  try {
    const r = JSON.parse(raw);
    if (isBoundaryRecord(r)) bUuids.push(r.uuid);
  } catch {}
};

function parseRawLines(raws) {
  const out = [];
  for (const raw of raws || []) {
    try { out.push(JSON.parse(raw)); } catch {}
  }
  return out;
}

/** 子代理首条用户消息的前 100 字(旧 buildAgentEntry:575-584 的表达式,一字不改)。 */
function agentPrompt100(head5) {
  const first = (head5 || []).find((r) => r.type === 'user');
  if (!first?.message?.content) return '';
  const raw = first.message.content;
  if (typeof raw === 'string') return raw.slice(0, 100);
  if (Array.isArray(raw)) return raw.find((c) => c.type === 'text')?.text?.slice(0, 100) || '';
  return '';
}

/** 子代理上下文占用:tail5 逆序首个带 usage 的 assistant(旧 :593-597)。 */
function agentCtxTokens(tail5) {
  const lastAsst = [...(tail5 || [])].reverse().find((r) => r.type === 'assistant' && r.message?.usage);
  const au = lastAsst?.message?.usage || null;
  return au ? (au.input_tokens || 0) + (au.cache_read_input_tokens || 0) + (au.cache_creation_input_tokens || 0) : null;
}

/** 全量派生:Artifacts → 画像(真值表见 INTERFACE §A.3/§A.4)。纯函数、无 I/O、不抛。 */
export function deriveProfile(art, st) {
  const base = { v: PROFILE_VERSION, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs };
  if (art.depth === 'head10') {
    // listProjects 专用等级:只够判 cwd10(与今天 parseJsonl({limit:10})+cwdFromHead 等价,
    // 见 INTERFACE §A.5)。其余字段「不存在」= 该等级不可用于会话列表(命中级由 getEntry 把关)。
    return { ...base, level: 'head10', cwd10: cwdFromHead((art.head40 || []).slice(0, 10)) };
  }
  const head = art.head40 || [];
  const tailRaw = art.tailRaw40 || [];
  const tail = parseRawLines(tailRaw);
  // tail5 ≠ tail40.slice(-5):tailRaw 是「最后 N 条非空**原始行**」,坏行占名额而解析时被丢,
  // 所以两个窗口必须各自解析(tailRaw5 = tailRaw40.slice(-5) 可证相等)。
  const tail5 = parseRawLines(tailRaw.slice(-5));
  const head5 = head.slice(0, 5);
  const firstRealUser = findFirstRealUser(head);
  const isContinuation = head.some(isBoundaryRecord);
  return {
    ...base,
    level: 'full',
    totalLines: art.totalLines,
    complete: art.complete,
    partial: art.partial,
    completeOffset: art.completeOffset,
    anchorHash: art.anchorHash,
    headFull: art.headFull,
    boundaryUuids: art.boundaryUuids,
    customTitle: art.titles.customTitle,
    aiTitle: art.titles.aiTitle,
    // ── 会话字段(head40 / tail40)──
    firstUserTs: firstRealUser?.record?.timestamp || null,
    firstUserText200: firstRealUser?.text?.slice(0, 200) || '',
    isSidechain: head.some((r) => r?.isSidechain === true),
    hasBoundaryInHead: isContinuation,
    continuationPrompt200: isContinuation ? (findContinuationPrompt(head)?.slice(0, 200) ?? null) : null,
    cwd40: cwdFromHead(head),
    cwd10: cwdFromHead(head.slice(0, 10)),
    headAssistantModel: head.find((r) => r.type === 'assistant')?.message?.model || null,
    tailAssistantModel: [...tail].reverse().find((r) => r.type === 'assistant' && r.message?.model && !/^</.test(r.message.model))?.message?.model || null,
    lastTs: tail[tail.length - 1]?.timestamp || null,
    // ── 子代理字段(head5 / tail5)──
    agent: {
      prompt100: agentPrompt100(head5),
      assistantModel: head5.find((r) => r.type === 'assistant')?.message?.model || null,
      cwd: head5.find((r) => r?.cwd)?.cwd || tail5.find((r) => r?.cwd)?.cwd || null,
      gitBranch: head5.find((r) => r?.gitBranch)?.gitBranch || null,
      ctxTokens: agentCtxTokens(tail5),
      lastTs: tail5[tail5.length - 1]?.timestamp || null,
    },
  };
}

/**
 * 增量派生:headDerived 从 prev 原样继承(闸门 G-e 保证头窗口已满 40 条可解析记录 ⇒
 * 追加不可能改变它),tailDerived/fileDerived 用与全量**同一份代码**重算。
 *
 * 返回 null = 「这条增量无法保证与全量逐字段相等」→ 调用方 fail-closed 走全量重扫
 * (I3:宁可慢一次,不许错一格)。唯一触发点见下方 agent.cwd 的推导。
 */
export function applyIncremental(prev, art, st) {
  const tail = parseRawLines(art.tailRaw40);
  const tail5 = parseRawLines((art.tailRaw40 || []).slice(-5));
  const tailCwd = tail5.find((r) => r?.cwd)?.cwd || null;
  // agent.cwd = head5 段 || tail5 段,而 head5 段在增量路径上没有原始行可算 → 只能反推:
  //   · prev.agent.cwd === null ⇒ 头段与旧尾段都空 ⇒ 头段必为 null(且不变)⇒ 答案只看新尾窗口(精确)
  //   · 否则当新尾窗口的值与旧值同串 ⇒ 无论旧值来自头段(不变)还是尾段(同值),答案都是它(精确)
  //   · 其余情况分不清旧值出处 ⇒ fail-closed(交给全量重扫)。
  //     ponytail: 这一分支在真实数据上约 3/119 个文件会命中(尾 5 条记录都不带 cwd 的那几个);
  //     要把它也变成增量,只需在这里补一次「有界回读文件头重算 head5 段」,目前不值得。
  if (prev.agent && prev.agent.cwd !== null) {
    if (tailCwd !== prev.agent.cwd) return null;
  }
  return {
    ...prev,
    v: PROFILE_VERSION,
    ino: st.ino,
    size: st.size,
    mtimeMs: st.mtimeMs,
    level: 'full',
    totalLines: art.totalLines,
    complete: art.complete,
    partial: art.partial,
    completeOffset: art.completeOffset,
    anchorHash: art.anchorHash,
    headFull: true,
    boundaryUuids: art.boundaryUuids,
    customTitle: art.titles.customTitle,
    aiTitle: art.titles.aiTitle,
    // tail 派生字段全部重算(回读窗口自足,不需要旧尾行)
    tailAssistantModel: [...tail].reverse().find((r) => r.type === 'assistant' && r.message?.model && !/^</.test(r.message.model))?.message?.model || null,
    lastTs: tail[tail.length - 1]?.timestamp || null,
    agent: {
      ...prev.agent,
      cwd: prev.agent?.cwd === null || prev.agent?.cwd === undefined ? tailCwd : prev.agent.cwd,
      ctxTokens: agentCtxTokens(tail5),
      lastTs: tail5[tail5.length - 1]?.timestamp || null,
    },
  };
}

/**
 * 缓存未命中时的编排(私有;listSessions 与 listProjects 共用,唯一允许调 scanProfile /
 * deriveProfile / applyIncremental 的地方)。读失败原样抛出(调用方各自的错误语义见 §B.1)。
 */
async function loadProfile(filePath, st, need, hash) {
  if (hash) await ensureProjectLoaded(hash);
  const hit = getEntry(filePath, st, need);
  if (hit) return hit;
  const prev = getRawEntry(filePath);
  // 边界/标题的累加器由扫描器自己管:全量路径从空开始,增量路径才用 prev 播种
  // (播种与否必须与「本次到底走了哪条路径」一致,否则 trim 掉的旧标题会赖着不走)。
  const seed = prev && prev.level === 'full' ? prev : null;
  const opts = need === 'full' ? { need, onRawLine, seed } : { need };
  let art = await scanProfile(filePath, st, prev, opts);
  let prof = art.mode === 'incremental' ? applyIncremental(prev, art, st) : null;
  if (!prof) {
    if (art.mode === 'incremental') {
      // 增量自认不等价(见 applyIncremental 的 fail-closed)→ 全量重扫一次
      art = await scanProfile(filePath, st, null, { need, onRawLine });
      noteScan('rescanned', hash);
    } else {
      noteScan(prev ? 'rescanned' : 'scanned', hash);
    }
    prof = deriveProfile(art, st);
  } else {
    noteScan('incremental', hash);
  }
  putEntry(filePath, prof, { dirty: true });
  return prof;
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
      const prof = await loadProfile(filePath, st0, 'full', projectHash);
      const totalLines = prof.totalLines;

      // Extract metadata from first REAL user message (skips isMeta / pure
      // tool_result / local-command-echo records, aligned with getSessionMessages).
      // 画像里只存结果:firstUserText200 === '' 与今天 firstRealUser === null 可证等价
      // (findFirstRealUser 只在文本非空时返回记录;compact 兜底分支返回固定非空串)。
      let firstPrompt = prof.firstUserText200;
      // The session jsonl records carry the EXACT cwd (including any Unicode
      // characters) the CLI was launched with. We must pass this exact string
      // back to --resume; reconstructing from the hash dir name loses Unicode
      // (`肠骨轴` → `----` is one-way).
      const realCwd = prof.cwd40;

      // De-collision: drop sessions that belong to a different real path which
      // the CLI hash collapsed into this same dir. Sessions whose cwd can't be
      // determined (realCwd === null) are kept — they're rare and more likely
      // ours than a sibling's.
      if (sidecarCwd && realCwd && realCwd !== sidecarCwd) continue;

      // findFirstRealUser already resolved the display text (plain prompt or a
      // reconstructed `/name args` for skill/slash-started sessions), so we just
      // slice it — no re-parsing of raw content / command blobs needed.
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
      if (!firstPrompt) continue;

      // 保险:sidechain(子代理)transcript 不进主列表。当前 Desktop/CLI 都把子代理
      // 写在 <sessionId>/subagents/ 子目录(顶层扫不到),但形态若变(写到顶层),
      // 记录里的 isSidechain:true 仍是可靠标记——头部任一记录带真值即跳过。
      if (prof.isSidechain) continue;

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
        const as = await stat(agentPath); // r13-p2-6:提前 stat(画像判据用它,免第二次系统调用)
        // 子代理字段全部来自画像的 agent.*(head5/tail5 两条窗口各自的派生,见 §A.2):
        // 同一个文件不再按 edgeSize 各扫一遍(旧键 `path#40` / `path#5` 的两份缓存合并成一份)。
        const agentProfile = await loadProfile(agentPath, as, 'full', projectHash);
        const agent = agentProfile.agent || {};
        // R1: sibling meta.json 带 toolUseId(=父会话 Task tool_use 的 id)。workflow agent 的
        // meta 没有 toolUseId(它不对应父流任何 Task 卡片),留空即可。
        let agentMeta = {};
        try { agentMeta = JSON.parse(await readFile(metaPath, 'utf-8')); } catch {}
        const base = agentPath.split(/[/\\]/).pop().replace('.jsonl', '');
        // #2/#11 子代理视图数据:上下文占用取 tail 最后一条 assistant 的 usage(单次调用口径,
        // 与主会话徽章同算法:input+cache_read+cache_creation);cwd 取任一记录顶层 cwd —— 子代理
        // 在 worktree 隔离时它与主项目路径不同,前端据此显示 worktree 徽标。
        return {
          sessionId: base,
          projectHash,
          filePath: agentPath,
          firstPrompt: agent.prompt100 || base.replace('agent-', 'Agent '),
          messageCount: agentProfile.totalLines,
          lastActivity: agent.lastTs || new Date(as.mtimeMs).toISOString(),
          model: agent.assistantModel || null,
          toolUseId: agentMeta.toolUseId || null,
          agentType: agentMeta.agentType || null,
          contextTokens: agent.ctxTokens,
          cwd: agent.cwd,
          gitBranch: agent.gitBranch,
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
      const isContinuation = prof.hasBoundaryInHead;
      chainMeta.set(sessionId, {
        boundaryUuids: prof.boundaryUuids,
        isContinuation,
        // 画像里只留 200 字 —— 旧表达式的两个使用点(:741/:760)本来都先 .slice(0,200),
        // 结果逐字相同(见 INTERFACE §A.3 对 continuationPrompt200 的说明)。
        fallbackPrompt: isContinuation ? (prof.continuationPrompt200 ?? null) : null,
      });

      sessions.push({
        sessionId,
        projectHash,
        projectPath: realCwd || decodeProjectHash(projectHash),
        filePath,
        firstPrompt,
        // jsonl 里的两种标题,各自独立(不合并,理由见 takeTitleLine)。空串=没有。
        customTitle: prof.customTitle,
        aiTitle: prof.aiTitle,
        messageCount: totalLines,
        startTime: prof.firstUserTs || new Date(s.birthtimeMs).toISOString(),
        lastActivity: prof.lastTs || new Date(s.mtimeMs).toISOString(),
        // #14:模型徽章取【最后一条】assistant 的 model —— 用户切 provider/model 后列表
        // 跟随最新使用的模型;原取 head 首条=创建时初始模型,永不更新(用户实报)。
        // 逆序扫 tail,跳过 <synthetic> 等伪模型 id(compact 摘要/错误占位,同 turn.model
        // 过滤规则);tail 无 assistant(极短/纯用户消息尾)回落 head 原逻辑。
        model: prof.tailAssistantModel || prof.headAssistantModel || null,
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
 * never a real user prompt — never becomes a user bubble / session title.
 * R10:消息流里它不再整条消失,而是经 classifyTaskNotification 投影成一行系统通知
 * (见下);本函数对它的作用仍只是"不当作真实首条/标题"。
 */
function isLocalCommandEcho(text) {
  return /^\s*<(local-command-(caveat|stdout|stderr)|command-(name|message|args)|task-notification|cgui-tool-retry)\b/.test(text);
}

// ── R10:task-notification 的读取端投影 ────────────────────────────────────────
// CLI 把同一个后台任务通知信封同时以【两种形态】落盘(真机转写实测):
//   · 普通 user 记录:origin.kind='task-notification' + queueSkipAttachments:true
//   · attachment/queued_command:commandMode='task-notification',无 source_uuid
// 它不是用户说的话。旧行为:普通 user 形态被 isLocalCommandEcho 整条吞掉(用户看不到任务
// 结果),queued_command 形态无条件合成 type:user/steered:true → 界面上冒充"你 / 已并入"。
//
// 分类只认【协议自报的来源】或【受控的整段信封形态】,不"包含标签就吞",也不因"缺
// source_uuid"就吞:
//   declaredKind:user 记录取 record.origin?.kind;queued_command 取
//                commandMode('task-notification'/'prompt')与 source_uuid(人工并入必带)。
//   - 协议说 human / commandMode=prompt / 带 source_uuid → 人工消息(含人工粘贴的
//     完整信封、讨论标签的正文),照旧原样显示,一个字不删。
//   - 协议说 task-notification → 已确认的 CLI 通知。
//   - 没有协议字段但整段就是一份完整信封(旧 CLI 的通知 / 人工粘贴)→ 来源未确认,
//     内容照样保留(前端标"来源未确认"),绝不静默丢。
// 返回 null = 按人工消息处理。
const TASK_NOTIFICATION_ENVELOPE = /^\s*<task-notification\b[\s\S]*<\/task-notification>\s*$/;
const TASK_NOTIFICATION_FIELD = /<(task-id|status)\b/;
function classifyTaskNotification(text, declaredKind = null) {
  // 协议明说这是人发的(origin.kind='human' / commandMode='prompt' / 带 source_uuid):
  // 全文照旧当人工消息,哪怕它粘贴了一整封信封(合同:人工来源时不隐藏)。
  if (declaredKind === 'human') return null;
  const raw = typeof text === 'string' ? text : '';
  const declared = declaredKind === 'task-notification';
  const wellFormed = TASK_NOTIFICATION_ENVELOPE.test(raw) && TASK_NOTIFICATION_FIELD.test(raw);
  if (!declared && !wellFormed) return null;
  return {
    confirmed: declared,
    status: raw.match(/<status>\s*([^<]*?)\s*<\/status>/)?.[1] || null,
    taskId: raw.match(/<task-id>\s*([^<]*?)\s*<\/task-id>/)?.[1] || null,
  };
}

// genui action 消息(INTERFACE §3.2,PLAN §1.3.5)。历史回读时打一个布尔标记,前端据它
// 把这条渲染成折叠的「界面操作」小标记。**只加标记,不加过滤** —— 消息照常返回、照常
// 可见:它是模型输出唯一一条"以用户身份发言"的通道,用户必须能回溯自己发了什么。
// (顺带:`[genui-action] ` 不以 `<` 开头,isLocalCommandEcho 本来就不会误吞它。)
// 前缀与 client/src/genui/host/action-send.js 的 ACTION_MESSAGE_PREFIX 逐字一致 ——
// 不 import 那个模块:打包只带 server/ 与 client/dist,client/src 不在产物里。
// 两处字面量的一致性由 tests/unit/check-genui-action-fold.mjs 锁住。
const GENUI_ACTION_PREFIX = '[genui-action] ';
const isGenuiAction = (t) => typeof t === 'string' && t.startsWith(GENUI_ACTION_PREFIX);

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

/**
 * R12:子代理转写里 toolUseId 的来源 —— 与转写同目录的 `<agentSessionId>.meta.json`
 * (CLI 起子代理时写,带 toolUseId = 母会话里那次 Task/Agent 调用的 id)。
 * 读不到/没有该键都返回 null(workflow 起的 agent 的 meta 就没有 toolUseId)。
 * A 项起 agentType 也取自同一个文件,故读一次拿两个字段(见 readAgentMeta)。
 */
async function readAgentToolUseId(metaPath) {
  return (await readAgentMeta(metaPath)).toolUseId;
}

/** 读子代理 meta.json 的两个字段(读不到/类型不对一律 null,不抛)。 */
async function readAgentMeta(metaPath) {
  try {
    const meta = JSON.parse(await readFile(metaPath, 'utf-8'));
    return {
      toolUseId: typeof meta?.toolUseId === 'string' && meta.toolUseId ? meta.toolUseId : null,
      agentType: typeof meta?.agentType === 'string' && meta.agentType ? meta.agentType : null,
    };
  } catch { return { toolUseId: null, agentType: null }; }
}

/** 在某个 projectHash 下按"父会话目录/subagents[/workflows/wf_*]/<sid>.jsonl"找子代理转写。 */
async function findAgentTranscript(projectHash, sessionId) {
  let entries;
  try { entries = await readdir(join(PROJECTS_DIR, projectHash), { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const subDir = join(PROJECTS_DIR, projectHash, e.name, 'subagents');
    const cand = join(subDir, `${sessionId}.jsonl`);
    if (existsSync(cand)) {
      return { filePath: cand, parentSessionId: e.name, toolUseId: await readAgentToolUseId(join(subDir, `${sessionId}.meta.json`)) };
    }
    // workflow 起的 agent 深埋 subagents/workflows/wf_*/<sid>.jsonl(点开列表里的 workflow agent
    // 要能找到真身,否则 404)。多探一层 workflows/。
    try {
      for (const wf of await readdir(join(subDir, 'workflows'))) {
        const wfDir = join(subDir, 'workflows', wf);
        const wfCand = join(wfDir, `${sessionId}.jsonl`);
        if (existsSync(wfCand)) {
          return { filePath: wfCand, parentSessionId: e.name, toolUseId: await readAgentToolUseId(join(wfDir, `${sessionId}.meta.json`)) };
        }
      }
    } catch {}
  }
  return null;
}

/**
 * R12:定位会话文件并解析它的归属。三种结果:
 *   { filePath, parentSessionId, toolUseId }  找到了(普通会话 parentSessionId=null)
 *   { conflict: true }                        子代理转写不在调用方给的 projectHash 下,而在别的项目里
 *   null                                      哪里都没有这个身份
 * 归属冲突只对【子代理转写】报:AGENT_OWNER_UNRESOLVED 的名字与语义都只针对代理。普通会话
 * 在别的项目下 = 这次请求的目标不存在(404),不借代理的错误码。
 */
async function locateSessionFile(sessionId, projectHash) {
  const direct = join(PROJECTS_DIR, projectHash, `${sessionId}.jsonl`);
  if (existsSync(direct)) return { filePath: direct, parentSessionId: null, toolUseId: null };
  const here = await findAgentTranscript(projectHash, sessionId);
  if (here) return here;
  let dirs;
  try { dirs = await readdir(PROJECTS_DIR); } catch { return null; }
  for (const d of dirs) {
    if (d === projectHash) continue;
    if (await findAgentTranscript(d, sessionId)) return { conflict: true };
  }
  return null;
}

/**
 * R12:子代理视图的有序展示块。按会话消息的原顺序摊平 —— 人工提示是 prompt 块,AI 回合沿用
 * messages[].blocks 的原顺序(thinking/text/tool_use,工具结果并在那次 tool_use 块里)。与
 * 母会话共用同一份块结构,前端不必为子代理另写一套渲染。
 */
function agentViewBlocks(messages) {
  const blocks = [];
  for (const m of messages) {
    if (m.type === 'user') {
      blocks.push({ type: 'prompt', content: m.text, uuid: m.uuid, timestamp: m.timestamp });
    } else if (m.type === 'turn') {
      for (const b of (m.blocks || [])) blocks.push(b);
    }
  }
  return blocks;
}

// ── A 项(2026-09-11):子代理逐条用量与归属 ────────────────────────────────
// 契约:`.devflow/INTERFACE-20260911-pricing.md` §10.1。子代理的【真】model 与 usage 只在
// 自己的转写里(meta.json 的 model 是别名如 "opus",不可用于计价),故逐转写只取
// message.model / message.usage / timestamp 三样,不把整条消息留在内存。
// 结果只读、不改任何既有字段;读不到就少一条,绝不摊派、绝不猜。
const SUBAGENT_USAGE_CACHE_MAX = 24;
const subagentUsageCache = new Map();   // `<projectHash>/<sid>` → { sig, agents }

/** 列出 `subagents/`(含 workflows/wf_*)下的子代理转写;同时算出目录的 stat 签名。 */
async function listSubagentTranscripts(dir) {
  const files = [];      // { filePath, metaPath, runId }
  let count = 0;
  let mtimeSum = 0;
  const pushDir = async (d, runId) => {
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries.slice().sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!e.isFile() || !e.name.startsWith('agent-') || !e.name.endsWith('.jsonl')) continue;
      const filePath = join(d, e.name);
      try {
        const s = await stat(filePath);
        count += 1;
        mtimeSum += s.mtimeMs;
      } catch { continue; }
      files.push({ filePath, metaPath: join(d, `${e.name.slice(0, -'.jsonl'.length)}.meta.json`), runId });
    }
  };
  await pushDir(dir, null);
  let wfEntries;
  try { wfEntries = await readdir(join(dir, 'workflows'), { withFileTypes: true }); } catch { wfEntries = []; }
  for (const wf of wfEntries.slice().sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!wf.isDirectory() || !wf.name.startsWith('wf_')) continue;
    await pushDir(join(dir, 'workflows', wf.name), wf.name);
  }
  return { files, sig: `${count}:${Math.round(mtimeSum)}` };
}

/**
 * 读一条子代理转写里计价需要的三样东西。
 * usage 的去重口径与回合 usageCalls **逐字相同**(§3.4):按 message.id 去重、首次出现为准、
 * 全零 usage 不计;两档 TTL 分项按同一口径各自汇总,顶层量与分项互不相加。
 * 返回 null = 这条读不出来(调用方跳过)。
 */
async function readAgentUsage(filePath) {
  const calls = new Map();     // message.id → { at, usage }
  let model = null;
  let timestamp = null;
  try {
    await streamJsonl(filePath, (rec) => {
      if (rec?.type !== 'assistant') return;
      if (!timestamp && typeof rec.timestamp === 'string' && rec.timestamp) timestamp = rec.timestamp;
      const message = rec.message;
      if (!message || typeof message !== 'object') return;
      // 真 model:跳过 `<synthetic>` 伪模型(compact 摘要/错误占位,同 turn.model 的过滤口径)。
      if (!model && message.model && !/^</.test(message.model)) model = message.model;
      const usage = message.usage;
      if (!usage || typeof usage !== 'object') return;
      const mid = message.id || rec.uuid;
      if (!mid || calls.has(mid)) return;
      const nonZero = (usage.input_tokens || 0) + (usage.output_tokens || 0)
        + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0) > 0;
      if (!nonZero) return;
      calls.set(mid, { at: rec.timestamp || null, usage });
    });
  } catch { return null; }
  if (!model && calls.size === 0) return null;   // model 与 usage 都读不到 → 不值得进 agents[]
  const agg = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const usageCalls = [];
  let sum5m = 0;
  let sum1h = 0;
  for (const entry of calls.values()) {
    const u = entry.usage;
    agg.input_tokens += u.input_tokens || 0;
    agg.output_tokens += u.output_tokens || 0;
    agg.cache_read_input_tokens += u.cache_read_input_tokens || 0;
    agg.cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
    const w5 = u.cache_creation?.ephemeral_5m_input_tokens || 0;
    const w1 = u.cache_creation?.ephemeral_1h_input_tokens || 0;
    sum5m += w5;
    sum1h += w1;
    usageCalls.push({ at: entry.at, usage: u });
  }
  if (sum5m + sum1h > 0) agg.cache_creation = { ephemeral_5m_input_tokens: sum5m, ephemeral_1h_input_tokens: sum1h };
  return { model, timestamp, usage: agg, usageCalls };
}

/**
 * 读某个会话的全部子代理用量(逐条:身份 + 真 model + 聚合 usage + 逐调用 usageCalls)。
 * 只是"读到什么",不做归属 —— 归属要配对母 jsonl 的 tool_use.id,在 getSessionMessages
 * 内做(见 attachSubagentUsage)。进程内按 subagents 目录的 stat 签名缓存(文件数 + mtimeMs
 * 之和,递归含 workflows/wf_*),不写磁盘。
 *
 * ⚠️ 安全边界(2026-09-12 后台扫描告警核查为误报,此处显式写明依赖):
 * 本函数**直接拼接** projectHash / sid 进文件路径、**自身不做任何校验** —— 安全性依赖
 * 调用链上游的 safeId(拒含 `/`、`\`、`..`、`\0` 的串,见 routes/sessions.js:17)。
 * 当前唯一调用点就是本文件的 getSessionMessages,而它仅有的两个 HTTP 入口
 * (routes/sessions.js:457-460 与 :893)都在进入前校验过 projectHash 与 sessionId。
 * **若将来新增调用点,必须自行先过 safeId**,否则会打开任意文件读取。
 */
async function readSessionSubagentUsage(projectHash, sid) {
  const dir = join(PROJECTS_DIR, projectHash, sid, 'subagents');
  const listed = await listSubagentTranscripts(dir);
  if (!listed.files.length) return [];
  const key = `${projectHash}/${sid}`;
  const cached = subagentUsageCache.get(key);
  if (cached && cached.sig === listed.sig) return cached.agents;
  const agents = [];
  for (const file of listed.files) {
    try {
      const usage = await readAgentUsage(file.filePath);
      if (!usage) continue;
      const meta = await readAgentMeta(file.metaPath);
      agents.push({
        agentSessionId: basename(file.filePath).replace('.jsonl', ''),
        agentType: meta.agentType,
        toolUseId: meta.toolUseId,
        runId: file.runId,
        ...usage,
      });
    } catch { /* 单条读失败只跳过它(契约:无错误码、其余照常) */ }
  }
  subagentUsageCache.set(key, { sig: listed.sig, agents });
  // 上限保护:历史会话 + 面板轮询会各自累积 —— 只留最近用到的若干个会话。
  while (subagentUsageCache.size > SUBAGENT_USAGE_CACHE_MAX) {
    subagentUsageCache.delete(subagentUsageCache.keys().next().value);
  }
  return agents;
}

/** 路径段安全(与 routes/sessions.js 的 safeId 同款判据;那份在 routes 层,本模块不能反向 import)。 */
function pathSegSafe(s) {
  return typeof s === 'string' && !!s
    && !s.includes('/') && !s.includes('\\') && !s.includes('..') && !s.includes('\0');
}

/**
 * 一条转写 → agents[] 同形状条目(读不到用量就 null)。
 * 比历史路径多一道闸:连一条非零 usage 都没有(文件刚建/正在 flush)也不发 —— 历史那边
 * 是"回合已结束、账就该齐了",这里发早了在卡片上画一个 $0.00 比不画更坏(宁缺勿假)。
 */
async function agentEntryFromTranscript(filePath, metaPath, fallbackToolUseId) {
  const usage = await readAgentUsage(filePath);
  if (!usage || !usage.usageCalls?.length) return null;
  const meta = await readAgentMeta(metaPath);
  return {
    agentSessionId: basename(filePath).replace('.jsonl', ''),
    agentType: meta.agentType,
    // 归属键取调用方给的(它才是卡片键);meta 只是兜底。
    toolUseId: fallbackToolUseId || meta.toolUseId,
    ...usage,
  };
}

/**
 * 直播补齐(2026-09-13):子代理【完成那一刻】只读它那一条转写,给完成事件附金额用。
 * 与 readSessionSubagentUsage 的区别是**不扫全盘**:先按 taskId 直连 `agent-<task-id>.jsonl`
 * (CLI 的 task_id 与转写文件名同名,实测同名率 ~100%),命不中才扫 subagents/*.meta.json
 * (+ workflows/wf_*)按 toolUseId 找(88 条实测 6 ms;转写读取最坏样本 3.86 MB / 13 ms)。
 * 返回形状与 attachSubagentUsage 产出的 agents[] 逐字段相同 —— 同一形状 = 同一计价口径。
 * 读不到 usage(文件刚建/正在 flush)→ null,调用方据此不下发(宁缺勿假)。
 *
 * ⚠️ 安全边界:与 readSessionSubagentUsage 同款,自行过 pathSegSafe —— 调用方是
 * routes/chat.js 的消息泵(入参来自 slot.cwd 派生 + CLI 事件),不是 HTTP 查询串。
 */
export async function readSubagentUsageForToolUse(projectHash, sid, { toolUseId, taskId } = {}) {
  if (!pathSegSafe(projectHash) || !pathSegSafe(sid)) return null;
  if (!toolUseId && !taskId) return null;
  const dir = join(PROJECTS_DIR, projectHash, sid, 'subagents');
  if (typeof taskId === 'string' && /^[A-Za-z0-9_-]+$/.test(taskId)) {
    const filePath = join(dir, `agent-${taskId}.jsonl`);
    if (existsSync(filePath)) {
      return await agentEntryFromTranscript(filePath, join(dir, `agent-${taskId}.meta.json`), toolUseId);
    }
  }
  const listed = await listSubagentTranscripts(dir);
  if (!listed.files.length) return null;
  for (const file of listed.files) {
    const meta = await readAgentMeta(file.metaPath);
    if (meta.toolUseId && meta.toolUseId === toolUseId) {
      return await agentEntryFromTranscript(file.filePath, file.metaPath, toolUseId);
    }
  }
  return null;
}

function parseStamp(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const t = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/**
 * workflow 子代理的归属:runId → 母 jsonl 里那次 Workflow 调用的 tool_use.id。
 * 同一 runId 可能出现在多条 tool_result 上(resume/续跑)—— 唯一命中直接归属;多命中按
 * 时间戳就近:取「承载记录时刻 ≤ 该 agent 首条记录时刻」的最后一次调用,agent 早于全部
 * 调用则取最早一次。分不开(agent 无时间戳 / 承载记录无时间戳 / 选中的那次与别的调用
 * **时间戳相同**,契约 §10.1「多命中且时间戳分不开」)→ null,宁缺勿猜。
 */
function pickWorkflowCall(calls, agentTimestamp) {
  if (!calls || !calls.length) return null;
  if (calls.length === 1) return calls[0];
  const at = parseStamp(agentTimestamp);
  if (at == null) return null;
  let chosen = null;
  for (const call of calls) {
    const callAt = parseStamp(call.at);
    if (callAt == null) return null;
    if (callAt <= at) chosen = call;
  }
  const pick = chosen || calls[0];
  // 选中的那次时刻与别的调用完全相同 → 先后无从区分(再往下比只是文件记录顺序的产物,
  // 不是时间证据)→ 不可归属。金额宁可空着,也不能挂到猜出来的那一次上。
  const pickAt = parseStamp(pick.at);
  if (calls.filter((call) => parseStamp(call.at) === pickAt).length > 1) return null;
  return pick;
}

/**
 * 把子代理用量挂到各自回合的 `subUsage.agents[]` 上(契约 §10.1)。
 * 归属键两条:普通子代理 = meta.json 的 toolUseId;workflow 子代理 = runId → 那次
 * Workflow 调用的 tool_use.id。都归不到 → 不进任何 agents[](不摊派、不猜)。
 * 顺序 = 该轮内 toolUseId 首次出现顺序;同一 toolUseId 多个 agent 按转写文件名升序
 * (扫描顺序已保证)。本轮一条都没有 → subUsage 键不出现。
 */
function attachSubagentUsage(messages, agents, workflowCalls) {
  if (!agents.length) return;
  const turnOf = new Map();      // toolUseId → 该 tool_use 所属的 turn
  for (const m of messages) {
    if (m.type !== 'turn' || !Array.isArray(m.toolCalls)) continue;
    for (const tc of m.toolCalls) if (tc?.id && !turnOf.has(tc.id)) turnOf.set(tc.id, m);
  }
  const byTurn = new Map();      // turn → Map(toolUseId → agent[])
  for (const agent of agents) {
    const call = agent.runId
      ? pickWorkflowCall(workflowCalls.get(agent.runId), agent.timestamp)
      : (agent.toolUseId ? { toolUseId: agent.toolUseId } : null);
    if (!call) continue;
    const turn = turnOf.get(call.toolUseId);
    if (!turn) continue;
    let grouped = byTurn.get(turn);
    if (!grouped) { grouped = new Map(); byTurn.set(turn, grouped); }
    if (!grouped.has(call.toolUseId)) grouped.set(call.toolUseId, []);
    grouped.get(call.toolUseId).push(agent);
  }
  for (const [turn, grouped] of byTurn) {
    const order = new Map();
    (turn.toolCalls || []).forEach((tc, i) => { if (tc?.id && !order.has(tc.id)) order.set(tc.id, i); });
    const ids = [...grouped.keys()].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    const list = [];
    for (const id of ids) {
      for (const agent of grouped.get(id)) {
        list.push({
          agentSessionId: agent.agentSessionId,
          toolUseId: id,
          agentType: agent.agentType,
          model: agent.model,
          timestamp: agent.timestamp,
          usage: agent.usage,
          usageCalls: agent.usageCalls,
        });
      }
    }
    if (list.length) turn.subUsage = { agents: list };
  }
}


export async function getSessionMessages(sessionId, projectHash) {
  const loc = await locateSessionFile(sessionId, projectHash);
  if (!loc) return { notFound: true };
  if (loc.conflict) return { conflict: true };
  const filePath = loc.filePath;
  const rawRecords = await parseJsonl(filePath);
  const records = dedupReplayedRecords(rawRecords);
  // L4/R07: 加载附件 sidecar,在 user 消息 push 时注入 attachments/displayText
  // (身份索引 messageId 优先,旧 textHash 兜底)。
  const attachmentsSidecar = await readAttachmentsSidecar(sessionId);

  // Collect all tool results first, keyed by tool_use_id
  const toolResultMap = new Map();
  // A 项:runId → 承载它的那次 tool_use 调用(按记录顺序 = 时间顺序)。同一 runId 可有多条
  // (resume/续跑),归属时按时间戳就近挑(见 pickWorkflowCall)。
  const workflowCalls = new Map();
  for (const record of records) {
    if (record.type === 'user') {
      const content = normalizeContent(record.message?.content);
      for (const item of content) {
        if (item.type === 'tool_result') {
          const entry = {
            toolUseId: item.tool_use_id,
            ...toolResultBody(item.content),
            isError: item.is_error || false,
          };
          // 工作流的结果才附 workflowRun;其余 tool_result 一个键都不多出来。
          const workflowRun = workflowRunOf(record.toolUseResult, entry.content);
          if (workflowRun) {
            entry.workflowRun = workflowRun;
            if (workflowRun.runId && item.tool_use_id) {
              if (!workflowCalls.has(workflowRun.runId)) workflowCalls.set(workflowRun.runId, []);
              workflowCalls.get(workflowRun.runId).push({ toolUseId: item.tool_use_id, at: record.timestamp || null });
            }
          }
          toolResultMap.set(item.tool_use_id, entry);
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
        // 逐次 API 调用各留一条 {at, usage}(顺序 = 首次出现顺序):同一个回合可能横跨
        // 分时段价的档位边界,汇总后的四字段没法再拆回"哪一段算高价" —— 客户端按这一列
        // 逐调用计价(定价看调用自己的时刻)。汇总口径与数值一字不变,这里只是**追加**字段。
        const calls = [];
        for (const entry of currentTurn._usageById.values()) {
          const u = entry.usage;
          agg.input_tokens += u.input_tokens || 0;
          agg.output_tokens += u.output_tokens || 0;
          agg.cache_read_input_tokens += u.cache_read_input_tokens || 0;
          agg.cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
          last = u;
          calls.push({ at: entry.at ?? null, usage: u });
        }
        currentTurn.usage = agg;
        currentTurn.ctxUsage = last;
        currentTurn.usageCalls = calls;
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

        // R10:先做协议通知分类,再谈斜杠命令/人工气泡。通知在转写里插在回合中间 →
        // 切一刀保住它的真实位置(切的是 AI 回合,不造人工气泡,也就不多一个"你")。
        const notification = text ? classifyTaskNotification(text, record.origin?.kind || null) : null;
        if (notification) {
          flushTurn();
          messages.push({
            type: 'task-notice',
            uuid: record.uuid,
            timestamp: record.timestamp,
            text,
            ...notification,
          });
          continue;
        }

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
          messages.push({
            type: 'user',
            uuid: record.uuid,
            text: shownText,
            timestamp: record.timestamp,
            sessionId: record.sessionId,
            permissionMode: record.permissionMode,
            ...(isGenuiAction(shownText) ? { genuiAction: true } : {}),
            ...attachmentMessageFields(attachmentsSidecar, [record.uuid], text),
          });
        }
        // tool_result-only messages are silently merged via toolResultMap
      }

    } else if (record.type === 'assistant') {
      // 会话级用量收集(供 usageTotals)。跳过 `<synthetic>` 伪模型记录(错误占位/
      // compact 摘要,不是真实 API 调用)。首见即记,与 per-turn 去重规则一致。
      if (record.message?.usage && !/^</.test(record.message?.model || '')) {
        const sid = record.message?.id || record.uuid;
        if (sid && !sessionUsageById.has(sid)) {
          // R22/R24:上游用量无效/自相矛盾时,代理把结论(含原始数字)记在服务端自有存储里
          // (CLI 落盘只留官方字段,自定义键会被丢掉)。这里按消息 id 回读补上 code,
          // CLI 写下的数字一个字不改。
          sessionUsageById.set(sid, attachUsageIssues(record.message.usage, {
            messageId: record.message?.id || null,
            model: record.message?.model || null,
            timestamp: record.timestamp,
          }));
        }
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
          // **首次出现为准**(与 usage 的去重口径逐字一致):同一 message.id 的流式分片
          // 只记第一片 —— 分片的 usage 不是相同值(中间片 output 常为 0),换成"取末条/
          // 取最大"会让逐调用之和 ≠ usage,两条口径就分叉了。
          if (!currentTurn._usageById.has(mid)) {
            currentTurn._usageById.set(mid, { usage: u0, at: record.timestamp || null });
          }
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
      // R10:同一份通知信封折叠进本回合时,CLI 落的是 queued_command(commandMode=
      // 'task-notification',无 source_uuid)。真人工并入是 commandMode='prompt' 且带
      // source_uuid —— 协议字段说了算,不靠"缺 source_uuid"或"包含标签"猜。
      const declared = a.commandMode === 'task-notification'
        ? 'task-notification'
        : (a.commandMode === 'prompt' || a.source_uuid) ? 'human' : null;
      const notification = prompt.trim() ? classifyTaskNotification(prompt, declared) : null;
      if (notification) {
        // 通知写在折叠点(回合中间)→ 与 user 形态同口径:切段保住位置,不合成人工气泡。
        flushTurn();
        messages.push({
          type: 'task-notice',
          uuid: record.uuid,
          timestamp: record.timestamp || a.timestamp,
          text: prompt.trim(),
          ...notification,
        });
      } else if (prompt.trim()) {
        // flushTurn 把在飞回合从折叠点切开 → 历史天然渲染成「回合A → 引导气泡 → 回合B」,
        // 与 Claude Desktop 一致。
        flushTurn();
        messages.push({
          type: 'user',
          uuid: record.uuid,
          steered: true,
          steerUuid: a.source_uuid || null,
          // 忙时触发的 action 会进队列、被 CLI 折叠成 queued_command(无 user 行),
          // 这条路径漏打标记 = "排队发出去的那次操作重开会话后展成整段"。
          ...(isGenuiAction(prompt) ? { genuiAction: true } : {}),
          text: prompt,
          timestamp: record.timestamp || a.timestamp,
          // 并入消息同样查附件 sidecar:漏了这步,带图并入的消息重开会话后图片全丢
          // (用户实报"并入的消息有图片不显示")。并入提交的 uuid 就是 steerId=
          // source_uuid,身份索引直接命中;旧的按文本哈希条目继续兜底。
          ...attachmentMessageFields(attachmentsSidecar, [a.source_uuid, record.uuid], prompt),
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
  // A 项:子代理用量按归属挂到各自回合(契约 §10.1)。只读、失败静默 —— 读不到就不挂,
  // 绝不影响既有字段与错误契约(轮末 usage/costUsd/命中率口径一个字不动)。
  try {
    const agents = await readSessionSubagentUsage(projectHash, sessionId);
    attachSubagentUsage(finalMessages, agents, workflowCalls);
  } catch { /* 子代理用量读不出来 = 这条会话没有金额可显示,历史照常返回 */ }
  // 聚合用量(R22/R23):五类量 + 缓存写 TTL 分项 + 无效/冲突 code,归一规则只在
  // utils/usage-normalize.js 一处(顶层 creation 与 5m/1h 分项不重复相加)。
  // apiCalls = 去重后的底层 API 调用次数,供前端明细展示/排查。
  const usageTotals = accumulateUsage([...sessionUsageById.values()]);
  usageTotals.apiCalls = sessionUsageById.size;
  // R12:owner 明确母归属(子代理带真实 parentSessionId+toolUseId,普通会话两者为 null);
  // view 区分本次读的是会话还是子代理视图,子代理的有序展示块在 view.blocks。
  // 既有字段 messages/usageTotals 一字不改(GUI 与两个卡片组件都在读)。
  const owner = {
    sessionId,
    projectHash,
    parentSessionId: loc.parentSessionId || null,
    toolUseId: loc.toolUseId || null,
  };
  const view = loc.parentSessionId
    ? { kind: 'agent', blocks: agentViewBlocks(finalMessages) }
    : { kind: 'session', blocks: [] };
  return { messages: finalMessages, usageTotals, owner, view };
}

// R12:子代理的终态词汇(与 SDK 的 task_notification.status 及 GUI 的终态判据同一套)。
// chat.js 的终态簿记共用这一份,避免两处各写一遍再各自漂移。
export const AGENT_TERMINAL_STATUSES = ['completed', 'failed', 'stopped', 'killed'];

/**
 * 从一份 task-notification 信封正文里取该 toolUseId 的终态。
 * 返回 undefined = 这不是该 toolUseId 的通知;null = 是它的通知但没有可确证的终态。
 */
function notificationStatus(text, toolUseId) {
  if (typeof text !== 'string' || !text.includes(toolUseId)) return undefined;
  const id = text.match(/<tool-use-id>\s*([^<]*?)\s*<\/tool-use-id>/);
  if (!id || id[1] !== toolUseId) return undefined;
  const st = text.match(/<status>\s*([^<]*?)\s*<\/status>/)?.[1] || null;
  return AGENT_TERMINAL_STATUSES.includes(st) ? st : null;
}

/**
 * 一条记录是否留下该 toolUseId 的痕迹;有则给出它能确证的终态(没有就是 null)。
 * 单开函数而不是内联:两种落盘形态(普通 user 信封 / 折叠进回合的 queued_command)与
 * 结构化 tool_use/tool_result 都要认,单测直接喂记录对象即可。
 */
export function agentEvidenceInRecord(record, toolUseId) {
  const content = record?.message?.content;
  if (Array.isArray(content)) {
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use' && b.id === toolUseId) return { seen: true, status: null };
      if (b.type === 'tool_result' && b.tool_use_id === toolUseId) {
        // 结构化 toolUseResult.status:前台 Task 完成时是 'completed'/'failed';
        // 后台启动的是 'async_launched'(还没结束,不算终态)。
        const st = typeof record.toolUseResult?.status === 'string' ? record.toolUseResult.status : null;
        return { seen: true, status: AGENT_TERMINAL_STATUSES.includes(st) ? st : null };
      }
      if (b.type === 'text') {
        const st = notificationStatus(b.text, toolUseId);
        if (st !== undefined) return { seen: true, status: st };
      }
    }
  }
  if (typeof content === 'string') {
    const st = notificationStatus(content, toolUseId);
    if (st !== undefined) return { seen: true, status: st };
  }
  const prompt = record?.attachment?.type === 'queued_command' ? record.attachment.prompt : null;
  if (typeof prompt === 'string') {
    const st = notificationStatus(prompt, toolUseId);
    if (st !== undefined) return { seen: true, status: st };
  }
  return null;
}

/**
 * R12(stop-task 用):某子代理身份(母会话 sid + toolUseId)在磁盘上的证据。
 * 返回 { seen: true, status: 终态或 null };该身份在母会话历史里毫无痕迹则 null ——
 * 调用方据此区分"只有历史、没有运行实例"(409 AGENT_NOT_RUNNING)与"从未找到该身份"(404)。
 * status 只有能从通知/结构化结果确证时才给:宁可 null,不猜一个假终态。
 */
export async function findAgentRunEvidence(parentSessionId, toolUseId) {
  if (!toolUseId) return null;
  const filePath = await findSessionFile(parentSessionId);
  if (!filePath) return null;
  let found = null;
  try {
    // 只要"出现过该 id 的行":readJsonlEdges 的 onLine 收原始字符串,先做一次子串过滤,
    // 大会话里把 JSON.parse 的次数从数万降到几条。
    await readJsonlEdges(filePath, 0, (raw) => {
      if (!raw.includes(toolUseId)) return;
      let rec;
      try { rec = JSON.parse(raw); } catch { return; }
      const hit = agentEvidenceInRecord(rec, toolUseId);
      if (!hit) return;
      // 同一 task 可以通知多次(每次停下都发)→ 通篇以后者为准。
      found = { seen: true, status: hit.status || found?.status || null };
    });
  } catch { return null; }
  return found;
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
