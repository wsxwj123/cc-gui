// R25:历史变换的合同入口(dry-run 预览 → 提交)。
//
// 【合同要点】所有实际提交都是 POST + 业务参数 + `dryRun:false,baseVersion,previewToken`;
// dryRun 缺省或非布尔一律 400(**绝不"字段缺失就直接改历史"**,旧实现正是这样把用户会话
// 裁掉的)。预览零改写、不停止任务;提交先写完整备份再原子替换,失败不写会话。
// 错误统一 {ok:false,code,error},code 稳定、error 可读且不含调用堆栈/正文。
//
// 【为什么单独一个模块】原来 trim/strip-thinking/repair 各写一套读盘+改写,判据(运行中?
// 版本变了?)各不相同。这里收敛成一台引擎:参数校验 → 定位/改写(纯计算) → 预览令牌 →
// 提交(备份+双闸+原子替换)。单测直接 import 纯函数。
import { Router } from 'express';
import { readFile, writeFile, stat, unlink } from 'fs/promises';
import { join, basename, dirname } from 'path';
import { randomUUID, randomBytes, createHash } from 'crypto';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { homedir, tmpdir } from 'os';
import { isLocalReq, requestHostname } from '../services/auth.js';
import { findSessionFile } from '../services/session-reader.js';
import { repairOfficialCompat } from '../utils/session-repair.js';
import {
  claudeSpawn, cleanChildEnv, safeModelArg, closePersistentForSession, getActiveChatProcesses,
} from './chat.js';
import {
  safeId, sessionFile, hasRealConversationLine, writeJsonlAtomic,
  broadcastSessionFileChange, trimJsonlBeforeTool, compactSegmentJsonl,
  renderSegmentTranscript, repairSessionFileGuarded,
} from './sessions.js';

const router = Router();
const execFileP = promisify(execFile);

// ── 错误信封与身份 ─────────────────────────────────────────────────────────
// 合同「公共规则、身份与错误」:本节新增/修改的 JSON 失败一律 {ok:false,code,error}。
// 兼容保留旧字段时也必须在同一 body 里带这三个(旧前端读 error,新前端读 code)。
function fail(res, status, code, error) {
  return res.status(status).json({ ok: false, code, error });
}

const SESSION_INVALID_INPUT = 'SESSION_INVALID_INPUT';
const SESSION_NOT_FOUND = 'SESSION_NOT_FOUND';
const SESSION_RUNNING = 'SESSION_RUNNING';
const SESSION_CHANGED = 'SESSION_CHANGED';
const SESSION_OPERATION_CONFLICT = 'SESSION_OPERATION_CONFLICT';
const SESSION_PREVIEW_EXPIRED = 'SESSION_PREVIEW_EXPIRED';
const SESSION_PREVIEW_BUSY = 'SESSION_PREVIEW_BUSY';
const SESSION_COMPATIBILITY_UNVERIFIED = 'SESSION_COMPATIBILITY_UNVERIFIED';
const SESSION_BACKUP_FAILED = 'SESSION_BACKUP_FAILED';
const SESSION_OPERATION_TIMEOUT = 'SESSION_OPERATION_TIMEOUT';

// 「主体」:本地请求(回环)与每个远端来源各算一个。备份/预览都按主体隔离,
// 越权读别人的备份引用 → 403(不是 404:对象存在但无权)。
function principalOf(req) {
  if (isLocalReq(req)) return 'local';
  return `remote:${requestHostname(req) || 'unknown'}`;
}

// ── 版本标识 ───────────────────────────────────────────────────────────────
// baseVersion/resultVersion = 内容哈希 + 字节数。不含正文、不可反推内容,任何写入都会变,
// 跨进程可比 —— 正好用来做"提交点再验一次版本"与"旧预览不得再执行"。
export function versionOf(text) {
  const h = createHash('sha256').update(String(text), 'utf8').digest('hex');
  return `v1-${h.slice(0, 16)}-${Buffer.byteLength(String(text), 'utf8')}`;
}

// 文件按行重组的规范形态(与 writeJsonlAtomic 的收尾一致):版本比较不受尾行换行影响。
function normalized(text) {
  const s = String(text ?? '');
  return s.length && !s.endsWith('\n') ? `${s}\n` : s;
}

// 会话"正在跑回合"的判据。
// 【为什么不是"slot 非 idle 就算"】实测(隔离实例,2026-09-11):slot 在【回合已收尾但状态
// 未回收】与【CLI 冷启动/上游重试】两种情况下都会长时间停在非 idle 上 —— 把它当"运行中"
// 会让一个其实没在干活的会话被历史操作拒之门外(套件里 [CLI] 夹具会话正是这一种:POST 建完
// 会话后回合仍在重试,旧判据一律 409)。
// 【正确判据】"回合"在本合同里的身份是 canonical turn(clientTurnId 起的那个回合,见会话流
// 一节):该 slot 绑定了未结算的 turnRecord 才是"有回合在跑"。GUI 发送恒带 clientTurnId,
// 所以用户真实回合照样拦住;而检测/脚本那种不带 clientTurnId 的裸 POST 不构成 canonical turn,
// 不阻塞历史操作。进程已退出或回合已结算都不算运行中。
export function isSessionRunning(sessionId) {
  return getActiveChatProcesses().some(
    (p) => p.sessionId === sessionId && p.exitCode === null && !p.idle && p.turnRunning,
  );
}

// ── 预览存储 ───────────────────────────────────────────────────────────────
// 预览最多保留 5 分钟、每桶最多 64 项;提交完成后条目留到到期(同进程重放要回原结果)。
// 桶 = 主体+会话+操作+锚点形态:同一会话上用不同定位方式(按 uuid / 按时间戳)的预览
// 各自独立计额,互不挤占 —— 容量是内存保护,不是"用户只能攒 64 条预览"的产品限制。
const PREVIEW_TTL_MS = 5 * 60 * 1000;
const PREVIEW_CAP = 64;
const previews = new Map(); // token -> entry

