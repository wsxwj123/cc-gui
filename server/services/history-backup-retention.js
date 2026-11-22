// r209:会话记录备份(.histbak 等)的保留规则。
//
// 【管什么】历史操作(回退、压缩片段、体检与清理、去掉思考块)改写会话记录之前,会在同目录整份复制一份。
// 这里集中放:文件名解析、工作区目录核验、归属判定、保留规则(纯函数)、执行删除、「会话忙」登记、
// 自动清理排程与「连续两轮」记忆、设置页列表与删除。对外约定见 .devflow/INTERFACE-r209-histbak-retention.md
// (下面注释里的「3.x」都指它的小节)。
//
// 【为什么每个会动磁盘的入口都要调用方显式传根目录】这里的代码会真的删用户的文件。不设默认值、import 时
// 没有任何副作用:单测或脚本漏传根目录时直接报错,而不是静默落到真实的 ~/.claude/projects。
//
// 【只删什么】四种整串锚定、大小写敏感的文件名(parseBackupName),只在过了三条核验的工作区目录第一层
// (isWorkspaceDir),且 lstat 为普通文件(不跟随软链接)。会话记录本身、名字差一点的、子目录、软链接一律不碰。
// 日志只记计数、errno 代码与会话编号前 8 位,不记路径与文件内容(fs 错误的 message 里带路径,不打 message)。
import { readdir, lstat, realpath, unlink, open } from 'fs/promises';
import { join, isAbsolute } from 'path';
import { SESSION_ID_SHAPE } from './session-reader.js';

export const HISTBAK_MAX_AGE_MS = 14 * 24 * 3600 * 1000; // 1209600000
export const HISTBAK_MAX_PER_SESSION = 3;
const MAX_TIMER_MS = 2147483647; // setTimeout / setInterval 的上限:超过会被 Node 当成 1 毫秒反复触发
const DIR_PAUSE_MS = 50;         // 自动清理每处理完一个工作区目录歇一下,首次启动删十几 GB 时不挤占其他请求
const TITLE_HEAD_BYTES = 8192;
const NUL = String.fromCharCode(0);

// ── 文件名 ─────────────────────────────────────────────────────────────────
// SID 与 session-reader 的 SESSION_ID_SHAPE 同一判据(单测钉住两者一致);TS 恰好 13 位、首位非 0
// (Date.now() 在 2001–2286 年间就是这个形态);令牌 24 位小写十六进制。
export const SID_PATTERN = '[0-9a-fA-F-]{36}';
const TS_PATTERN = '[1-9][0-9]{12}';
const NAME_FORMS = [
  ['histbak', new RegExp(`^(${SID_PATTERN})\\.jsonl\\.histbak-(${TS_PATTERN})-[0-9a-f]{24}$`)],
  ['histbak-legacy', new RegExp(`^(${SID_PATTERN})\\.jsonl\\.histbak-(${TS_PATTERN})$`)],
  ['bak-ts', new RegExp(`^(${SID_PATTERN})\\.jsonl\\.bak-(${TS_PATTERN})$`)],
  ['bak-plain', new RegExp(`^(${SID_PATTERN})\\.jsonl\\.bak$`)],
];

/**
 * 3.0 的四种备份文件名。返回 null(不是备份)或 { sid, form, ts, auto }:
 * ts 为名里的毫秒时刻(`.jsonl.bak` 没有,为 null,创建时刻改用 lstat 的修改时间);
 * auto=false 只有 `.jsonl.bak`:它不参与自动清理与删除会话连带,只在设置页手动删。
 */
export function parseBackupName(name) {
  if (typeof name !== 'string') return null;
  for (const [form, re] of NAME_FORMS) {
    const m = re.exec(name);
    if (m) return { sid: m[1], form, ts: m[2] === undefined ? null : Number(m[2]), auto: form !== 'bak-plain' };
  }
  return null;
}

/** 3.0 的组内排序:创建时刻从新到旧,相同按文件名字典序从大到小(按码元比较,与区域设置无关)。 */
export function newestFirst(a, b) {
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  return a.name < b.name ? 1 : a.name > b.name ? -1 : 0;
}

