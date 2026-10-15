// r151b T-X2:跨会话消息的收件箱存储(PLAN X.1.4,接口 X.3.5)。只管落盘,不管业务判定。
//
// 文件:元数据 ~/.claude-gui/xsession/messages.json,正文 ~/.claude-gui/xsession/bodies/<消息id>.txt,分开放:
//   - 正文只在消息"未结束"(pending / queued / claimed / processing)时存在;消息变 done / dismissed 或被删掉时
//     立即删正文,元数据保留(没有正文、没有预览)。
//   - 新消息先写正文、再写元数据:调用方拿到成功时两者都已在盘上;元数据写失败就删掉刚写的正文,整次不生效。
//   - 一律"临时文件 + 改名"写入,进程内串行(一条 promise 链);目录 0700、文件 0600。
//   - 全库最多留 500 条:超出时按到达先后删最旧的已结束消息,未结束的一条不删(宁可超出也不丢)。
//   - 本进程第一次读盘时做恢复:遗留的 processing / claimed 一律退回 pending、原因 interrupted,不自动重跑
//     (重跑可能把同一件事做两遍);同时清掉没有对应未结束消息的孤儿正文(上次在"改元数据"与"删正文"之间退出)
//     和本模块自己留下的临时文件(上次在"写临时文件"与"改名"之间退出),以及保留满 7 天的损坏留存文件
//     messages.json.corrupt-*(起算取修改时间与文件名里挪开时刻的较晚者;挪开时也把修改时间设成那一刻)。只认本模块的命名:正文只删 <消息id>.txt,
//     临时文件只删 messages.json.tmp.<pid>.<n> 与 <消息id>.txt.tmp.<pid>.<n>(pid 是另一个还活着的进程时不动);
//     正文目录是符号链接时整个跳过,不跟着链接删别处的文件。
// 懒加载:第一次用到时才读盘。总开关关着时路由层先回 409,本模块不会经那些接口被调到;关着时仍会被调到的只有:
//   · 删会话(DELETE /api/sessions/:id):会读收件箱、有变化时写 —— 收件箱文件不存在时什么都不写、不建目录;
//   · GET /api/xsession/config 的 stored 计数(countUnfinishedXsMessages):只读,不做恢复、不写、不建目录;
//   · POST /api/xsession/clear(clearXsInbox,只在关着时可用):只删本模块的文件,不建任何东西;
//   · 服务启动(sweepXsLeftovers;开着时改由读盘恢复做同样的清理):只删本模块的残留,不做恢复、不写、不建目录。
// 日志只带消息 id,不带任何正文片段。
//
// 一条记录的字段由 xsession.js(T-X4)定;本模块只依赖下面这几个:
//   id(会话 id 同形状)、status(六种之一)、to.sessionId、heldReason、via,
//   以及认领 / 处理期间的临时字段 token、heldBefore、turn —— 恢复时删掉它们(旧凭据随之作废)。
import { readFile, writeFile, rename, unlink, mkdir, readdir, lstat, utimes } from 'fs/promises';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { homedir } from 'os';
import { isSessionIdShape } from './session-reader.js';

export const XS_DIR = join(homedir(), '.claude-gui', 'xsession');
const MESSAGES_PATH = join(XS_DIR, 'messages.json');
const BODIES_DIR = join(XS_DIR, 'bodies');

export const XS_STATUSES = ['pending', 'queued', 'claimed', 'processing', 'done', 'dismissed'];
const OPEN_STATUSES = new Set(['pending', 'queued', 'claimed', 'processing']);
export const isOpenStatus = (status) => OPEN_STATUSES.has(status);

// 不可配置的固定值(接口 X.3.5)。
export const XS_LIMITS = Object.freeze({
  bodyBytes: 32768,
  pendingPerSession: 50,
  targetsPerSend: 8,
  maxKept: 500,
});

// 恢复时清掉的临时字段(见文件头)。
const TRANSIENT_KEYS = ['token', 'heldBefore', 'turn'];