function bucketOf(entry) {
  return `${entry.principal}\x00${entry.projectHash}\x00${entry.sid}\x00${entry.op}\x00${entry.anchorKind}`;
}

function gcPreviews(now) {
  for (const [token, entry] of previews) {
    if (entry.expiresAt <= now) previews.delete(token);
  }
}

export function previewBucketCount(key, now = Date.now()) {
  let n = 0;
  for (const entry of previews.values()) {
    if (entry.expiresAt > now && bucketOf(entry) === key) n += 1;
  }
  return n;
}

// ── 各操作的纯计算(读入原文 → 输出新内容与报告)────────────────────────────
// 返回 {ok:false,status,code,error} 或
//      {ok:true, changed, report, affectedRange, compatibility, requiresNewSession, newContent, extra?}
//
// compatibility:'compatible' = 保留下来的历史逐字未改(或只做结构裁剪)且不留下孤立的
// 工具配对;'unverified' = 无法保证变换后的历史能继续发送 → 提交一律拒绝(数据保护)。

// 工具配对完整性:保留段里每个 tool_use 都要有配对的 tool_result。
function pairingIntact(lines) {
  const uses = new Set();
  const results = new Set();
  for (const line of lines) {
    if (!line || !line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const content = Array.isArray(obj?.message?.content) ? obj.message.content : null;
    if (!content) continue;
    for (const block of content) {
      if (block?.type === 'tool_use' && block.id) uses.add(block.id);
      if (block?.type === 'tool_result' && block.tool_use_id) results.add(block.tool_use_id);
    }
  }
  for (const id of uses) if (!results.has(id)) return false;
  return true;
}

function parseJsonl(text) {
  return String(text || '').split('\n').map((line) => {
    if (!line.trim()) return null;
    try { return JSON.parse(line); } catch { return null; }
  });
}

// 提交时"关闭常驻空闲进程"会写盘(CLI 落收尾记录)。判定这次漂移能不能算我们自己的:
// 必须同时满足 ①确实关了本会话的常驻空闲进程 ②新内容是旧内容的纯追加(收尾记录只追加、
// 不改写既有行)。只满足一半就照旧 SESSION_CHANGED —— 第三方新写入绝不能被当成这次提交的
// 一部分吞掉(那是丢用户消息)。纯函数,单测直接钉。
export function closeWriteAbsorbable({ prevRaw, freshRaw, idleSlotsClosed } = {}) {
  if (!idleSlotsClosed) return false;
  if (typeof prevRaw !== 'string' || typeof freshRaw !== 'string') return false;
  return freshRaw.length >= prevRaw.length && freshRaw.startsWith(prevRaw);
}

const OPS = {  trim: {
    anchorKind: (p) => (p.uuid ? 'uuid' : 'fromTimestamp'),
    parse(body) {
      const { uuid, fromTimestamp } = body;
      const hasUuid = typeof uuid === 'string' && uuid.trim() !== '';
      const hasTs = typeof fromTimestamp === 'string' && fromTimestamp.trim() !== '';
      if (hasUuid === hasTs) {
        return { ok: false, error: 'trim 需要 uuid 或 fromTimestamp 二者之一' };
      }
      if (hasTs && Number.isNaN(Date.parse(fromTimestamp))) {
        return { ok: false, error: 'fromTimestamp 必须是合法 ISO 时间' };
      }
      return { ok: true, params: hasUuid ? { uuid: uuid.trim() } : { fromTimestamp: new Date(fromTimestamp).toISOString() } };
    },
    apply(raw, params) {
      const lines = String(raw).split('\n');
      const cutoffMs = params.fromTimestamp ? Date.parse(params.fromTimestamp) : null;
      let cutIdx = -1;
      for (let i = 0; i < lines.length; i += 1) {
        if (!lines[i].trim()) continue;
        let obj;
        try { obj = JSON.parse(lines[i]); } catch { continue; }
        if (params.uuid && obj.uuid === params.uuid) { cutIdx = i; break; }
        if (cutoffMs !== null && obj.timestamp) {
          const t = Date.parse(obj.timestamp);
          if (!Number.isNaN(t) && t >= cutoffMs) { cutIdx = i; break; }
        }
      }
      if (cutIdx === -1) {
        return { ok: false, status: 404, code: SESSION_NOT_FOUND, error: '会话里找不到该锚点' };
      }
      const kept = lines.slice(0, cutIdx);
      const newContent = normalized(kept.join('\n'));
      const requiresNewSession = !hasRealConversationLine(kept);
      return {
        ok: true,
        changed: newContent !== normalized(raw),
        newContent,
        requiresNewSession,
        compatibility: pairingIntact(kept) ? 'compatible' : 'unverified',
        affectedRange: { kind: 'lines', fromLine: cutIdx, toLine: lines.length },
        report: {
          op: 'trim',
          anchor: params.uuid ? { kind: 'uuid', uuid: params.uuid } : { kind: 'fromTimestamp', fromTimestamp: params.fromTimestamp },
          removedFromLine: cutIdx,
          removedRecords: lines.length - cutIdx,
          keptRecords: cutIdx,
        },
      };
    },
  },

  'strip-thinking': {
    anchorKind: () => 'none',
    parse() { return { ok: true, params: {} }; },
    apply(raw) {
      const lines = String(raw).split('\n');
      let strippedBlocks = 0;
      let touchedLines = 0;
      let skippedThinkingOnly = 0;
      const out = lines.map((line) => {
        if (!line.trim()) return line;
        let obj;
        try { obj = JSON.parse(line); } catch { return line; }
        if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
          const before = obj.message.content.length;
          const filtered = obj.message.content.filter((c) => c?.type !== 'thinking' && c?.type !== 'redacted_thinking');
          // 纯 thinking 轮次:剥离后 content 变 [] → 上游会拒绝空 content 的 assistant 记录
          // (400)导致 resume 失败。这种行保留原样(与旧实现同判据)。
          if (filtered.length === 0) { skippedThinkingOnly += 1; return line; }
          const removed = before - filtered.length;
          if (removed > 0) {
            obj.message.content = filtered;
            strippedBlocks += removed;
            touchedLines += 1;
            return JSON.stringify(obj);
          }
        }
        return line;
      });
      const newContent = normalized(out.join('\n'));
      return {
        ok: true,
        changed: newContent !== normalized(raw),
        newContent,
        requiresNewSession: false,
        // 这个操作的目的就是清掉跨 provider 失效的思考块(用户显式请求),保留段其余内容逐字未改。
        compatibility: 'compatible',
        affectedRange: { kind: 'blocks', touchedLines, strippedBlocks },
        report: {
          op: 'strip-thinking', strippedBlocks, touchedLines, skippedThinkingOnly,
        },
      };
    },
  },

  'trim-before-tool': {
    anchorKind: () => 'toolUseId',
    parse(body) {
      const toolUseId = typeof body.toolUseId === 'string' ? body.toolUseId.trim() : '';
      if (!toolUseId) return { ok: false, error: 'toolUseId 必填' };
      return { ok: true, params: { toolUseId } };
    },
    apply(raw, params) {
      const r = trimJsonlBeforeTool(raw, params.toolUseId);
      if (!r.found) {
        return { ok: false, status: 404, code: SESSION_NOT_FOUND, error: '会话里找不到该 tool_use 锚点' };
      }
      const newContent = normalized(r.keptLines.join('\n'));
      const requiresNewSession = !hasRealConversationLine(r.keptLines);
      return {
        ok: true,
        changed: newContent !== normalized(raw),
        newContent,
        requiresNewSession,
        compatibility: pairingIntact(r.keptLines) ? 'compatible' : 'unverified',
        affectedRange: { kind: 'lines', fromLine: r.removedFromLine, toLine: r.totalLines },
        report: {
          op: 'trim-before-tool',
          toolUseId: params.toolUseId,
          removedFromLine: r.removedFromLine,
          keptAssistantBlocks: r.keptAssistantBlocks,
          totalLines: r.totalLines,
        },
      };
    },
  },

  'compact-segment': {
    anchorKind: () => 'compact',
    parse(body) {
      const uuid = typeof body.uuid === 'string' ? body.uuid.trim() : '';
      const direction = body.direction;
      if (!uuid) return { ok: false, error: 'uuid 必填' };
      if (direction !== 'before' && direction !== 'after') {
        return { ok: false, error: 'direction 必须是 before 或 after' };
      }
      const model = typeof body.model === 'string' ? body.model : '';
      return { ok: true, params: { uuid, direction, model } };
    },
    // 摘要只在明确请求 compact 时生成(预览阶段一次,存进预览项;提交复用同一份摘要,
    // 不接受客户端替换)。
    needsSummary: true,
    apply(raw, params, extra = {}) {
      const records = parseJsonl(raw);
      if (!records.some((o) => o?.uuid === params.uuid)) {
        return { ok: false, status: 404, code: SESSION_NOT_FOUND, error: '会话里找不到该锚点' };
      }
      const summary = extra.summary;
      if (!summary) {
        return { ok: false, status: 503, code: SESSION_OPERATION_TIMEOUT, error: '摘要未生成,请重新预览' };
      }
      const summaryContent = params.direction === 'before'
        ? `此前的对话内容已被压缩为以下摘要(原始记录保留在会话文件中,不再计入上下文):\n\n${summary}`
        : `以下是本会话中已被回退移除的一段后续对话的摘要,供参考:\n\n${summary}`;
      const result = compactSegmentJsonl(raw, params.uuid, params.direction, summaryContent);
      if (!result.ok) {
        return { ok: false, status: 400, code: SESSION_INVALID_INPUT, error: result.error || '该锚点不能作为压缩段边界' };
      }
      const anchorIdx = records.findIndex((o) => o?.uuid === params.uuid);
      return {
        ok: true,
        changed: true,
        newContent: normalized(result.lines.join('\n')),
        requiresNewSession: false,
        compatibility: 'compatible',
        affectedRange: params.direction === 'before'
          ? { kind: 'lines', fromLine: 0, toLine: anchorIdx }
          : { kind: 'lines', fromLine: anchorIdx, toLine: records.length },
        report: { op: 'compact-segment', direction: params.direction, anchorUuid: params.uuid },
      };
    },
  },

  'repair-official-compat': {
    anchorKind: () => 'none',
    parse() { return { ok: true, params: {} }; },
    apply(raw) {
      const { lines, report } = repairOfficialCompat(String(raw).split('\n'));
      const changed = !!(report.emptyText || report.emptyThinking || report.droppedLines || report.relinked);
      return {
        ok: true,
        changed,
        newContent: changed ? normalized(lines.join('\n')) : normalized(raw),
        requiresNewSession: false,
        // 只删空块/空行并重挂 parentUuid 链:保留的每条记录内容都逐字未改。
        compatibility: 'compatible',
        affectedRange: { kind: 'blocks', changedBlocks: (report.emptyText || 0) + (report.emptyThinking || 0), droppedLines: report.droppedLines || 0 },
        report,
      };
    },
  },
};