/**
 * present 组的保留规则(纯函数)。files:[{ name, auto, createdAt }],只含创建时刻 ≤ now 的;
 * protectName:历史操作刚写的那份 —— 无条件保留、排最前、固定占一个名额(即使它没出现在 files 里)。
 * `.jsonl.bak`(auto=false)不计入名额、不按天数删,既不在 keep 也不在 remove 里。
 */
export function planPresentGroup(files, now, protectName = null) {
  const keep = [];
  const remove = [];
  const fresh = [];
  for (const f of files) {
    if (!f.auto) continue;
    if (protectName && f.name === protectName) keep.push(f);
    else if (now - f.createdAt >= HISTBAK_MAX_AGE_MS) remove.push(f);
    else fresh.push(f);
  }
  fresh.sort(newestFirst);
  const slots = HISTBAK_MAX_PER_SESSION - (protectName ? 1 : 0);
  keep.push(...fresh.slice(0, slots));
  remove.push(...fresh.slice(slots));
  return { keep, remove };
}

// ── 环境变量(3.1;只在开始监听时读一次)──────────────────────────────────
function msOr(raw, min, fallback) {
  const s = raw == null ? '' : String(raw).trim();
  if (s === '') return fallback;
  const n = Number(s);
  return Number.isFinite(n) && n >= min && n <= MAX_TIMER_MS ? n : fallback;
}

export function historyBackupSweepPlan(env = {}) {
  return {
    delayMs: msOr(env.CGUI_HISTBAK_SWEEP_DELAY_MS, 0, 60_000),
    intervalMs: msOr(env.CGUI_HISTBAK_SWEEP_INTERVAL_MS, 1000, 3_600_000),
  };
}

// ── 会话忙 ─────────────────────────────────────────────────────────────────
// 从开始写历史操作备份到该次提交收尾结束。按会话编号计数(同一会话编号理论上可能同时在两个目录各有一次
// 提交);键统一小写,大小写不敏感的文件系统上大小写不同的写法也当同一个会话,只会多跳过、不会多删。
const busyCounts = new Map();