/** 落盘失败(建目录 / 写临时文件 / 改名)。路由层据此回 500 STORAGE_WRITE_FAILED;抛出时内存状态未变。 */
export class XsStorageError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'XsStorageError';
    this.code = 'STORAGE_WRITE_FAILED';
    if (cause) this.cause = cause;
  }
}

let cache = null; // 已加载的消息数组(按到达先后);null = 本进程还没读过盘
let queue = Promise.resolve();
function enqueue(task) {
  const run = queue.then(task);
  queue = run.then(() => {}, () => {}); // 失败不断链
  return run;
}

let tmpSeq = 0;
async function atomicWrite(file, data, dir = BODIES_DIR) {
  await mkdir(dir, { recursive: true, mode: 0o700 }); // 默认连带建出 xsession/;发送档案只建 xsession/
  const tmp = `${file}.tmp.${process.pid}.${tmpSeq++}`;
  try {
    await writeFile(tmp, data, { encoding: 'utf-8', mode: 0o600 });
    await rename(tmp, file);
  } catch (e) {
    try { await unlink(tmp); } catch {}
    throw e;
  }
}

const bodyPath = (id) => join(BODIES_DIR, `${id}.txt`);

async function persist(messages) {
  try {
    await atomicWrite(MESSAGES_PATH, JSON.stringify({ version: 1, messages }));
  } catch (e) {
    throw new XsStorageError('xsession 元数据写入失败', e);
  }
}

async function removeBody(id) {
  try { await unlink(bodyPath(id)); } catch (e) {
    if (e?.code !== 'ENOENT') console.warn(`[xsession] 正文删除失败(消息 ${id}):${e.code || e.message}`);
  }
}

function isValidRecord(m) {
  return !!m && typeof m === 'object' && !Array.isArray(m)
    && isSessionIdShape(m.id) && XS_STATUSES.includes(m.status)
    && !!m.to && typeof m.to === 'object' && typeof m.to.sessionId === 'string';
}

// processing / claimed → pending + interrupted;via 保留(合法组合:出错退回时 via = 上次的方式)。
function recoverInterrupted(m) {
  m.status = 'pending';
  m.heldReason = 'interrupted';
  for (const k of TRANSIENT_KEYS) delete m[k];
}

// 只在队列里调。读盘失败(不是"文件不存在")时原样抛出,cache 保持 null,下次再试 —— 不能拿空表顶上,
// 否则下一次写会把读不出来的那份整个覆盖掉。
async function loadIfNeeded() {
  if (cache) return;
  let raw = null;
  try { raw = await readFile(MESSAGES_PATH, 'utf-8'); } catch (e) {
    if (e?.code !== 'ENOENT') throw e;
  }
  let messages = [];
  let dirty = false;
  let quarantined = false;
  if (raw !== null) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
    if (parsed && Array.isArray(parsed.messages)) {
      messages = parsed.messages.filter(isValidRecord);
      dirty = messages.length !== parsed.messages.length;
    } else {
      // 文件损坏:挪到一边留证(不覆盖),从空表开始。这一次不清孤儿正文,给手工找回留余地。
      quarantined = true;
      const aside = `${MESSAGES_PATH}.corrupt-${Date.now()}`;
      let moved = false;
      try { await rename(MESSAGES_PATH, aside); moved = true; } catch {}
      console.warn(`[xsession] messages.json 无法解析,已移到 ${aside}`);
      // 改名不改修改时间:设成挪开这一刻,"保留 7 天"从这里算(设不上只记日志,最坏是不满 7 天就被启动清理删掉)
      if (moved) {
        const now = new Date();
        try { await utimes(aside, now, now); } catch (e) { console.warn(`[xsession] 损坏留存文件未能更新修改时间:${e.code || e.message}`); }
      }
    }
  }
  for (const m of messages) {
    if (m.status === 'processing' || m.status === 'claimed') { recoverInterrupted(m); dirty = true; }
  }
  if (dirty) {
    // 恢复结果写不进去也照样用内存里的:下一次成功的写会带上它;重启后会再恢复一遍,结果相同。
    try { await persist(messages); } catch (e) { console.warn(`[xsession] 启动恢复未能落盘:${e.cause?.code || e.message}`); }
  }
  cache = messages;
  if (!quarantined) await sweepLeftovers(messages);
}

