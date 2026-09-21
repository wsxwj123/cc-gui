// r126:GUI 配置 json 的守卫读取 —— "读不出就不许写、先备份、恢复后自动正常"(BRIEF-r126 Q1/Q2/Q4/Q5)。
//
// 背景:custom-providers.json 之类的文件若半写 / 被外部工具改坏,此前读成"空"只记一行日志;之后任何一次
// 新增 / 编辑都把"空 + 新项"写回去,原有条目连同密钥永久丢失。这里统一收口:
//  - readJsonGuarded(file) → { file, value, missing, corrupt, unreadable, backup, error }
//      · 文件不存在(ENOENT)= missing:正常的空,可写,不备份(首次使用 / 用户删掉让程序重建)。
//      · 解析失败 = corrupt:原文件一个字节不动,按字节复制一份到同目录 `<原名>.corrupt-<数字时间戳>`;
//        同一份损坏内容(按 sha256 判,不看 mtime)只备份一次 —— 进程内记模块级状态,跨重启靠扫同目录已有
//        备份比对字节;并发首读串行化,不会重复建。
//      · 其它读取错误(EACCES / EISDIR …)= unreadable:读不出同样不许写(rename 覆盖仍可能成功,一样丢数据)。
//      · 读取成功即清除该文件的损坏态(Q4:修好 / 删掉后不用重启)。
//  - assertWritable(file):写入前调用;损坏 / 读不出 → 抛 ConfigGuardError(status 409,code CONFIG_CORRUPT /
//    CONFIG_UNREADABLE,带 file 与 backup),路由层用 sendConfigGuardError 统一回 409 JSON。
//    每次都重新读盘判定(不信任上一次读的缓存):写路径的"读-改-写"之间文件可能被修好或改坏。
//  - corruptWarning(r):给 GET /providers 的 warnings[] 用的结构化警告 { kind:'config-corrupt', file, message, backup }。
//
// 备份文件本身含明文密钥(与原文件同级),固定 0600;文案只含路径,绝不含文件内容。
// 0 字节 / 只有空白的文件按 missing 处理:没有任何数据可保护,锁住只会把用户挡在外面
// (provider-models.json / active-provider.json 是非原子 writeFile,进程被杀可能留下空文件)。
import { readFile, writeFile, readdir, stat } from 'fs/promises';
import { createHash } from 'crypto';
import { basename, dirname, join } from 'path';

const corruptState = new Map();   // file → { hash, backup }
const backupInflight = new Map(); // file → Promise<string|null>(并发首读串行化)
const loggedBackupFailure = new Set();

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class ConfigGuardError extends Error {
  constructor({ code, file, backup, message }) {
    super(message);
    this.name = 'ConfigGuardError';
    this.status = 409;
    this.code = code;
    this.file = file;
    this.backup = backup ?? null;
  }
}

export const isConfigGuardError = (err) => !!err && err.status === 409 && typeof err.code === 'string' && err.code.startsWith('CONFIG_');

/** 路由层统一出口:409 + { error, code, file, backup }(INTERFACE-r126 §C1 同形)。 */
export function sendConfigGuardError(res, err) {
  return res.status(409).json({ error: err.message, code: err.code, file: err.file, backup: err.backup ?? null });
}

function backupClause(backup) {
  return backup ? `原文件未改动，已备份到 ${backup}` : '原文件未改动（备份失败，请先手动复制一份）';
}

/** GET /providers 的结构化警告(只对 corrupt 给;missing / 正常 → null)。 */
export function corruptWarning(r) {
  if (!r || !r.corrupt) return null;
  const name = basename(r.file);
  return {
    kind: 'config-corrupt',
    file: r.file,
    backup: r.backup ?? null,
    message: `${name} 不是合法 JSON（可能写到一半或被外部改坏），其中的配置暂时读不到，写入已锁定以免覆盖。${backupClause(r.backup)}；修复该文件或删除它（程序会重建）后重试。`,
  };
}

