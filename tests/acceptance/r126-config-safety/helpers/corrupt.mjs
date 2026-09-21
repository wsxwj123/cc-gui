// r126 · "把配置文件弄坏"与"证明文件一个字节没动"的工具。
// 两种损坏内容(INTERFACE §A 用半截 JSON 举例;BRIEF 说"半写、被外部工具改坏"→ 再加一种含非 UTF-8 字节的乱码):
//   半截 = 写到一半断掉的 JSON;乱码 = 含 0x00/0xff/非法 UTF-8 序列的二进制垃圾(字节比对才有意义)。
// 所有写操作都先过 assertIsolated(绝不碰真实家目录)。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { FILES, cfgPath, guiDir, assertIsolated } from './fixtures.mjs';

export const HALF = Buffer.from('{"providers":[{"id":"r126-half","name":"半截 JSON —— 写到一半断了"', 'utf8');
export const GARBAGE = Buffer.concat([
  Buffer.from([0x00, 0xff, 0xfe, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x80, 0x81, 0xc3, 0x28]),
  Buffer.from('r126 乱码 fixture: 这不是 JSON\n', 'utf8'),
  Buffer.from([0xf0, 0x28, 0x8c, 0xbc, 0x00, 0x7f]),
]);
/** 两种损坏内容,按名字取。 */
export const KINDS = { '半截': HALF, '乱码': GARBAGE };

/** 往隔离 HOME 的 ~/.claude-gui/<file> 写入损坏字节,返回文件路径。 */
export function corruptFile(home, key, bytes) {
  assertIsolated(home);
  const p = cfgPath(home, key);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, bytes);
  return p;
}

/** 覆写(或删除,bytes === null)隔离 HOME 里的某个配置文件。 */
export function setFile(home, key, bytes) {
  assertIsolated(home);
  const p = cfgPath(home, key);
  if (bytes === null) { fs.rmSync(p, { force: true }); return p; }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, bytes);
  return p;
}

/** 删掉某个配置文件连同它的所有 .corrupt-* 备份(界面用例在共享 HOME 里复位用)。 */
export function resetFile(home, key) {
  assertIsolated(home);
  fs.rmSync(cfgPath(home, key), { force: true });
  for (const name of listBackups(home, key)) fs.rmSync(path.join(guiDir(home), name), { force: true });
}

export const readBytes = (p) => (fs.existsSync(p) ? fs.readFileSync(p) : null);
export const sha = (buf) => (buf ? crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16) : 'absent');
export const sameBytes = (a, b) => (a === null && b === null) || (!!a && !!b && a.equals(b));

/** 文件的可打印描述(证据用):存在与否、字节数、sha256 前 16 位、前 48 字节转义。 */
export function describe(p) {
  const buf = readBytes(p);
  if (!buf) return { exists: false, size: 0, sha: 'absent', head: '' };
  return { exists: true, size: buf.length, sha: sha(buf), head: JSON.stringify(buf.subarray(0, 48).toString('latin1')) };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 备份文件名规则(INTERFACE B3):<原名>.corrupt-<数字时间戳>,同目录。 */
export const backupRe = (key) => new RegExp(`^${escapeRe(FILES[key])}\\.corrupt-\\d+$`);
/** 同目录下某文件的全部备份文件名(按名字排序)。 */
export function listBackups(home, key) {
  const dir = guiDir(home);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => backupRe(key).test(n)).sort();
}
export const backupPaths = (home, key) => listBackups(home, key).map((n) => path.join(guiDir(home), n));
/** 目录里所有形如 *.corrupt-* 的文件(反向守卫:正常/不存在时一个都不该有)。 */
export function listAnyBackups(home) {
  const dir = guiDir(home);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => /\.corrupt-\d+$/.test(n)).sort();
}

/** 一次"写请求"前后的字节证据:{ before, after, unchanged, beforeDesc, afterDesc }。 */
export async function withBytes(p, fn) {
  const before = readBytes(p);
  const result = await fn();
  const after = readBytes(p);
  return { result, before, after, unchanged: sameBytes(before, after), beforeDesc: { size: before?.length ?? 0, sha: sha(before) }, afterDesc: { size: after?.length ?? 0, sha: sha(after) } };
}
