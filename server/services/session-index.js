// 会话画像的**存储层**:进程内 LRU + 按项目落盘 + 计数。
//
// 分工红线(INTERFACE §C,§E):本模块**不扫描、不派生、不碰源 jsonl** —— 它只认
// 「一个绝对 filePath → 一份画像对象」的键值关系,以及「该项目有变化,≤3 s 内把它的
// 索引文件原子地写下去」。画像里有什么字段、字段怎么算,与它无关。
//
// 为什么运行期就落盘而不是退出时落盘:Tauri 退出走 kill -9(src-tauri lib.rs:180/813),
// 没有 SIGTERM/SIGINT 钩子 —— 攒到退出写 = 永远写不下去,「每次开 app 从零开始」的根因
// 原样保留。所以扫描完 ≤3 s 尾随去抖写一次。
import { mkdir, readFile, readdir, rename, writeFile, chmod } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { PROFILE_VERSION, isProfileValid, profileLevel } from './session-profile.js';

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const MAX_ENTRIES = 4000;                  // §C.1:值 ≈0.4 KB/条 ⇒ 上限 ≈2 MB
const MAX_INDEX_BYTES = 4 * 1024 * 1024;   // §C.2 体积防御:超了不落盘
const FLUSH_DEBOUNCE_MS = 2000;            // §C.2「≤3 s 尾随去抖」的实现值
const LOG = () => process.env.CGUI_SESSION_INDEX_LOG === '1';

/** 索引层开关(§C.3):off = 完全退回今天的行为(不缓存/不读不写索引/不走增量)。 */
export function indexEnabled() {
  return String(process.env.CGUI_SESSION_INDEX || '').trim().toLowerCase() !== 'off';
}
function indexDir() {
  const override = process.env.CGUI_SESSION_INDEX_DIR;
  return override && override.trim() ? override : join(homedir(), '.claude-gui', 'session-index');
}

// 键 = 绝对 filePath(与今天的 EDGES_CACHE 同形,不再拼 #edgeSize)。Map 的迭代序 = 插入序,
// 命中时 delete+set 实现 LRU(修掉今天「命中不刷新位置 + 插入序 FIFO」的错淘汰)。
const cache = new Map();

const counters = {
  hit: 0, loaded: 0, scanned: 0, rescanned: 0, incremental: 0,
  indexReadFailed: 0, indexWriteFailed: 0, indexWrite: 0,
};

/** hash → { loadPromise, timer, dirty, persistedAt, bytes, hits, misses, incremental } */
const projects = new Map();
function projectRec(hash) {
  let rec = projects.get(hash);
  if (!rec) { rec = { loadPromise: null, timer: null, dirty: false, persistedAt: null, bytes: 0, hits: 0, misses: 0, incremental: 0 }; projects.set(hash, rec); }
  return rec;
}

/** 与 server/routes/sessions.js 的 safeId 同款判据(hash 拼进路径前的闸门)。 */
function safeId(s) {
  if (typeof s !== 'string' || !s) return false;
  if (s.includes('/') || s.includes('\\') || s.includes('..') || s.includes('\0')) return false;
  return true;
}

/** 绝对 filePath → 所属 projectHash(不在 ~/.claude/projects 下则 null)。 */
const norm = (p) => String(p).replace(/\\/g, '/');
function hashOf(filePath) {
  const p = norm(filePath);
  const prefix = norm(PROJECTS_DIR);
  if (!p.startsWith(prefix)) return null;
  const rest = p.slice(prefix.length).replace(/^\/+/, '');
  const i = rest.indexOf('/');
  if (i <= 0) return null;
  const h = rest.slice(0, i);
  return safeId(h) ? h : null;
}

function relKeyOf(filePath) {
  const h = hashOf(filePath);
  if (!h) return null;
  const rest = norm(filePath).slice(norm(PROJECTS_DIR).length);
  const segs = rest.replace(/^\/+/, '').split('/');
  segs.shift(); // 去掉 hash 段
  return segs.join('/'); // 键形态统一正斜杠(§C.2)
}