/** 登记会话忙,返回解除函数(重复调用只解除一次)。调用方必须在 finally 里解除。 */
export function markSessionBusy(sid) {
  const key = String(sid ?? '').toLowerCase();
  busyCounts.set(key, (busyCounts.get(key) || 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (busyCounts.get(key) || 0) - 1;
    if (left > 0) busyCounts.set(key, left);
    else busyCounts.delete(key);
  };
}

/** ownHolds:调用方自己持有的登记数(提交自己的收尾传 1,不被自己挡住)。 */
export function isSessionBusy(sid, ownHolds = 0) {
  return (busyCounts.get(String(sid ?? '').toLowerCase()) || 0) > ownHolds;
}

// ── 小工具 ─────────────────────────────────────────────────────────────────
function requireRoot(root) {
  if (typeof root !== 'string' || root === '' || !isAbsolute(root)) {
    throw new TypeError('history-backup-retention: 必须显式传入会话记录根目录(绝对路径)');
  }
}

const errCode = (e) => String(e?.code || e?.name || 'Error').slice(0, 40).replace(/[^A-Za-z0-9_-]/g, '?');
const sid8 = (sid) => String(sid ?? '').slice(0, 8).replace(/[^A-Za-z0-9_-]/g, '?') || '-';
const isAbsent = (e) => e?.code === 'ENOENT' || e?.code === 'ENOTDIR';
const pause = () => new Promise((resolve) => { setTimeout(resolve, DIR_PAUSE_MS); });

function newTally() {
  return {
    deleted: 0, freedBytes: 0, failed: 0, skippedBusy: 0, skippedUnknown: 0, skippedDirs: 0,
    unknownGroups: 0, pendingGone: 0, failCodes: new Map(),
  };
}

function noteFailure(t, code) {
  t.failed += 1;
  t.failCodes.set(code, (t.failCodes.get(code) || 0) + 1);
}

// 名字像备份、但 lstat 失败(ENOENT 以外)的文件:确认不了是不是普通文件,不删,在删除入口里算作删不掉的。
function countStatFailures(t, group, includePlain) {
  for (const s of group.statFailures) if (s.auto || includePlain) noteFailure(t, s.code);
}

/** 删一份。查会话忙与发起 unlink 之间没有 await:Node 单线程,中间插不进别的 JS。 */
async function removeBackup(dirPath, file, sid, t, ownHolds = 0) {
  if (isSessionBusy(sid, ownHolds)) { t.skippedBusy += 1; return; }
  try {
    await unlink(join(dirPath, file.name));
    t.deleted += 1;
    t.freedBytes += file.size;
  } catch (e) {
    if (e?.code !== 'ENOENT') noteFailure(t, errCode(e)); // 已不在:既不算删除也不算失败;其余只计数,不重试、不改属性
  }
}

/** R 的第一层与 realpath(R)。R 不存在 → null(按 0 个工作区目录处理);其余错误抛出(按「R 读不了」处理)。 */
async function readRoot(root) {
  try {
    const names = await readdir(root);
    return { names, realRoot: await realpath(root) };
  } catch (e) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * 3.0 工作区目录三条:名字不以点开头;lstat 是目录(不是软链接);realpath 逐字等于 realpath(R) 拼上名字。
 * 第三条挡住 Windows 目录联接、挂载点等任何重定向,不依赖 Dirent 怎么报联接;大小写不敏感的文件系统上
 * 大小写写法不同的名字也过不了(realpath 给的是磁盘上的写法)。
 */
async function isWorkspaceDir(root, realRoot, name) {
  if (typeof name !== 'string' || name === '' || name.startsWith('.')) return false;
  const p = join(root, name);
  try {
    if (!(await lstat(p)).isDirectory()) return false;
    return (await realpath(p)) === join(realRoot, name);
  } catch {
    return false;
  }
}

/**
 * 列一个工作区目录第一层的备份文件,按文件名里的会话编号分组:Map<sid, { files, statFailures }>。
 * 只收名字匹配、lstat 为普通文件、创建时刻 ≤ now 的(晚于 now 的:扫描开始后才写的、正在写的、时钟回拨或
 * 人造的未来时刻,一律不当备份)。列目录失败直接抛出,调用方计入「目录读取失败」。
 */
async function scanDir(dirPath, now) {
  const names = await readdir(dirPath);
  const groups = new Map();
  const groupOf = (sid) => {
    let g = groups.get(sid);
    if (!g) { g = { files: [], statFailures: [] }; groups.set(sid, g); }
    return g;
  };
  for (const name of names) {
    const parsed = parseBackupName(name);
    if (!parsed) continue;
    let st;
    try {
      st = await lstat(join(dirPath, name));
    } catch (e) {
      if (e?.code !== 'ENOENT') groupOf(parsed.sid).statFailures.push({ code: errCode(e), auto: parsed.auto });
      continue;
    }
    if (!st.isFile()) continue;
    const createdAt = parsed.ts ?? Math.floor(st.mtimeMs);
    if (createdAt > now) continue;
    groupOf(parsed.sid).files.push({ name, auto: parsed.auto, createdAt, size: st.size });
  }
  return groups;
}

/**
 * 3.0 的归属:'present' | 'gone' | 'elsewhere' | 'unknown'。走文件系统判定(lstat),不拿列举出的名字比对 ——
 * macOS / Windows 默认大小写不敏感,名字比对会把活会话判成已删。只把 ENOENT / ENOTDIR 当「不在」。
 * rootNames:R 第一层条目名(含不是工作区目录的);传 null 时用到才去列。
 */
async function attributionOf(root, rootNames, dirName, sid) {
  try {
    const st = await lstat(join(root, dirName, `${sid}.jsonl`));
    // 会话记录本身是软链接:它可能正指向同组某份备份,按规则删就删掉了真数据 —— 整组不动
    return st.isSymbolicLink() ? 'unknown' : 'present';
  } catch (e) {
    if (!isAbsent(e)) return 'unknown';
  }
  let names = rootNames;
  if (!names) {
    try { names = await readdir(root); } catch { return 'unknown'; }
  }
  let uncertain = false;
  for (const other of names) {
    if (other === dirName) continue;
    try {
      await lstat(join(root, other, `${sid}.jsonl`));
      return 'elsewhere';
    } catch (e) {
      if (!isAbsent(e)) uncertain = true;
    }
  }
  return uncertain ? 'unknown' : 'gone';
}

// ── 自动清理(3.1)─────────────────────────────────────────────────────────
function sweepLine(kind, dirCount, t, elapsedMs) {
  let line = `[histbak] 清理完成(${kind === 'startup' ? '启动' : '定时'}): 工作区目录 ${dirCount} 个, `
    + `删除 ${t.deleted} 份共 ${t.freedBytes} 字节, 失败 ${t.failed} 份, 占用跳过 ${t.skippedBusy} 份, `
    + `归属不明 ${t.unknownGroups} 组, 待确认已删 ${t.pendingGone} 组, 目录读取失败 ${t.skippedDirs} 个, 耗时 ${elapsedMs} ms`;
  if (t.failed > 0) line += ` (失败原因 ${[...t.failCodes].map(([code, n]) => `${code}×${n}`).join(' ')})`;
  return line;
}

/**
 * 跑一轮自动清理。goneMemory:排程持有的 Set(键 = 目录名/会话编号),进来时是「上一轮判为 gone 的组」,
 * 跑完换成本轮的 —— gone 组连续两轮都判到才删。kind:'startup' | 'interval'(只影响日志)。
 * 整轮吞错不抛:R 读不了打「清理失败」一行、清空记忆(连续两轮从头算,只会少删),返回 null;否则返回计数。
 */
export async function runHistoryBackupSweep(root, goneMemory, kind) {
  requireRoot(root);
  const startedAt = Date.now();
  const now = startedAt;
  const t = newTally();
  let dirCount = 0;
  try {
    const top = await readRoot(root);
    const goneThisRound = new Set();
    for (const dirName of top ? top.names : []) {
      if (!(await isWorkspaceDir(root, top.realRoot, dirName))) continue;
      dirCount += 1;
      const dirPath = join(root, dirName);
      let groups;
      try {
        groups = await scanDir(dirPath, now);
      } catch {
        t.skippedDirs += 1;
        await pause();
        continue;
      }
      for (const [sid, g] of groups) {
        const auto = g.files.filter((f) => f.auto);
        if (auto.length === 0 && !g.statFailures.some((s) => s.auto)) continue; // 只有 .jsonl.bak:自动清理不管
        const state = await attributionOf(root, top.names, dirName, sid);
        if (state === 'present') {
          countStatFailures(t, g, false);
          for (const f of planPresentGroup(g.files, now).remove) await removeBackup(dirPath, f, sid, t);
        } else if (state === 'gone') {
          const key = `${dirName}/${sid}`;
          goneThisRound.add(key);
          if (goneMemory.has(key)) {
            countStatFailures(t, g, false);
            for (const f of auto) await removeBackup(dirPath, f, sid, t);
          } else {
            t.pendingGone += 1;
          }
        } else if (state === 'unknown') {
          t.unknownGroups += 1;
        }
        // elsewhere:自动清理不动,设置页列出、由用户删
      }
      await pause();
    }
    goneMemory.clear();
    for (const key of goneThisRound) goneMemory.add(key);
  } catch (e) {
    goneMemory.clear();
    console.error(`[histbak] 清理失败(已忽略,不影响服务): ${errCode(e)}`);
    return null;
  }
  console.log(sweepLine(kind, dirCount, t, Date.now() - startedAt));
  return { ...t, dirCount };
}

/**
 * 排程:开始监听后 delayMs 跑首轮,首轮结束后再过 delayMs 跑第二轮(专为 gone 组「连续两轮」;第二轮若要等
 * 一个完整间隔,每次只开不到 1 小时的用户就永远删不掉已删会话的备份),之后每 intervalMs 一轮。
 * 上一轮没跑完时到点的那一轮直接跳过。定时器全部 unref,不拖住进程退出。返回 { stop() }。
 */
export function scheduleHistoryBackupSweeps(root, plan) {
  requireRoot(root);
  const delayMs = msOr(plan?.delayMs, 0, 60_000);
  const intervalMs = msOr(plan?.intervalMs, 1, 3_600_000);
  const goneMemory = new Set();
  let running = false;
  let stopped = false;
  let timer = null;
  let ticker = null;
  const round = async (kind) => {
    if (running || stopped) return;
    running = true;
    try { await runHistoryBackupSweep(root, goneMemory, kind); } catch { /* 已在内部打过日志 */ } finally { running = false; }
  };
  const later = (fn, ms) => { timer = setTimeout(fn, ms); timer.unref?.(); };
  later(async () => {
    await round('startup');
    if (stopped) return;
    later(async () => {
      await round('interval');
      if (stopped) return;
      ticker = setInterval(() => { round('interval'); }, intervalMs);
      ticker.unref?.();
    }, delayMs);
  }, delayMs);
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      clearInterval(ticker);
    },
  };
}