// 正文目录不是真目录(符号链接、文件、不存在)→ null:不往里面清东西。
// onError(可选,r151c 先修 7):列目录出错(不是"不存在")时回调一次,给调用方记日志;返回值照样是 null。
async function bodiesDirEntries(onError = null) {
  try {
    const st = await lstat(BODIES_DIR);
    if (!st.isDirectory()) return null; // lstat 不跟链接:符号链接在这里不算目录
    return await readdir(BODIES_DIR);
  } catch (e) {
    if (onError && e?.code !== 'ENOENT') onError(e);
    return null;
  }
}

const isBodyFileName = (f) => f.endsWith('.txt') && isSessionIdShape(f.slice(0, -4));

async function sweepOrphanBodies(messages) {
  const files = await bodiesDirEntries();
  if (!files) return;
  const keep = new Set(messages.filter((m) => isOpenStatus(m.status)).map((m) => `${m.id}.txt`));
  for (const f of files) {
    if (isBodyFileName(f) && !keep.has(f)) await removeBody(f.slice(0, -4));
  }
}

// atomicWrite 的临时文件名:<目标文件名>.tmp.<pid>.<序号>。
const TEMP_SUFFIX_RE = /\.tmp\.(\d{1,10})\.\d{1,16}$/;
function pidAlive(pid) {
  if (!(pid > 0)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}
// 只删本模块命名的临时文件;文件名里的 pid 是另一个还活着的进程(同一 HOME 下另一个 GUI 实例正在写)时不动。
async function sweepOwnTempFiles() {
  const stale = (name, isTarget) => {
    const m = TEMP_SUFFIX_RE.exec(name);
    if (!m || !isTarget(name.slice(0, m.index))) return false;
    const pid = Number(m[1]);
    return pid === process.pid || !pidAlive(pid);
  };
  let top = [];
  try { top = await readdir(XS_DIR); } catch { /* 目录不存在 */ }
  for (const f of top) {
    if (stale(f, (base) => base === 'messages.json' || base === 'profiles.json')) await unlinkQuietly(join(XS_DIR, f));
  }
  for (const f of (await bodiesDirEntries()) || []) {
    if (stale(f, isBodyFileName)) await unlinkQuietly(join(BODIES_DIR, f));
  }
}

async function unlinkQuietly(file) {
  try { await unlink(file); } catch (e) {
    if (e?.code !== 'ENOENT') console.warn(`[xsession] 临时文件删除失败:${e.code || e.message}`);
  }
}

// 损坏留存文件(messages.json.corrupt-<挪开时刻的毫秒数>)保留 7 天;只删普通文件,不跟链接、不删目录。
// r151c 先修 6:起算时刻 = max(修改时间, 文件名里的毫秒时间戳)。改名不改修改时间,挪开后设修改时间失败时它仍是原文件最后一次
// 写入的时刻(可能早已超过 7 天,下次启动就被删);文件名里的就是挪开那一刻。取较晚的只会多留、不会早删;文件名后缀不是
// 纯数字时只看修改时间。
export const XS_CORRUPT_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const CORRUPT_PREFIX = 'messages.json.corrupt-';
function corruptKeptSince(name, mtimeMs) {
  const tail = name.slice(CORRUPT_PREFIX.length);
  const named = /^\d{1,16}$/.test(tail) ? Number(tail) : NaN;
  return Number.isFinite(named) ? Math.max(mtimeMs, named) : mtimeMs;
}
async function sweepStaleCorruptFiles() {
  let top = [];
  try { top = await readdir(XS_DIR); } catch { return; }
  const now = Date.now();
  for (const f of top) {
    if (!f.startsWith(CORRUPT_PREFIX)) continue;
    try {
      const st = await lstat(join(XS_DIR, f));
      if (st.isFile() && now - corruptKeptSince(f, st.mtimeMs) > XS_CORRUPT_KEEP_MS) await unlink(join(XS_DIR, f));
    } catch (e) {
      if (e?.code !== 'ENOENT') console.warn(`[xsession] 过期的损坏留存文件删除失败(${f}):${e.code || e.message}`);
    }
  }
}

// 启动清理(只删,不写、不建):过期的损坏留存文件、本模块的临时文件、没有对应未结束消息的正文。
// clear 删掉记录后没删成的正文 / 临时文件 / 损坏留存文件也由这里收尾(正文此时都是孤儿;损坏留存按 7 天)。
async function sweepLeftovers(messages) {
  await sweepStaleCorruptFiles();
  await sweepOwnTempFiles();
  await sweepOrphanBodies(messages);
}

function trimToCapacity(messages) {
  let excess = messages.length - XS_LIMITS.maxKept;
  if (excess <= 0) return messages;
  return messages.filter((m) => {
    if (excess > 0 && !isOpenStatus(m.status)) { excess -= 1; return false; }
    return true;
  });
}

/** 确保本进程已读过盘(含启动恢复)。index.js 启动时在总开关开着时调一次;其余入口都会自己触发。 */
export function loadXsInbox() {
  return cache ? Promise.resolve() : enqueue(loadIfNeeded);
}

/**
 * 服务启动时总开关关着用(index.js;开着时由 loadXsInbox 的读盘恢复做同样的清理):只删不写 —— 不做恢复、不挪损坏文件、
 * 不建目录。按只读读到的 messages.json 判哪些正文还有用:文件不存在 = 都没用;读不出或解析不了 → 这一次什么都不清
 * (与读盘时挪开损坏文件那一次一样,给手工找回留余地)。本进程已读过盘时什么都不做(读盘时清过了)。
 */
export function sweepXsLeftovers() {
  return enqueue(async () => {
    if (cache) return;
    let raw = null;
    try { raw = await readFile(MESSAGES_PATH, 'utf-8'); } catch (e) {
      if (e?.code !== 'ENOENT') return;
    }
    let messages = [];
    if (raw !== null) {
      let parsed;
      try { parsed = JSON.parse(raw); } catch { return; }
      if (!parsed || !Array.isArray(parsed.messages)) return;
      messages = parsed.messages.filter(isValidRecord);
    }
    await sweepLeftovers(messages);
  });
}

/** 全部消息记录(按到达先后;深拷贝,随便改不影响存储)。 */
export async function listXsMessages() {
  await loadXsInbox();
  return structuredClone(cache);
}

/** 各会话 status 为 pending 的条数:Map<会话id, 条数>(没有的会话不在表里)。 */
export async function pendingCountsBySession() {
  await loadXsInbox();
  const counts = new Map();
  for (const m of cache) {
    if (m.status === 'pending') counts.set(m.to.sessionId, (counts.get(m.to.sessionId) || 0) + 1);
  }
  return counts;
}

/**
 * 未结束(pending / queued / claimed / processing)的消息条数(GET /api/xsession/config 的 stored;总开关关着也调)。
 * 只读:本进程读过盘就数内存里的;没读过就直接数文件里的(不做启动恢复、不挪损坏文件、不写、不建目录)。
 * 文件不存在、读不出或解析不了 → 0(配置接口不因收件箱出错而失败)。
 */
export async function countUnfinishedXsMessages() {
  if (cache) return cache.filter((m) => isOpenStatus(m.status)).length;
  let raw;
  try { raw = await readFile(MESSAGES_PATH, 'utf-8'); } catch (e) {
    if (e?.code !== 'ENOENT') console.warn(`[xsession] 读取收件箱失败,未处理条数按 0:${e.code || e.message}`);
    return 0;
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return 0; }
  return Array.isArray(parsed?.messages) ? parsed.messages.filter((m) => isValidRecord(m) && isOpenStatus(m.status)).length : 0;
}

async function unlinkIfExists(file) {
  try { await unlink(file); } catch (e) {
    if (e?.code !== 'ENOENT') throw e;
  }
}

/**
 * 清空收件箱(POST /api/xsession/clear;路由层只在总开关关着时调)。在存储队列里跑,与其它读写串行。删:
 *   messages.json(先删它:删不掉就整次失败、什么都没变)、xsession/ 下的 messages.json.corrupt-* 与 messages.json 的临时文件、
 *   正文目录里本模块的正文(<消息id>.txt)与正文临时文件;正文目录不是真目录(符号链接等)时不进去。
 * 不删 xsession/ 以外的任何东西,不建任何目录或文件。返回删掉的消息总条数(含已结束的;文件不存在为 0)。
 * 以收件箱记录为准(复审建议 2):messages.json 删不掉(不是"不存在")→ XsStorageError(路由回 500),什么都没改;
 * 记录删掉之后,删正文 / 损坏留存 / 临时文件失败只记日志(只带文件名),整次仍算成功、removed 照实;剩下的由下次启动的
 * 清理删掉(sweepLeftovers:正文此时都是孤儿,临时文件按 pid,损坏留存按 7 天)。
 */
export function clearXsInbox() {
  return enqueue(async () => {
    let removed = 0;
    if (cache) removed = cache.length;
    else {
      try {
        const parsed = JSON.parse(await readFile(MESSAGES_PATH, 'utf-8'));
        if (Array.isArray(parsed?.messages)) removed = parsed.messages.filter(isValidRecord).length;
      } catch { /* 不存在或解析不了:按 0 条(读不出的话下面的删除也会失败) */ }
    }
    try {
      await unlinkIfExists(MESSAGES_PATH);
    } catch (e) {
      throw new XsStorageError('xsession 清空失败', e);
    }
    cache = null; // 之后第一次用到时重新读盘:文件不存在 = 空表
    let top = [];
    try { top = await readdir(XS_DIR); } catch (e) {
      if (e?.code !== 'ENOENT') console.warn(`[xsession] 清空时读目录失败,留待下次启动清理:${e.code || e.message}`);
    }
    for (const f of top) {
      const t = TEMP_SUFFIX_RE.exec(f);
      if (f.startsWith(CORRUPT_PREFIX) || (t && f.slice(0, t.index) === 'messages.json')) await unlinkLeftover(join(XS_DIR, f), f);
    }
    // r151c 先修 7:正文目录列不出来(权限等)时原先静默跳过,现在记一行日志;剩下的正文留待下次启动清理
    const bodyFiles = await bodiesDirEntries((e) => console.warn(`[xsession] 清空时读正文目录失败,留待下次启动清理:${e.code || e.message}`));
    for (const f of bodyFiles || []) {
      const m = TEMP_SUFFIX_RE.exec(f);
      if (isBodyFileName(m ? f.slice(0, m.index) : f)) await unlinkLeftover(join(BODIES_DIR, f), f);
    }
    return removed;
  });
}

// clear 删掉记录之后的删除:失败只记日志(文件名里只有消息 id,没有正文),不抛。
async function unlinkLeftover(file, name) {
  try { await unlink(file); } catch (e) {
    if (e?.code !== 'ENOENT') console.warn(`[xsession] 清空时 ${name} 删除失败,留待下次启动清理:${e.code || e.message}`);
  }
}

/** 读正文;已删除、不存在或 id 形状不对 → null。 */
export async function readXsBody(id) {
  if (!isSessionIdShape(id)) return null;
  try { return await readFile(bodyPath(id), 'utf-8'); } catch { return null; }
}

/**
 * 串行事务:fn(messages, tx) 在一份草稿上增删改(messages 是深拷贝的数组),新消息的正文用 tx.putBody(id, text) 交给本模块。
 * fn 抛错 → 什么都不写,原样抛出。之后按 500 条裁剪;有变化才写盘:先写新正文,再写元数据;任何一步失败 → 删掉本次
 * 新写的正文,抛 XsStorageError,内存状态不变。写成功后删掉"之前未结束、现在已结束或已删除"的消息的正文。
 * 返回 fn 的返回值。
 */
export function mutateXsInbox(fn) {
  return enqueue(async () => {
    await loadIfNeeded();
    const before = cache;
    const draft = structuredClone(before);
    const newBodies = new Map();
    const existingIds = new Set(before.map((m) => m.id));
    const tx = {
      // 只给新消息用:已有消息的正文不许改写(失败回滚会把它连带删掉)。
      putBody(id, text) {
        if (!isSessionIdShape(id) || typeof text !== 'string') throw new TypeError('putBody:id 形状不对或正文不是字符串');
        if (existingIds.has(id)) throw new TypeError('putBody:只能给新消息写正文');
        newBodies.set(id, text);
      },
    };
    const result = await fn(draft, tx);
    const next = trimToCapacity(draft);
    if (newBodies.size === 0 && JSON.stringify(next) === JSON.stringify(before)) return result;

    const openAfter = new Set(next.filter((m) => isOpenStatus(m.status)).map((m) => m.id));
    const written = [];
    try {
      for (const [id, text] of newBodies) {
        if (!openAfter.has(id)) continue; // 没有落成未结束消息的正文不留
        try { await atomicWrite(bodyPath(id), text); } catch (e) { throw new XsStorageError('xsession 正文写入失败', e); }
        written.push(id);
      }
      await persist(next);
    } catch (e) {
      for (const id of written) await removeBody(id);
      throw e;
    }
    cache = next;
    for (const m of before) {
      if (isOpenStatus(m.status) && !openAfter.has(m.id)) await removeBody(m.id);
    }
    return result;
  });
}

// ── r151c:发送档案 ~/.claude-gui/xsession/profiles.json(方案 A5 / A12)──────────────────────────────────
// { salt, sessions: { <会话id>: { replay, judge } } }。replay = 该会话最近一次回合请求体里的会话级参数(请求原值,没带为 null,
// model 为解析后的值),只用于重放;judge = { mode(解析后的界面档位), providerFp(provider 指纹,加盐摘要), recordedAt(ISO) },
// 判定只读它。salt:本机首次需要时随机生成 32 字节(十六进制),随第一次写盘落下,不出本机。
// 与收件箱共用同一条串行队列与"临时文件 + 改名"写法(目录 0700、文件 0600);只认白名单字段;内容没变不写盘;
// 文件损坏时挪到 profiles.json.corrupt-<毫秒> 留证、从空开始。文件不存在时只读、删条目都不建任何东西。
// 凭据明文不在这里:providerFp 是摘要,原文只在内存里参与计算(见 xsession-policy.js)。
const PROFILES_PATH = join(XS_DIR, 'profiles.json');
export const XS_PROFILE_REPLAY_KEYS = Object.freeze(['cwd', 'model', 'effort', 'addDirs', 'permissionMode', 'globalRead', 'appendSystemPrompt', 'promptSuggestions', 'keepAlive', 'maxBudgetUsd', 'genui']);
export const XS_PROFILE_MODES = Object.freeze(['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']);
const SALT_RE = /^[0-9a-f]{64}$/;
const FP_RE = /^[0-9a-f]{16}$/;
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// replay 的值只收 JSON 标量与字符串数组(请求体里这 11 个键本来就只有这些形态);cwd 必须是非空字符串。
const isReplayValue = (v) => v === null || typeof v === 'string' || typeof v === 'boolean'
  || (typeof v === 'number' && Number.isFinite(v)) || (Array.isArray(v) && v.every((x) => typeof x === 'string'));

/** 一条档案 → 只含白名单字段的新对象;不合规返回 null。 */
function pickProfile(p) {
  if (!isPlainObject(p) || !isPlainObject(p.replay) || !isPlainObject(p.judge)) return null;
  const replay = {};
  for (const k of XS_PROFILE_REPLAY_KEYS) {
    const v = p.replay[k] === undefined ? null : p.replay[k];
    if (!isReplayValue(v)) return null;
    replay[k] = Array.isArray(v) ? [...v] : v;
  }
  if (typeof replay.cwd !== 'string' || !replay.cwd) return null;
  const { mode, providerFp, recordedAt } = p.judge;
  if (!XS_PROFILE_MODES.includes(mode) || typeof providerFp !== 'string' || !FP_RE.test(providerFp)
    || typeof recordedAt !== 'string' || Number.isNaN(Date.parse(recordedAt))) return null;
  return { replay, judge: { mode, providerFp, recordedAt } };
}
function pickSessions(sessions) {
  const out = {};
  if (!isPlainObject(sessions)) return out;
  for (const [id, p] of Object.entries(sessions)) {
    const picked = isSessionIdShape(id) ? pickProfile(p) : null;
    if (picked) out[id] = picked;
  }
  return out;
}

let profiles = null; // 已加载的 { salt, sessions };null = 本进程还没读过盘
// 只在队列里调。读盘失败(不是"文件不存在")原样抛出,profiles 保持 null,下次再试(不拿空表顶上,免得下一次写把它覆盖掉)。
async function loadProfilesIfNeeded() {
  if (profiles) return;
  let raw = null;
  try { raw = await readFile(PROFILES_PATH, 'utf-8'); } catch (e) {
    if (e?.code !== 'ENOENT') throw e;
  }
  let salt = null;
  let sessions = {};
  if (raw !== null) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
    if (isPlainObject(parsed) && isPlainObject(parsed.sessions)) {
      if (typeof parsed.salt === 'string' && SALT_RE.test(parsed.salt)) salt = parsed.salt;
      sessions = pickSessions(parsed.sessions);
    } else {
      const aside = `${PROFILES_PATH}.corrupt-${Date.now()}`;
      try { await rename(PROFILES_PATH, aside); } catch {}
      console.warn(`[xsession] profiles.json 无法解析,已移到 ${aside}`);
    }
  }
  profiles = { salt: salt || randomBytes(32).toString('hex'), sessions };
}