function keyOf(hash, relKey) {
  return join(PROJECTS_DIR, hash, ...String(relKey).split('/'));
}

/**
 * 读缓存条目(§C.1 判据):版本/等级/size/mtimeMs/(正数 ino) 全过才算命中。
 * **不满足一律当 miss** —— 由 isProfileValid + 这里的等级判断共同实现。不抛。
 */
export function getEntry(filePath, st, need) {
  if (!indexEnabled()) return null;
  const entry = cache.get(filePath);
  if (!isProfileValid(entry, st)) {
    const h = hashOf(filePath);
    if (h) projectRec(h).misses++;
    return null;
  }
  if (need === 'full' && profileLevel(entry) !== 'full') {
    const h = hashOf(filePath);
    if (h) projectRec(h).misses++;
    return null;
  }
  cache.delete(filePath); // LRU:命中移到队尾
  cache.set(filePath, entry);
  counters.hit++;
  const h = hashOf(filePath);
  if (h) projectRec(h).hits++;
  return entry;
}

/** 取**未判有效性**的原始条目(增量路径的 prev 来源;可能已过期)。不抛。 */
export function getRawEntry(filePath) {
  if (!indexEnabled()) return null;
  return cache.get(filePath) || null;
}

/** 写缓存条目;dirty:true 触发该项目的 ≤3 s 尾随落盘。不抛。 */
export function putEntry(filePath, profile, opts = {}) {
  if (!indexEnabled() || !profile) return;
  cache.delete(filePath);
  cache.set(filePath, profile);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  const h = hashOf(filePath);
  if (!h) return;
  const rec = projectRec(h);
  if (opts && opts.dirty) {
    rec.dirty = true;
    if (!rec.timer) {
      rec.timer = setTimeout(() => { rec.timer = null; flushProject(h).catch(() => {}); }, FLUSH_DEBOUNCE_MS);
      rec.timer.unref?.();
    }
  }
}

/**
 * 计数器上报(扫描发生在 session-profile,计数口径唯一放在本模块 —— §D.3)。
 * kind: 'scanned'(首次全量)| 'rescanned'(文件变了/闸门不满足 → 全量重扫)| 'incremental'。
 * 契约 §E 之外的一处内部导出,只为让 readStats 能给出 §D.3 的计数器。
 */
export function noteScan(kind, hash) {
  if (kind === 'incremental') counters.incremental++;
  else if (kind === 'rescanned') counters.rescanned++;
  else counters.scanned++;
  if (kind === 'incremental' && hash && safeId(hash)) projectRec(hash).incremental++;
}

/** 该目录下当前 readdir 里存在的键(§C.1:只为存在的文件导入条目;不存在的旧条目自然被剔)。 */
async function existingRelKeys(hash, relKeys) {
  const out = new Set();
  const dirCache = new Map();
  const names = async (relDir) => {
    if (dirCache.has(relDir)) return dirCache.get(relDir);
    let set = null;
    try { set = new Set(await readdir(relDir ? keyOf(hash, relDir) : join(PROJECTS_DIR, hash))); }
    catch { set = null; }
    dirCache.set(relDir, set);
    return set;
  };
  for (const rel of relKeys) {
    const parts = rel.split('/');
    const name = parts.pop();
    const list = await names(parts.join('/'));
    if (list && list.has(name)) out.add(rel);
  }
  return out;
}

/**
 * 惰性载入某项目的索引文件(**每进程每项目一次**)。任何异常整份当空,绝不抛给调用方。
 */