export const HISTORY_OP_NAMES = Object.keys(OPS);

/** 参数校验(纯函数,单测直 import;路由也用同一条路径,不给测试留"影子实现")。 */
export function parseHistoryParams(op, body = {}) {
  const def = OPS[op];
  if (!def) return { ok: false, error: '未知的历史操作' };
  return def.parse(body);
}

/** 变换计算(纯函数:原文进、新内容与报告出。不读盘、不写盘)。 */
export function applyHistoryOp(op, raw, params, extra = {}) {
  const def = OPS[op];
  if (!def) return { ok: false, status: 404, code: 'SESSION_NOT_FOUND', error: '未知的历史操作' };
  return def.apply(raw, params, extra);
}

/** 定位形态(预览配额分桶用)。 */
export function anchorKindOf(op, params) {
  const def = OPS[op];
  return def ? def.anchorKind(params) : 'none';
}

// ── 备份:不透明引用 + 在文件管理器中定位 ───────────────────────────────────
// backupRef 与原会话同权限,不是可跨项目读取的路径;副本正文不回传浏览器(见 GET 备份注释),
// 结果入口只在系统文件管理器里定位这份文件。备份文件不在本批清理。
const backups = new Map(); // ref -> { path, sid, projectHash, principal, at }

// ref 形态:`bk-<创建时刻 base36>-<随机令牌 96bit>`。时刻与令牌跟**文件名**同源(见
// writeHistoryBackup),所以服务端重启、登记表清空之后,单凭 ref 就能把路径推回来
// (recoverBackup)—— 不必让用户以为"备份被清理了"。令牌照旧是保密的那一半:光知道时刻
// 推不出文件名。
function makeBackupRef(ts) {
  return `bk-${ts.toString(36)}-${randomBytes(12).toString('hex')}`;
}