// ── 历史操作之后(3.2)───────────────────────────────────────────────────
function afterOpLine(sid, dropOwn, t) {
  return `[histbak] 历史操作后清理(${dropOwn ? '删本次' : '按规则'}) sid=${sid8(sid)}: 删除 ${t.deleted} 份, `
    + `失败 ${t.failed} 份, 归属不明 ${t.unknownGroups} 组, 目录读取失败 ${t.skippedDirs} 个`;
}
const logAfterOp = (sid, dropOwn, t) => {
  if (t.deleted || t.failed || t.unknownGroups || t.skippedDirs) console.log(afterOpLine(sid, dropOwn, t));
};

/**
 * 提交写备份之后、返回响应之前的收尾(调用方此时已登记该会话忙)。
 * dropOwn=true:改写前就失败、会话记录确定没被改写 —— 只删本次那份,同组别的不动。
 * dropOwn=false(成功,或改写可能已发生的失败):按 present 规则清理同组,本次那份无条件保留。
 * 只动这个目录里这个会话的组;吞掉一切错误,永不抛。
 */
export async function cleanupAfterHistoryOp(root, { projectHash, sid, ownName, dropOwn }) {
  try {
    requireRoot(root);
    const t = newTally();
    if (await isWorkspaceDir(root, await realpath(root), projectHash)) {
      const dirPath = join(root, projectHash);
      if (dropOwn) {
        const parsed = parseBackupName(ownName);
        if (parsed && parsed.sid === sid) {
          let st = null;
          try { st = await lstat(join(dirPath, ownName)); } catch (e) { if (e?.code !== 'ENOENT') noteFailure(t, errCode(e)); }
          if (st?.isFile()) await removeBackup(dirPath, { name: ownName, size: st.size }, sid, t, Infinity);
        }
      } else {
        const now = Date.now();
        let groups = null;
        try { groups = await scanDir(dirPath, now); } catch { t.skippedDirs += 1; }
        const g = groups?.get(sid);
        if (g && (g.files.some((f) => f.auto) || g.statFailures.some((s) => s.auto))) {
          const state = await attributionOf(root, null, projectHash, sid);
          if (state === 'present') {
            countStatFailures(t, g, false);
            for (const f of planPresentGroup(g.files, now, ownName).remove) await removeBackup(dirPath, f, sid, t, 1);
          } else if (state === 'unknown') {
            t.unknownGroups += 1;
          }
        }
      }
    }
    logAfterOp(sid, dropOwn, t);
  } catch (e) {
    console.error(`[histbak] 历史操作后清理出错(已忽略) sid=${sid8(sid)}: ${errCode(e)}`);
  }
}