export async function ensureProjectLoaded(hash) {
  if (!indexEnabled() || !safeId(hash)) return;
  const rec = projectRec(hash);
  if (rec.loadPromise) return rec.loadPromise;
  rec.loadPromise = (async () => {
    const file = join(indexDir(), `${hash}.json`);
    let raw;
    try {
      raw = await readFile(file, 'utf-8');
    } catch (e) {
      // ENOENT = 第一次用这个项目,不是故障,不计 readFailed
      if (e?.code !== 'ENOENT') { counters.indexReadFailed++; if (LOG()) console.log(`[session-index] index read failed ${hash}: ${e?.message || e}`); }
      return;
    }
    let data;
    try { data = JSON.parse(raw); } catch { counters.indexReadFailed++; return; }
    if (!data || typeof data !== 'object' || data.v !== PROFILE_VERSION || data.hash !== hash || !data.files || typeof data.files !== 'object') {
      counters.indexReadFailed++;
      return;
    }
    const keys = Object.keys(data.files).filter((k) => k && !k.startsWith('/') && !k.includes('..'));
    const existing = await existingRelKeys(hash, keys);
    let loaded = 0;
    for (const rel of keys) {
      const prof = data.files[rel];
      if (!existing.has(rel) || !prof || prof.v !== PROFILE_VERSION) continue;
      const abs = keyOf(hash, rel);
      if (cache.has(abs)) continue;
      cache.set(abs, prof);
      loaded++;
      while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
    }
    counters.loaded += loaded;
    rec.persistedAt = new Date().toISOString();
    rec.bytes = Buffer.byteLength(raw);
  })().catch(() => {});
  return rec.loadPromise;
}

/** 把某项目当前内存里的条目原子落盘(写 tmp + rename)。永远不抛。 */
export async function flushProject(hash) {
  try {
    if (!indexEnabled() || !safeId(hash)) return;
    const rec = projectRec(hash);
    if (rec.timer) { clearTimeout(rec.timer); rec.timer = null; }
    const prefix = norm(join(PROJECTS_DIR, hash)) + '/';
    const files = {};
    let n = 0;
    for (const [p, prof] of cache) {
      if (!norm(p).startsWith(prefix)) continue;
      const rel = relKeyOf(p);
      if (!rel) continue;
      files[rel] = prof;
      n++;
    }
    const body = JSON.stringify({ v: PROFILE_VERSION, hash, builtAt: new Date().toISOString(), files });
    const bytes = Buffer.byteLength(body);
    if (bytes > MAX_INDEX_BYTES) {
      if (LOG()) console.log(`[session-index] ${hash} index ${bytes}B > 4MB, skipped`);
      return;
    }
    const dir = indexDir();
    await mkdir(dir, { recursive: true, mode: 0o700 }).catch(() => {});
    chmod(dir, 0o700).catch(() => {});
    const file = join(dir, `${hash}.json`);
    const tmp = `${file}.tmp-${randomUUID()}`;
    await writeFile(tmp, body, { mode: 0o600 });
    await rename(tmp, file);
    chmod(file, 0o600).catch(() => {});
    counters.indexWrite++;
    rec.dirty = false;
    rec.persistedAt = new Date().toISOString();
    rec.bytes = bytes;
    if (LOG()) console.log(`[session-index] ${hash} files=${n} wrote=${bytes}B`);
  } catch (e) {
    counters.indexWriteFailed++;
    if (LOG()) console.log(`[session-index] index write failed: ${e?.message || e}`);
  }
}

/** §D.3 的数据源。永远不抛、不泄漏绝对路径。 */
export function readStats() {
  const perHash = new Map();
  for (const [p, prof] of cache) {
    const h = hashOf(p);
    if (!h) continue;
    let c = perHash.get(h);
    if (!c) { c = { files: 0, full: 0, head10: 0 }; perHash.set(h, c); }
    c.files++;
    if (profileLevel(prof) === 'full') c.full++; else c.head10++;
  }
  const out = {};
  for (const [h, c] of perHash) {
    const rec = projects.get(h);
    out[h] = {
      files: c.files,
      entries: c.files,
      level: c.head10 === 0 ? 'full' : (c.full === 0 ? 'head10' : 'mixed'),
      hits: rec?.hits || 0,
      misses: rec?.misses || 0,
      incremental: rec?.incremental || 0,
      persistedAt: rec?.persistedAt || null,
      bytes: rec?.bytes || 0,
    };
  }
  return {
    ok: true,
    version: PROFILE_VERSION,
    enabled: indexEnabled(),
    memory: { entries: cache.size, projects: perHash.size },
    counters: { ...counters },
    projects: out,
  };
}