async function writeHistoryBackup(file, raw, meta) {
  const ts = Date.now();
  const token = randomBytes(12).toString('hex');
  const path = `${file}.histbak-${ts}-${token}`;
  await writeFile(path, raw, 'utf-8'); // 备份失败 → 调用方 500,原文件一个字都不动
  const ref = `bk-${ts.toString(36)}-${token}`;
  backups.set(ref, { path, at: ts, ...meta });
  return ref;
}

const BACKUP_REF_SHAPE = /^bk-([0-9a-z]+)-([0-9a-f]{24})$/;

/**
 * 登记表是纯内存的(不为重启后的展示另落一份盘:那会多一份要保证不腐坏的副本)。
 * 重启后备份文件还在原处(会话记录文件旁边),而 ref 里编着创建时刻与令牌 —— 拿它配上
 * 会话文件路径就能把登记**找回来**。
 *
 * 为什么"提交 ref 本身"就够授权:令牌是 96 bit 随机、只随创建那条响应发出去,文件名里
 * 也得有同一份令牌才推得出路径 —— 拿不出 ref 就没法枚举(时间戳单独不构成凭证)。
 * 主体身份在重启后无从恢复,按**出示 ref 者**记账(与"引用即能力令牌"同义)。
 *
 * @returns {{entry: null|object, reason: null|'unresolvable'|'file-missing'}}
 *   reason 只用于给出如实的 404 文案:`unresolvable` = ref 形态对不上(旧版建的备份),
 *   `file-missing` = 定位到了路径但文件确实不在磁盘上。
 */
async function recoverBackup(ref, sid, principal) {
  const m = BACKUP_REF_SHAPE.exec(String(ref || ''));
  if (!m) return { entry: null, reason: 'unresolvable' };
  const file = await findSessionFile(sid).catch(() => null);
  const path = file ? `${file}.histbak-${parseInt(m[1], 36)}-${m[2]}` : '';
  if (!path || !existsSync(path)) return { entry: null, reason: 'file-missing' };
  const entry = { path, at: parseInt(m[1], 36), sid, projectHash: basename(dirname(file)), principal };
  backups.set(ref, entry); // 本进程后续请求直接命中,不再走恢复
  return { entry, reason: null };
}

/** 找不到备份时的如实说明:别让用户以为文件被删了。 */
function backupMissingText(reason) {
  if (reason === 'file-missing') return '备份文件已不在磁盘上（已被删除或移走）';
  return '这次运行里没有这份备份的登记（服务端重启过就会这样）；备份文件本身没有被动过，它是与该会话记录同目录、文件名以 .histbak- 结尾的那份副本';
}

// ── 摘要生成(只服务于 compact-segment 预览)────────────────────────────────
function generateSegmentSummary(segment, model) {
  const transcript = renderSegmentTranscript(segment);
  if (!transcript.trim()) return Promise.resolve('');
  const prompt = `请把下面 <对话></对话> 标签内的一段开发对话压缩成一份信息保全的中文摘要。要求:\n- 保留:任务目标、关键决策与理由、涉及的文件路径与函数名、已完成/未完成事项、重要结论与数据、用户明确的要求与偏好。\n- 省略:寒暄、重复内容、工具调用的过程细节。\n- 用条目式陈述,直接输出摘要本身,不加任何前言或解释。\n\n<对话>\n${transcript}\n</对话>`;
  return new Promise((resolve) => {
    let proc;
    // 每次请求用唯一子目录(同 /chat/title):并发压缩共用固定 cwd 会互相污染。
    const compactCwd = join(tmpdir(), 'cgui-compact', `${process.pid}-${randomUUID()}`);
    const cleanup = () => { try { rmSync(compactCwd, { recursive: true, force: true }); } catch {} };
    try {
      const args = ['-p', '--permission-mode', 'plan', '--no-session-persistence'];
      if (model) args.push('--model', model);
      mkdirSync(compactCwd, { recursive: true }); // 必须同步建目录:spawn 的 cwd 不存在 = 首次必失败
      proc = claudeSpawn(args, { cwd: compactCwd, stdio: ['pipe', 'pipe', 'pipe'], env: cleanChildEnv() });
      proc.stdin.write(prompt); proc.stdin.end();
    } catch { cleanup(); return resolve(''); }
    if (!proc.pid) { cleanup(); return resolve(''); }
    proc.stderr?.resume(); // 不排空 stderr 超 64KB 会把子进程写死
    let out = '';
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      clearTimeout(timer);
      try { proc.kill('SIGKILL'); } catch {}
      cleanup();
      resolve(out.trim());
    };
    const timer = setTimeout(finish, 120_000);
    proc.stdout.on('data', (c) => { out += c.toString(); });
    proc.on('close', finish);
    proc.on('error', () => { if (!done) { done = true; clearTimeout(timer); cleanup(); resolve(''); } });
  });
}