/** 由一次读取结果得到"为什么不许写"的错误;可写 → null。 */
export function guardError(r) {
  if (!r) return null;
  const name = basename(r.file);
  if (r.corrupt) {
    return new ConfigGuardError({
      code: 'CONFIG_CORRUPT', file: r.file, backup: r.backup,
      message: `${name} 不是合法 JSON（可能写到一半或被外部改坏），为避免覆盖原有内容已拒绝写入。${backupClause(r.backup)}；修复该文件或删除它（程序会重建）后重试。`,
    });
  }
  if (r.unreadable) {
    return new ConfigGuardError({
      code: 'CONFIG_UNREADABLE', file: r.file, backup: null,
      message: `${name} 读取失败（${r.error || '未知错误'}），为避免覆盖原有内容已拒绝写入；请检查该文件的权限后重试。`,
    });
  }
  return null;
}

async function findSameContentBackup(file, raw) {
  const dir = dirname(file);
  const re = new RegExp(`^${escapeRe(basename(file))}\\.corrupt-\\d+$`);
  let names;
  try { names = (await readdir(dir)).filter((n) => re.test(n)).sort().reverse(); } catch { return null; }
  for (const n of names) {
    const p = join(dir, n);
    try {
      const s = await stat(p);
      if (!s.isFile() || s.size !== raw.length) continue;
      if ((await readFile(p)).equals(raw)) return p;
    } catch { /* 读不了的备份跳过 */ }
  }
  return null;
}

async function createBackup(file, raw) {
  const ts = Date.now();
  for (let i = 0; i < 1000; i += 1) {
    const candidate = `${file}.corrupt-${ts + i}`;
    try {
      await writeFile(candidate, raw, { flag: 'wx', mode: 0o600 });
      return candidate;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
    }
  }
  throw new Error('备份文件名连续冲突');
}

// 同一文件的备份动作串行化:10 路并发首读只建 1 份(B3-7);链上后来的调用看到前者已记的状态直接复用。
function ensureBackup(file, raw) {
  const hash = sha256(raw);
  const prev = backupInflight.get(file);
  const run = (prev ? prev.catch(() => null) : Promise.resolve()).then(async () => {
    const cur = corruptState.get(file);
    if (cur && cur.hash === hash && cur.backup && await exists(cur.backup)) return cur.backup;
    const backup = (await findSameContentBackup(file, raw)) || await createBackup(file, raw);
    corruptState.set(file, { hash, backup });
    return backup;
  });
  backupInflight.set(file, run);
  return run.finally(() => { if (backupInflight.get(file) === run) backupInflight.delete(file); });
}

export async function readJsonGuarded(file) {
  let raw;
  try {
    raw = await readFile(file);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      corruptState.delete(file);
      return { file, value: undefined, missing: true, corrupt: false, unreadable: false, backup: null, error: null };
    }
    return { file, value: undefined, missing: false, corrupt: false, unreadable: true, backup: null, error: err?.code || err?.message || String(err) };
  }
  const text = raw.toString('utf-8');
  if (!text.trim()) {
    corruptState.delete(file);
    return { file, value: undefined, missing: true, corrupt: false, unreadable: false, backup: null, error: null };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    let backup = null;
    try {
      backup = await ensureBackup(file, raw);
    } catch (e) {
      const key = `${file}:${e?.code || e?.message}`;
      if (!loggedBackupFailure.has(key)) {
        loggedBackupFailure.add(key);
        console.warn(`[config-guard] ${basename(file)} 损坏但备份失败：${e?.code || e?.message || e}`);
      }
      corruptState.set(file, { hash: sha256(raw), backup: null });
    }
    return { file, value: undefined, missing: false, corrupt: true, unreadable: false, backup, error: err?.message || 'invalid JSON' };
  }
  corruptState.delete(file);
  return { file, value, missing: false, corrupt: false, unreadable: false, backup: null, error: null };
}

/** 写入前必调:重新读盘判定;损坏 / 读不出 → 抛 ConfigGuardError;否则返回这次读取结果(可写)。 */
export async function assertWritable(file) {
  const r = await readJsonGuarded(file);
  const err = guardError(r);
  if (err) throw err;
  return r;
}

/** 只给单测:清空进程内的损坏态(模拟重启)。 */
export function _resetGuardStateForTests() {
  corruptState.clear();
  backupInflight.clear();
  loggedBackupFailure.clear();
}
