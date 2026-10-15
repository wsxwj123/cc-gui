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
//     和本模块自己留下的临时文件(上次在"写临时文件"与"改名"之间退出)。只认本模块的命名:正文只删 <消息id>.txt,
//     临时文件只删 messages.json.tmp.<pid>.<n> 与 <消息id>.txt.tmp.<pid>.<n>(pid 是另一个还活着的进程时不动);
//     正文目录是符号链接时整个跳过,不跟着链接删别处的文件。
// 懒加载:第一次用到时才读盘。总开关关着时路由层先回 409,本模块不会经那些接口被调到;关着时仍会被调到的只有:
//   · 删会话(DELETE /api/sessions/:id):会读收件箱、有变化时写 —— 收件箱文件不存在时什么都不写、不建目录;
//   · GET /api/xsession/config 的 stored 计数(countUnfinishedXsMessages):只读,不做恢复、不写、不建目录;
//   · POST /api/xsession/clear(clearXsInbox,只在关着时可用):只删本模块的文件,不建任何东西。
// 日志只带消息 id,不带任何正文片段。
//
// 一条记录的字段由 xsession.js(T-X4)定;本模块只依赖下面这几个:
//   id(会话 id 同形状)、status(六种之一)、to.sessionId、heldReason、via,
//   以及认领 / 处理期间的临时字段 token、heldBefore、turn —— 恢复时删掉它们(旧凭据随之作废)。
import { readFile, writeFile, rename, unlink, mkdir, readdir, lstat } from 'fs/promises';
import { join } from 'path';
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
async function atomicWrite(file, data) {
  await mkdir(BODIES_DIR, { recursive: true, mode: 0o700 }); // 连带建出 xsession/
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
      try { await rename(MESSAGES_PATH, aside); } catch {}
      console.warn(`[xsession] messages.json 无法解析,已移到 ${aside}`);
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
  if (!quarantined) {
    await sweepOwnTempFiles();
    await sweepOrphanBodies(messages);
  }
}

// 正文目录不是真目录(符号链接、文件、不存在)→ null:不往里面清东西。
async function bodiesDirEntries() {
  try {
    const st = await lstat(BODIES_DIR);
    if (!st.isDirectory()) return null; // lstat 不跟链接:符号链接在这里不算目录
    return await readdir(BODIES_DIR);
  } catch { return null; }
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
    if (stale(f, (base) => base === 'messages.json')) await unlinkQuietly(join(XS_DIR, f));
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
 * 删除失败(不是"不存在")→ XsStorageError;记录已删、正文没删完时,剩下的正文在下次读盘恢复时按孤儿清掉。
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
      cache = null; // 之后第一次用到时重新读盘:文件不存在 = 空表
      let top = [];
      try { top = await readdir(XS_DIR); } catch (e) { if (e?.code !== 'ENOENT') throw e; }
      for (const f of top) {
        const t = TEMP_SUFFIX_RE.exec(f);
        if (f.startsWith('messages.json.corrupt-') || (t && f.slice(0, t.index) === 'messages.json')) await unlinkIfExists(join(XS_DIR, f));
      }
      for (const f of (await bodiesDirEntries()) || []) {
        const m = TEMP_SUFFIX_RE.exec(f);
        if (isBodyFileName(m ? f.slice(0, m.index) : f)) await unlinkIfExists(join(BODIES_DIR, f));
      }
    } catch (e) {
      throw new XsStorageError('xsession 清空失败', e);
    }
    return removed;
  });
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