// ── 预览 ───────────────────────────────────────────────────────────────────
async function createPreview({ op, sid, projectHash, principal, params }) {
  const def = OPS[op];
  const file = sessionFile(projectHash, sid);
  let raw;
  try { raw = await readFile(file, 'utf-8'); }
  catch { return { ok: false, status: 404, code: SESSION_NOT_FOUND, error: '会话不存在' }; }
  const extra = {};
  if (def.needsSummary) {
    const records = parseJsonl(raw);
    const anchorIdx = records.findIndex((o) => o?.uuid === params.uuid);
    const segment = params.direction === 'before' ? records.slice(0, anchorIdx) : records.slice(anchorIdx);
    const summary = await generateSegmentSummary(segment, safeModelArg(String(params.model || '').replace(/\[1m\]/i, '')));
    if (!summary || summary.length < 20 || /not logged in|please run|api key|unauthor|rate limit|error:|usage:/i.test(summary.slice(0, 200))) {
      // 摘要失败不是"会话问题",是依赖不可用:不写会话,明确让用户重试。
      return { ok: false, status: 503, code: 'SESSION_SUMMARY_UNAVAILABLE', error: '摘要生成失败(模型无输出或返回错误),会话未改动' };
    }
    extra.summary = summary;
  }
  // 先做纯计算(定位锚点/算变换):锚点不存在是 404,与"会话在跑"无关 —— 顺序反过来会把
  // "未知锚点"错报成 409 SESSION_RUNNING(同一次请求的两种拒绝理由,取更根本的那个)。
  const applied = applyHistoryOp(op, raw, params, extra);
  if (!applied.ok) return applied;
  if (isSessionRunning(sid)) {
    return { ok: false, status: 409, code: SESSION_RUNNING, error: '该会话有回合正在运行,请先停止再做历史操作' };
  }

  gcPreviews(Date.now());
  const now = Date.now();
  const token = `pv-${randomUUID().replace(/-/g, '')}`;
  const entry = {
    token,
    principal,
    sid,
    projectHash,
    op,
    anchorKind: anchorKindOf(op, params),
    params,
    extra,
    baseVersion: versionOf(raw),
    changed: applied.changed,
    report: applied.report,
    compatibility: applied.compatibility,
    affectedRange: applied.affectedRange,
    requiresNewSession: applied.requiresNewSession,
    createdAt: now,
    expiresAt: now + PREVIEW_TTL_MS,
    result: null,
    inFlight: null,
  };
  if (previewBucketCount(bucketOf(entry), now) >= PREVIEW_CAP) {
    return { ok: false, status: 503, code: SESSION_PREVIEW_BUSY, error: `待提交预览已达上限(${PREVIEW_CAP}),请先提交或等待预览过期` };
  }
  previews.set(token, entry);
  return {
    ok: true,
    preview: entry,
    payload: {
      ok: true,
      baseVersion: entry.baseVersion,
      previewToken: token,
      expiresAt: new Date(entry.expiresAt).toISOString(),
      changed: entry.changed,
      report: entry.report,
      compatibility: entry.compatibility,
      affectedRange: entry.affectedRange,
      requiresNewSession: entry.requiresNewSession,
      ...(extra.summary ? { summary: extra.summary } : {}),
    },
  };
}

// ── 提交 ───────────────────────────────────────────────────────────────────
// 同一会话文件的提交按会话串行,范围从第一次 stat 覆盖到 rename 落盘之后。不串行时两个不同预览
// 各自的双闸都可能在对方 rename 前放行:后写用变换前的原文覆盖前写,且双方都报成功。串行后排在
// 后面的那个在版本对比处自然拿到 409 SESSION_CHANGED。
// 这是独立于 writeJsonlAtomic 每文件写队列的另一条队列:锁内要调用它,共用同一条会自己等自己。
const submitQueues = new Map(); // 会话文件路径 → 队尾 Promise(永不 reject)
async function runSubmit(entry) {
  const file = sessionFile(entry.projectHash, entry.sid);
  const run = (submitQueues.get(file) || Promise.resolve()).then(() => runSubmitLocked(entry));
  const tail = run.catch(() => {}); // 前一个抛错不能把后面的永远卡住
  submitQueues.set(file, tail);
  tail.then(() => { if (submitQueues.get(file) === tail) submitQueues.delete(file); });
  return run;
}