/** 读档案:{ salt, sessions } 的深拷贝(与写入同一条队列,读到的是此前所有事务提交后的状态)。 */
export function readXsProfiles() {
  return enqueue(async () => {
    await loadProfilesIfNeeded();
    return structuredClone(profiles);
  });
}

/**
 * 档案事务:fn(draft) 在 { salt, sessions } 的深拷贝上改 sessions(salt 改了也不认);提交时按白名单重新取一遍(不合规的条目丢掉),
 * 与改之前逐字相同就不写盘。写失败 → 抛 XsStorageError,内存不变。返回 fn 的返回值。
 */
export function mutateXsProfiles(fn) {
  return enqueue(async () => {
    await loadProfilesIfNeeded();
    const before = profiles;
    const draft = structuredClone(before);
    const result = await fn(draft);
    const next = { salt: before.salt, sessions: pickSessions(draft.sessions) };
    if (JSON.stringify(next) === JSON.stringify(before)) return result;
    try {
      await atomicWrite(PROFILES_PATH, JSON.stringify(next), XS_DIR);
    } catch (e) {
      throw new XsStorageError('xsession 发送档案写入失败', e);
    }
    profiles = next;
    return result;
  });
}

/** 删掉某会话的档案(会话 id 不分大小写);没有这一条、文件不存在时什么都不写。返回是否删了。 */
export function dropXsProfile(sessionId) {
  const target = String(sessionId || '').toLowerCase();
  return mutateXsProfiles((d) => {
    let dropped = false;
    for (const k of Object.keys(d.sessions)) {
      if (k.toLowerCase() === target) { delete d.sessions[k]; dropped = true; }
    }
    return dropped;
  });
}