/**
 * 写备份本身失败时删掉写了一半的那份(writeHistoryBackup 调用;filePath 是这次调用自己刚建的文件,
 * 名字里带新生成的随机令牌)。不在 / 根本没建出来(ENOENT)不算删除也不算失败。永不抛。
 */
export async function discardPartialBackup(filePath, sid) {
  const t = newTally();
  try {
    await unlink(filePath);
    t.deleted = 1;
  } catch (e) {
    if (e?.code !== 'ENOENT') noteFailure(t, errCode(e));
  }
  logAfterOp(sid, true, t);
}

// ── 删除会话时(3.3)─────────────────────────────────────────────────────
/**
 * 会话记录删除成功后:只看这个目录、不做归属判定,删这个会话三种参与形态的备份(不论新旧);会话忙的跳过;
 * `.jsonl.bak` 不删。吞掉一切错误,永不抛。
 */
export async function dropSessionBackups(root, projectHash, sid) {
  try {
    requireRoot(root);
    const t = newTally();
    if (await isWorkspaceDir(root, await realpath(root), projectHash)) {
      const dirPath = join(root, projectHash);
      let groups = null;
      try { groups = await scanDir(dirPath, Date.now()); } catch { t.skippedDirs += 1; }
      const g = groups?.get(sid);
      if (g) {
        countStatFailures(t, g, false);
        for (const f of g.files) if (f.auto) await removeBackup(dirPath, f, sid, t);
      }
    }
    if (t.deleted || t.failed || t.skippedBusy || t.skippedDirs) {
      console.log(`[histbak] 删除会话时清理 sid=${sid8(sid)}: 删除 ${t.deleted} 份, 失败 ${t.failed} 份, `
        + `占用跳过 ${t.skippedBusy} 份, 目录读取失败 ${t.skippedDirs} 个`);
    }
  } catch (e) {
    console.error(`[histbak] 删除会话时清理出错(已忽略) sid=${sid8(sid)}: ${errCode(e)}`);
  }
}