async function runSubmitLocked(entry) {
  const { op, sid, projectHash, params } = entry;
  const def = OPS[op];
  const file = sessionFile(projectHash, sid);
  // 双闸之一:先拍 stat 基准再读文件(读期间有写入 → 后面的复查会发现,原文件不动)。
  let before;
  let raw;
  try {
    before = await stat(file);
    raw = await readFile(file, 'utf-8');
  } catch { return { ok: false, status: 404, code: SESSION_NOT_FOUND, error: '会话不存在' }; }
  // 提交前有新内容 → 409(旧预览不得再执行;不是"自动重做一次压缩/删除")。
  if (versionOf(raw) !== entry.baseVersion) {
    return { ok: false, status: 409, code: SESSION_CHANGED, error: '会话在预览后发生了变化,请重新预览再提交' };
  }
  if (isSessionRunning(sid)) {
    return { ok: false, status: 409, code: SESSION_RUNNING, error: '该会话有回合正在运行,请先停止再做历史操作' };
  }
  if (entry.compatibility !== 'compatible') {
    return {
      ok: false, status: 409, code: SESSION_COMPATIBILITY_UNVERIFIED,
      error: '该变换的签名兼容性无法验证,已拒绝改写(可保留原始继续,或用官方新会话入口)',
    };
  }

  // 关闭常驻空闲进程(原 trim/strip 同判据:它的内存上下文与改写后的 jsonl 已分叉)。
  // 【为什么这里要认下自己的写入】关闭动作会让 CLI 落一笔收尾记录 —— 旧顺序(先备份、
  // 出错前才关)把这一笔算进"会话刚有新活动",于是带常驻空闲 slot 的会话【第一次提交
  // 必败 SESSION_CHANGED、第二次才过】(第一次已经关掉了 slot,重试无 slot 可关)。
  // 真机实测 2026-09-11:提交前后文件 +553B、该会话 slot 由 idle 转 done、回退第一次
  // 点击即报"会话记录裁剪失败"。判定收窄到两条同时成立才吸收:①确实关掉了本会话的
  // 常驻空闲进程;②新内容是旧内容的【纯追加】(收尾记录只追加,不改写既有行)。
  const idleSlotsBefore = getActiveChatProcesses()
    .filter((p) => p.sessionId === sid && p.exitCode === null && p.idle).length;
  await closePersistentForSession(sid);
  let closedStat;
  try { closedStat = await stat(file); }
  catch { return { ok: false, status: 404, code: SESSION_NOT_FOUND, error: '会话不存在' }; }
  if (closedStat.mtimeMs !== before.mtimeMs || closedStat.size !== before.size) {
    let fresh = null;
    try { fresh = await readFile(file, 'utf-8'); } catch { fresh = null; }
    if (!closeWriteAbsorbable({ prevRaw: raw, freshRaw: fresh, idleSlotsClosed: idleSlotsBefore > 0 })) {
      return { ok: false, status: 409, code: SESSION_CHANGED, error: '会话刚有新活动,请重新预览再提交' };
    }
    raw = fresh;   // 基准内容换成关闭之后的内容:变换与备份都按它算
  }
  before = closedStat; // 双闸之二(以及 repair 分支的判据)以"关闭之后"那一刻为准

  const applied = applyHistoryOp(op, raw, params, entry.extra);
  if (!applied.ok) return applied;

  let backupRef;
  try {
    backupRef = await writeHistoryBackup(file, raw, { sid, projectHash, principal: entry.principal });
  } catch (e) {
    return { ok: false, status: 500, code: SESSION_BACKUP_FAILED, error: `备份失败,会话未改动:${e.message}` };
  }

  try {
    if (op === 'repair-official-compat') {
      // repair 沿用既有 repairSessionFileGuarded 的双闸语义(写前复查在跑进程 + mtime/size 判变);
      // 它的备份是 .bak-<ts>,这里把 backupRef 指到那份文件。
      const outcome = await repairSessionFileGuarded(file, () => isSessionRunning(sid));
      if (outcome.status === 'running') {
        return { ok: false, status: 409, code: SESSION_RUNNING, error: '该会话有回合正在运行,请先停止再做历史操作' };
      }
      if (outcome.status === 'stale') {
        return { ok: false, status: 409, code: SESSION_CHANGED, error: '会话刚有新活动,请重新预览再提交' };
      }
      const fresh = await readFile(file, 'utf-8');
      if (outcome.changed) broadcastSessionFileChange(file);
      return {
        ok: true,
        result: {
          ok: true,
          changed: outcome.changed,
          baseVersion: entry.baseVersion,
          resultVersion: versionOf(fresh),
          backupRef,
          resultSessionId: sid,
          report: outcome.report,
          compatibility: entry.compatibility,
        },
      };
    }
    // 双闸之二:备份写完、原子替换前复验文件没被写过(CLI 落盘延迟/新回合)。基准
    // `before` 是"关闭常驻进程之后"那一刻拍的,所以这条闸只反映第三方写入。
    const now = await stat(file);
    if (now.mtimeMs !== before.mtimeMs || now.size !== before.size) {
      return { ok: false, status: 409, code: SESSION_CHANGED, error: '会话刚有新活动,请重新预览再提交' };
    }
    await writeJsonlAtomic(file, applied.newContent);
    broadcastSessionFileChange(file);
    return {
      ok: true,
      result: {
        ok: true,
        changed: applied.changed,
        baseVersion: entry.baseVersion,
        resultVersion: versionOf(applied.newContent),
        backupRef,
        resultSessionId: applied.requiresNewSession ? null : sid,
        report: applied.report,
        compatibility: entry.compatibility,
      },
    };
  } catch (e) {
    return { ok: false, status: 500, code: 'SESSION_WRITE_FAILED', error: `改写失败,原会话可能未改动:${e.message}` };
  }
}