// ── 设置页(3.4、3.5)───────────────────────────────────────────────────
/** 标题:文件开头 8192 字节内、前 50 行里第一条有文本的 user 记录,截前 80 个字符;取不到为空串。 */
async function readTitle(filePath) {
  let fh = null;
  try {
    fh = await open(filePath, 'r');
    const buf = Buffer.alloc(TITLE_HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, TITLE_HEAD_BYTES, 0);
    const lines = buf.subarray(0, bytesRead).toString('utf-8').split('\n').slice(0, 50);
    for (const ln of lines) {
      if (!ln.trim()) continue;
      let obj;
      try { obj = JSON.parse(ln); } catch { continue; }
      if (obj?.type !== 'user' || !obj.message?.content) continue;
      const c = obj.message.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.find((x) => x?.type === 'text')?.text : '';
      if (typeof text === 'string' && text) return Array.from(text).slice(0, 80).join('');
    }
  } catch {
    // 读不了就没有标题
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
  return '';
}

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** GET /api/history-backups 的活。返回 { status, body }。 */
export async function listHistoryBackups(root) {
  requireRoot(root);
  const now = Date.now();
  let top;
  try {
    top = await readRoot(root);
  } catch (e) {
    return { status: 500, body: { ok: false, code: 'HISTBAK_LIST_FAILED', error: `读取会话记录目录失败(${errCode(e)})` } };
  }
  const sessions = [];
  let totalCount = 0;
  let totalBytes = 0;
  let skippedUnknown = 0;
  let skippedDirs = 0;
  for (const dirName of top ? top.names : []) {
    if (!(await isWorkspaceDir(root, top.realRoot, dirName))) continue;
    const dirPath = join(root, dirName);
    let groups;
    try { groups = await scanDir(dirPath, now); } catch { skippedDirs += 1; continue; }
    for (const [sid, g] of groups) {
      if (g.files.length === 0) continue;
      const state = await attributionOf(root, top.names, dirName, sid);
      if (state === 'unknown') { skippedUnknown += g.files.length; continue; }
      const sorted = [...g.files].sort(newestFirst);
      const bytes = sorted.reduce((sum, f) => sum + f.size, 0);
      sessions.push({
        projectHash: dirName,
        sessionId: sid,
        state,
        title: await readTitle(join(dirPath, sorted[0].name)),
        count: sorted.length,
        bytes,
        oldestAt: sorted[sorted.length - 1].createdAt,
        newestAt: sorted[0].createdAt,
      });
      totalCount += sorted.length;
      totalBytes += bytes;
    }
  }
  sessions.sort((a, b) => (b.bytes - a.bytes) || (b.newestAt - a.newestAt)
    || cmpStr(a.projectHash, b.projectHash) || cmpStr(a.sessionId, b.sessionId));
  return {
    status: 200,
    body: {
      ok: true, totalCount, totalBytes, skippedUnknown, skippedDirs,
      rules: { maxAgeDays: HISTBAK_MAX_AGE_MS / 86_400_000, maxPerSession: HISTBAK_MAX_PER_SESSION },
      sessions,
    },
  };
}

function deleteBody(t) {
  return {
    ok: true, deleted: t.deleted, freedBytes: t.freedBytes, failed: t.failed,
    skippedBusy: t.skippedBusy, skippedUnknown: t.skippedUnknown, skippedDirs: t.skippedDirs,
  };
}

function logSettings(scope, t) {
  console.log(`[histbak] 设置页清理(${scope}): 删除 ${t.deleted} 份共 ${t.freedBytes} 字节, 失败 ${t.failed} 份, `
    + `占用跳过 ${t.skippedBusy} 份, 归属不明 ${t.skippedUnknown} 份, 目录读取失败 ${t.skippedDirs} 个`);
}

// 设置页删一组:归属为 present / gone / elsewhere 时删其中全部备份(四种形态,不受 14 天 / 3 份限制);unknown 不删。
async function deleteWholeGroup(root, rootNames, dirName, sid, g, t) {
  if (g.files.length === 0 && g.statFailures.length === 0) return;
  const state = await attributionOf(root, rootNames, dirName, sid);
  if (state === 'unknown') { t.skippedUnknown += g.files.length; return; }
  countStatFailures(t, g, true);
  const dirPath = join(root, dirName);
  for (const f of g.files) await removeBackup(dirPath, f, sid, t);
}

/** DELETE /api/history-backups/all 的活。返回 { status, body }。 */
export async function deleteAllHistoryBackups(root) {
  requireRoot(root);
  const now = Date.now();
  const t = newTally();
  let top;
  try {
    top = await readRoot(root);
  } catch (e) {
    logSettings('全部', t);
    return { status: 500, body: { ok: false, code: 'HISTBAK_DELETE_FAILED', error: `清理失败(${errCode(e)})` } };
  }
  for (const dirName of top ? top.names : []) {
    if (!(await isWorkspaceDir(root, top.realRoot, dirName))) continue;
    let groups;
    try { groups = await scanDir(join(root, dirName), now); } catch { t.skippedDirs += 1; continue; }
    for (const [sid, g] of groups) await deleteWholeGroup(root, top.names, dirName, sid, g, t);
  }
  logSettings('全部', t);
  return { status: 200, body: deleteBody(t) };
}

/**
 * DELETE /api/history-backups/:projectHash/:sessionId 的活(两个参数已由路由按 URL 解码)。返回 { status, body }。
 * 校验顺序:projectHash 形态 → sessionId 形态 → 工作区目录核验 → 列目录。projectHash 只用来挑出 R 下已有的
 * 工作区目录,sessionId 只用来比对文件名里的会话编号;被删的文件全部来自服务端对该目录的列举。
 */
export async function deleteSessionHistoryBackups(root, projectHash, sessionId) {
  requireRoot(root);
  const hash = typeof projectHash === 'string' ? projectHash : '';
  if (hash === '' || hash.length > 255 || hash.includes('/') || hash.includes('\\') || hash.includes(NUL) || hash.startsWith('.')) {
    return { status: 400, body: { ok: false, code: 'HISTBAK_INVALID_INPUT', error: 'projectHash 必须是合法的工作区目录名' } };
  }
  if (typeof sessionId !== 'string' || !SESSION_ID_SHAPE.test(sessionId)) {
    return { status: 400, body: { ok: false, code: 'HISTBAK_INVALID_INPUT', error: 'sessionId 必须是 36 位会话编号' } };
  }
  const now = Date.now();
  let realRoot = null;
  try { realRoot = await realpath(root); } catch { realRoot = null; }
  if (!realRoot || !(await isWorkspaceDir(root, realRoot, hash))) {
    return { status: 404, body: { ok: false, code: 'HISTBAK_NOT_FOUND', error: '没有这个工作区目录' } };
  }
  const scope = `单个会话 sid=${sid8(sessionId)}`;
  const t = newTally();
  let groups;
  try {
    groups = await scanDir(join(root, hash), now);
  } catch (e) {
    t.skippedDirs = 1;
    logSettings(scope, t);
    return { status: 500, body: { ok: false, code: 'HISTBAK_DELETE_FAILED', error: `清理失败(${errCode(e)})` } };
  }
  const g = groups.get(sessionId);
  if (g) await deleteWholeGroup(root, null, hash, sessionId, g, t);
  logSettings(scope, t);
  return { status: 200, body: deleteBody(t) };
}