/** 提交入口:令牌/参数/版本/兼容性四道检查,同预览并发共用一次执行。 */
async function submitPreview({ op, sid, projectHash, principal, params, previewToken, baseVersion }) {
  const entry = previews.get(previewToken);
  const now = Date.now();
  if (!entry || entry.expiresAt <= now) {
    return { ok: false, status: 409, code: SESSION_PREVIEW_EXPIRED, error: '预览已失效(过期或服务已重启),请重新预览' };
  }
  if (entry.principal !== principal || entry.sid !== sid || entry.projectHash !== projectHash || entry.op !== op
    || JSON.stringify(entry.params) !== JSON.stringify(params)) {
    return { ok: false, status: 409, code: SESSION_OPERATION_CONFLICT, error: '提交参数与预览不一致,请重新预览' };
  }
  if (baseVersion !== undefined && String(baseVersion) !== entry.baseVersion) {
    return { ok: false, status: 409, code: SESSION_OPERATION_CONFLICT, error: 'baseVersion 与预览不一致,请重新预览' };
  }
  if (entry.result) return { ok: true, result: entry.result, replay: true };
  if (entry.inFlight) return await entry.inFlight; // 同预览并发:只写一次,另一个拿同一结果
  const run = (async () => {
    try { return await runSubmit(entry); } finally { entry.inFlight = null; }
  })();
  entry.inFlight = run;
  const outcome = await run;
  // 成功结果留到预览到期:同进程重放要回原结果(不二次写入)。
  if (outcome.ok) entry.result = outcome.result;
  return outcome;
}

// ── 路由 ───────────────────────────────────────────────────────────────────
function resolveOp(name) {
  return Object.prototype.hasOwnProperty.call(OPS, name) ? OPS[name] : null;
}

async function handleHistoryOp(req, res, opName, dryRunFlag) {
  const def = resolveOp(opName);
  if (!def) return fail(res, 404, SESSION_NOT_FOUND, '未知的历史操作');
  const body = req.body || {};
  const sid = req.params.sessionId;
  const projectHash = typeof body.projectHash === 'string' ? body.projectHash.trim() : '';
  // 非法身份/参数一律 400(先验身份,再验 dryRun 与业务参数 —— 缺 dryRun 绝不落进执行分支)。
  if (!safeId(sid) || !safeId(projectHash) || !projectHash) {
    return fail(res, 400, SESSION_INVALID_INPUT, 'projectHash 与 sessionId 必填且必须是合法标识');
  }
  const dryRun = body.dryRun;
  if (typeof dryRun !== 'boolean') {
    return fail(res, 400, SESSION_INVALID_INPUT, 'dryRun 必须是布尔值(true=只预览,false=提交)');
  }
  const parsed = parseHistoryParams(opName, body);
  if (!parsed.ok) return fail(res, 400, SESSION_INVALID_INPUT, parsed.error);
  const principal = principalOf(req);

  if (dryRun) {
    if (dryRunFlag === 'get') return fail(res, 400, SESSION_INVALID_INPUT, 'dryRun 预览必须用 POST 提交参数');
    const out = await createPreview({ op: opName, sid, projectHash, principal, params: parsed.params });
    if (!out.ok) return fail(res, out.status, out.code, out.error);
    return res.json(out.payload);
  }
  if (typeof body.previewToken !== 'string' || !body.previewToken) {
    return fail(res, 400, SESSION_INVALID_INPUT, '提交需要 previewToken(先用 dryRun:true 预览)');
  }
  if (body.baseVersion === undefined || body.baseVersion === null || body.baseVersion === '') {
    return fail(res, 400, SESSION_INVALID_INPUT, '提交需要 baseVersion(取预览响应里的值)');
  }
  const out = await submitPreview({
    op: opName, sid, projectHash, principal, params: parsed.params,
    previewToken: body.previewToken, baseVersion: body.baseVersion,
  });
  if (!out.ok) return fail(res, out.status, out.code, out.error);
  return res.json(out.result);
}

// 五个历史操作统一入口。实际提交一律 POST + dryRun:false。
for (const opName of HISTORY_OP_NAMES) {
  router.post(`/sessions/:sessionId/${opName}`, async (req, res) => {
    try {
      await handleHistoryOp(req, res, opName, 'post');
    } catch (err) {
      fail(res, 500, 'SESSION_OPERATION_FAILED', `历史操作失败:${err.message}`);
    }
  });
}

/**
 * GET /api/sessions/:sessionId/repair-official-compat?projectHash=... — 只读体检。
 * 200 {changed,report,compatibility};不关进程、不生成摘要、不写备份。
 * projectHash 可省(旧调用点按 sid 反查项目目录),给了就必须合法。
 */
router.get('/sessions/:sessionId/repair-official-compat', async (req, res) => {
  try {
    const sid = req.params.sessionId;
    if (!safeId(sid)) return fail(res, 400, SESSION_INVALID_INPUT, 'sessionId 非法');
    const projectHash = req.query.projectHash;
    if (projectHash !== undefined && !safeId(String(projectHash))) {
      return fail(res, 400, SESSION_INVALID_INPUT, 'projectHash 非法');
    }
    const file = projectHash ? sessionFile(String(projectHash), sid) : await findSessionFile(sid);
    if (!file) return fail(res, 404, SESSION_NOT_FOUND, '会话不存在');
    let raw;
    try { raw = await readFile(file, 'utf-8'); }
    catch { return fail(res, 404, SESSION_NOT_FOUND, '会话不存在'); }
    const { report } = repairOfficialCompat(String(raw).split('\n'));
    const changed = !!(report.emptyText || report.emptyThinking || report.droppedLines || report.relinked);
    // wouldChange 是旧前端的兼容字段(与 changed 同义),新前端读 changed/compatibility。
    res.json({ ok: true, changed, report, compatibility: 'compatible', wouldChange: changed });
  } catch (err) {
    fail(res, 500, 'SESSION_OPERATION_FAILED', `体检失败:${err.message}`);
  }
});

/**
 * GET /api/sessions/:sessionId/backups/:backupRef — 历史操作备份副本的**元数据**,只读。
 *
 * 【为什么不再回正文(V0.2.x 实修)】旧实现把整份副本原文当 content 字段回,前端塞进 <pre>
 * —— 16.9MB 会话实测:接口 54ms 出 17.8MB payload,前端 JSON.parse 51ms,<pre> 排版 11.9s、
 * 界面 38.1s 对任何操作没应答(正文 347 万 px 高)。副本本身有价值(读文件管理器里的真文件即可),
 * 但"把整份原文送进浏览器"这条路径没有任何用户价值 → 砍掉。正文一律不进 HTTP 响应。
 * 无恢复/覆盖副作用;越权 403,对象不存在 404。
 */
router.get('/sessions/:sessionId/backups/:backupRef', async (req, res) => {
  try {
    const sid = req.params.sessionId;
    const backupRef = req.params.backupRef;
    if (!safeId(sid) || !/^[A-Za-z0-9_-]{1,128}$/.test(backupRef)) {
      return fail(res, 400, SESSION_INVALID_INPUT, '备份引用非法');
    }
    let entry = backups.get(backupRef);
    let missReason = null;
    // 登记表没有 → 服务端重启过而已(文件还在磁盘上),按 ref 把登记找回来再走正常路径。
    if (!entry) ({ entry, reason: missReason } = await recoverBackup(backupRef, sid, principalOf(req)));
    // 越权与不存在分开:对象在,但不是本主体的 → 403(与 404 不同,便于诊断)。
    if (entry && entry.principal !== principalOf(req)) {
      return fail(res, 403, 'SESSION_FORBIDDEN', '无权读取该备份');
    }
    if (!entry || entry.sid !== sid) return fail(res, 404, SESSION_NOT_FOUND, backupMissingText(missReason));
    let bytes;
    try { bytes = (await stat(entry.path)).size; }
    catch { return fail(res, 404, SESSION_NOT_FOUND, backupMissingText('file-missing')); }
    res.json({
      ok: true,
      backupRef,
      sessionId: sid,
      projectHash: entry.projectHash,
      createdAt: new Date(entry.at).toISOString(),
      bytes,
      // 只给展示用文件名,不给完整路径:前端拿不到服务器目录结构,路径一律由服务端自持。
      fileName: basename(entry.path),
    });
  } catch (err) {
    fail(res, 500, 'SESSION_OPERATION_FAILED', `备份读取失败:${err.message}`);
  }
});

/**
 * POST /api/sessions/:sessionId/backups/:backupRef/reveal — 在系统文件管理器中定位备份文件。
 * 路径**只**从服务端备份登记表(backups.get(ref))取,不接受客户端传的任何路径(防路径穿越);
 * 重启后登记表是空的 → 先按 ref 恢复(见 recoverBackup,路径仍由服务端自己推),不报"不存在";
 * 身份口径与 GET 备份一致(越权 403、对象不存在 404)。
 * mac `open -R` 高亮该文件,win `explorer /select,`(成功也常以非零退出码结束,不当失败
 * —— memory Win 三坑),其余平台 xdg-open 打开所在目录。数组传参不拼命令串。
 * 远程/手机访问时作用在服务器本机(与 /settings/reveal、/reveal-path 同预期)。
 */
router.post('/sessions/:sessionId/backups/:backupRef/reveal', async (req, res) => {
  try {
    const sid = req.params.sessionId;
    const backupRef = req.params.backupRef;
    if (!safeId(sid) || !/^[A-Za-z0-9_-]{1,128}$/.test(backupRef)) {
      return fail(res, 400, SESSION_INVALID_INPUT, '备份引用非法');
    }
    let entry = backups.get(backupRef);
    let missReason = null;
    // 同 GET:重启后登记表是空的,但备份文件还在磁盘上 → 按 ref 恢复登记,别报成"不存在"。
    if (!entry) ({ entry, reason: missReason } = await recoverBackup(backupRef, sid, principalOf(req)));
    if (entry && entry.principal !== principalOf(req)) {
      return fail(res, 403, 'SESSION_FORBIDDEN', '无权访问该备份');
    }
    if (!entry || entry.sid !== sid) return fail(res, 404, SESSION_NOT_FOUND, backupMissingText(missReason));
    if (!existsSync(entry.path)) return fail(res, 404, SESSION_NOT_FOUND, backupMissingText('file-missing'));
    let cmd, args;
    if (process.platform === 'darwin') { cmd = 'open'; args = ['-R', entry.path]; }
    else if (process.platform === 'win32') { cmd = 'explorer'; args = [`/select,${entry.path}`]; }
    else { cmd = 'xdg-open'; args = [dirname(entry.path)]; }
    try {
      await execFileP(cmd, args, { timeout: 10000 });
    } catch (err) {
      // explorer.exe 成功打开也常以非零退出码结束,Win 下不当失败(同 /settings/reveal)。
      if (process.platform !== 'win32') throw err;
    }
    res.json({ ok: true });
  } catch (err) {
    fail(res, 500, 'SESSION_OPERATION_FAILED', `打开备份位置失败:${err.message}`);
  }
});

// 单测用:备份写入 + 重启后的登记恢复 + 404 文案。三者的耦合点就是 ref 形态(时刻+令牌),
// 拆开测不出「ref 与文件名同源」这条不变量 —— 它一旦走散,重启后就再也找不回备份。
export { writeHistoryBackup as __writeHistoryBackup, recoverBackup as __recoverBackup, backupMissingText as __backupMissingText };

// 单测用:清空预览/备份登记表(不导出给产品路径)。
export function __resetHistoryStores() {
  previews.clear();
  backups.clear();
}

export default router;
